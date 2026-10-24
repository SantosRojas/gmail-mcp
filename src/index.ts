import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createGmailClient, createDriveClient, createPeopleClient } from './auth/googleAuth.js';
import { JsonlAuditLogger } from './utils/logger.js';
import { registerReadTools } from './tools/readTools.js';
import { registerDriveTools } from './tools/driveTools.js';
import { registerSemanticTools } from './tools/semanticTools.js';
import { registerWriteTools } from './tools/writeTools.js';
import { registerManageTools } from './tools/manageTools.js';
import { registerDraftTools } from './tools/draftTools.js';
import { registerMessageTools } from './tools/messageTools.js';
import { registerOrganizeTools } from './tools/organizeTools.js';
import { registerDriveSendTools } from './tools/driveSendTools.js';
import { registerContactsTools } from './tools/contactsTools.js';

// Crash diagnostics first: opencode only reports "exited with code 255".
// Registered before any fallible startup step so config/auth/audit
// failures are visible on stderr instead of surfacing as a bare exit.
process.on('unhandledRejection', (reason) => {
  console.error('[gmail-mcp] unhandledRejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
process.on('uncaughtException', (error) => {
  console.error('[gmail-mcp] uncaughtException:', error instanceof Error ? (error.stack ?? error.message) : error);
});

const config = loadConfig();
const gmail = await createGmailClient(config);
const drive = await createDriveClient(config);
const people = await createPeopleClient(config);
const auditLog = new JsonlAuditLogger(config.auditLogPath, config.maxAuditBytes);
await auditLog.ensureReady();

const server = new McpServer({
  name: 'gmail-secure-mcp',
  version: '1.1.0',
});

registerReadTools(server, gmail, config);
registerDriveTools(server, drive, config);
registerSemanticTools(server, gmail, config);
registerWriteTools(server, gmail, config, auditLog);
registerManageTools(server, gmail, config, auditLog);
registerDraftTools(server, gmail, config, auditLog);
registerMessageTools(server, gmail, config);
registerOrganizeTools(server, gmail, config, auditLog);
registerDriveSendTools(server, gmail, drive, config, auditLog);
registerContactsTools(server, people, config);

serveStdio(() => server);
