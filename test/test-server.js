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
import { exportSession, cleanupSession, getSessionFilePath } from "../bin/sidecar.js";
import { setupSidecar } from "../scripts/setup-sidecar.js";
import { startSettingsServer, loadConfig, saveConfig, DEFAULT_CONFIG } from "../lib/settings-server.js";

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
    // There's no real agentapi binary in the test environment, so the attempt itself
    // will fail at the exec layer -- but that's the point: the failure reason should
    // come from *trying* agentapi, not from being skipped for a config reason.
    console.log("\n[Test 7c] Wake mechanism: wake attempted when wake_on_mail is true...");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        antigravity: { wake_on_mail: true, wake_method: "agentapi", conversation_id: "conv-abc-123" }
      }
    }), "utf8");

    // Seed a valid mock session file so resolveAntigravitySession succeeds and allows
    // wakeViaAgentapi to proceed to the exec layer even when running outside Antigravity.
    const mockSessionPath = path.join(wakeTestDir, SESSION_FILENAME);
    fs.writeFileSync(mockSessionPath, JSON.stringify({
      address: "localhost:12345",
      csrf_token: "mock-token",
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
    try { fs.unlinkSync(mockSessionPath); } catch {}
    console.log(`✓ Wake was attempted (not skipped for a config reason) when wake_on_mail is true`);

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
  "args": ["$1", "$2", "$3", "$4"]
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
    assert.equal(mockResult.args[0], "send-message");
    assert.equal(mockResult.args[1], "--title=Dead Drop Mail");
    assert.equal(mockResult.args[2], "conv-target-999");
    assert.equal(mockResult.args[3], "New Dead Drop mail from claude: test-mail.md. Read it with read_messages.");

    // Restore env vars
    if (origLs) process.env.ANTIGRAVITY_LS_ADDRESS = origLs;
    if (origCsrf) process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf;
    console.log("✓ agentapi successfully received discovered ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN");


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
      assert.ok(stateData.config.agents.antigravity);
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

    } finally {
      await closeSettingsServer();
      console.log("✓ Settings server closed cleanly");
    }

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
