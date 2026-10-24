import { appendFile, chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEntry, AuditLogger } from '../types/index.js';

function sanitizeSingleLine(value: string, maxLength = 500): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

export class JsonlAuditLogger implements AuditLogger {
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {}

  public async ensureReady(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  }

  public write(entry: AuditEntry): Promise<void> {
    const safeEntry: AuditEntry = {
      timestamp: entry.timestamp,
      tool_name: sanitizeSingleLine(entry.tool_name, 120),
      target_id: sanitizeSingleLine(entry.target_id, 200),
      reason: sanitizeSingleLine(entry.reason, 500),
      status: entry.status,
      ...(entry.duration_ms !== undefined ? { duration_ms: entry.duration_ms } : {}),
      ...(entry.error ? { error: sanitizeSingleLine(entry.error, 1000) } : {}),
    };

    const task = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded();
      await appendFile(this.filePath, `${JSON.stringify(safeEntry)}\n`, { mode: 0o600 });
      await chmod(this.filePath, 0o600);
    });
    this.queue = task;

    return this.queue;
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    // Single-slot buffer, not an archive: operators must ship audit.log
    // through normal secure log management before it fills again.
    await rm(`${this.filePath}.1`, { force: true });
    await rename(this.filePath, `${this.filePath}.1`);
  }
}

export async function auditStateChange(
  logger: AuditLogger,
  params: Omit<AuditEntry, 'timestamp'>,
): Promise<void> {
  await logger.write({ timestamp: new Date().toISOString(), ...params });
}

export async function tryAuditStateChange(
  logger: AuditLogger,
  params: Omit<AuditEntry, 'timestamp'>,
): Promise<'recorded' | 'unavailable'> {
  try {
    await auditStateChange(logger, params);
    return 'recorded';
  } catch (error) {
    console.error(`Gmail MCP audit logging failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'unavailable';
  }
}
