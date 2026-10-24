import type { people_v1 } from 'googleapis';

export interface ContactSummary {
  resource_name: string;
  display_name: string;
  primary_email: string | null;
  all_emails: string[];
  organization: string | null;
  phone: string | null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_NAME_CHARS = 200;
const MAX_EMAILS_PER_CONTACT = 5;

function cleanEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length > 254) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

function cleanText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.slice(0, max);
}

export function pickPrimaryEmail(
  emails: people_v1.Schema$EmailAddress[] | undefined,
): { primary: string | null; all: string[] } {
  if (!emails?.length) return { primary: null, all: [] };
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Metadata.primary first, then the rest in API order.
  const sorted = [...emails].sort((a, b) => Number(b.metadata?.primary === true) - Number(a.metadata?.primary === true));
  for (const entry of sorted) {
    const cleaned = cleanEmail(entry.value);
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      ordered.push(cleaned);
      if (ordered.length >= MAX_EMAILS_PER_CONTACT) break;
    }
  }
  return { primary: ordered[0] ?? null, all: ordered };
}

export function formatContact(person: people_v1.Schema$Person): ContactSummary {
  const displayName =
    cleanText(person.names?.find((n) => n.metadata?.primary)?.displayName ?? person.names?.[0]?.displayName, MAX_NAME_CHARS) ??
    '(sin nombre)';
  const { primary, all } = pickPrimaryEmail(person.emailAddresses);
  const org = person.organizations?.find((o) => o.metadata?.primary) ?? person.organizations?.[0];
  const organization = cleanText(org?.name ?? null, 200);
  const phone = cleanText(person.phoneNumbers?.find((p) => p.metadata?.primary)?.value ?? person.phoneNumbers?.[0]?.value, 50);
  return {
    resource_name: person.resourceName ?? '',
    display_name: displayName,
    primary_email: primary,
    all_emails: all,
    organization,
    phone,
  };
}

export function validateResourceName(resourceName: string): string {
  const trimmed = resourceName.trim();
  if (!/^people\/[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error('resource_name debe tener forma people/c123 (solo letras, numeros, guion y guion bajo).');
  }
  return trimmed;
}
