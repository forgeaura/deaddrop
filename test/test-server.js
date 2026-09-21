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
  wakeAntigravityIfTargeted,
  getAgentapiExecutable,
  AUTHORITY_NOTICE
} from "../lib/messages.js";

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

    // Test 6: wakeAntigravityIfTargeted (Missing config file)
    console.log("\n[Test 6] Wake mechanism: missing .config.json...");
    const wakeNoConfig = await wakeAntigravityIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test.md",
      deaddropDir: testDir
    });
    assert.equal(wakeNoConfig.woke, false);
    assert.ok(wakeNoConfig.reason.includes("not found"));
    console.log(`✓ Correctly handled missing .config.json without error or new conversation`);

    // Test 7: wakeAntigravityIfTargeted (Empty/invalid conversation ID)
    console.log("\n[Test 7] Wake mechanism: empty conversation ID...");
    const configPath = path.join(testDir, ".config.json");
    fs.writeFileSync(configPath, JSON.stringify({ antigravity_conversation_id: "" }), "utf8");

    const wakeEmptyId = await wakeAntigravityIfTargeted({
      to: "antigravity",
      from: "claude",
      filename: "test.md",
      deaddropDir: testDir
    });
    assert.equal(wakeEmptyId.woke, false);
    assert.equal(wakeEmptyId.reason, "antigravity_conversation_id missing or empty");
    console.log(`✓ Correctly handled empty conversation ID without creating conversation`);

    // Test 7b: getAgentapiExecutable precedence (env var > config file > default)
    console.log("\n[Test 7b] getAgentapiExecutable precedence...");
    delete process.env.DEADDROP_AGENTAPI_PATH;
    assert.equal(
      getAgentapiExecutable({ config: { agentapi_path: "/custom/path/to/agentapi" } }),
      "/custom/path/to/agentapi"
    );
    process.env.DEADDROP_AGENTAPI_PATH = "/env/path/to/agentapi";
    assert.equal(
      getAgentapiExecutable({ config: { agentapi_path: "/custom/path/to/agentapi" } }),
      "/env/path/to/agentapi"
    );
    delete process.env.DEADDROP_AGENTAPI_PATH;
    console.log("✓ getAgentapiExecutable prefers env var, then config, then default");

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
