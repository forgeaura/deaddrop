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

### 4. `start_session`
Starts a new Claude Code session in a given folder.
In desktop mode this tool starts the session, waits for its short bootstrap turn to finish, stops that same session, and opens it in the Claude desktop app.
- `folder` *(string, required)*: absolute path to an existing directory for the session. The directory must be trusted by Claude Code.
- `prompt` *(string, optional)*: initial message / instructions for the session (required for `"background"` mode; optional context for `"desktop"` mode). Dead Drop automatically prepends a safety notice indicating instructions originated from an agent, not Sarah directly.
- `name` *(string, optional)*: session name (default: `deaddrop-<timestamp>`). Must not start with `-` or be empty.
- `model` *(string, optional)*: model name or ID (default: `"claude-haiku-5-5"`, or `agents.claude.default_model` from config). A model matching `agents.claude.blocked_models` is rejected before anything launches.
- `effort` *(string, optional)*: reasoning effort level (`"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`).
- `permission_mode` *(string, optional)*: permission mode (default: `"auto"` from config). Must be in `agents.claude.allowed_permission_modes`.
- `handoff` *(string, optional, `"desktop"` | `"background"`)*: handoff mode (default: `"desktop"` from config).
- `from` *(string, optional)*: sender identity. Defaults to caller agent identity.

Returns desktop session ID (`local_<sessionId>`) and instructions for delegating the task via the desktop app's `send_message` tool, or background session details if `handoff: "background"`.

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
      "wake_method": "unsupported",
      "default_model": "claude-haiku-5-5",
      "blocked_models": [],
      "default_permission_mode": "auto",
      "allowed_permission_modes": [
        "auto",
        "default",
        "acceptEdits",
        "plan"
      ],
      "default_handoff": "desktop",
      "cli_path": "/optional/custom/path/to/claude"
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
- **`default_model`** *(optional, Claude only)*: the model `start_session` uses when the caller gives none. Defaults to `"claude-haiku-5-5"` when unset. The settings UI never writes this field; edit it by hand.
- **`blocked_models`** *(optional, Claude only, default `[]`)*: a list of model denylist patterns. Each pattern is a whole-string glob: `*` matches any run of characters, everything else is literal, and matching is case-insensitive. `"sonnet"` blocks only `sonnet`; `"*sonnet*"` blocks `claude-sonnet-5-5`, `SONNET` and any other model containing `sonnet`. The check runs on the resolved model, so a blocked `default_model` is rejected too. A blocked start fails with an error naming the model and pattern, and nothing is spawned or logged. Malformed values (anything other than an array of non-empty strings) fail closed: every `start_session` for Claude is rejected until the value is fixed. The settings UI never writes this field; edit it by hand.

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
| `DEADDROP_CLAUDE_PATH`   | Path to the `claude` executable used for `start_session`  | auto-detected (env -> config -> PATH -> desktop bundle) |

---

### Claude Code Sessions (`start_session`)

#### Handoff Modes
- **`"desktop"` (default)**: Starts a session in the background with a minimal bootstrap prompt, waits for it to become idle, stops it with `claude stop <id>`, and opens it in the Claude desktop app via `claude://resume?session=<sessionId>` (macOS only). The desktop app adopts it as `local_<sessionId>`. To run the actual task live in the desktop app, the caller (which must be a desktop Claude Code session) calls its desktop `send_message` tool with `session_id: "local_<sessionId>"`. If the caller does not have desktop session tools, it should use `handoff: "background"`.
- **`"background"`**: Starts a standard background CLI session that executes unattended until completion. `prompt` is required.

#### Prerequisites
- **One-time Login**: The Claude CLI must be authenticated independently of the desktop app (`claude auth login`).
- **Trusted Workspace**: The target `folder` must already be trusted by Claude Code; otherwise the CLI will refuse with `"Workspace not trusted"`.

#### Permission Guardrail
- Allowed permission modes default to `["auto", "default", "acceptEdits", "plan"]`.
- `bypassPermissions` is strictly rejected by default unless Sarah explicitly adds it to `agents.claude.allowed_permission_modes` in `<mailbox>/.config.json`.

##### Opting in to `bypassPermissions`
Add it to the list. The mode is accepted only when it appears in the list; there is no other special case for it:

```json
{
  "agents": {
    "claude": {
      "allowed_permission_modes": ["auto", "default", "acceptEdits", "plan", "bypassPermissions"]
    }
  }
}
```

Bypass mode means the Claude Code session runs its tools without asking for per-action approval. This is the owner's choice; Dead Drop never enables it on its own.

A missing `allowed_permission_modes` field in an agent's entry falls back to the default list above. The fallback applies when the field is absent from the agent entry, not only when the whole config file is missing.

##### `default_permission_mode` and `permission_mode`
- `default_permission_mode` (in `agents.claude`, default `"auto"`) is used when `start_session` gets no `permission_mode`.
- A per-call `permission_mode` overrides it for that call.
- Either value must be in `allowed_permission_modes`, or `start_session` rejects the call.

##### Keep orchestrator and builders in the same mode
Claude Code holds a cross-session message for its user's approval when the sender runs in a different permission mode, and may let it expire. So an orchestrator and the builders it starts through Dead Drop should use the same permission mode. This is the behaviour of Claude Code's SendMessage tool, not a Dead Drop guarantee.

The Claude desktop app's own `start_session` (not Dead Drop's) only starts a session in the caller's permission mode or a lower one (as of 2026-10-27).

#### Session Log (`.sessions.jsonl`)
Every spawned session is logged to `<mailbox>/.sessions.jsonl` (e.g. `~/deaddrop/.sessions.jsonl`) with restricted file permissions (`0600`), tracking `handoff` and `outcome` (`handed_off`, `still_running`, or `background`):
```json
{"time":"2026-10-20T12:00:00+08:00","from":"antigravity","folder":"/path/to/repo","name":"deaddrop-1729468000000","model":"claude-haiku-5-5","effort":"medium","permission_mode":"auto","handoff":"desktop","outcome":"handed_off","id":"b73a79df","sessionId":"uuid-value","prompt":"..."}
```

#### Viewing Sessions
- Inspect running background sessions: `claude agents --json --all`
- Open in Claude Desktop: once a session is idle or stopped, open `claude://resume?session=<sessionId>`

## Installation

```bash
git clone <this-repo-url>
cd deaddrop
npm install
npm test
```

## Registration

Each agent is registered with its own `--agent=<name>` identity, which becomes its default `from` when sending and its default filter when reading.

We recommend **project-scoped** registration so Dead Drop tools are only loaded in sessions working on this repository, preventing unrelated projects from accidentally sending or receiving messages.

### Claude Code

Use `--scope local` to register Dead Drop for this project repository only:

```bash
claude mcp add --scope local deaddrop node /path/to/deaddrop/index.js -- --agent=claude
```

This stores the configuration in local project settings without injecting Dead Drop into unrelated Claude Code sessions. (Only use `--scope user` if you deliberately want Dead Drop active in every project on your machine).

### Antigravity (Gemini)

Antigravity natively discovers workspace-scoped MCP servers from `.agents/mcp_config.json` at the repository root. Create `.agents/mcp_config.json` in your project workspace:

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

> [!NOTE]
> Make sure `.agents/` is included in your `.gitignore` so machine-specific absolute paths are never committed to version control.

### Multi-Project Setup & Mailbox Isolation

When using Dead Drop on multiple projects on the same machine, MCP registration scope is only half of the picture — the mailbox location (`DEADDROP_DIR`) controls message isolation:

- **Separate by default (Isolated projects)**:
  When setting up Dead Drop for a second, separate project, configure a **distinct `DEADDROP_DIR`** for that project's registration (e.g. `DEADDROP_DIR: "/Users/<you>/deaddrop/other-project"` or a project-local `.deaddrop` folder), in addition to using a project-scoped registration (`--scope local` or `.agents/mcp_config.json`). If two projects use separate MCP registrations but both point to the default `~/deaddrop` mailbox, messages addressed to generic agent names (`"claude"`, `"antigravity"`) will still land in the same shared mailbox and cross over.
- **Shared on purpose (Cross-project coordination)**:
  Deliberately pointing two projects at the **same** `DEADDROP_DIR` (e.g. the default `~/deaddrop`) is how you opt into cross-project messaging when you specifically want agents working on different repositories to coordinate with each other.

  For example, to share this mailbox with a second project in Antigravity, create `/Users/<you>/Repos/other-project/.agents/mcp_config.json`:

  ```json
  {
    "mcpServers": {
      "deaddrop": {
        "command": "node",
        "args": [
          "/Users/<you>/Repos/deaddrop/index.js",
          "--agent=antigravity"
        ],
        "env": {
          "DEADDROP_DIR": "/Users/<you>/deaddrop"
        }
      }
    }
  }
  ```

  *(Remember to add `.agents/` to `.gitignore` in `other-project` too, since it contains local absolute paths. Adjust `--agent=` if you want a distinct identity for that project's agent).*

  For Claude Code in the second project's folder:

  ```bash
  claude mcp add --scope local -e DEADDROP_DIR=/Users/<you>/deaddrop deaddrop node /Users/<you>/Repos/deaddrop/index.js -- --agent=claude
  ```

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

[AGPL-3.0](LICENSE) — if you modify Dead Drop and run it as a network service, you must make your modified source available to users of that service.
