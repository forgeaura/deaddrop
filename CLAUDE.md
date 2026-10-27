@AGENTS.md

# Claude Code only
- Never use AskUserQuestion. It opens a dialog in Sarah's window and blocks your session until she
  answers, and messages from the orchestrator queue behind it unread.
- Never use the Agent tool to spawn subagents. Ask the orchestrator for another session instead.
- To ask the orchestrator a question: write it as plain text in your reply and stop. Also send it
  with your cross-session message tool (SendMessage to the session id your brief names).
