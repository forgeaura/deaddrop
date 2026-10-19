import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureDirectory } from "../lib/messages.js";
import { DEFAULT_CONFIG } from "../lib/settings-server.js";
import {
  resolveClaudeExecutable,
  compareSemver,
  stripAnsi,
  buildPromptWithPreamble,
  buildClaudeArgs,
  parseShortId,
  lookupSessionId,
  logSessionSpawn,
  startClaudeSession,
  formatExecError,
  DEFAULT_CLAUDE_ALLOWED_MODES,
  VALID_EFFORT_LEVELS
} from "../lib/claude-cli.js";

export async function runClaudeCliTests(testDir) {
  console.log("\n[Test 10] Claude CLI & start_session MCP Tool...");
  const claudeTestDir = path.join(testDir, "claude-cli-test");
  ensureDirectory(claudeTestDir);

  // 10a: compareSemver tests
  console.log("  Testing compareSemver...");
  assert.ok(compareSemver("2.1.299", "2.1.99") > 0);
  assert.ok(compareSemver("2.1.99", "2.1.299") < 0);
  assert.equal(compareSemver("2.1.299", "2.1.299"), 0);
  assert.ok(compareSemver("2.2.0", "2.1.299") > 0);
  assert.ok(compareSemver("3.0.0", "2.9.9") > 0);

  // 10b: resolveClaudeExecutable precedence
  console.log("  Testing resolveClaudeExecutable precedence...");
  // 1. env var wins
  const customEnvPath = "/custom/env/bin/claude";
  const resEnv = resolveClaudeExecutable({
    env: { DEADDROP_CLAUDE_PATH: customEnvPath },
    agentConfig: { cli_path: "/config/path" }
  });
  assert.equal(resEnv, customEnvPath);

  // 2. config cli_path wins when env unset
  const customConfigPath = "/config/claude/bin";
  const resConfig = resolveClaudeExecutable({
    env: {},
    agentConfig: { cli_path: customConfigPath }
  });
  assert.equal(resConfig, customConfigPath);

  // 3. PATH manual walking (without shelling out to which)
  const mockBinDir = path.join(claudeTestDir, "mock-bin");
  ensureDirectory(mockBinDir);
  const mockClaudeOnPath = path.join(mockBinDir, "claude");
  fs.writeFileSync(mockClaudeOnPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const resPath = resolveClaudeExecutable({
    env: { PATH: `/usr/bin:${mockBinDir}:/bin` },
    agentConfig: {}
  });
  assert.equal(resPath, mockClaudeOnPath);

  // 4. Desktop bundle directory scanning with semver sorting
  const mockAppSupport = path.join(claudeTestDir, "mock-app-support");
  const v2_1_99 = path.join(mockAppSupport, "Library", "Application Support", "Claude", "claude-code", "2.1.99", "hash1", "claude.app", "Contents", "MacOS");
  const v2_1_299 = path.join(mockAppSupport, "Library", "Application Support", "Claude", "claude-code", "2.1.299", "hash2", "claude.app", "Contents", "MacOS");
  ensureDirectory(v2_1_99);
  ensureDirectory(v2_1_299);

  const oldBinary = path.join(v2_1_99, "claude");
  const newBinary = path.join(v2_1_299, "claude");
  const linuxSibling = path.join(v2_1_299, "claude-code-vm");
  fs.writeFileSync(oldBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(newBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(linuxSibling, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const resBundle = resolveClaudeExecutable({
    env: { PATH: "" },
    homeDir: mockAppSupport,
    agentConfig: {}
  });
  assert.equal(resBundle, newBinary, "Must pick newest semver-sorted bundle executable and ignore old versions");

  // 5. Throws clear error when not found
  assert.throws(
    () => resolveClaudeExecutable({ env: { PATH: "" }, homeDir: path.join(claudeTestDir, "empty-home"), agentConfig: {} }),
    /Claude Code CLI executable not found/
  );

  // 10c: buildPromptWithPreamble & buildClaudeArgs
  console.log("  Testing buildPromptWithPreamble and buildClaudeArgs...");
  const promptText = "Please write a test";
  const fullPrompt = buildPromptWithPreamble({ prompt: promptText, from: "juno" });
  assert.ok(fullPrompt.includes("[Started via Dead Drop by juno."));
  assert.ok(fullPrompt.includes("Actions requiring Sarah's decision"));
  assert.ok(fullPrompt.endsWith(promptText));

  const cliArgs = buildClaudeArgs({
    name: "test-sess",
    model: "sonnet",
    effort: "medium",
    permissionMode: "auto",
    fullPrompt
  });
  assert.deepEqual(cliArgs, [
    "--bg",
    "-n",
    "test-sess",
    "--model",
    "sonnet",
    "--effort",
    "medium",
    "--permission-mode",
    "auto",
    fullPrompt
  ]);

  // 10d: Flag injection checks in startClaudeSession
  console.log("  Testing flag injection guardrails...");
  await assert.rejects(
    async () => startClaudeSession({ folder: claudeTestDir, prompt: "hi", name: "-flagInjection" }),
    /Invalid session name '-flagInjection'/
  );
  await assert.rejects(
    async () => startClaudeSession({ folder: claudeTestDir, prompt: "hi", name: "" }),
    /Invalid session name ''/
  );
  await assert.rejects(
    async () => startClaudeSession({ folder: claudeTestDir, prompt: "hi", model: "--inject-flag" }),
    /Invalid model '--inject-flag'/
  );
  await assert.rejects(
    async () => startClaudeSession({ folder: claudeTestDir, prompt: "hi", effort: "extreme" }),
    /Invalid effort 'extreme'/
  );

  // 10e: Folder validation in startClaudeSession (lives in library)
  console.log("  Testing folder validation in library...");
  await assert.rejects(
    async () => startClaudeSession({ folder: "./relative-path", prompt: "hi" }),
    /folder must be an absolute path/
  );
  await assert.rejects(
    async () => startClaudeSession({ folder: "/non/existent/path/for/deaddrop/test", prompt: "hi" }),
    /folder does not exist/
  );
  const regularFilePath = path.join(claudeTestDir, "not-a-dir.txt");
  fs.writeFileSync(regularFilePath, "file content");
  await assert.rejects(
    async () => startClaudeSession({ folder: regularFilePath, prompt: "hi" }),
    /folder is not a directory/
  );

  // 10f: Permission guardrails in startClaudeSession
  console.log("  Testing permission guardrails in library...");
  // bypassPermissions rejected by default
  await assert.rejects(
    async () => startClaudeSession({
      folder: claudeTestDir,
      prompt: "hi",
      permissionMode: "bypassPermissions",
      config: DEFAULT_CONFIG
    }),
    /Permission mode 'bypassPermissions' is not allowed/
  );

  // Arbitrary unallowed mode rejected
  await assert.rejects(
    async () => startClaudeSession({
      folder: claudeTestDir,
      prompt: "hi",
      permissionMode: "yolo",
      config: DEFAULT_CONFIG
    }),
    /Permission mode 'yolo' is not allowed/
  );

  // bypassPermissions permitted when configured
  let mockExecCalled = false;
  const mockExecFileSuccess = (file, args, opts, cb) => {
    mockExecCalled = true;
    assert.equal(opts.cwd, claudeTestDir);
    assert.equal(opts.timeout, 60000);
    assert.equal(opts.maxBuffer, 10 * 1024 * 1024);
    cb(null, "backgrounded · 1234abcd · test-name\n", "");
  };

  const allowedBypassConfig = {
    agents: {
      claude: {
        allowed_permission_modes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
        default_model: "sonnet",
        default_permission_mode: "auto"
      }
    }
  };

  const resBypass = await startClaudeSession({
    folder: claudeTestDir,
    prompt: "test bypass",
    permissionMode: "bypassPermissions",
    config: allowedBypassConfig,
    execFileFn: mockExecFileSuccess,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });
  assert.equal(mockExecCalled, true);
  assert.equal(resBypass.permissionMode, "bypassPermissions");
  assert.equal(resBypass.id, "1234abcd");

  // 10g: parseShortId with ANSI and service startup lines
  console.log("  Testing parseShortId with ANSI and service startup lines...");
  const plainOut = "backgrounded · 7a8b9c0d · my-session";
  assert.equal(parseShortId(plainOut), "7a8b9c0d");

  const multiLineOut = "Starting background service…\nConnected to server.\nbackgrounded · e4f5a6b7 · my-session\nDone.";
  assert.equal(parseShortId(multiLineOut), "e4f5a6b7");

  const ansiOut = "\u001b[32mStarting background service…\u001b[0m\n\u001b[1mbackgrounded · a9b8c7d6 · my-session\u001b[0m";
  assert.equal(parseShortId(ansiOut), "a9b8c7d6");

  assert.throws(() => parseShortId("No session started"), /Failed to parse short session ID/);

  // 10h: lookupSessionId and retry logic
  console.log("  Testing lookupSessionId and retries (10 tries x 500ms)...");
  let lookupAttempts = 0;
  const mockLookupExec = (file, args, opts, cb) => {
    lookupAttempts++;
    assert.deepEqual(args, ["agents", "--json", "--all"]);
    assert.equal(opts.timeout, 15000);
    assert.equal(opts.maxBuffer, 10 * 1024 * 1024);
    if (lookupAttempts === 1) {
      // First try: session not listed yet
      cb(null, "[]", "");
    } else {
      // Second try: session is present
      cb(null, JSON.stringify([
        { id: "e4f5a6b7", sessionId: "uuid-9999-8888-7777", name: "my-session" }
      ]), "");
    }
  };

  const foundUuid = await lookupSessionId({
    claudeExec: "/fake/claude",
    cwd: claudeTestDir,
    shortId: "e4f5a6b7",
    name: "my-session",
    maxRetries: 5,
    retryDelayMs: 10,
    execFileFn: mockLookupExec,
    sleepFn: async () => {}
  });
  assert.equal(foundUuid, "uuid-9999-8888-7777");
  assert.equal(lookupAttempts, 2, "lookupSessionId should have succeeded on 2nd attempt");

  // When retry exhausts, returns null
  const exhaustedLookup = await lookupSessionId({
    claudeExec: "/fake/claude",
    cwd: claudeTestDir,
    shortId: "missing-id",
    maxRetries: 3,
    retryDelayMs: 10,
    execFileFn: (file, args, opts, cb) => cb(null, "[]", ""),
    sleepFn: async () => {}
  });
  assert.equal(exhaustedLookup, null, "lookupSessionId should return null when exhausted");

  // 10i: CLI error formatting and diagnosability (Issue #18 lesson)
  console.log("  Testing CLI error formatting and diagnosability...");
  const mockErr = new Error("Command failed");
  mockErr.code = 1;
  const formattedErr = formatExecError(mockErr, "some output", "Workspace not trusted: /not/trusted");
  assert.ok(formattedErr.includes("Workspace not trusted"));
  assert.ok(formattedErr.includes("code: 1"));
  assert.ok(formattedErr.includes("stderr:"));
  assert.ok(formattedErr.includes("stdout:"));

  const mockExecFail = (file, args, opts, cb) => {
    const err = new Error("Command failed: claude --bg");
    err.code = 1;
    cb(err, "", "Workspace not trusted");
  };

  await assert.rejects(
    async () => startClaudeSession({
      folder: claudeTestDir,
      prompt: "test error",
      config: DEFAULT_CONFIG,
      execFileFn: mockExecFail,
      claudeExec: "/fake/claude"
    }),
    (err) => {
      assert.ok(err.message.includes("Workspace not trusted"));
      assert.ok(err.message.includes("exit code / error code: 1"));
      return true;
    }
  );

  // 10j: .sessions.jsonl logging
  console.log("  Testing .sessions.jsonl logging...");
  const logMailboxDir = path.join(claudeTestDir, "mailbox-log");
  ensureDirectory(logMailboxDir);

  const mockExecLogging = (file, args, opts, cb) => {
    if (args[0] === "--bg") {
      cb(null, "backgrounded · feedbeef · test-logged-session\n", "");
    } else {
      cb(null, JSON.stringify([{ id: "feedbeef", sessionId: "uuid-logged-1234" }]), "");
    }
  };

  const sessionRes = await startClaudeSession({
    folder: claudeTestDir,
    prompt: "Log me please",
    name: "test-logged-session",
    model: "sonnet",
    effort: "high",
    permissionMode: "auto",
    from: "juno",
    deaddropDir: logMailboxDir,
    config: DEFAULT_CONFIG,
    execFileFn: mockExecLogging,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });

  assert.equal(sessionRes.id, "feedbeef");
  assert.equal(sessionRes.sessionId, "uuid-logged-1234");

  const sessionsLogFile = path.join(logMailboxDir, ".sessions.jsonl");
  assert.ok(fs.existsSync(sessionsLogFile), ".sessions.jsonl must exist");
  const logLines = fs.readFileSync(sessionsLogFile, "utf8").trim().split("\n");
  assert.equal(logLines.length, 1);
  const parsedLog = JSON.parse(logLines[0]);
  assert.equal(parsedLog.from, "juno");
  assert.equal(parsedLog.folder, claudeTestDir);
  assert.equal(parsedLog.name, "test-logged-session");
  assert.equal(parsedLog.model, "sonnet");
  assert.equal(parsedLog.effort, "high");
  assert.equal(parsedLog.permission_mode, "auto");
  assert.equal(parsedLog.id, "feedbeef");
  assert.equal(parsedLog.sessionId, "uuid-logged-1234");
  assert.ok(parsedLog.prompt.includes("[Started via Dead Drop by juno."));
  assert.ok(parsedLog.prompt.includes("Log me please"));

  // 10k: End-to-end MCP Client tool call start_session
  console.log("  Testing end-to-end MCP Client start_session...");
  const e2eMcpDir = path.join(claudeTestDir, "e2e-mcp");
  ensureDirectory(e2eMcpDir);

  // Create mock claude executable script (ensures zero real Claude CLI processes)
  const mockClaudeScript = path.join(e2eMcpDir, "mock_claude.sh");
  fs.writeFileSync(mockClaudeScript, `#!/bin/sh
if [ "$1" = "--bg" ]; then
  echo "Starting background service…"
  echo "backgrounded · 7f8a9b0c · $3"
  exit 0
elif [ "$1" = "agents" ] && [ "$2" = "--json" ] && [ "$3" = "--all" ]; then
  cat << 'JSONEOF'
[
  {
    "id": "7f8a9b0c",
    "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "mock-name",
    "cwd": "$PWD",
    "status": "idle",
    "pid": 99999
  }
]
JSONEOF
  exit 0
else
  echo "Unknown command: $@" >&2
  exit 1
fi
`, { mode: 0o755 });

  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "index.js"), "--agent=claude"],
    env: {
      ...process.env,
      DEADDROP_DIR: e2eMcpDir,
      DEADDROP_CLAUDE_PATH: mockClaudeScript
    }
  });

  const mcpClient = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);

  try {
    // Successful start_session call
    const startRes = await mcpClient.callTool({
      name: "start_session",
      arguments: {
        folder: claudeTestDir,
        prompt: "Start my background task",
        name: "mcp-test-session",
        model: "sonnet",
        effort: "medium",
        permission_mode: "auto"
      }
    });

    assert.equal(startRes.isError, undefined);
    const text = startRes.content[0].text;
    assert.ok(text.includes("Started Claude Code session 'mcp-test-session'"));
    assert.ok(text.includes("ID: 7f8a9b0c"));
    assert.ok(text.includes("Model: sonnet"));
    assert.ok(text.includes("Session ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
    assert.ok(text.includes("claude://resume?session=a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
    assert.ok(text.includes("claude agents --json --all"));

    // Verify sessions.jsonl created by MCP tool call
    const mcpLogFile = path.join(e2eMcpDir, ".sessions.jsonl");
    assert.ok(fs.existsSync(mcpLogFile));
    const mcpLogData = JSON.parse(fs.readFileSync(mcpLogFile, "utf8").trim());
    assert.equal(mcpLogData.id, "7f8a9b0c");
    assert.equal(mcpLogData.sessionId, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");

    // Rejected permission_mode call
    const rejectRes = await mcpClient.callTool({
      name: "start_session",
      arguments: {
        folder: claudeTestDir,
        prompt: "Unsafe task",
        permission_mode: "bypassPermissions"
      }
    });
    assert.equal(rejectRes.isError, true);
    assert.ok(rejectRes.content[0].text.includes("Permission mode 'bypassPermissions' is not allowed"));
  } finally {
    await mcpClient.close();
  }

  console.log("✓ All Claude CLI & start_session MCP Tool tests passed");
}
