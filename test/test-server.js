import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  normalizeReIssue,
  generateFilename,
  formatLocalISO,
  ensureDirectory,
  sendMessage,
  readMessages,
  markRead,
  wakeAgentIfTargeted,
  getAgentapiExecutable,
  AUTHORITY_NOTICE,
  resolveAntigravitySession,
  isPidAlive,
  SESSION_FILENAME
} from "../lib/messages.js";
import { exportSession, cleanupSession, reconcileSession, getSessionFilePath } from "../bin/sidecar.js";
import { setupSidecar } from "../scripts/setup-sidecar.js";
import { startSettingsServer, loadConfig, saveConfig, DEFAULT_CONFIG } from "../lib/settings-server.js";
import { runClaudeCliTests } from "./test-claude-cli.js";
import { runAntigravityTests } from "./test-antigravity.js";

async function runTests() {
  console.log("=== Starting Dead Drop Test Suite ===");

  const testDir = path.join(os.tmpdir(), `deaddrop-test-${Date.now()}`);
  ensureDirectory(testDir);
  console.log(`[Setup] Using isolated test directory: ${testDir}`);

  try {
    // Test 1: normalizeReIssue
    console.log("\n[Test 1] normalizeReIssue requirements...");
    assert.equal(normalizeReIssue(2140), "2140");
    assert.equal(normalizeReIssue("2140"), "2140");
    assert.equal(normalizeReIssue("#2140"), "#2140");
    assert.equal(normalizeReIssue("custom/repo#55"), "custom/repo#55");
    assert.equal(normalizeReIssue(null), null);
    assert.equal(normalizeReIssue(""), null);
    assert.equal(normalizeReIssue(undefined), null);
    console.log("✓ normalizeReIssue passed");

    // Test 2: generateFilename
    console.log("\n[Test 2] generateFilename formatting...");
    const testDate = new Date("2026-09-21T14:30:15");
    const fn = generateFilename(testDate, "claude", "antigravity", "API Review & Notes!");
    assert.match(fn, /^2026-09-21_143015_claude_to_antigravity_api-review-notes\.md$/);
    console.log(`✓ generateFilename passed: ${fn}`);

    // Test 3: sendMessage without wake (to claude)
    console.log("\n[Test 3] sendMessage to claude...");
    const msg1 = await sendMessage({
      to: "claude",
      subject: "Refactor API endpoint logic",
      body: "Please review the updated recommendation endpoint logic.",
      re_issue: 2140,
      from: "antigravity",
      deaddropDir: testDir
    });

    assert.ok(fs.existsSync(msg1.filePath));
    const fileContent = fs.readFileSync(msg1.filePath, "utf8");
    assert.ok(fileContent.includes("from: antigravity"));
    assert.ok(fileContent.includes("to: claude"));
    assert.ok(fileContent.includes('re_issue: "2140"'));
    assert.ok(fileContent.includes("read: false"));
    assert.ok(fileContent.includes("Please review the updated recommendation endpoint logic."));
    console.log(`✓ sendMessage to claude created file: ${msg1.filename}`);

    // Test 4: readMessages
    console.log("\n[Test 4] readMessages with filtering...");
    const claudeUnread = readMessages({
      for: "claude",
      unread_only: true,
      deaddropDir: testDir
    });
    assert.equal(claudeUnread.length, 1);
    assert.equal(claudeUnread[0].id, msg1.id);
    assert.equal(claudeUnread[0].re_issue, "2140");
    console.log(`✓ readMessages for claude found 1 unread message`);

    const antigravityMsgs = readMessages({
      for: "antigravity",
      unread_only: true,
      deaddropDir: testDir
    });
    assert.equal(antigravityMsgs.length, 0);
    console.log(`✓ readMessages for antigravity correctly found 0 messages`);

    // Test 5: markRead
    console.log("\n[Test 5] markRead functionality...");
    const markRes = markRead({
      id: msg1.id,
      deaddropDir: testDir
    });
    assert.equal(markRes.read, true);

    const claudeUnreadAfter = readMessages({
      for: "claude",
      unread_only: true,
      deaddropDir: testDir
    });
    assert.equal(claudeUnreadAfter.length, 0);

    const claudeAllAfter = readMessages({
      for: "claude",
      unread_only: false,
      deaddropDir: testDir
    });
    assert.equal(claudeAllAfter.length, 1);
    assert.equal(claudeAllAfter[0].read, true);
    assert.ok(claudeAllAfter[0].read_at !== null);
    console.log(`✓ markRead successfully marked message read`);

    // Test 5b: markRead rejects path traversal ids
    console.log("\n[Test 5b] markRead rejects path traversal ids...");
    const traversalTargetPath = path.join(os.tmpdir(), "evil.md");
    // Ensure a plausible traversal target does NOT exist beforehand, and stays that way.
    if (fs.existsSync(traversalTargetPath)) {
      fs.unlinkSync(traversalTargetPath);
    }
    assert.throws(
      () => markRead({ id: "../../../../tmp/evil", deaddropDir: testDir }),
      /Invalid message id/,
      "markRead should throw on a path-traversal id"
    );
    assert.equal(
      fs.existsSync(traversalTargetPath),
      false,
      "markRead must not create a file outside deaddropDir"
    );
    // Also confirm nothing inside the isolated testDir was disturbed by the attempt.
    const filesInTestDirAfterTraversal = fs.readdirSync(testDir).filter((f) => f.endsWith(".md"));
    assert.equal(
      filesInTestDirAfterTraversal.length,
      1,
      "markRead traversal attempt should not add/remove files in testDir"
    );
    console.log(`✓ markRead rejected path traversal id and touched no file outside testDir`);

    // Test 6: wakeAgentIfTargeted (Missing config file)
    console.log("\n[Test 6] Wake mechanism: missing .config.json...");
    const wakeNoConfig = await wakeAgentIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test.md",
      deaddropDir: testDir
    });
    assert.equal(wakeNoConfig.woke, false);
    assert.ok(wakeNoConfig.reason.includes("not found"));
    console.log(`✓ Correctly handled missing .config.json without error or new conversation`);

    // Wake-gating tests (7-7f) get their own subdirectory, since some of them call
    // sendMessage and write real message files -- keeping those out of testDir avoids
    // polluting the antigravity mailbox that Test 8 later asserts is empty.
    const wakeTestDir = path.join(testDir, "wake-gating");
    ensureDirectory(wakeTestDir);
    const configPath = path.join(wakeTestDir, ".config.json");

    // Test 7: wakeAgentIfTargeted (Empty/invalid conversation ID, new per-agent shape)
    console.log("\n[Test 7] Wake mechanism: empty conversation ID under new agents shape...");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        antigravity: { wake_on_mail: true, wake_method: "agentapi", conversation_id: "" }
      }
    }), "utf8");

    const wakeEmptyId = await wakeAgentIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test.md",
      deaddropDir: wakeTestDir
    });
    assert.equal(wakeEmptyId.woke, false);
    assert.equal(wakeEmptyId.reason, "conversation_id missing or empty for agent 'antigravity'");
    console.log(`✓ Correctly handled empty conversation ID without creating conversation`);

    // Test 7b: getAgentapiExecutable precedence (env var > config file > default)
    console.log("\n[Test 7b] getAgentapiExecutable precedence...");
    delete process.env.DEADDROP_AGENTAPI_PATH;
    assert.equal(
      getAgentapiExecutable({ config: { agents: { antigravity: { agentapi_path: "/custom/path/to/agentapi" } } } }),
      "/custom/path/to/agentapi"
    );
    process.env.DEADDROP_AGENTAPI_PATH = "/env/path/to/agentapi";
    assert.equal(
      getAgentapiExecutable({ config: { agents: { antigravity: { agentapi_path: "/custom/path/to/agentapi" } } } }),
      "/env/path/to/agentapi"
    );
    delete process.env.DEADDROP_AGENTAPI_PATH;
    console.log("✓ getAgentapiExecutable prefers env var, then config, then default");

    // Test 7c: wake attempted when wake_on_mail is true with a valid conversation_id.
    // A stub agentapi fails the way the real one does (#18): exit 1, the reason as
    // JSON on stdout, nothing on stderr. The failure reason must come from *trying*
    // agentapi (not from being skipped for a config reason) and must carry
    // agentapi's own error text and exit code, without the session token.
    console.log("\n[Test 7c] Wake mechanism: wake attempted when wake_on_mail is true...");
    const failingAgentapi = path.join(wakeTestDir, "failing_agentapi.sh");
    fs.writeFileSync(failingAgentapi, `#!/bin/sh
printf '{\\n  "response": {},\\n  "error": "project_id is required when providing project_env_config (token %s)"\\n}\\n' "$ANTIGRAVITY_CSRF_TOKEN"
exit 1
`, { mode: 0o755 });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        antigravity: {
          wake_on_mail: true,
          wake_method: "agentapi",
          conversation_id: "conv-abc-123",
          agentapi_path: failingAgentapi
        }
      }
    }), "utf8");

    // Seed a valid mock session file so resolveAntigravitySession succeeds and allows
    // wakeViaAgentapi to proceed to the exec layer even when running outside Antigravity.
    const mockSessionPath = path.join(wakeTestDir, SESSION_FILENAME);
    const wakeSentinelToken = "wake-sentinel-token-7c";
    fs.writeFileSync(mockSessionPath, JSON.stringify({
      address: "localhost:12345",
      csrf_token: wakeSentinelToken,
      pid: process.pid
    }), { mode: 0o600 });

    const wakeAttempted = await wakeAgentIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test.md",
      deaddropDir: wakeTestDir
    });
    assert.ok(
      wakeAttempted.woke === true || /agentapi/i.test(wakeAttempted.reason || ""),
      `Expected a real wake attempt (success or agentapi-level failure), got: ${JSON.stringify(wakeAttempted)}`
    );
    assert.ok(!/wake_on_mail/.test(wakeAttempted.reason || ""));
    assert.ok(!/not configured/.test(wakeAttempted.reason || ""));
    // #18 regression: agentapi's stdout error and exit code are surfaced, the token is not
    assert.equal(wakeAttempted.woke, false);
    assert.match(wakeAttempted.reason, /project_id is required when providing project_env_config/);
    assert.match(wakeAttempted.reason, /exit code \/ error code: 1/);
    assert.ok(!wakeAttempted.reason.includes(wakeSentinelToken), "wake reason must not contain the session token");
    assert.match(wakeAttempted.reason, /<redacted>/);
    try { fs.unlinkSync(mockSessionPath); } catch {}
    console.log(`✓ Wake was attempted, and agentapi's stdout error and exit code are surfaced without the token`);

    // Test 7d: wake skipped (but message file still written) when wake_on_mail is false.
    console.log("\n[Test 7d] Wake mechanism: skipped when wake_on_mail is false...");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        antigravity: { wake_on_mail: false, wake_method: "agentapi", conversation_id: "conv-abc-123" }
      }
    }), "utf8");

    const msgWakeOff = await sendMessage({
      to: "antigravity",
      subject: "Should not wake",
      body: "wake_on_mail is false for this agent.",
      from: "claude",
      deaddropDir: wakeTestDir
    });
    assert.ok(fs.existsSync(msgWakeOff.filePath), "Message file should still be written when wake is skipped");
    assert.equal(msgWakeOff.wakeResult.woke, false);
    assert.match(msgWakeOff.wakeResult.reason, /wake_on_mail is false or unset for agent 'antigravity'/);
    console.log(`✓ Message written and wake correctly skipped with reason logged`);

    // Test 7e: wake skipped when the target agent isn't present in `agents` at all.
    console.log("\n[Test 7e] Wake mechanism: skipped when agent absent from agents map...");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        antigravity: { wake_on_mail: true, wake_method: "agentapi", conversation_id: "conv-abc-123" }
      }
    }), "utf8");

    const msgUnknownAgent = await sendMessage({
      to: "sarah",
      subject: "No agents entry",
      body: "sarah has no entry in the agents map.",
      from: "claude",
      deaddropDir: wakeTestDir
    });
    assert.ok(fs.existsSync(msgUnknownAgent.filePath), "Message file should still be written for an unconfigured agent");
    assert.equal(msgUnknownAgent.wakeResult.woke, false);
    assert.match(msgUnknownAgent.wakeResult.reason, /not configured in agents map/);
    console.log(`✓ Message written and wake correctly skipped for an agent absent from the agents map`);

    // Test 7f: wake skipped when wake_method is "unsupported" (e.g. Claude Code today),
    // even if wake_on_mail were somehow true -- there is no external wake mechanism for it.
    console.log("\n[Test 7f] Wake mechanism: skipped for wake_method 'unsupported'...");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        claude: { wake_on_mail: true, wake_method: "unsupported" }
      }
    }), "utf8");

    const wakeUnsupported = await wakeAgentIfTargeted({
      to: "claude",
      from: "antigravity",
      filename: "test.md",
      deaddropDir: wakeTestDir
    });
    assert.equal(wakeUnsupported.woke, false);
    assert.match(wakeUnsupported.reason, /not a supported external wake method/);
    console.log(`✓ Correctly declined to wake an agent with wake_method 'unsupported'`);
    // Test 7g: resolveAntigravitySession unit tests
    console.log("\n[Test 7g] resolveAntigravitySession unit tests...");
    const subSessionDir = path.join(testDir, "session-test");
    ensureDirectory(subSessionDir);

    // Save and clear env vars
    const origLs = process.env.ANTIGRAVITY_LS_ADDRESS;
    const origCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    // Missing file
    const resMissing = resolveAntigravitySession({ deaddropDir: subSessionDir });
    assert.equal(resMissing.valid, false);
    assert.equal(resMissing.error, "missing");
    assert.match(resMissing.reason, /npm run setup-sidecar/);

    // Unreadable / malformed file
    const sessionFile = path.join(subSessionDir, SESSION_FILENAME);
    fs.writeFileSync(sessionFile, "{ not valid json", "utf8");
    const resUnreadable = resolveAntigravitySession({ deaddropDir: subSessionDir });
    assert.equal(resUnreadable.valid, false);
    assert.equal(resUnreadable.error, "unreadable");

    // Invalid fields
    fs.writeFileSync(sessionFile, JSON.stringify({ address: "localhost:1234" }), "utf8");
    const resInvalid = resolveAntigravitySession({ deaddropDir: subSessionDir });
    assert.equal(resInvalid.valid, false);
    assert.equal(resInvalid.error, "invalid");

    // Stale PID
    fs.writeFileSync(sessionFile, JSON.stringify({
      address: "localhost:1234",
      csrf_token: "tok-123",
      pid: 999999999
    }), "utf8");
    const resStale = resolveAntigravitySession({ deaddropDir: subSessionDir });
    assert.equal(resStale.valid, false);
    assert.equal(resStale.error, "stale");
    assert.match(resStale.reason, /stale/);

    // Valid session file with current process PID (guaranteed alive)
    fs.writeFileSync(sessionFile, JSON.stringify({
      address: "localhost:57849",
      csrf_token: "csrf-abc-xyz",
      pid: process.pid
    }), "utf8");
    const resValid = resolveAntigravitySession({ deaddropDir: subSessionDir });
    assert.equal(resValid.valid, true);
    assert.equal(resValid.address, "localhost:57849");
    assert.equal(resValid.csrfToken, "csrf-abc-xyz");
    assert.equal(resValid.source, "session_file");

    // Env var override
    process.env.ANTIGRAVITY_LS_ADDRESS = "localhost:9999";
    process.env.ANTIGRAVITY_CSRF_TOKEN = "env-token-xyz";
    const resEnv = resolveAntigravitySession({ deaddropDir: subSessionDir });
    assert.equal(resEnv.valid, true);
    assert.equal(resEnv.address, "localhost:9999");
    assert.equal(resEnv.csrfToken, "env-token-xyz");
    assert.equal(resEnv.source, "env");

    // Restore env vars
    if (origLs) process.env.ANTIGRAVITY_LS_ADDRESS = origLs;
    else delete process.env.ANTIGRAVITY_LS_ADDRESS;
    if (origCsrf) process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf;
    else delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    console.log("✓ resolveAntigravitySession handled all states (missing, unreadable, invalid, stale, valid, env)");

    // Test 7h: sidecar exportSession and cleanupSession
    console.log("\n[Test 7h] sidecar exportSession and cleanupSession...");
    const sidecarTestDir = path.join(testDir, "sidecar-test");
    ensureDirectory(sidecarTestDir);

    const exported = exportSession({
      address: "localhost:57849",
      csrfToken: "tok-sidecar-1",
      deaddropDir: sidecarTestDir,
      pid: process.pid
    });
    assert.ok(exported);
    assert.equal(exported.address, "localhost:57849");
    assert.equal(exported.csrf_token, "tok-sidecar-1");

    const exportedFile = getSessionFilePath(sidecarTestDir);
    assert.ok(fs.existsSync(exportedFile));
    const stat = fs.statSync(exportedFile);
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    }

    cleanupSession(sidecarTestDir);
    assert.ok(!fs.existsSync(exportedFile));
    console.log("✓ sidecar exportSession writes 0600 file and cleanupSession removes it");

    // Test 7h2: sidecar exports the project id, and heals its own file that lacks it
    console.log("\n[Test 7h2] sidecar exports project_id and heals a file without it...");
    const projectSidecarDir = path.join(testDir, "sidecar-project-test");
    ensureDirectory(projectSidecarDir);
    const savedProjectEnv = process.env.ANTIGRAVITY_PROJECT_ID;
    delete process.env.ANTIGRAVITY_PROJECT_ID;

    // An older sidecar wrote this file for our pid, without project_id
    exportSession({ address: "localhost:57850", csrfToken: "tok-sidecar-2", deaddropDir: projectSidecarDir, pid: process.pid });
    const projectSessionFile = getSessionFilePath(projectSidecarDir);
    assert.equal("project_id" in JSON.parse(fs.readFileSync(projectSessionFile, "utf8")), false);
    const noProjectSession = resolveAntigravitySession({ deaddropDir: projectSidecarDir });
    assert.equal(noProjectSession.valid, true);
    assert.equal(noProjectSession.projectId, null, "a missing project id must not invalidate the session");

    const healed = reconcileSession({
      address: "localhost:57850",
      csrfToken: "tok-sidecar-2",
      projectId: "proj-from-sidecar",
      deaddropDir: projectSidecarDir,
      pid: process.pid
    });
    assert.equal(healed.action, "healed");
    assert.equal(healed.reason, "missing_project_id");
    assert.equal(JSON.parse(fs.readFileSync(projectSessionFile, "utf8")).project_id, "proj-from-sidecar");
    assert.equal(resolveAntigravitySession({ deaddropDir: projectSidecarDir }).projectId, "proj-from-sidecar");

    // Once it has the project id, the next tick writes nothing
    const unchanged = reconcileSession({
      address: "localhost:57850",
      csrfToken: "tok-sidecar-2",
      projectId: "proj-from-sidecar",
      deaddropDir: projectSidecarDir,
      pid: process.pid
    });
    assert.equal(unchanged.action, "none");
    if (savedProjectEnv) process.env.ANTIGRAVITY_PROJECT_ID = savedProjectEnv;
    console.log("✓ sidecar exports project_id, heals its own file without it, and the session reports it");

    // Test 7i: setupSidecar registration and uninstall
    console.log("\n[Test 7i] setupSidecar registration and uninstallation...");
    const setupDir = path.join(testDir, "setup-sidecar-test");
    const setupConfigFile = path.join(setupDir, "sidecar.json");
    const setupRes = setupSidecar({
      sidecarDir: setupDir,
      sidecarConfigPath: setupConfigFile,
      sidecarScriptPath: "/fake/path/bin/sidecar.js",
      nodeExecutable: "/fake/node",
      deaddropDir: "/fake/deaddrop",
      geminiConfigPath: path.join(setupDir, "config.json")
    });
    assert.ok(fs.existsSync(setupConfigFile));
    const loadedSetup = JSON.parse(fs.readFileSync(setupConfigFile, "utf8"));
    assert.equal(loadedSetup.command, "/fake/node");
    assert.deepEqual(loadedSetup.args, ["/fake/path/bin/sidecar.js"]);
    assert.equal(loadedSetup.env.DEADDROP_DIR, "/fake/deaddrop");

    setupSidecar({ sidecarConfigPath: setupConfigFile, geminiConfigPath: path.join(setupDir, "config.json"), uninstall: true });
    assert.ok(!fs.existsSync(setupConfigFile));
    console.log("✓ setupSidecar registers valid JSON and uninstalls cleanly");

    // Test 7j: Mock agentapi execution receives session env vars
    console.log("\n[Test 7j] Mock agentapi verifies env vars passed from .antigravity_session.json...");
    const e2eDir = path.join(testDir, "e2e-wake-test");
    ensureDirectory(e2eDir);

    // Save and clear env vars
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    const mockOutputLog = path.join(e2eDir, "mock_agentapi_output.json");
    const mockAgentapiScript = path.join(e2eDir, "mock_agentapi.sh");
    fs.writeFileSync(mockAgentapiScript, `#!/bin/sh
cat << EOF > "${mockOutputLog}"
{
  "address": "$ANTIGRAVITY_LS_ADDRESS",
  "csrf_token": "$ANTIGRAVITY_CSRF_TOKEN",
  "project_id": "$ANTIGRAVITY_PROJECT_ID",
  "args": ["$1", "$2", "$3", "$4", "$5"]
}
EOF
exit 0
`, { mode: 0o755 });

    // 1. Without session file -> wake skipped, reason mentions setup-sidecar
    fs.writeFileSync(path.join(e2eDir, ".config.json"), JSON.stringify({
      agents: {
        antigravity: {
          wake_on_mail: true,
          wake_method: "agentapi",
          conversation_id: "conv-target-999",
          agentapi_path: mockAgentapiScript
        }
      }
    }), "utf8");

    const wakeNoSession = await wakeAgentIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test-mail.md",
      deaddropDir: e2eDir
    });
    assert.equal(wakeNoSession.woke, false);
    assert.match(wakeNoSession.reason, /npm run setup-sidecar/);
    assert.ok(!fs.existsSync(mockOutputLog), "agentapi should not have been executed");

    // 2. With valid session file -> wake succeeds and agentapi receives the env vars!
    fs.writeFileSync(path.join(e2eDir, SESSION_FILENAME), JSON.stringify({
      address: "localhost:61234",
      csrf_token: "test-token-777",
      project_id: "sidecar-project-1",
      pid: process.pid
    }), { mode: 0o600 });

    const wakeWithSession = await wakeAgentIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test-mail.md",
      deaddropDir: e2eDir
    });
    assert.equal(wakeWithSession.woke, true);
    assert.equal(wakeWithSession.conversationId, "conv-target-999");
    assert.ok(fs.existsSync(mockOutputLog), "agentapi should have executed");

    const mockResult = JSON.parse(fs.readFileSync(mockOutputLog, "utf8"));
    assert.equal(mockResult.address, "localhost:61234");
    assert.equal(mockResult.csrf_token, "test-token-777");
    assert.equal(mockResult.project_id, "sidecar-project-1", "wake must pass the sidecar's project id (#18)");
    assert.equal(mockResult.args[0], "send-message");
    assert.equal(mockResult.args[1], "--title=Dead Drop Mail");
    assert.equal(mockResult.args[2], "--", "`--` must precede the conversation id");
    assert.equal(mockResult.args[3], "conv-target-999");
    assert.equal(mockResult.args[4], "New Dead Drop mail from claude: test-mail.md. Read it with read_messages.");

    // The agent's own project_id (written by register_as) wins over the sidecar's
    fs.writeFileSync(path.join(e2eDir, ".config.json"), JSON.stringify({
      agents: {
        antigravity: {
          wake_on_mail: true,
          wake_method: "agentapi",
          conversation_id: "conv-target-999",
          project_id: "agent-project-2",
          agentapi_path: mockAgentapiScript
        }
      }
    }), "utf8");
    const wakeAgentProject = await wakeAgentIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test-mail.md",
      deaddropDir: e2eDir
    });
    assert.equal(wakeAgentProject.woke, true);
    assert.equal(JSON.parse(fs.readFileSync(mockOutputLog, "utf8")).project_id, "agent-project-2");

    // Restore env vars
    if (origLs) process.env.ANTIGRAVITY_LS_ADDRESS = origLs;
    if (origCsrf) process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf;
    console.log("✓ agentapi successfully received discovered ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN");


    // Test 7k: sidecar self-healing session lease, tie-break yield, and cleanupSession preservation
    console.log("\n[Test 7k] sidecar self-healing lease, tie-break yield, and cleanupSession preservation...");
    const origLs7k = process.env.ANTIGRAVITY_LS_ADDRESS;
    const origCsrf7k = process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    const leaseDir = path.join(testDir, "lease-test");
    ensureDirectory(leaseDir);
    const leaseFile = getSessionFilePath(leaseDir);

    // 1. Self-healing from a dead PID
    const deadPid = 99999999;
    assert.ok(!isPidAlive(deadPid), "Test deadPid must not be alive");
    fs.writeFileSync(leaseFile, JSON.stringify({
      address: "localhost:11111",
      csrf_token: "tok-dead",
      pid: deadPid,
      ppid: 100,
      updated_at: "2026-01-01T00:00:00.000Z"
    }, null, 2), { mode: 0o600 });

    const beforeHeal = resolveAntigravitySession({ deaddropDir: leaseDir });
    assert.equal(beforeHeal.valid, false);
    assert.equal(beforeHeal.error, "stale");
    assert.equal(beforeHeal.pid, deadPid);

    // Reconcile as our live process
    const healResult = reconcileSession({
      address: "localhost:22222",
      csrfToken: "tok-healed",
      deaddropDir: leaseDir,
      pid: process.pid,
      ppid: process.ppid
    });
    assert.equal(healResult.action, "healed");
    assert.equal(healResult.reason, "dead_pid");
    assert.equal(healResult.previousPid, deadPid);
    assert.equal(healResult.session.pid, process.pid);
    assert.equal(healResult.session.address, "localhost:22222");
    assert.equal(healResult.session.csrf_token, "tok-healed");

    const afterHeal = resolveAntigravitySession({ deaddropDir: leaseDir });
    assert.equal(afterHeal.valid, true);
    assert.equal(afterHeal.address, "localhost:22222");
    assert.equal(afterHeal.csrfToken, "tok-healed");

    // Reconcile again when the file already matches our PID -> action: "none", no disk writes
    const statBefore = fs.statSync(leaseFile);
    const unchangedResult = reconcileSession({
      address: "localhost:22222",
      csrfToken: "tok-healed",
      deaddropDir: leaseDir,
      pid: process.pid,
      ppid: process.ppid
    });
    assert.equal(unchangedResult.action, "none");
    const statAfter = fs.statSync(leaseFile);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "Unchanged session file should not be rewritten");

    // 2. Self-healing from corrupted file
    fs.writeFileSync(leaseFile, "{ corrupt json !!", { mode: 0o600 });
    const corruptHeal = reconcileSession({
      address: "localhost:33333",
      csrfToken: "tok-repaired",
      deaddropDir: leaseDir,
      pid: process.pid,
      ppid: process.ppid
    });
    assert.equal(corruptHeal.action, "healed");
    assert.equal(corruptHeal.reason, "corrupted");
    const afterCorrupt = resolveAntigravitySession({ deaddropDir: leaseDir });
    assert.equal(afterCorrupt.valid, true);
    assert.equal(afterCorrupt.address, "localhost:33333");

    // 3. Sibling collision: tie-break yield (do not overwrite when file points to live higher-PID sibling)
    const higherSiblingPid = 88888888;
    const lowerProcessPid = 77777777;
    fs.writeFileSync(leaseFile, JSON.stringify({
      address: "localhost:44444",
      csrf_token: "tok-higher-sibling",
      pid: higherSiblingPid,
      ppid: 100,
      updated_at: new Date().toISOString()
    }, null, 2), { mode: 0o600 });

    const yieldResult = reconcileSession({
      address: "localhost:55555",
      csrfToken: "tok-lower-process",
      deaddropDir: leaseDir,
      pid: lowerProcessPid,
      ppid: 100,
      isPidAliveFn: (p) => p === higherSiblingPid
    });
    assert.equal(yieldResult.action, "yield");
    assert.equal(yieldResult.reason, "higher_pid_sibling");
    assert.equal(yieldResult.higherPid, higherSiblingPid);

    // Verify on-disk file was NOT overwritten
    const onDiskAfterYield = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
    assert.equal(onDiskAfterYield.pid, higherSiblingPid);
    assert.equal(onDiskAfterYield.csrf_token, "tok-higher-sibling");

    // 4. Sibling collision: tie-break win (override older/lower-PID sibling)
    const winResult = reconcileSession({
      address: "localhost:66666",
      csrfToken: "tok-winning-process",
      deaddropDir: leaseDir,
      pid: 99999990,
      ppid: 100,
      isPidAliveFn: (p) => p === higherSiblingPid
    });
    assert.equal(winResult.action, "healed");
    assert.equal(winResult.reason, "won_tiebreak");
    assert.equal(winResult.previousPid, higherSiblingPid);
    const onDiskAfterWin = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
    assert.equal(onDiskAfterWin.pid, 99999990);
    assert.equal(onDiskAfterWin.csrf_token, "tok-winning-process");

    // 5. cleanupSession() does not delete a live sibling's session file
    fs.writeFileSync(leaseFile, JSON.stringify({
      address: "localhost:77777",
      csrf_token: "tok-live-sibling",
      pid: process.pid,
      ppid: process.ppid
    }, null, 2), { mode: 0o600 });

    // Simulate an exiting older/other sibling process with a different PID
    const otherPid = process.pid + 1;
    const cleanedUpSibling = cleanupSession(leaseDir, otherPid, (p) => p === process.pid);
    assert.equal(cleanedUpSibling, false, "cleanupSession should return false when file is owned by live sibling");
    assert.ok(fs.existsSync(leaseFile), "cleanupSession must NOT delete file owned by a live sibling");
    const preservedData = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
    assert.equal(preservedData.pid, process.pid);

    // cleanupSession with matching PID does delete the file
    const cleanedUpOwn = cleanupSession(leaseDir, process.pid);
    assert.equal(cleanedUpOwn, true);
    assert.ok(!fs.existsSync(leaseFile), "cleanupSession must delete file when PID matches");

    // cleanupSession cleans up a dead PID if exiting
    fs.writeFileSync(leaseFile, JSON.stringify({
      address: "localhost:88888",
      csrf_token: "tok-stale-exit",
      pid: deadPid
    }, null, 2), { mode: 0o600 });
    const cleanedUpDead = cleanupSession(leaseDir, otherPid);
    assert.equal(cleanedUpDead, true);
    assert.ok(!fs.existsSync(leaseFile), "cleanupSession removes dead-PID file on exit");

    if (origLs7k) process.env.ANTIGRAVITY_LS_ADDRESS = origLs7k;
    if (origCsrf7k) process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf7k;
    console.log("✓ sidecar self-healing lease, tie-break yield, and cleanupSession preservation passed");


    // Test 8: End-to-end Stdio MCP JSON-RPC protocol via MCP Client
    console.log("\n[Test 8] End-to-end Stdio MCP Client interaction...");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "index.js"), "--agent=claude"],
      env: { ...process.env, DEADDROP_DIR: testDir }
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    // List tools
    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);
    assert.ok(toolNames.includes("send_message"));
    assert.ok(toolNames.includes("read_messages"));
    assert.ok(toolNames.includes("mark_read"));
    assert.ok(toolNames.includes("start_session"));
    console.log(`✓ MCP tools available: ${toolNames.join(", ")}`);

    // Call send_message
    const sendResult = await client.callTool({
      name: "send_message",
      arguments: {
        to: "antigravity",
        subject: "PR 2140 Feedback",
        body: "The test suite passes cleanly.",
        re_issue: 2140
      }
    });
    assert.ok(sendResult.content[0].text.includes("Message saved to ~/deaddrop/"));
    console.log(`✓ send_message tool call succeeded: ${sendResult.content[0].text.split("\n")[0]}`);

    // Call read_messages
    const readResult = await client.callTool({
      name: "read_messages",
      arguments: {
        for: "antigravity",
        unread_only: true
      }
    });
    assert.ok(readResult.content[0].text.includes(AUTHORITY_NOTICE));
    assert.ok(readResult.content[0].text.includes("The test suite passes cleanly."));
    assert.ok(readResult.content[0].text.includes("Re-Issue: 2140"));
    console.log(`✓ read_messages tool call succeeded and included Authority Notice`);

    // Extract message ID to test mark_read
    const matchId = readResult.content[0].text.match(/ID:\s*([^\r\n]+)/);
    assert.ok(matchId, "Message ID should be present in read output");
    const msgId = matchId[1].trim();

    // Call mark_read
    const markToolRes = await client.callTool({
      name: "mark_read",
      arguments: { id: msgId }
    });
    assert.ok(markToolRes.content[0].text.includes(`Marked message ${msgId}`));
    console.log(`✓ mark_read tool call succeeded`);

    // Verify it is now marked as read
    const readAfter = await client.callTool({
      name: "read_messages",
      arguments: {
        for: "antigravity",
        unread_only: true
      }
    });
    assert.ok(readAfter.content[0].text.includes("No unread messages found for 'antigravity'"));
    console.log(`✓ Verified unread list is now empty`);

    await client.close();
    console.log("✓ MCP Client transport closed cleanly");

    // Test 9: Settings Web UI & API tests
    console.log("\n[Test 9] Settings Web UI & API tests...");
    const settingsTestDir = path.join(testDir, "settings-test");
    ensureDirectory(settingsTestDir);

    // 9a: Default config fallback
    const initialConfig = loadConfig(settingsTestDir);
    assert.deepEqual(initialConfig, DEFAULT_CONFIG);
    assert.equal(initialConfig.agents.antigravity.wake_method, "agentapi");
    assert.equal(initialConfig.agents.claude.wake_method, "unsupported");
    console.log("✓ loadConfig returns DEFAULT_CONFIG when .config.json is absent");

    // 9b: Start server on 127.0.0.1
    const { server: settingsServer, port: settingsPort, url: settingsUrl, close: closeSettingsServer } =
      await startSettingsServer({ port: 0, deaddropDir: settingsTestDir });

    try {
      assert.equal(settingsServer.address().address, "127.0.0.1");
      console.log(`✓ Server bound strictly to 127.0.0.1 on port ${settingsPort}`);

      // 9c: GET / returns HTML
      const getHtmlRes = await fetch(settingsUrl);
      assert.equal(getHtmlRes.status, 200);
      assert.ok(getHtmlRes.headers.get("content-type").includes("text/html"));
      const htmlBody = await getHtmlRes.text();
      assert.ok(htmlBody.includes("Dead Drop Settings"));
      assert.ok(htmlBody.includes("Agent Wake Configuration"));
      assert.ok(htmlBody.includes("Recent Messages"));
      console.log("✓ GET / returns HTML settings page");

      // 9d: GET /api/state returns config, mailboxDir, and recent messages
      // Create a test message in settingsTestDir first
      await sendMessage({
        to: "claude",
        subject: "Settings UI Test Message",
        body: "Top-secret message content which should NOT appear in recent messages list.",
        re_issue: "4",
        from: "antigravity",
        deaddropDir: settingsTestDir
      });

      const getStateRes = await fetch(`${settingsUrl}api/state`);
      assert.equal(getStateRes.status, 200);
      const stateData = await getStateRes.json();
      assert.ok(stateData.mailboxDir);
      // No .config.json yet: the API reports that and serves no defaults (see 9k)
      assert.equal(stateData.config_status, "missing");
      assert.equal(stateData.config.agents, undefined);
      assert.equal(stateData.messages.length, 1);
      assert.equal(stateData.messages[0].subject, "Settings UI Test Message");
      assert.equal(stateData.messages[0].re_issue, "4");
      assert.strictEqual(stateData.messages[0].body, undefined, "Message body must not be included in recent messages API");
      console.log("✓ GET /api/state returns config and message metadata without body");

      // 9e: POST /api/config rejects non-json Content-Type
      const plainTextRes = await fetch(`${settingsUrl}api/config`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ agents: {} })
      });
      assert.equal(plainTextRes.status, 400);
      const plainTextErr = await plainTextRes.json();
      assert.ok(plainTextErr.error.includes("application/json"));
      console.log("✓ POST /api/config rejects non-JSON Content-Type with 400");

      // 9f: POST /api/config rejects malformed payloads
      const invalidRes = await fetch(`${settingsUrl}api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents: { antigravity: { wake_on_mail: "not-a-bool" } } })
      });
      assert.equal(invalidRes.status, 400);
      console.log("✓ POST /api/config rejects invalid field types with 400");

      // 9g: POST /api/config updates .config.json atomically
      const updatePayload = {
        agents: {
          antigravity: {
            wake_on_mail: true,
            wake_method: "agentapi",
            conversation_id: "conv-settings-999"
          },
          claude: {
            wake_on_mail: true, // Should be forced to false because wake_method is unsupported
            wake_method: "unsupported"
          },
          custom_agent: {
            wake_on_mail: false,
            wake_method: "unsupported"
          }
        }
      };

      const postRes = await fetch(`${settingsUrl}api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatePayload)
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.success, true);
      assert.equal(postData.config.agents.antigravity.conversation_id, "conv-settings-999");
      assert.equal(postData.config.agents.antigravity.wake_on_mail, true);
      assert.equal(postData.config.agents.claude.wake_on_mail, false, "Unsupported agent must have wake_on_mail forced to false");
      assert.ok(postData.config.agents.custom_agent, "Dynamically includes any configured agent keys");

      // Verify file on disk survived
      const diskConfig = JSON.parse(fs.readFileSync(path.join(settingsTestDir, ".config.json"), "utf8"));
      assert.equal(diskConfig.agents.antigravity.conversation_id, "conv-settings-999");
      assert.equal(diskConfig.agents.claude.wake_on_mail, false);
      console.log("✓ POST /api/config saves valid config atomically to .config.json");

      // 9h: Verify Dead Drop wakeAgentIfTargeted respects the updated config
      // Toggle wake_on_mail to false for antigravity
      await fetch(`${settingsUrl}api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: {
            antigravity: {
              wake_on_mail: false,
              conversation_id: "conv-settings-999"
            }
          }
        })
      });

      const wakeSkippedRes = await wakeAgentIfTargeted({
        to: "antigravity",
        from: "claude",
        filename: "test.md",
        deaddropDir: settingsTestDir
      });
      assert.equal(wakeSkippedRes.woke, false);
      assert.ok(wakeSkippedRes.reason.includes("wake_on_mail is false"));
      console.log("✓ wakeAgentIfTargeted correctly reads updated wake_on_mail: false from settings");

      // 9i: CLI invocation and Ctrl-C (SIGINT) clean exit
      const { spawn } = await import("node:child_process");
      const cliChild = spawn(process.execPath, ["index.js", "settings", "--port=0", `--dir=${settingsTestDir}`], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let cliStdout = "";
      cliChild.stdout.on("data", (chunk) => { cliStdout += chunk.toString(); });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(cliStdout.includes("Settings server listening at http://127.0.0.1:"));
      assert.ok(cliStdout.includes("Press Ctrl+C to stop."));
      cliChild.kill("SIGINT");
      const cliExitCode = await new Promise((resolve) => cliChild.on("exit", (code) => resolve(code)));
      assert.equal(cliExitCode, 0);
      assert.ok(cliStdout.includes("Settings server stopped."));
      console.log("✓ CLI spawn and SIGINT clean shutdown passed with exit code 0");

      // 9j: POST /api/config rejects submitted agent with no wake_method when no on-disk record exists (400)
      const freshMailboxDir = path.join(testDir, "fresh-mailbox-test");
      ensureDirectory(freshMailboxDir);
      const { server: freshServer, url: freshUrl, close: closeFreshServer } =
        await startSettingsServer({ port: 0, deaddropDir: freshMailboxDir });

      try {
        const noMethodRes = await fetch(`${freshUrl}api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agents: {
              antigravity: {
                wake_on_mail: true,
                conversation_id: "test-conv-id"
              }
            }
          })
        });
        assert.equal(noMethodRes.status, 400);
        const noMethodErr = await noMethodRes.json();
        assert.ok(noMethodErr.error.includes("Missing required 'wake_method'"));
        assert.equal(fs.existsSync(path.join(freshMailboxDir, ".config.json")), false, ".config.json must not be created on rejected POST");
        console.log("✓ POST /api/config rejects agent missing wake_method when no on-disk record exists (400)");
      } finally {
        await closeFreshServer();
      }


    } finally {
      await closeSettingsServer();
      console.log("✓ Settings server closed cleanly");
    }

    // 9k: default_model and blocked_models are never written by the settings UI or HTTP API
    console.log("  Testing settings save never writes default_model or blocked_models...");
    assert.equal(DEFAULT_CONFIG.agents.claude.default_model, "claude-haiku-5-5");
    assert.deepEqual(DEFAULT_CONFIG.agents.claude.blocked_models, []);

    const policySettingsDir = path.join(testDir, "settings-policy-test");
    ensureDirectory(policySettingsDir);
    const policyConfigPath = path.join(policySettingsDir, ".config.json");
    const readPolicyConfig = () => JSON.parse(fs.readFileSync(policyConfigPath, "utf8"));
    const writePolicyConfig = (claude) => fs.writeFileSync(policyConfigPath, JSON.stringify({ agents: { claude } }, null, 2));
    const postPolicyConfig = (serverUrl, agents) => fetch(`${serverUrl}api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents })
    });
    const onDiskClaude = {
      wake_on_mail: false,
      wake_method: "unsupported",
      default_model: "claude-haiku-5-5",
      blocked_models: ["*sonnet*"],
      default_permission_mode: "auto"
    };

    // saveConfig is a library call: it keeps what it is given
    writePolicyConfig(onDiskClaude);
    saveConfig(policySettingsDir, { claude: { ...onDiskClaude } });
    assert.equal(readPolicyConfig().agents.claude.default_model, "claude-haiku-5-5");
    assert.deepEqual(readPolicyConfig().agents.claude.blocked_models, ["*sonnet*"]);

    // saveConfig refuses to overwrite a file it cannot parse
    fs.writeFileSync(policyConfigPath, "{not json");
    assert.throws(
      () => saveConfig(policySettingsDir, { claude: { ...onDiskClaude } }),
      (err) => err.message.includes(policyConfigPath) && err.message.includes("is not valid JSON")
    );
    assert.equal(fs.readFileSync(policyConfigPath, "utf8"), "{not json", "unparseable config must not be overwritten");

    const policyServer = await startSettingsServer({ port: 0, deaddropDir: policySettingsDir });
    try {
      // The UI posts back what /api/state returned; the values must survive unchanged
      writePolicyConfig(onDiskClaude);
      const roundTripState = await (await fetch(`${policyServer.url}api/state`)).json();
      assert.equal(roundTripState.config_status, "ok");
      assert.equal(roundTripState.config_path, policyConfigPath);
      const roundTripRes = await postPolicyConfig(policyServer.url, roundTripState.config.agents);
      assert.equal(roundTripRes.status, 200);
      assert.equal(readPolicyConfig().agents.claude.default_model, "claude-haiku-5-5");
      assert.deepEqual(readPolicyConfig().agents.claude.blocked_models, ["*sonnet*"]);

      // A crafted POST cannot unblock Sonnet or change the default
      const craftedRes = await postPolicyConfig(policyServer.url, {
        claude: { wake_method: "unsupported", default_model: "sonnet", blocked_models: [] }
      });
      assert.equal(craftedRes.status, 200);
      assert.equal(readPolicyConfig().agents.claude.default_model, "claude-haiku-5-5", "POST must not change default_model");
      assert.deepEqual(readPolicyConfig().agents.claude.blocked_models, ["*sonnet*"], "POST must not change blocked_models");

      // With no on-disk default_model, a POST must not add one
      writePolicyConfig({ wake_on_mail: false, wake_method: "unsupported", default_permission_mode: "auto" });
      const noDefaultRes = await postPolicyConfig(policyServer.url, {
        claude: { wake_method: "unsupported", default_model: "sonnet", blocked_models: ["*"] }
      });
      assert.equal(noDefaultRes.status, 200);
      assert.equal("default_model" in readPolicyConfig().agents.claude, false, "POST must not write a default_model");
      assert.equal("blocked_models" in readPolicyConfig().agents.claude, false, "POST must not write blocked_models");

      // Missing file: /api/state serves no defaults and creates nothing; the UI gets a reason
      fs.rmSync(policyConfigPath);
      const missingState = await (await fetch(`${policyServer.url}api/state`)).json();
      assert.equal(missingState.config_status, "missing");
      assert.equal(missingState.config_path, policyConfigPath);
      assert.equal(missingState.config.agents, undefined, "missing file must not serve DEFAULT_CONFIG agents");
      assert.equal(fs.existsSync(policyConfigPath), false, "GET /api/state must not create .config.json");

      // Unparseable file: /api/state says so; POST refuses and leaves the file alone
      fs.writeFileSync(policyConfigPath, "{not json");
      const invalidState = await (await fetch(`${policyServer.url}api/state`)).json();
      assert.equal(invalidState.config_status, "invalid");
      assert.equal(invalidState.config.agents, undefined);
      const invalidPostRes = await postPolicyConfig(policyServer.url, { claude: { wake_method: "unsupported" } });
      assert.equal(invalidPostRes.status, 409);
      const invalidPostErr = await invalidPostRes.json();
      assert.ok(invalidPostErr.error.includes(policyConfigPath) && invalidPostErr.error.includes("is not valid JSON"));
      assert.equal(fs.readFileSync(policyConfigPath, "utf8"), "{not json", "POST must not overwrite an unparseable config");
    } finally {
      await policyServer.close();
    }
    console.log("✓ Settings save round-trips default_model and blocked_models, and never writes defaults");

    // Test 10: Claude CLI & start_session MCP Tool
    await runClaudeCliTests(testDir);

    // Test 11: start_antigravity_session
    await runAntigravityTests(testDir);

    console.log("\n=== ALL TESTS PASSED SUCCESSFULLY ===");
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log(`[Cleanup] Removed test directory: ${testDir}`);
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
