# Deployment guide (localhost, VPS, service)

This server speaks MCP over **stdio**: it has no TCP port. An MCP client
(opencode, Claude Desktop, Inspector) spawns `node dist/index.js` as a child
process. "Deploying" therefore means deciding **where that process runs** and
**how secrets and logs are handled** — not opening firewall ports.

## Option A — local process (recommended default)

Run everything on your own machine:

```bash
npm install
cp .env.example .env   # fill in GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI
npm run auth:init       # one-time OAuth on http://localhost:3000/oauth2callback
npm run build
npm start
```

Point the MCP client at `<repo>/dist/index.js` (see `opencode.json` and the
Claude Desktop example in `README.md`). Secrets stay in `.env` (git-ignored);
the refresh token may live in `.env` (`GOOGLE_REFRESH_TOKEN`) or in the
`0600` token file created by `auth:init`.

## Option B — VPS over SSH (shared or always-on host)

Keep the stdio transport; run the process on the VPS and reach it over SSH:

1. Provision the VPS (Node.js >= 20, dedicated OS user, e.g. `gmail-mcp`).
2. Copy the repo, `npm ci`, create `.env` from `.env.example`.
3. Run `auth:init` **with SSH port forwarding** so the localhost callback
   works: `ssh -L 3000:localhost:3000 user@vps`, then `npm run auth:init`
   on the VPS and complete the browser flow locally.
4. Run under systemd so it restarts on failure (example unit):

```ini
[Unit]
Description=gmail-secure-mcp stdio server
After=network.target

[Service]
User=gmail-mcp
WorkingDirectory=/opt/gmail-mcp
ExecStart=/usr/bin/node /opt/gmail-mcp/dist/index.js
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

5. From your laptop, expose it through SSH stdio in the MCP client
   (`ssh user@vps node /opt/gmail-mcp/dist/index.js`) or run opencode
   directly on the VPS.

## Option C — remote MCP over HTTP (only if you need it)

Only if several users/agents must reach the server over the network: the
current codebase has **no HTTP transport**. Converting it means replacing
`serveStdio` with the SDK Streamable HTTP transport plus OAuth/token auth,
TLS termination (reverse proxy), and per-tenant Gmail credentials. That is a
Tier-2 architecture change — do it only with a concrete multi-user
requirement, not preemptively.

## Operations checklist (all options)
- **Secrets**: never commit `.env`, `.credentials/`, or `audit.log`
  (already git-ignored). Prefer the host secret manager on a VPS; restrict
  files to the service user (`0600`).
- **Token rotation**: Google refresh tokens stop working when revoked or when
  the OAuth grant changes. Any tool error containing `invalid_grant` already
  tells the operator to run `npm run auth:init` again — do that, then
  restart the process.
- **Audit rotation**: when `audit.log` exceeds `MAX_AUDIT_BYTES` it moves to
  `audit.log.1` (single slot). Ship both files to secure log management
  before they fill again; never upload message bodies anywhere.
- **Verification after any deploy**: `npm run check` (build + tests), then
  one read-only tool call (`gmail_list_threads`) before enabling mutations.

## Install troubleshooting

- **sharp download fails on Windows**: `@huggingface/transformers` pulls
  `sharp` (image-only, unused here). Install with `npm install --omit=optional`,
  then add the platform binding your toolchain needs
  (e.g. `npm install -D @rolldown/binding-win32-x64-msvc@<rolldown-version>`
  if vitest fails to start). `onnxruntime-node` ships as a transformers
  dependency and installs from prebuilt binaries.
- **Semantic search fails on Alpine/musl**: `onnxruntime-node` ships glibc
  binaries (`ld-linux-x86-64.so.2`). Use a glibc-based image or install
  `gcompat`; the rest of the server is unaffected because the import is lazy.
- **First semantic search is slow**: the multilingual embedding model
  (~120MB) downloads once from Hugging Face Hub and caches locally; the
  index then builds from recent threads. Subsequent queries are fast until
  `SEMANTIC_INDEX_TTL_HOURS` expires.
- **contacts_search returns 403/insufficient permissions**: enable People API
  in GCP, ensure `GOOGLE_SCOPES` includes
  `https://www.googleapis.com/auth/contacts.readonly`, re-run
  `npm run auth:init`, then restart the process.
