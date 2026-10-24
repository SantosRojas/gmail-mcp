# Gmail Secure MCP

Enterprise-oriented Gmail MCP server in TypeScript/Node.js using the stable MCP TypeScript SDK v2. It implements the supplied specification with additional guardrails around auditability, untrusted email content, reply threading, recipient limits, and protected Trash semantics.

## What is implemented

| Tool | Purpose | Destructive? |
|---|---|---:|
| `gmail_list_threads` | Gmail search (validated syntax) + thread IDs/snippets + result estimate | No |
| `gmail_get_thread_summary` | Thread with pagination, sanitized Markdown, metadata, attachment IDs | No |
| `gmail_list_labels` | Label ids/names, use before applying labels | No |
| `gmail_list_drafts` | Draft identifiers for review before sending | No |
| `gmail_get_attachment` | Attachment bytes as base64 (size-capped, never written to disk) | No |
| `gmail_upcoming_events` | Upcoming events parsed from recent .ics invites | No |
| `gmail_get_meeting_notes` | Meeting-notes links (Gemini Docs URLs, Read AI report URLs) extracted from a thread | No |
| `drive_get_doc_text` | Plain-text export of a Google Doc you can access (e.g. Gemini meeting notes); needs `drive.readonly` + re-auth | No |
| `gmail_semantic_search` | Meaning-based thread search with local multilingual embeddings | No |
| `gmail_reindex_semantic` | Rebuilds the local semantic index | No |
| `gmail_create_draft` | Create draft for human review; optional `attachments` (local paths) | No |
| `gmail_create_draft_with_drive_files` | Create draft attaching Drive files by ID | No |
| `gmail_get_draft` | Fetch a draft with parsed body/attachments | No |
| `gmail_update_draft` | Replace a draft (recipients, subject, body, attachments) | No |
| `gmail_delete_draft` | Permanently delete a draft (drafts only, needs reason) | Yes, draft-scoped |
| `gmail_send_draft` | Send an existing reviewed draft | No, but externally consequential |
| `gmail_reply_with_quote` | Reply draft quoting the original message | No |
| `gmail_forward_message` | Forward draft with quoted attribution (never sends directly) | No |
| `gmail_preview_message` | Dry-run: shows exactly what send would transmit, without sending | No |
| `gmail_send_message_strict` | Direct send with `confirm_send=true`; optional `attachments` (local paths, max 5, validated by size) | No, but externally consequential |
| `gmail_trash_message` | Soft-delete to Trash | Yes, reversible |
| `gmail_restore_message` | Remove from Trash (returns message to Inbox when applicable) | No |
| `gmail_apply_labels` | Add/remove labels | No |
| `gmail_search_messages` | Message-level search (IDs + threads) | No |
| `gmail_get_message_details` | One parsed message with safe Markdown body | No |
| `gmail_export_message` | Raw RFC822 export (base64url, for `.eml`) | No |
| `gmail_suggest_recipients` | Frequency-ranked address heuristic from recent threads (user must confirm; kept as fallback for senders not in Contacts) | No |
| `contacts_search` | Google Contacts lookup by name/email to resolve recipients (e.g. "fulano" → email) | No |
| `contacts_get` | Contact detail by `people/c...` resourceName | No |
| `gmail_get_profile` | Active identity + totals | No |
| `gmail_get_send_as` | Aliases, display names, signatures | No |
| `gmail_list_templates` / `gmail_render_template` | Built-in templates with `{{variable}}` substitution | No |
| `gmail_batch_trash` | Trash up to 25 messages/threads (needs reason) | Yes, reversible |
| `gmail_batch_modify_labels` | Label changes on up to 25 targets | No |
| `gmail_mark_spam` / `gmail_unmark_spam` | Spam report / reversal | No |
| `gmail_list_filters` / `gmail_create_filter` / `gmail_delete_filter` | Filter CRUD | No |
| `gmail_audit_query` | Query the JSONL audit log (never audited itself) | No |
| `gmail_watch_start` / `gmail_watch_stop` | Pub/Sub push notifications start/stop | No |

There is intentionally **no permanent-delete tool**, and the implementation does not invoke the Gmail `messages.delete` or `threads.delete` APIs. Gmail documents `trash`/`untrash` as the relevant reversible operations, while `gmail.modify` does not grant immediate permanent deletion.

## Architecture improvements beyond the supplied specification

- **OAuth state protection:** `auth:init` validates localhost redirect usage and checks an OAuth `state` value before accepting the callback.
- **Credential separation:** runtime can use `GOOGLE_REFRESH_TOKEN` or a permission-restricted token file; credentials are excluded from Git.
- **Reply-thread correctness:** when `thread_id` is supplied, the server fetches metadata, verifies subject compatibility, and constructs `In-Reply-To`/`References` headers. Gmail's threading rules require the target thread ID plus compliant reply headers and matching subject.
- **Untrusted-context handling:** HTML is converted to Markdown, active HTML is stripped, unsafe Markdown link schemes are neutralized, and the tool output explicitly marks email content as untrusted.
- **Output bounds:** message and thread body size limits prevent a single email from flooding the model context.
- **Recipient safety:** configurable maximum recipient count and optional domain allowlist.
- **Local file confinement:** optional `ALLOWED_ATTACHMENT_DIRS` allowlist for local attachments and inline images, canonicalized with `realpath` so symlinks cannot escape the allowed roots.
- **Filter guardrail:** `gmail_create_filter` rejects `TRASH` actions so filters cannot bypass the audited soft-delete path.
- **Label guardrail:** `TRASH` is rejected by `gmail_apply_labels` so trash moves remain auditable through the dedicated tool.
- **Serialized JSONL audit:** startup fails if the audit file cannot be prepared; writes are queued to avoid interleaving concurrent entries; secrets and message bodies are never written. A post-mutation audit I/O failure is surfaced as `audit_status=unavailable` without turning a successful Gmail mutation into a retryable tool error.
- **Tool annotations:** read-only vs state-changing behavior is declared in MCP metadata where supported by the SDK.

## Requirements

- Node.js >= 20
- Google Cloud project with Gmail API enabled
- OAuth 2.0 credentials for a Desktop app or localhost web flow
- Access to npm to install dependencies

The supplied specification requests these scopes:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/drive.readonly` (meeting-notes docs)
- `https://www.googleapis.com/auth/contacts.readonly` (recipient resolution; enable People API + re-run `auth:init`)

Google classifies Gmail `readonly`, `compose`, and `modify` as restricted scopes; `gmail.modify` specifically allows modification without immediate permanent deletion. Use the narrowest set that matches your actual deployment and your organization's Google verification requirements.

## Installation

```bash
npm install
cp .env.example .env
```

Fill in the Google client ID/secret and redirect URI. Do not commit `.env`, OAuth token files, or `audit.log`.

## OAuth initialization

```bash
npm run auth:init
```

Open the printed Google authorization URL. The helper validates the OAuth state and stores the refresh token at `GMAIL_TOKEN_PATH` (default `.credentials/gmail-token.json`) with mode `0600`.

For Google Cloud setup, create/configure Google Auth Platform, enable Gmail API, configure the OAuth consent screen, and add the scopes used by this project. Google's Gmail MCP configuration guide provides the current UI sequence.

## Run

```bash
npm run build
npm start
```

Development:

```bash
npm run dev
```

The MCP server uses the MCP SDK v2 `serveStdio` helper, so MCP clients should launch `dist/index.js` as a local process. The current v2 SDK is the stable release line and replaces the v1 monolithic `@modelcontextprotocol/sdk` package.

## Claude Desktop example

```json
{
  "mcpServers": {
    "gmail-secure": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-secure-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your_client_id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "your_client_secret",
        "GOOGLE_REDIRECT_URI": "http://localhost:3000/oauth2callback",
        "GOOGLE_REFRESH_TOKEN": "your_refresh_token",
        "AUDIT_LOG_PATH": "/absolute/path/to/gmail-secure-mcp/audit.log"
      }
    }
  }
}
```

For production, prefer supplying secrets through the host/service secret mechanism rather than checking them into a client configuration file.

## Audit log

State-changing tool executions append one JSON object per line:

```json
{"timestamp":"2026-10-06T16:00:00.000Z","tool_name":"gmail_trash_message","target_id":"18c123...","reason":"duplicate promotional thread","status":"success","duration_ms":142}
```

The required fields are `timestamp`, `tool_name`, `target_id`, `reason`, and `status`. Failures are also logged with bounded error text.

## Common recipes

These compose the existing tools — no new code needed:

- **Mark a thread read**: `gmail_apply_labels` with `remove_labels: ["UNREAD"]`.
  Mark unread again with `add_labels: ["UNREAD"]`.
- **Archive (remove from inbox, keep forever)**: `gmail_apply_labels` with
  `remove_labels: ["INBOX"]`. The message stays searchable under All Mail.
- **Find unread from today**: `gmail_list_threads` with
  `query: "in:inbox is:unread newer_than:1d"`.
- **Heavy threads first**: `gmail_list_threads` with `query: "larger:5M"`.
- **Review before sending**: `gmail_preview_message` first, then
  `gmail_create_draft` (human sends from Gmail) or `gmail_send_message_strict`
  with `confirm_send: true`.
- **Forward for review**: `gmail_forward_message` (creates a draft, never sends).

## Test and verification

```bash
npm run check
```

The test suite verifies pure formatting/sanitization behavior, OAuth configuration guards, audit log serialization, and static enforcement that the forbidden Gmail permanent-delete methods are not referenced by the implementation.

## Operational hardening checklist

See `docs/DEPLOYMENT.md` for localhost/VPS/service deployment.

- Put the server under a dedicated OS user.
- Restrict the token file and audit log to that user (`0600` is recommended for both).
- Back up the audit log through your normal secure log-management process; do not upload message bodies into a third-party logger.
- Rotate OAuth client secrets according to your organization's policy.
- For Google Workspace internal use, prefer an Internal OAuth audience where available; otherwise use the approved external/test-user flow and complete verification requirements as applicable.

## License

MIT
