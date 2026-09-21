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

All configuration lives in a single JSON file inside the mailbox folder: `<mailbox>/.config.json` (e.g. `~/deaddrop/.config.json`).

```json
{
  "antigravity_conversation_id": "<conversation-id>"
}
```

- **`antigravity_conversation_id`**: the ID of the one dedicated conversation Antigravity's CLI (`agentapi`) should be woken in. Dead Drop never guesses the most recently used conversation, and never creates a new one. If this field is missing or empty, Dead Drop still writes the message file — it just logs a warning to stderr and skips the wake-up.
- **`agentapi_path`** *(optional)*: absolute path to the Antigravity `agentapi` CLI executable, if it isn't on your `PATH`. Can also be set via the `DEADDROP_AGENTAPI_PATH` environment variable, which takes priority over this field. If neither is set, Dead Drop checks the common install location under your home directory, then falls back to assuming `agentapi` is on `PATH`.

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

### Any other agent

Run the server with `--agent=<name>` (or set `DEADDROP_AGENT=<name>`), pointed at a shared `DEADDROP_DIR`, and it can send and receive mail the same way.

---

## License

[MIT](LICENSE)
