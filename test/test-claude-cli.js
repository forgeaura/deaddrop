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
  buildDesktopBootstrapPrompt,
  waitForSessionIdle,
  buildClaudeArgs,
  parseShortId,
  lookupSessionId,
  logSessionSpawn,
  startClaudeSession,
  formatExecError,
  DEFAULT_CLAUDE_ALLOWED_MODES,
  VALID_EFFORT_LEVELS,
  VALID_HANDOFF_MODES
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

  // 10c: buildPromptWithPreamble, buildDesktopBootstrapPrompt & buildClaudeArgs
  console.log("  Testing buildPromptWithPreamble, buildDesktopBootstrapPrompt, and buildClaudeArgs...");
  const promptText = "Please write a test";
  const fullPrompt = buildPromptWithPreamble({ prompt: promptText, from: "juno" });
  assert.ok(fullPrompt.includes("[Started via Dead Drop by juno."));
  assert.ok(fullPrompt.includes("Actions requiring Sarah's decision"));
  assert.ok(fullPrompt.endsWith(promptText));

  // Bootstrap prompt without caller prompt
  const bootstrapNoPrompt = buildDesktopBootstrapPrompt({ from: "juno" });
  assert.ok(bootstrapNoPrompt.includes("[Started via Dead Drop by juno."));
  assert.ok(bootstrapNoPrompt.includes("You were created by juno via Dead Drop. Your task will arrive as the next message. Reply with one line: READY. Use no tools."));
  assert.ok(!bootstrapNoPrompt.includes("Context (do not act on it yet):"));

  // Bootstrap prompt with caller prompt context
  const bootstrapWithPrompt = buildDesktopBootstrapPrompt({ prompt: "Refactor database queries", from: "juno" });
  assert.ok(bootstrapWithPrompt.includes("[Started via Dead Drop by juno."));
  assert.ok(bootstrapWithPrompt.includes("You were created by juno via Dead Drop. Your task will arrive as the next message. Reply with one line: READY. Use no tools."));
  assert.ok(bootstrapWithPrompt.includes("Context (do not act on it yet):\nRefactor database queries"));

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
  await assert.rejects(
    async () => startClaudeSession({ folder: claudeTestDir, prompt: "hi", handoff: "invalid_mode" }),
    /Invalid handoff mode 'invalid_mode'/
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
    if (args[0] === "--bg") {
      assert.equal(opts.cwd, claudeTestDir);
      assert.equal(opts.timeout, 60000);
      assert.equal(opts.maxBuffer, 10 * 1024 * 1024);
      cb(null, "backgrounded · 1234abcd · test-name\n", "");
    } else {
      cb(null, "[]", "");
    }
  };

  const allowedBypassConfig = {
    agents: {
      claude: {
        allowed_permission_modes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
        default_model: "sonnet",
        default_permission_mode: "auto",
        default_handoff: "background"
      }
    }
  };

  const resBypass = await startClaudeSession({
    folder: claudeTestDir,
    prompt: "test bypass",
    permissionMode: "bypassPermissions",
    handoff: "background",
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

  // 10h: lookupSessionId and retry logic (strictly matches short id only)
  console.log("  Testing lookupSessionId and retries (10 tries x 500ms)...");
  let lookupAttempts = 0;
  const mockLookupExec = (file, args, opts, cb) => {
    lookupAttempts++;
    assert.deepEqual(args, ["agents", "--json", "--all"]);
    assert.equal(opts.timeout, 15000);
    assert.equal(opts.maxBuffer, 10 * 1024 * 1024);
    if (lookupAttempts === 1) {
      cb(null, "[]", "");
    } else {
      cb(null, JSON.stringify([
        { id: "e4f5a6b7", sessionId: "uuid-9999-8888-7777", name: "my-session" }
      ]), "");
    }
  };

  const foundUuid = await lookupSessionId({
    claudeExec: "/fake/claude",
    cwd: claudeTestDir,
    shortId: "e4f5a6b7",
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

  // Must match on short id only: ignore older session with same name listed first
  console.log("  Testing lookupSessionId matches on short id only (ignores duplicate name listed first)...");
  const mockDuplicateNameExec = (file, args, opts, cb) => {
    cb(null, JSON.stringify([
      { id: "old11111", sessionId: "uuid-old-wrong-session", name: "worker" },
      { id: "new22222", sessionId: "uuid-new-correct-session", name: "worker" }
    ]), "");
  };

  const matchedById = await lookupSessionId({
    claudeExec: "/fake/claude",
    cwd: claudeTestDir,
    shortId: "new22222",
    maxRetries: 1,
    execFileFn: mockDuplicateNameExec,
    sleepFn: async () => {}
  });
  assert.equal(matchedById, "uuid-new-correct-session", "Must match on short id and not hit older session with same name");

  // 10i: waitForSessionIdle unit test
  console.log("  Testing waitForSessionIdle...");
  let waitPollCount = 0;
  const mockWaitExec = (file, args, opts, cb) => {
    waitPollCount++;
    if (waitPollCount === 1) {
      cb(null, JSON.stringify([{ id: "idle123", status: "busy", sessionId: "sess-1" }]), "");
    } else {
      cb(null, JSON.stringify([{ id: "idle123", status: "idle", sessionId: "sess-1" }]), "");
    }
  };
  const isNowIdle = await waitForSessionIdle({
    claudeExec: "/fake/claude",
    cwd: claudeTestDir,
    shortId: "idle123",
    maxWaitRetries: 5,
    waitDelayMs: 10,
    execFileFn: mockWaitExec,
    sleepFn: async () => {}
  });
  assert.equal(isNowIdle, true);
  assert.equal(waitPollCount, 2);

  // Timeout returns false
  const timedOutIdle = await waitForSessionIdle({
    claudeExec: "/fake/claude",
    cwd: claudeTestDir,
    shortId: "idle123",
    maxWaitRetries: 2,
    waitDelayMs: 10,
    execFileFn: (f, a, o, cb) => cb(null, JSON.stringify([{ id: "idle123", status: "busy", sessionId: "sess-1" }]), ""),
    sleepFn: async () => {}
  });
  assert.equal(timedOutIdle, false);

  // 10j: Desktop handoff: idle -> stop -> open (Darwin, success)
  console.log("  Testing Desktop handoff: idle -> stop -> open...");
  const recordedCommands = [];
  const mockExecDesktopSuccess = (file, args, opts, cb) => {
    recordedCommands.push({ file, args });
    if (file === "open" || file === "/mock/open") {
      return cb(null, "", "");
    }
    if (args[0] === "--bg") {
      return cb(null, "backgrounded · handoff1 · desktop-session\n", "");
    }
    if (args[0] === "agents") {
      return cb(null, JSON.stringify([
        { id: "handoff1", sessionId: "uuid-handoff-1111", status: "idle" }
      ]), "");
    }
    if (args[0] === "stop") {
      assert.equal(args[1], "handoff1");
      return cb(null, "Stopped session handoff1\n", "");
    }
    cb(new Error(`Unexpected command: ${file} ${args}`));
  };

  const handoffSuccessRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    name: "desktop-session",
    platform: "darwin",
    config: DEFAULT_CONFIG,
    execFileFn: mockExecDesktopSuccess,
    sleepFn: async () => {},
    claudeExec: "/fake/claude",
    env: { DEADDROP_OPEN_BIN: "/mock/open" }
  });

  assert.equal(handoffSuccessRes.outcome, "handed_off");
  assert.equal(handoffSuccessRes.desktopId, "local_uuid-handoff-1111");
  assert.equal(handoffSuccessRes.sessionId, "uuid-handoff-1111");

  // Verify stop and open were called
  const stopCall = recordedCommands.find((c) => c.args && c.args[0] === "stop");
  assert.ok(stopCall, "claude stop must be called");
  assert.equal(stopCall.args[1], "handoff1");

  const openCall = recordedCommands.find((c) => c.file === "/mock/open" || (c.args && c.args[0] === "claude://resume?session=uuid-handoff-1111"));
  assert.ok(openCall, "open claude://resume must be called");

  // 10k: Desktop handoff timeout (session never idle -> no stop, outcome: still_running)
  console.log("  Testing Desktop handoff timeout (no stop, still_running)...");
  const timeoutCommands = [];
  const mockExecTimeout = (file, args, opts, cb) => {
    timeoutCommands.push({ file, args });
    if (args[0] === "--bg") {
      return cb(null, "backgrounded · timeout1 · timeout-session\n", "");
    }
    if (args[0] === "agents") {
      return cb(null, JSON.stringify([
        { id: "timeout1", sessionId: "uuid-timeout-2222", status: "busy" }
      ]), "");
    }
    cb(new Error(`Unexpected command: ${file} ${args}`));
  };

  const timeoutRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    name: "timeout-session",
    platform: "darwin",
    config: DEFAULT_CONFIG,
    execFileFn: mockExecTimeout,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });

  assert.equal(timeoutRes.outcome, "still_running");
  assert.equal(timeoutRes.desktopId, null);
  assert.ok(!timeoutCommands.some((c) => c.args && c.args[0] === "stop"), "Must NOT stop session on timeout");

  // 10l: Pre-stop check: status went busy or sessionId changed between idle check and stop -> no stop
  console.log("  Testing Desktop handoff pre-stop guardrail (went busy right before stop)...");
  let preStopCheckAttempts = 0;
  const preStopCommands = [];
  const mockExecWentBusy = (file, args, opts, cb) => {
    preStopCommands.push({ file, args });
    if (args[0] === "--bg") {
      return cb(null, "backgrounded · busybeforestop · went-busy-session\n", "");
    }
    if (args[0] === "agents") {
      preStopCheckAttempts++;
      if (preStopCheckAttempts <= 2) {
        // First lookup and idle wait: return idle
        return cb(null, JSON.stringify([
          { id: "busybeforestop", sessionId: "uuid-busy-3333", status: "idle" }
        ]), "");
      } else {
        // Pre-stop re-read: status went busy!
        return cb(null, JSON.stringify([
          { id: "busybeforestop", sessionId: "uuid-busy-3333", status: "busy" }
        ]), "");
      }
    }
    cb(new Error(`Unexpected command: ${file} ${args}`));
  };

  const wentBusyRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    name: "went-busy-session",
    platform: "darwin",
    config: DEFAULT_CONFIG,
    execFileFn: mockExecWentBusy,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });

  assert.equal(wentBusyRes.outcome, "still_running");
  assert.equal(wentBusyRes.desktopId, null);
  assert.ok(!preStopCommands.some((c) => c.args && c.args[0] === "stop"), "Must NOT stop session if status went busy right before stop");

  // 10m: Desktop handoff on non-darwin (skip BOTH stop and open, report background)
  console.log("  Testing Desktop handoff on non-darwin (skip stop and open, background)...");
  const linuxCommands = [];
  const mockExecLinux = (file, args, opts, cb) => {
    linuxCommands.push({ file, args });
    if (args[0] === "--bg") {
      return cb(null, "backgrounded · linux1 · linux-session\n", "");
    }
    if (args[0] === "agents") {
      return cb(null, JSON.stringify([
        { id: "linux1", sessionId: "uuid-linux-4444", status: "idle" }
      ]), "");
    }
    cb(new Error(`Unexpected command: ${file} ${args}`));
  };

  const linuxRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    name: "linux-session",
    platform: "linux",
    config: DEFAULT_CONFIG,
    execFileFn: mockExecLinux,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });

  assert.equal(linuxRes.outcome, "background");
  assert.equal(linuxRes.desktopId, null);
  assert.ok(!linuxCommands.some((c) => c.args && c.args[0] === "stop"), "Must NOT stop session on non-darwin");
  assert.ok(!linuxCommands.some((c) => c.file === "open"), "Must NOT open on non-darwin");

  // 10n: Desktop handoff when sessionId is null (skip stop and open, report background)
  console.log("  Testing Desktop handoff when sessionId is null...");
  const noSessionIdCommands = [];
  const mockExecNoSessionId = (file, args, opts, cb) => {
    noSessionIdCommands.push({ file, args });
    if (args[0] === "--bg") {
      return cb(null, "backgrounded · nosess1 · no-sess-session\n", "");
    }
    if (args[0] === "agents") {
      return cb(null, "[]", ""); // session never found
    }
    cb(new Error(`Unexpected command: ${file} ${args}`));
  };

  const noSessionIdRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    name: "no-sess-session",
    platform: "darwin",
    config: DEFAULT_CONFIG,
    execFileFn: mockExecNoSessionId,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });

  assert.equal(noSessionIdRes.outcome, "background");
  assert.equal(noSessionIdRes.sessionId, null);
  assert.equal(noSessionIdRes.desktopId, null);
  assert.ok(!noSessionIdCommands.some((c) => c.args && c.args[0] === "stop"), "Must NOT stop session when sessionId is null");

  // 10o: Desktop handoff open failure after successful stop (stopped_not_opened)
  console.log("  Testing Desktop handoff open failure (stopped_not_opened)...");
  const mockExecOpenFails = (file, args, opts, cb) => {
    if (file === "open" || file === "/mock/open") {
      return cb(new Error("No application is registered to open this URL"));
    }
    if (args[0] === "--bg") {
      return cb(null, "backgrounded · openfail1 · openfail-session\n", "");
    }
    if (args[0] === "agents") {
      return cb(null, JSON.stringify([
        { id: "openfail1", sessionId: "uuid-openfail-5555", status: "idle" }
      ]), "");
    }
    if (args[0] === "stop") {
      return cb(null, "Stopped session openfail1\n", "");
    }
    cb(new Error(`Unexpected command: ${file} ${args}`));
  };

  const openFailRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    name: "openfail-session",
    platform: "darwin",
    config: DEFAULT_CONFIG,
    execFileFn: mockExecOpenFails,
    sleepFn: async () => {},
    claudeExec: "/fake/claude",
    env: { DEADDROP_OPEN_BIN: "/mock/open" }
  });

  assert.equal(openFailRes.outcome, "stopped_not_opened");
  assert.equal(openFailRes.desktopId, "local_uuid-openfail-5555");
  assert.equal(openFailRes.sessionId, "uuid-openfail-5555");

  // 10p: Background mode requires prompt; desktop mode allows omitted prompt
  console.log("  Testing prompt requirements for background vs desktop handoff...");
  await assert.rejects(
    async () => startClaudeSession({
      folder: claudeTestDir,
      handoff: "background",
      config: DEFAULT_CONFIG
    }),
    /Missing required parameter: 'prompt' \(required when handoff is 'background'\)/
  );

  // Desktop mode with omitted prompt succeeds
  const desktopNoPromptRes = await startClaudeSession({
    folder: claudeTestDir,
    handoff: "desktop",
    platform: "linux", // test on linux to skip idle wait
    config: DEFAULT_CONFIG,
    execFileFn: (file, args, opts, cb) => {
      if (args[0] === "--bg") return cb(null, "backgrounded · noprompt1 · noprompt-session\n", "");
      if (args[0] === "agents") return cb(null, JSON.stringify([{ id: "noprompt1", sessionId: "uuid-noprompt" }]), "");
    },
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });
  assert.equal(desktopNoPromptRes.id, "noprompt1");

  // 10q: CLI error formatting and diagnosability (Issue #18 lesson)
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

  // 10r: .sessions.jsonl logging with handoff and outcome
  console.log("  Testing .sessions.jsonl logging with handoff and outcome...");
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
    handoff: "background",
    from: "juno",
    deaddropDir: logMailboxDir,
    config: DEFAULT_CONFIG,
    execFileFn: mockExecLogging,
    sleepFn: async () => {},
    claudeExec: "/fake/claude"
  });

  assert.equal(sessionRes.id, "feedbeef");
  assert.equal(sessionRes.sessionId, "uuid-logged-1234");
  assert.equal(sessionRes.handoff, "background");
  assert.equal(sessionRes.outcome, "background");

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
  assert.equal(parsedLog.handoff, "background");
  assert.equal(parsedLog.outcome, "background");
  assert.equal(parsedLog.id, "feedbeef");
  assert.equal(parsedLog.sessionId, "uuid-logged-1234");
  assert.ok(parsedLog.prompt.includes("[Started via Dead Drop by juno."));
  assert.ok(parsedLog.prompt.includes("Log me please"));

  // 10s: End-to-end MCP Client tool call start_session in desktop mode
  console.log("  Testing end-to-end MCP Client start_session in desktop mode...");
  const e2eMcpDir = path.join(claudeTestDir, "e2e-mcp");
  ensureDirectory(e2eMcpDir);

  // Create mock claude executable script
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
elif [ "$1" = "stop" ]; then
  echo "Stopped session $2"
  exit 0
else
  echo "Unknown command: $@" >&2
  exit 1
fi
`, { mode: 0o755 });

  const mockOpenScript = path.join(e2eMcpDir, "mock_open.sh");
  fs.writeFileSync(mockOpenScript, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "index.js"), "--agent=claude"],
    env: {
      ...process.env,
      DEADDROP_DIR: e2eMcpDir,
      DEADDROP_CLAUDE_PATH: mockClaudeScript,
      DEADDROP_OPEN_BIN: mockOpenScript
    }
  });

  const mcpClient = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);

  try {
    // Successful start_session call (defaults to desktop handoff)
    const startRes = await mcpClient.callTool({
      name: "start_session",
      arguments: {
        folder: claudeTestDir,
        name: "mcp-desktop-session",
        model: "sonnet",
        effort: "medium",
        permission_mode: "auto"
      }
    });

    assert.equal(startRes.isError, undefined);
    const text = startRes.content[0].text;
    assert.ok(text.includes("Started Claude Code session 'mcp-desktop-session'"));
    assert.ok(text.includes("ID: 7f8a9b0c"));
    assert.ok(text.includes("Desktop session ID: local_a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
    assert.ok(text.includes('To give it the task so it runs live in the desktop app, call the desktop app\'s send_message tool with session_id "local_a1b2c3d4-e5f6-7890-abcd-ef1234567890" and your task as the message. If you don\'t have that tool, call start_session again with handoff: "background".'));

    // Verify sessions.jsonl created by MCP tool call
    const mcpLogFile = path.join(e2eMcpDir, ".sessions.jsonl");
    assert.ok(fs.existsSync(mcpLogFile));
    const mcpLogData = JSON.parse(fs.readFileSync(mcpLogFile, "utf8").trim());
    assert.equal(mcpLogData.id, "7f8a9b0c");
    assert.equal(mcpLogData.sessionId, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    assert.equal(mcpLogData.handoff, "desktop");
    assert.equal(mcpLogData.outcome, "handed_off");

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

    // Background handoff requiring prompt
    const noPromptBgRes = await mcpClient.callTool({
      name: "start_session",
      arguments: {
        folder: claudeTestDir,
        handoff: "background"
      }
    });
    assert.equal(noPromptBgRes.isError, true);
    assert.ok(noPromptBgRes.content[0].text.includes("Missing required parameter: 'prompt'"));
  } finally {
    await mcpClient.close();
  }

  console.log("✓ All Claude CLI & start_session MCP Tool tests passed");
}
