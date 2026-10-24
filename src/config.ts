import 'dotenv/config';
import { DEFAULT_SEMANTIC_MODEL } from './utils/semantic.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseScopes(raw: string): string[] {
  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) throw new Error('GOOGLE_SCOPES must contain at least one scope');
  return [...new Set(scopes)];
}

function parsePathList(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const paths = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return paths.length ? paths : null;
}

function parseDomainAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw?.trim()) return null;
  const domains = raw
    .split(/[\s,]+/)
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return domains.length ? new Set(domains) : null;
}

export interface AppConfig {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleRefreshToken?: string;
  gmailTokenPath: string;
  googleScopes: string[];
  auditLogPath: string;
  maxAuditBytes: number;
  maxRecipients: number;
  maxAttachmentBytes: number;
  maxSendAttachmentBytes: number;
  semanticModel: string;
  semanticIndexPath: string;
  semanticIndexTtlHours: number;
  maxIndexThreads: number;
  maxContactsResults: number;
  maxSubjectLength: number;
  maxBodyLength: number;
  maxMessageBodyChars: number;
  maxThreadBodyChars: number;
  allowedRecipientDomains: Set<string> | null;
  /** When set, local attachment/inline-image paths must resolve inside one of these directories. */
  allowedAttachmentDirs: string[] | null;
}

export function loadConfig(): AppConfig {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  return {
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: required('GOOGLE_REDIRECT_URI'),
    ...(refreshToken ? { googleRefreshToken: refreshToken } : {}),
    gmailTokenPath: process.env.GMAIL_TOKEN_PATH?.trim() || '.credentials/gmail-token.json',
    googleScopes: parseScopes(
      process.env.GOOGLE_SCOPES ??
        [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/contacts.readonly',
        ].join(','),
    ),
    auditLogPath: process.env.AUDIT_LOG_PATH?.trim() || './audit.log',
    maxAuditBytes: positiveInt('MAX_AUDIT_BYTES', 10 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024),
    maxRecipients: positiveInt('MAX_RECIPIENTS', 20, 1, 100),
    maxAttachmentBytes: positiveInt('MAX_ATTACHMENT_BYTES', 1_000_000, 1024, 25_000_000),
    maxSendAttachmentBytes: positiveInt('MAX_SEND_ATTACHMENT_BYTES', 10_000_000, 1024, 25_000_000),
    semanticModel: process.env.SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL,
    semanticIndexPath: process.env.SEMANTIC_INDEX_PATH?.trim() || '.cache/gmail-semantic-index.json',
    semanticIndexTtlHours: positiveInt('SEMANTIC_INDEX_TTL_HOURS', 24, 1, 720),
    maxIndexThreads: positiveInt('MAX_INDEX_THREADS', 500, 10, 2000),
    maxContactsResults: positiveInt('MAX_CONTACTS_RESULTS', 10, 1, 30),
    maxSubjectLength: positiveInt('MAX_SUBJECT_LENGTH', 998, 1, 998),
    maxBodyLength: positiveInt('MAX_BODY_LENGTH', 200_000, 1, 1_000_000),
    maxMessageBodyChars: positiveInt('MAX_MESSAGE_BODY_CHARS', 20_000, 100, 200_000),
    maxThreadBodyChars: positiveInt('MAX_THREAD_BODY_CHARS', 60_000, 1_000, 1_000_000),
    allowedRecipientDomains: parseDomainAllowlist(process.env.ALLOWED_RECIPIENT_DOMAINS),
    allowedAttachmentDirs: parsePathList(process.env.ALLOWED_ATTACHMENT_DIRS),
  };
}
