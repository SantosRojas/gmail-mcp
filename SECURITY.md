# Security Model

## Threat model

This server assumes that Gmail message content is attacker-controlled data. A malicious sender may put instructions, fake approvals, links, credentials, or social-engineering content in a message. The MCP server therefore separates **tool authorization** from **email content**.

## Controls

### Destructive actions

Permanent Gmail message/thread deletion is not exposed. Deletion intent is mapped only to Trash, and Trash changes require a dedicated tool with a mandatory reason. The generic label tool cannot add the `TRASH` system label.

### Outbound communication

Draft creation is the default composition path. Direct send is isolated behind `gmail_send_message_strict`, whose schema requires the literal boolean `confirm_send: true`.

The server does not infer recipients from message content. Recipient count is capped and an optional domain allowlist can be enforced with `ALLOWED_RECIPIENT_DOMAINS`.

### Local file access

`gmail_create_draft`, `gmail_update_draft`, `gmail_send_message_strict` and
`gmail_preview_message` accept local attachment paths, and inline images use
the same mechanism. Without a restriction, the server can read any file the OS
user can read — which is dangerous when an agent is influenced by untrusted
email content.

Set `ALLOWED_ATTACHMENT_DIRS` to a comma-separated list of directories to
confine reads. Paths are canonicalized with `realpath`, so symlinks inside an
allowed directory cannot escape it. Running the process under a dedicated,
unprivileged OS user remains recommended.

### Thread integrity

Replies with `thread_id` use Gmail metadata to obtain the latest `Message-ID`/`References` headers. The subject is checked for compatibility before the send/draft operation is issued. This prevents accidental attachment to an unrelated conversation.

### Untrusted context

HTML is stripped of active content and converted to Markdown with Turndown. Unsafe Markdown link schemes are removed. Thread output explicitly labels email bodies as untrusted content, and output size is bounded.

### Secrets

OAuth refresh tokens and client secrets are never written to the audit log. `.env` and `.credentials/` are excluded from Git. The local OAuth helper writes the token file with mode `0600`.

### Auditability

All state-changing tool executions, including failures, produce JSONL audit entries. The audit writer serializes writes and enforces mode `0600`. Startup fails if the audit destination cannot be prepared. A post-mutation audit I/O failure is returned as an explicit `audit_status=unavailable` instead of creating a retryable false-negative mutation result.

## Scope

The project uses the scopes requested by the supplied specification. Google currently classifies `gmail.readonly`, `gmail.compose`, and `gmail.modify` as restricted Gmail scopes, so organizational deployment may require Google verification and/or security assessment depending on the data handling model.

## Operational recommendations

Run the MCP under a dedicated OS identity, keep token/audit files on an encrypted filesystem, use a controlled secret-injection mechanism for production, and monitor disk capacity so audit logging cannot silently degrade.
