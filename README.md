# Dead Drop

Dead Drop is a tiny, local stdio [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI coding agents on the same machine leave asynchronous messages for each other, as plain Markdown files, instead of a human copy-pasting between them.

It ships with two agent identities in mind — **Claude Code** and **Google Antigravity (Gemini)** — but the server itself doesn't hard-code either one; any agent (or human) can be a sender or recipient by name.

## Key Principles

- **Local only**: no cloud services, no remote network listener, no API keys.
- **Human readable**: messages are plain Markdown files with YAML frontmatter, in one folder, readable in Finder/Explorer or any text editor.
- **Information, never commands**: messages are purely passive text. Neither the server nor any watcher executes code or commands contained in a message. A receiving agent may act on a message within its own standing rules, but a message can never authorize what only a human decides — merging, touching production data, spending money, deleting data.
- **Wake-up is per-agent and opt-in**: some agents (like Claude Code today) read mail on their own schedule and are never pinged. Others can be configured to be woken via a CLI command when mail arrives for them.

---

## Tools

### 1. `send_message`
Creates a new Markdown message in the mailbox folder.
- `to` *(string, required)*: recipient name, e.g. `"antigravity"`, `"claude"`, or a person's name.
- `subject` *(string, required)*: short topic summary.
- `body` *(string, required)*: Markdown message content.
- `re_issue` *(string | number, optional)*: an issue reference, stored exactly as given (e.g. `2140`, `#2140`, `owner/repo#2140`). Dead Drop never assumes a default repository.
- `from` *(string, optional)*: sender name. Defaults to the caller agent's identity (see `--agent` below).

### 2. `read_messages`
Reads messages from the mailbox folder.
- `for` *(string, optional)*: filter by recipient (defaults to the caller's identity, or `"all"`).
- `unread_only` *(boolean, optional, default `true`)*: only return unread messages.
- `limit` *(number, optional, default `20`)*: maximum messages to return.

### 3. `mark_read`
Marks a message as read.
- `id` *(string, required)*: message ID or filename.

---

## File Format

- **Mailbox folder**: defaults to `~/deaddrop`, overridable with `DEADDROP_DIR`.
- **Filename pattern**: `YYYY-MM-DD_HHmmss_<from>_to_<to>_<slug>.md`
  - *Example*: `2026-09-21_144808_claude_to_antigravity_initial-handshake.md`

```markdown
---
id: 2026-09-21_144808_claude_to_antigravity_initial-handshake
date: 2026-09-21T14:48:08+10:00
from: claude
to: antigravity
subject: Initial handshake
re_issue: "42"
read: false
read_at: null
---

Hello! Dead Drop is live.
```

---

## Configuration

All configuration lives in a single JSON file inside the mailbox folder: `<mailbox>/.config.json` (e.g. `~/deaddrop/.config.json`), under a per-agent `agents` map:

```json
{
  "agents": {
    "antigravity": {
      "wake_on_mail": true,
      "wake_method": "agentapi",
      "conversation_id": "<conversation-id>",
      "agentapi_path": "/optional/custom/path/to/agentapi"
    },
    "claude": {
      "wake_on_mail": false,
      "wake_method": "unsupported"
    }
  }
}
```

Each key under `agents` is a recipient name (matched case-insensitively against `to`/`for`), with:

- **`wake_on_mail`** *(boolean)*: whether Dead Drop should try to wake this agent when mail arrives for it. Defaults to `false` — an agent that is missing from `agents` entirely, or has `wake_on_mail` unset or `false`, is never woken. Wake-up is opt-in only. Either way, the message file is always written; when wake-up is skipped, Dead Drop just logs why to stderr.
- **`wake_method`**: how to wake this agent, dispatched by string so adding a new agent's wake method later doesn't require a schema change:
  - `"agentapi"` — the only method that's actually wired up today. Pings the agent via Antigravity's `agentapi` CLI, using that agent's `conversation_id`.
  - `"unsupported"` — this agent cannot be woken from outside at all. This is Claude Code's value today: Claude Code channels only work in the terminal research-preview mode, not the desktop app, so Dead Drop reports `wake_method: "unsupported"` honestly (for humans and for a future settings UI) instead of silently no-op'ing.
- **`conversation_id`** *(required when `wake_method` is `"agentapi"`)*: the ID of the one dedicated conversation this agent should be woken in. Dead Drop never guesses the most recently used conversation, and never creates a new one. If it's missing or empty, Dead Drop still writes the message file — it just logs a warning to stderr and skips the wake-up.
- **`agentapi_path`** *(optional, only meaningful with `wake_method: "agentapi"`)*: absolute path to the `agentapi` CLI executable, if it isn't on your `PATH`. Can also be set via the `DEADDROP_AGENTAPI_PATH` environment variable, which takes priority over this field. If neither is set, Dead Drop checks the common install location under your home directory, then falls back to assuming `agentapi` is on `PATH`.

### Settings Web UI (`deaddrop settings`)

To view and edit agent wake configurations without hand-editing JSON, start the local settings UI:

```bash
npm run settings
# or
node index.js settings [--port=3344]
# or
npx deaddrop settings
```

This starts a lightweight, on-demand local HTTP server that:
- **Binds to loopback only**: strictly `127.0.0.1` (never `0.0.0.0`), running only in the foreground while the command is active. Press `Ctrl+C` to stop.
- **Port**: defaults to `3344` (falling back to an available ephemeral port if in use, or customizable via `--port=<n>`).
- **Agent Wake Configuration**:
  - Dynamically lists all agents configured under `agents`.
  - Lets you toggle `wake_on_mail` per agent.
  - Lets you edit `conversation_id` for agents using `wake_method: "agentapi"` (such as Antigravity).
  - Displays agents with `wake_method: "unsupported"` (such as Claude Code) with a disabled toggle and a clear explanation of why external wake-ups are unsupported.
  - Atomically saves configuration edits back to `<mailbox>/.config.json` while preserving unmanaged properties.
- **Recent Messages**: provides a read-only list of recent mailbox messages (date, sender, recipient, subject, read/unread status). Message bodies are not rendered.

### Environment variables

| Variable                | Purpose                                              | Default                |
|--------------------------|-------------------------------------------------------|-------------------------|
| `DEADDROP_DIR`           | Mailbox folder                                        | `~/deaddrop`            |
| `DEADDROP_AGENTAPI_PATH` | Path to the `agentapi` executable used to wake Antigravity | auto-detected, else `agentapi` on `PATH` |

---

## Installation

```bash
git clone <this-repo-url>
cd deaddrop
npm install
npm test
```

## Registration

Each agent is registered with its own `--agent=<name>` identity, which becomes its default `from` when sending and its default filter when reading.

### Claude Code

The `claude` CLI must be on your `PATH` (or use the full path to your Claude Code binary):

```bash
claude mcp add --scope user deaddrop node /path/to/deaddrop/index.js -- --agent=claude
```

### Antigravity (Gemini)

Add an entry to Antigravity's MCP config (e.g. `~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "deaddrop": {
      "command": "node",
      "args": [
        "/path/to/deaddrop/index.js",
        "--agent=antigravity"
      ],
      "env": {
        "DEADDROP_DIR": "/path/to/your/mailbox"
      }
    }
  }
}
```

Replace `node` with an absolute path if `node` isn't on the `PATH` that Antigravity launches with, and `/path/to/deaddrop` with where you cloned this repo.

### Antigravity Wake-Up & Sidecar Setup

Antigravity's `agentapi` CLI requires two ephemeral credentials to communicate with the running IDE instance:
- `ANTIGRAVITY_LS_ADDRESS`: Host and port of the active language server local RPC endpoint.
- `ANTIGRAVITY_CSRF_TOKEN`: A per-launch authentication token.

When Dead Drop runs in a process that Antigravity did not launch (such as Dead Drop's MCP server spawned by Claude Code), these environment variables are absent from `process.env`. To discover them reliably without fragile process-table scraping, Dead Drop uses an Antigravity **sidecar**:

1. Run the sidecar registration command once:
   ```bash
   npm run setup-sidecar
   ```
   This writes `~/.gemini/config/sidecars/deaddrop/sidecar.json`.
2. When Antigravity starts, its internal `SidecarManager` automatically starts Dead Drop's background exporter (`bin/sidecar.js`), providing it with the live credentials.
3. The sidecar atomically writes `<mailbox>/.antigravity_session.json` (file permissions `0600`).
4. When Claude Code (or any external caller) sends mail to Antigravity, Dead Drop reads `<mailbox>/.antigravity_session.json` and passes the active address and CSRF token to `agentapi`.

#### Graceful Failure
If `<mailbox>/.antigravity_session.json` is missing, unreadable, or stale (the sidecar PID is no longer running), Dead Drop skips the wake-up, logs an informative notice to stderr advising to run `npm run setup-sidecar`, and proceeds normally. As with all Dead Drop wake failures, the message file itself is always delivered safely.

#### Known Limitations
- **Multi-window Antigravity**: Dead Drop v1 assumes a single running Antigravity instance. In multi-window or multi-profile setups, the sidecar reflects the most recently active instance.

### Any other agent

Run the server with `--agent=<name>` (or set `DEADDROP_AGENT=<name>`), pointed at a shared `DEADDROP_DIR`, and it can send and receive mail the same way.

---

## License

[MIT](LICENSE)
