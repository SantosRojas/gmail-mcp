# Validation performed

## Automated checks

Verified on Node.js 24.18.1 / npm 11.12.1 after a clean `npm install`:

```bash
npm run check   # tsc build + vitest
```

Result: **build passed**, **21 test files / 114 tests passed** (including the
guardrail tests for the filter TRASH block and attachment allowlist), and
**`npm audit` reports 0 vulnerabilities**.

A stdio smoke test was also run with placeholder credentials:

- `initialize` returned protocol `2025-06-18` and server info `gmail-secure-mcp` 1.1.0.
- `tools/list` returned the full registered tool catalog.
- The audit log was created with mode `0600` at the configured path.

## Not covered by automated tests

- Live Gmail API calls: `trash`/`untrash`, draft creation/sending, filters,
  watch, contacts, Drive export and attachment download require real OAuth
  credentials. Validate them in a dedicated test mailbox before connecting the
  server to a production account.
- The first semantic search downloads the embedding model from Hugging Face
  Hub; this requires network access and is not exercised by unit tests.
- Semantic search uses `onnxruntime-node`, which ships glibc binaries. It does
  not load on Alpine/musl without `gcompat`/`libc6-compat`; every other tool
  works because the import is lazy.

## Static guardrails

- No `users.messages.delete` or `users.threads.delete` reference exists in the
  implementation; enforced by `tests/guardrails.test.ts`.
- `gmail_apply_labels`, `gmail_batch_modify_labels` and `gmail_create_filter`
  reject the `TRASH` system label.
- Secrets, token files, caches and the audit log are git-ignored.

## Before production use

```bash
npm ci
npm run check
npm run auth:init
```

Then run a read-only tool (`gmail_list_threads`) and a reversible
trash/restore cycle in a test mailbox before enabling mutations.
