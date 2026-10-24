# Acceptance Checklist

| Criterion | Implementation |
|---|---|
| TypeScript build | `npm run build` |
| Stdio MCP server | MCP SDK v2 `serveStdio` |
| Permanent delete forbidden | Static guardrail test + no delete API calls in source |
| Soft delete | `users.messages.trash` / `users.threads.trash` |
| Restore | `users.messages.untrash` / `users.threads.untrash` |
| Draft-first | `users.drafts.create` |
| Strict send | `users.messages.send` only behind `confirm_send: true` |
| HTML sanitization | Turndown + active-content stripping + safe-link filtering |
| Audit | JSONL for all state-changing tools, success and failure |
| Credential hygiene | `.env` / `.credentials` ignored, token file `0600` |
| Context limits | Per-message and per-thread character caps |
| Recipient controls | Maximum recipient count + optional domain allowlist |
| Thread reply safety | Subject compatibility + `In-Reply-To` / `References` |
