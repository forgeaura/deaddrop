# Dead Drop playbook

How we run AI agents on `forgeaura/deaddrop`. This is a living document: when a rule feels wrong,
the orchestrator raises it with the owner, and the change goes in the change log at the bottom.

Started from the Agreezo orchestrator playbook (`~/Desktop/ORCHESTRATOR-PLAYBOOK.md`) and Wren's
intervent playbook (`~/Repos/intervent/INTERVENT-PLAYBOOK.md`). Builder rules live in
[AGENTS.md](AGENTS.md); Claude-only lines in [CLAUDE.md](CLAUDE.md).

| Role | Who | Owns |
|---|---|---|
| **Owner** | Sarah | Product decisions, merges, spend on Fable, changes to her live `~/deaddrop/.config.json` |
| **Orchestrator** | **Rook** (one long-lived Claude session) | Issues, sequencing, model choice, briefs, plan approval, PR review, telling the owner what to do |
| **Builders** | short-lived sessions, one per issue or batch | Plan, build in their own worktree, test, open the PR, report back |
| **Customers** | Wren (orchestrator of `forgeaura/intervent`), Juno (Agreezo) | Use Dead Drop to start and message their own builders |

---

## 1. What makes Dead Drop different

Dead Drop is the tool the orchestrators themselves run on. It starts processes, writes the shared
config, and passes a local Antigravity session secret to `agentapi`. There is no production
database; the risks are **security boundaries** and **breaking other projects' orchestrators**.

### 1.1 Security boundary (non-negotiable)
- Every launcher uses `execFile` with an argv array. Never a shell, never string-built commands.
- Values that become CLI arguments (names, models, titles, prompts) are validated: no leading `-`.
- The "came from an agent, not Sarah" preamble is on every session or conversation Dead Drop starts.
- The Antigravity CSRF token never appears in output, errors, logs, tests, issues or PRs.
- Builders never edit `~/deaddrop/.config.json` or the live mailbox `~/deaddrop/`. Tests use a
  temporary `DEADDROP_DIR`. Changes to Sarah's config are made by the orchestrator, with her yes.
- Real launcher calls (a real `claude --bg`, a real `agentapi new-conversation`) only as many as the
  brief allows, each titled `deaddrop-test: ignore`.

### 1.2 Other projects depend on this
- A merged change reaches every orchestrator only after its Dead Drop MCP server restarts. After a
  merge that changes a tool, the orchestrator tells Sarah which sessions need to reconnect.
- Tool descriptions are instructions to other agents. A wrong default in a description is a bug.
- Mail Wren (`send_message`, recipient `wren`) when an issue Wren cares about is filed and when its
  PR merges.

### 1.3 Verification
`npm test` (runs `test/test-server.js`, which includes `test/test-claude-cli.js`). There is no lint
or build step. **GitHub Actions CI does not run** (account billing), so a red check proves nothing:
always run `npm test` locally.

---

## 2. Models

### 2.1 Standing rules (owner, 2026-10-27)
- **⛔ Never start a Sonnet 5.5 session.** No exceptions.
- **Always pass `model` explicitly** on every session start.
- **Haiku 5.5 is the default builder, and the only model the orchestrator starts without asking.**
- **Opus 5.5 and Fable 5.1 each need the owner's explicit yes, per session.** "Opus for judgement
  work" says when to *propose* Opus, not permission to start it. The proposal goes under Action
  items and says what Haiku would likely get wrong, the cost difference, and the Haiku fallback
  (e.g. Haiku/high with a tighter brief and a closer review).
- Before each dispatch, check what the launchers can do (§2.3) and choose model and effort for the
  task: cost, speed, reasoning depth. Record the outcome in §2.4.

### 2.2 Routing ledger

Every Opus or Fable row is a proposal for the owner, never a default.

| Task type | Model | Effort | Notes |
|---|---|---|---|
| Docs, README, config examples | Haiku 5.5 | low | Orchestrator checks every claim against the code |
| Small, well-specified code changes with tests (defaults, validation, a new field) | Haiku 5.5 | high | High effort is cheap on Haiku; guardrail code earns it |
| New MCP tool following an existing tool's pattern | Haiku 5.5 | medium | |
| Anything that spawns processes, handles the Antigravity secret, or writes shared config | Opus 5.5 (ask) | high | Security boundary |
| Diagnosis of environment-dependent bugs (e.g. #18) | Opus 5.5 (ask) | high | Folded into the related feature when it touches the same code |
| Investigation of an undocumented interface (e.g. Antigravity models) | Opus 5.5 (ask) | high | Plan must state findings with evidence before code |
| Independent second-opinion review | Gemini 4 Argon | high | Once Dead Drop can pick it (#25, #26); until then Opus |
| A Haiku build that failed review twice | Opus 5.5 (ask) | high | |
| Design docs, architecture | Opus 5.5 high, or Fable 5.1 xhigh | | Fable needs the owner's yes |
| **Sonnet 5.5** | **never** | | |

Prices per million tokens, input/output (from Wren, 2026-10-27): Haiku 5.5 $0.10/$0.50 ·
Opus 5.5 $4/$20 · Fable 5.1 $10/$50 · Gemini 4 Argon $2/$10 (doubles 1 Dec 2026) ·
Gemini 3.8 Flash $0.75/$3.75 (doubles 1 Jan 2027) · Gemini 3.1 Flash Lite $0.25/$1.50.

### 2.3 What the launchers can do (verified 2026-10-27)

| Launcher | Starts | Model choice | Effort | Notes |
|---|---|---|---|---|
| Desktop app `start_session` (built in) | Claude Code session in the sidebar, own worktree | Caller's model or cheaper (from Opus: Opus or Haiku) | at or below the caller's | **Preferred for builders.** Cross-session messages work at once. Permission mode at or below the caller's. |
| Dead Drop `start_session` | Claude Code session via `claude --bg` | Any Claude model, alias or full ID | low…max | Needed for Fable, or effort above the caller's. Falls back to `sonnet` without a model until #24 merges. `handoff: "desktop"` (#22) needs a Dead Drop MCP reconnect. |
| Antigravity `agentapi new-conversation` | Antigravity (Gemini) conversation | `flash_lite`, `flash`, `pro` only; mapping unconfirmed | none | Not in Dead Drop yet (#25); exact models under investigation (#26). Needs `ANTIGRAVITY_PROJECT_ID`. |
| Dead Drop mail to an `agentapi` agent | Wakes an existing Antigravity conversation | that conversation's | none | Wake fails from the long-running MCP process (#18). |

### 2.4 Outcomes log
One row per merged or abandoned PR, so the ledger rests on evidence.

| Date | Issue | Model / effort | Plan approved as sent? | Passed review first time? | Note |
|---|---|---|---|---|---|

---

## 3. The orchestrator

### 3.1 Job
- Plan, dispatch, review. Don't build, except an emergency fix the owner asks for "now".
- Every piece of work has a GitHub issue before it has a builder. The queue lives in GitHub issues.
- Decide the sequence. Batch issues that touch the same files into one builder; never run two
  builders on the same files.
- Before dispatching, `git fetch` and check `worktrees/` and the session list. A builder without a
  PR yet is not a dead builder.

### 3.2 Plan → approve → build (every builder)
1. The brief tells the builder to investigate in its own worktree, send a concise plan (files,
   approach, tests, open questions) by cross-session message, and **stop**.
2. The orchestrator approves, adjusts or rejects it.
3. Only then does the builder build, verify and open the PR.

### 3.3 Dispatch
- Desktop `start_session`: `context: "fresh"`, `use_worktree: true`, explicit `model` and `effort`,
  `permission_mode` the same as the orchestrator's (messages between sessions in different modes
  are held for approval).
- Dead Drop `start_session` only when the desktop launcher can't do it (Fable, higher effort).
- Follow-ups on an open PR go to the builder that owns it. After a merge, start a fresh session.

### 3.4 Brief template

```
NEW AGENT  (or: → the #NN agent, worktree <path>)
Model: <model>, effort: <effort>.   ← one-line reason if not the ledger default

Issue #NN: <title>. Read it in full first: gh issue view NN --comments

What and why: <2–5 lines; files you know are involved; your lead, marked "verify, don't trust">

Rules:
- Read AGENTS.md first. ⛔ No subagents. ⛔ Never use AskUserQuestion.
- Own worktree from a freshly fetched origin/main; branch feat|fix|chore|docs/issue-NN-slug.
  Never the primary checkout.
- Step 0: check the work isn't already done on main.
- PLAN GATE: investigate, then message me your plan and STOP until I reply "approved".
- Security: execFile only; never print the Antigravity token; never edit ~/deaddrop/.config.json
  or the live mailbox; tests use a temp DEADDROP_DIR. Real launcher calls: <none | N, titled
  "deaddrop-test: ignore">.
- Verify: npm test. Prove each new test fails without the fix. Report test counts per file you
  touched, before and after.
- PR body: "Closes #NN" only if fully done; else "Refs #NN" plus what's left.
- Blocked or unsure? Message Rook (session id local_<uuid>) and keep doing what doesn't depend on it.

Report back with the PR link.
```

Check your own session id at the moment you write the brief.

### 3.5 Review gate
1. Fetch the PR head into a throwaway worktree under `worktrees/`, merge latest `origin/main`,
   symlink `node_modules`.
2. Run `npm test` yourself.
3. Compare test counts per file against `main` (`grep -c "assert" test/*.js` and the suite's
   "Testing …" lines). A green suite can hide deleted tests.
4. Revert the fix and confirm the new tests fail.
5. Read the diff against §1.1, for duplication, scope creep, closing keywords, and tool
   descriptions that other agents will read as instructions.
6. Not a draft; based on `main`, not stacked.
7. Remove the review worktree. Only then list it for the owner, with its risk in plain words.

### 3.6 Talking to the owner
- **The owner often reads only `## Action items`.** Anything she must know, decide or do goes
  there: numbered, only owner tasks, each readable on its own (what, why, options).
- Plain English, tables over code dumps. Link only merge-ready PRs, each with its risk.
- Routine next steps in an agreed workflow are stated, not asked.

---

## 4. Things that went wrong, so the rules exist
- Early on, the orchestrator spawned Sonnet build agents directly; the owner wanted another route.
  **Ask before changing who builds.**
- 2026-10-27: the orchestrator started an Opus planner for #25 without asking, reading "Opus for
  judgement work" as permission; the owner stopped it. **Only Haiku starts without a yes.**
- CI fails on billing, not code. **Run `npm test` locally.**
- The primary checkout's `main` was a merge behind `origin/main` while issues were being written
  against it. **Fetch before citing line numbers.**
- Resuming a background Claude session that is still running, or passing any flag on resume,
  starts a copy. **Wake = stop (only when idle) + bare resume.**
- Claude Code's auto-mode classifier blocked `agentapi` commands whose text was full of
  credential language. **Let Dead Drop's library resolve the session; don't hand-assemble it.**

---

## 5. Change log
- 2026-10-27: Created by Rook. Took plan → approve → build, the no-Sonnet rule, Haiku default,
  routing ledger and launcher table from Wren's playbook; added the Dead Drop security boundary,
  the "other orchestrators depend on this" rules, and the local-only test rule. Dropped Agreezo's
  migration ledger and production-database rules (no database here).
- 2026-10-27: Owner correction (#32): Opus needs her explicit yes per session, like Fable. Only
  Haiku starts without asking. Ledger Opus rows marked "(ask)".
