# Specification: Secure Professional Gmail MCP Server (TypeScript)

## 1. Project Overview & Objective
Build an enterprise-grade Model Context Protocol (MCP) server in TypeScript/Node.js to interface with the Gmail API.
The primary goal is **absolute safety, operational auditability, and soft-deletion policies** to prevent AI agents from committing unintended destructive actions (such as permanent deletion or rogue email sending).

---

## 2. Technical Stack & Dependencies
- **Runtime:** Node.js (>= 18.x)
- **Language:** TypeScript (ES2022 / ESM modules)
- **MCP Framework:** `@modelcontextprotocol/sdk` (latest)
- **Schema Validation:** `zod`
- **Google API Client:** `googleapis`
- **HTML Parsing & Sanitization:** `turndown` (convert email HTML to clean Markdown for context efficiency)
- **Environment Management:** `dotenv`

---

## 3. Core Architectural Rules (Guardrails)

1. **NO PERMANENT DELETION:**
   - Exposing `users.messages.delete` or `users.threads.delete` is strictly forbidden.
   - All "delete" requests MUST route through `users.messages.trash` or `users.threads.trash` (Soft-Delete with a 30-day recovery window).

2. **RECOVERY SUPPORT:**
   - Must provide an explicit `gmail_restore_message` tool using `users.messages.untrash` and `users.threads.untrash`.

3. **DRAFT-FIRST & STRICT SENDING:**
   - The default mode for email composition is creating drafts (`users.drafts.create`).
   - Direct sending requires calling `gmail_send_message_strict` with an explicit `confirm_send: true` boolean property.

4. **CONTEXT SANITIZATION:**
   - Email thread responses must strip raw, bulky HTML and present clean Markdown (`turndown`) alongside metadata (Sender, Date, Subject, Message ID) to conserve LLM tokens.

5. **LOCAL AUDIT LOGGING:**
   - Every state-modifying tool execution (`trash`, `untrash`, `send_strict`, `create_draft`) must append an entry to a local JSONL file (`audit.log`) containing: `timestamp`, `tool_name`, `target_id`, `reason`, and `status`.

---

## 4. Required OAuth 2.0 Scopes
Limit Google OAuth permissions to the minimum necessary:
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.modify` *(Allows trash/untrash and label changes without granting permanent delete)*

---

## 5. Directory Structure to Implement

```
gmail-secure-mcp/
├── package.json
├── tsconfig.json
├── .env.example
├── PROMPT_SPECIFICATION.md
├── src/
│   ├── index.ts             # Entry point & MCP server registration
│   ├── auth/
│   │   └── googleAuth.ts    # Google OAuth2 client, token loading/refreshing
│   ├── tools/
│   │   ├── readTools.ts     # List threads, thread summaries
│   │   ├── writeTools.ts    # Create drafts, strict send
│   │   └── manageTools.ts   # Soft-delete, restore, apply/remove labels
│   ├── utils/
│   │   ├── sanitizer.ts     # HTML to Markdown conversion logic
│   │   └── logger.ts        # Audit logging service
│   └── types/
│       └── index.ts         # TypeScript interfaces & types
└── README.md
```

---

## 6. Detailed Tool Definitions & Schemas

### A. Read Tools

#### 1. `gmail_list_threads`
* **Description:** Searches and lists Gmail threads using standard Gmail query syntax.
* **Input Schema:**
  ```typescript
  z.object({
    query: z.string().describe("Gmail search query (e.g., 'from:boss@company.com is:unread', 'after:2026/01/01')"),
    max_results: z.number().min(1).max(50).default(10).describe("Maximum number of threads to return")
  })
  ```

#### 2. `gmail_get_thread_summary`
* **Description:** Fetches a full conversation thread by ID, sanitizing HTML bodies to plain Markdown.
* **Input Schema:**
  ```typescript
  z.object({
    thread_id: z.string().describe("The ID of the Gmail thread to retrieve"),
    include_attachments_info: z.boolean().default(true).describe("Include attachment names and MIME types")
  })
  ```

---

### B. Write Tools

#### 3. `gmail_create_draft`
* **Description:** Creates an email draft in the user's inbox for human review prior to sending.
* **Input Schema:**
  ```typescript
  z.object({
    to: z.array(z.string().email()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body content (text or markdown)"),
    thread_id: z.string().optional().describe("Optional thread ID to reply to")
  })
  ```

#### 4. `gmail_send_message_strict`
* **Description:** Sends an email directly. Requires explicit boolean confirmation flag.
* **Input Schema:**
  ```typescript
  z.object({
    to: z.array(z.string().email()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body content"),
    thread_id: z.string().optional().describe("Optional thread ID"),
    confirm_send: z.literal(true).describe("Must be explicitly set to true to authorize sending")
  })
  ```

---

### C. Management & Recovery Tools

#### 5. `gmail_trash_message`
* **Description:** Safely moves a message or thread to Gmail Trash (Soft-Delete with 30-day recovery window).
* **Input Schema:**
  ```typescript
  z.object({
    id: z.string().describe("ID of the message or thread to move to trash"),
    type: z.enum(["message", "thread"]).default("message").describe("Target type"),
    reason: z.string().describe("Mandatory explanation for why this item is being moved to trash")
  })
  ```

#### 6. `gmail_restore_message`
* **Description:** Restores a message or thread from the Gmail Trash back to the Inbox/labels.
* **Input Schema:**
  ```typescript
  z.object({
    id: z.string().describe("ID of the message or thread to restore from trash"),
    type: z.enum(["message", "thread"]).default("message").describe("Target type")
  })
  ```

#### 7. `gmail_apply_labels`
* **Description:** Adds or removes labels from a message/thread without deleting it.
* **Input Schema:**
  ```typescript
  z.object({
    id: z.string().describe("Message or Thread ID"),
    add_labels: z.array(z.string()).optional().describe("List of label IDs to add"),
    remove_labels: z.array(z.string()).optional().describe("List of label IDs to remove")
  })
  ```

---

## 7. Configuration & Installation Interface

### `package.json` scripts
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "auth:init": "tsx src/auth/setupAuth.ts"
  }
}
```

### Claude Desktop Integration Configuration (`claude_desktop_config.json`)
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
        "GOOGLE_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

---

## 8. Definition of Done (Acceptance Criteria)
1. Project builds without TypeScript errors (`npm run build`).
2. Server boots correctly using StdioTransport (`@modelcontextprotocol/sdk/server/stdio.js`).
3. Executing `gmail_trash_message` moves items to Gmail Trash, NEVER calling `delete`.
4. Executing `gmail_restore_message` brings trashed items back.
5. All state-changing operations create structured entries in `audit.log`.