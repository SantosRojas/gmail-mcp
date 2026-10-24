export interface CalendarEvent {
  summary: string;
  uid: string | null;
  startRaw: string;
  endRaw: string | null;
  startUtc: string | null;
  tzid: string | null;
  location: string | null;
}

function unfoldLines(text: string): string[] {
  const physical = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const logical: string[] = [];
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

function zoneOffsetMinutes(tzid: string, utcMillis: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMillis));
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((wallAsUtc - utcMillis) / 60000);
  } catch {
    return null;
  }
}

function zonedWallToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, tzid: string): string | null {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wallAsUtc;
  for (let round = 0; round < 3; round++) {
    const offset = zoneOffsetMinutes(tzid, guess);
    if (offset === null) return null;
    guess = wallAsUtc - offset * 60000;
  }
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseDateTime(value: string, tzid: string | null): string | null {
  const utc = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utc) {
    const [, year, month, day, hour, minute, second] = utc;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }
  const floating = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (floating) {
    const [, year, month, day, hour, minute, second] = floating.map(Number);
    if (tzid) return zonedWallToUtc(year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0, tzid);
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
  }
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return `${year}-${month}-${day}`;
  }
  return null;
}

export function parseIcsEvents(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: Record<string, { params: string; value: string }> | null = null;
  for (const line of unfoldLines(text)) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const start = current['DTSTART'];
        if (start) {
          const end = current['DTEND']?.value ?? null;
          const tzid = start.params.match(/TZID=([^;]+)/)?.[1] ?? null;
          events.push({
            summary: current['SUMMARY']?.value ?? '(sin título)',
            uid: current['UID']?.value ?? null,
            startRaw: start.params ? `${start.params}:${start.value}` : start.value,
            endRaw: end,
            startUtc: parseDateTime(start.value, tzid),
            tzid,
            location: current['LOCATION']?.value ?? null,
          });
        }
      }
      current = null;
      continue;
    }
    if (current) {
      const separator = line.indexOf(':');
      if (separator > 0) {
        const nameAndParams = line.slice(0, separator);
        const [name, ...params] = nameAndParams.split(';');
        if (name) current[name] = { params: params.join(';'), value: line.slice(separator + 1) };
      }
    }
  }
  return events;
}
