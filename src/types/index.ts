import type { drive_v3, gmail_v1, people_v1 } from 'googleapis';

export type GmailClient = gmail_v1.Gmail;
export type DriveClient = drive_v3.Drive;
export type PeopleClient = people_v1.People;
export type TargetType = 'message' | 'thread';

export interface AuditEntry {
  timestamp: string;
  tool_name: string;
  target_id: string;
  reason: string;
  status: 'success' | 'error';
  duration_ms?: number;
  error?: string;
}

export interface ToolRegistrationOptions {
  gmail: GmailClient;
  auditLog: AuditLogger;
}

export interface AuditLogger {
  write(entry: AuditEntry): Promise<void>;
}
