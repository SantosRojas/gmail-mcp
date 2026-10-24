import { describe, expect, it } from 'vitest';
import { parseIcsEvents } from '../src/utils/ics.js';

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:1@example.com',
  'DTSTART:20261007T150000Z',
  'DTEND:20261007T160000Z',
  'SUMMARY:Revision de Checklist - ParfumIA',
  'LOCATION:https://meet.google.com/twg-gahv-psc',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:2@example.com',
  'DTSTART;TZID=America/Lima:20261008T100000',
  'DTEND;TZID=America/Lima:20261008T110000',
  'SUMMARY:Reunion con un titulo muy largo que continua',
  ' en la siguiente linea plegada',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:3@example.com',
  'DTSTART:20261009',
  'SUMMARY:Dia libre',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcsEvents', () => {
  it('parses UTC, TZID and all-day events with unfolded lines', () => {
    const events = parseIcsEvents(SAMPLE);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      summary: 'Revision de Checklist - ParfumIA',
      startUtc: '2026-10-07T15:00:00Z',
      location: 'https://meet.google.com/twg-gahv-psc',
    });
    expect(events[1]?.summary).toBe('Reunion con un titulo muy largo que continuaen la siguiente linea plegada');
    expect(events[1]?.startRaw).toContain('TZID=America/Lima');
    expect(events[1]?.startUtc).toBe('2026-10-08T15:00:00Z');
    expect(events[2]?.startUtc).toBe('2026-10-09');
    expect(events[2]?.location).toBeNull();
  });

  it('resolves daylight-saving zones to UTC', () => {
    const events = parseIcsEvents(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ny\r\nDTSTART;TZID=America/New_York:20261007T150000\r\nSUMMARY:NY\r\nEND:VEVENT\r\nEND:VCALENDAR',
    );
    expect(events[0]?.startUtc).toBe('2026-10-07T19:00:00Z');
  });

  it('keeps unknown zones raw instead of guessing', () => {
    const events = parseIcsEvents(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:zx\r\nDTSTART;TZID=MadeUp/Zone:20261007T150000\r\nSUMMARY:Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    );
    expect(events[0]?.startUtc).toBeNull();
    expect(events[0]?.tzid).toBe('MadeUp/Zone');
  });

  it('ignores events without DTSTART', () => {
    const events = parseIcsEvents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR');
    expect(events).toHaveLength(0);
  });
});
