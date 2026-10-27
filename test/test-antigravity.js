import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureDirectory, sendMessage, SESSION_FILENAME } from "../lib/messages.js";
import { buildPromptWithPreamble } from "../lib/claude-cli.js";
import {
  startAntigravitySession,
  buildNewConversationArgs,
  parseNewConversationOutput,
  resolveProjectParam,
  assertRecipientNameAvailable,
  VALID_ANTIGRAVITY_MODELS
} from "../lib/antigravity.js";

const SENTINEL_TOKEN = "SENTINEL-antigravity-token-25";
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

// What the real agentapi prints for new-conversation (CRLF: it was captured from a pty)
function successStdout(prompt = "p") {
  return `{\r\n  "response": {\r\n    "newConversation": {\r\n      "prompt": ${JSON.stringify(prompt)},\r\n      "conversationId": "${CONVERSATION_ID}"\r\n    }\r\n  }\r\n}\r\n`;
}

// A mock execFile that records calls and answers with the given result
function makeExec({ stdout, stderr = "", err = null } = {}) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    setImmediate(() => cb(err, stdout ?? successStdout(args[args.length - 1]), stderr));
  };
  fn.calls = calls;
  return fn;
}

function writeSession(dir, extra = {}) {
  fs.writeFileSync(path.join(dir, SESSION_FILENAME), JSON.stringify({
    address: "localhost:1",
    csrf_token: SENTINEL_TOKEN,
    pid: process.pid,
    ...extra
  }), { mode: 0o600 });
}

function writeProject(projectsDir, id, name, folder) {
  fs.writeFileSync(path.join(projectsDir, `${id}.json`), JSON.stringify({
    id,
    name,
    projectResources: { resources: [{ gitFolder: { folderUri: `file://${folder}` } }] }
  }));
}

async function assertRejectsBeforeExec(exec, promise, pattern) {
  await assert.rejects(promise, pattern);
  assert.equal(exec.calls.length, 0, `agentapi must not run when rejecting with ${pattern}`);
}

export async function runAntigravityTests(testDir) {
  console.log("\n[Test 11] start_antigravity_session...");
  const agDir = path.join(testDir, "antigravity-test");
  ensureDirectory(agDir);

  const savedEnv = {};
  for (const key of ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_PROJECT_ID", "DEADDROP_AGENTAPI_PATH"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Everything printed to stderr during these tests, to prove the token never leaks
  const capturedStderr = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => {
    capturedStderr.push(parts.map(String).join(" "));
    originalConsoleError(...parts);
  };

  // Antigravity project registry fixture
  const projectsDir = path.join(agDir, "projects");
  ensureDirectory(projectsDir);
  writeProject(projectsDir, "proj-deaddrop", "deaddrop", "/repos/deaddrop");
  writeProject(projectsDir, "proj-intervent", "intervent", "/repos/intervent");
  writeProject(projectsDir, "proj-dup-a", "dup", "/repos/dup-a");
  writeProject(projectsDir, "proj-dup-b", "dup", "/repos/dup-b");
  fs.writeFileSync(path.join(projectsDir, "broken.json"), "{not json");

  const agentapiConfig = { agents: { antigravity: { agentapi_path: "/stub/agentapi" } } };
  const leakChecks = [];

  try {
    // 11a: argv construction
    console.log("  Testing new-conversation argv and `--`...");
    assert.deepEqual(buildNewConversationArgs({ fullPrompt: "hi" }), ["new-conversation", "--", "hi"]);
    assert.deepEqual(
      buildNewConversationArgs({ model: "pro", title: "Review", fullPrompt: "-looks-like-a-flag" }),
      ["new-conversation", "--model=pro", "--title=Review", "--", "-looks-like-a-flag"]
    );
    assert.deepEqual(VALID_ANTIGRAVITY_MODELS, ["flash_lite", "flash", "pro"]);

    // 11b: output parsing
    console.log("  Testing conversation id parsing...");
    assert.equal(parseNewConversationOutput(successStdout()), CONVERSATION_ID);
    assert.throws(
      () => parseNewConversationOutput(`{"response":{},"error":"boom ${SENTINEL_TOKEN}"}`, { secrets: [SENTINEL_TOKEN] }),
      (err) => /agentapi reported an error: boom <redacted>/.test(err.message) && !err.message.includes(SENTINEL_TOKEN)
    );
    assert.throws(() => parseNewConversationOutput("not json at all"), /Failed to parse conversation id/);
    assert.throws(() => parseNewConversationOutput(`{"response":{"newConversation":{"conversationId":"-x"}}}`), /Failed to parse/);

    // 11c: full success path with every option
    console.log("  Testing successful start with title, model and project...");
    const okDir = path.join(agDir, "ok");
    ensureDirectory(okDir);
    writeSession(okDir, { project_id: "sidecar-proj" });
    const okExec = makeExec();
    const okRes = await startAntigravitySession({
      prompt: "Review PR 12",
      title: "Second opinion",
      model: "pro",
      project: "intervent",
      from: "wren",
      deaddropDir: okDir,
      config: agentapiConfig,
      projectsDir,
      execFileFn: okExec
    });
    leakChecks.push(JSON.stringify(okRes));
    assert.equal(okRes.conversationId, CONVERSATION_ID);
    assert.equal(okRes.projectId, "proj-intervent");
    assert.equal(okRes.projectName, "intervent");
    assert.equal(okRes.projectSource, "param");
    assert.equal(okRes.model, "pro");
    assert.equal(okRes.title, "Second opinion");
    assert.equal(okExec.calls.length, 1);
    const okCall = okExec.calls[0];
    assert.equal(okCall.file, "/stub/agentapi");
    const expectedPrompt = buildPromptWithPreamble({ prompt: "Review PR 12", from: "wren" });
    assert.deepEqual(okCall.args, ["new-conversation", "--model=pro", "--title=Second opinion", "--", expectedPrompt]);
    assert.ok(expectedPrompt.startsWith("[Started via Dead Drop by wren."), "preamble must be prepended");
    assert.equal(okCall.opts.env.ANTIGRAVITY_LS_ADDRESS, "localhost:1");
    assert.equal(okCall.opts.env.ANTIGRAVITY_CSRF_TOKEN, SENTINEL_TOKEN);
    assert.equal(okCall.opts.env.ANTIGRAVITY_PROJECT_ID, "proj-intervent");
    assert.ok(!okCall.args.some((arg) => arg.includes(SENTINEL_TOKEN)), "token must never be in argv");

    // Omitted options add no flags
    const minimalExec = makeExec();
    const minimalRes = await startAntigravitySession({
      prompt: "hello", deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: minimalExec
    });
    assert.deepEqual(minimalExec.calls[0].args, ["new-conversation", "--", buildPromptWithPreamble({ prompt: "hello", from: "unknown" })]);
    assert.equal(minimalRes.model, null);

    // 11d: project id precedence and registry matching
    console.log("  Testing project id precedence and registry matching...");
    const byFolder = await startAntigravitySession({
      prompt: "p", project: "/repos/deaddrop/", deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: makeExec()
    });
    assert.equal(byFolder.projectId, "proj-deaddrop");
    assert.equal(byFolder.projectSource, "param");

    const byConfig = await startAntigravitySession({
      prompt: "p",
      deaddropDir: okDir,
      config: { agents: { antigravity: { agentapi_path: "/stub/agentapi", project_id: "proj-deaddrop" } } },
      projectsDir,
      execFileFn: makeExec()
    });
    assert.equal(byConfig.projectId, "proj-deaddrop");
    assert.equal(byConfig.projectSource, "antigravity_config");
    assert.equal(byConfig.projectName, "deaddrop");

    const bySidecar = await startAntigravitySession({
      prompt: "p", deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: makeExec()
    });
    assert.equal(bySidecar.projectId, "sidecar-proj");
    assert.equal(bySidecar.projectSource, "sidecar");
    assert.equal(bySidecar.projectName, null);

    assert.throws(() => resolveProjectParam("nope", { projectsDir }), /Unknown Antigravity project 'nope'.*deaddrop, dup, dup, intervent/s);
    assert.throws(() => resolveProjectParam("dup", { projectsDir }), /ambiguous/);
    assert.throws(() => resolveProjectParam("Deaddrop", { projectsDir }), /Unknown/, "name match must be exact");
    let exec = makeExec();
    await assertRejectsBeforeExec(exec, startAntigravitySession({
      prompt: "p", project: "nope", deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: exec
    }), /Unknown Antigravity project/);
    exec = makeExec();
    await assertRejectsBeforeExec(exec, startAntigravitySession({
      prompt: "p", project: "dup", deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: exec
    }), /ambiguous/);

    const noProjectDir = path.join(agDir, "no-project");
    ensureDirectory(noProjectDir);
    writeSession(noProjectDir);
    exec = makeExec();
    await assertRejectsBeforeExec(exec, startAntigravitySession({
      prompt: "p", deaddropDir: noProjectDir, config: agentapiConfig, projectsDir, execFileFn: exec
    }), /No Antigravity project id/);

    // 11e: input validation, all before agentapi runs
    console.log("  Testing input validation (leading '-', model, prompt)...");
    const invalidCases = [
      [{ prompt: "" }, /Missing required parameter: 'prompt'/],
      [{ prompt: "   " }, /Missing required parameter: 'prompt'/],
      [{ prompt: "p", title: "-x" }, /Invalid title/],
      [{ prompt: "p", title: "  " }, /Invalid title/],
      [{ prompt: "p", project: "--project=evil" }, /Invalid project/],
      [{ prompt: "p", model: "claude-sonnet-5-5" }, /Invalid model/],
      [{ prompt: "p", model: "--model=pro" }, /Invalid model/],
      [{ prompt: "p", register_as: "-evil" }, /Invalid register_as/],
      [{ prompt: "p", register_as: "Bad_Name" }, /Invalid register_as/],
      [{ prompt: "p", register_as: "" }, /Invalid register_as/]
    ];
    for (const [params, pattern] of invalidCases) {
      exec = makeExec();
      await assertRejectsBeforeExec(exec, startAntigravitySession({
        ...params, deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: exec
      }), pattern);
    }

    // 11f: invalid session
    console.log("  Testing missing and stale sessions...");
    const noSessionDir = path.join(agDir, "no-session");
    ensureDirectory(noSessionDir);
    exec = makeExec();
    await assertRejectsBeforeExec(exec, startAntigravitySession({
      prompt: "p", deaddropDir: noSessionDir, config: agentapiConfig, projectsDir, execFileFn: exec
    }), /npm run setup-sidecar/);
    const staleDir = path.join(agDir, "stale-session");
    ensureDirectory(staleDir);
    writeSession(staleDir, { pid: 99999999, project_id: "sidecar-proj" });
    exec = makeExec();
    await assertRejectsBeforeExec(exec, startAntigravitySession({
      prompt: "p", deaddropDir: staleDir, config: agentapiConfig, projectsDir, execFileFn: exec
    }), /stale/);

    // 11g: agentapi failure surfaces agentapi's error without the token
    console.log("  Testing agentapi failure reporting...");
    const failErr = Object.assign(new Error("Command failed: /stub/agentapi new-conversation"), { code: 1 });
    const failExec = makeExec({
      err: failErr,
      stdout: `{\n  "response": {},\n  "error": "project_id is required (token was ${SENTINEL_TOKEN})"\n}\n`
    });
    await assert.rejects(
      startAntigravitySession({ prompt: "p", deaddropDir: okDir, config: agentapiConfig, projectsDir, execFileFn: failExec }),
      (err) => {
        leakChecks.push(err.message);
        return /Failed to start Antigravity conversation/.test(err.message) &&
          /project_id is required/.test(err.message) &&
          /exit code \/ error code: 1/.test(err.message) &&
          !err.message.includes(SENTINEL_TOKEN);
      }
    );

    // 11h: register_as writes the agent, and refuses every name already in use
    console.log("  Testing register_as registration and refusals...");
    const regDir = path.join(agDir, "register");
    ensureDirectory(regDir);
    writeSession(regDir, { project_id: "sidecar-proj" });
    fs.writeFileSync(path.join(regDir, ".config.json"), JSON.stringify({
      agents: {
        antigravity: { wake_on_mail: true, wake_method: "agentapi", conversation_id: "existing-ag", agentapi_path: "/stub/agentapi" },
        pip: { wake_on_mail: true, wake_method: "agentapi", conversation_id: "existing-pip" }
      }
    }, null, 2));
    // wren and rook get mail but have no config entry
    await sendMessage({ to: "wren", from: "rook", subject: "fixture", body: "mailbox fixture", deaddropDir: regDir });
    const configBefore = fs.readFileSync(path.join(regDir, ".config.json"), "utf8");

    for (const [name, pattern] of [
      ["claude", /already an agent/],
      ["antigravity", /already an agent/],
      ["pip", /already an agent/],
      ["wren", /already sends or receives Dead Drop mail/],
      ["rook", /already sends or receives Dead Drop mail/],
      ["all", /reserved/],
      ["sarah", /reserved/],
      ["unknown", /reserved/]
    ]) {
      exec = makeExec();
      await assertRejectsBeforeExec(exec, startAntigravitySession({
        prompt: "p", register_as: name, deaddropDir: regDir, projectsDir, execFileFn: exec
      }), pattern);
    }
    assert.equal(fs.readFileSync(path.join(regDir, ".config.json"), "utf8"), configBefore, "refusals must not touch .config.json");

    // Default agent names are refused even with no config file at all
    const emptyDir = path.join(agDir, "empty-mailbox");
    ensureDirectory(emptyDir);
    assert.throws(() => assertRecipientNameAvailable("claude", { deaddropDir: emptyDir }), /already an agent/);
    assert.doesNotThrow(() => assertRecipientNameAvailable("gemini-reviewer", { deaddropDir: emptyDir }));

    const regExec = makeExec();
    const regRes = await startAntigravitySession({
      prompt: "Review the plan",
      register_as: "gemini-reviewer",
      from: "wren",
      deaddropDir: regDir,
      projectsDir,
      execFileFn: regExec
    });
    leakChecks.push(JSON.stringify(regRes));
    assert.equal(regRes.registeredAs, "gemini-reviewer");
    assert.equal(regRes.registerError, null);
    const savedConfig = JSON.parse(fs.readFileSync(path.join(regDir, ".config.json"), "utf8"));
    assert.deepEqual(savedConfig.agents["gemini-reviewer"], {
      wake_on_mail: true,
      wake_method: "agentapi",
      conversation_id: CONVERSATION_ID,
      project_id: "sidecar-proj"
    });
    assert.equal(savedConfig.agents.pip.conversation_id, "existing-pip", "other agents untouched");
    assert.equal(savedConfig.agents.antigravity.conversation_id, "existing-ag", "other agents untouched");

    // Now taken: a second registration under the same name is refused before launching
    exec = makeExec();
    await assertRejectsBeforeExec(exec, startAntigravitySession({
      prompt: "p", register_as: "gemini-reviewer", deaddropDir: regDir, projectsDir, execFileFn: exec
    }), /already an agent/);

    // 11i: .sessions.jsonl entry
    console.log("  Testing .sessions.jsonl entry...");
    const regLog = fs.readFileSync(path.join(regDir, ".sessions.jsonl"), "utf8").trim().split("\n");
    assert.equal(regLog.length, 1, "only launched conversations are logged");
    const entry = JSON.parse(regLog[0]);
    assert.deepEqual(Object.keys(entry).sort(), [
      "conversation_id", "from", "launcher", "model", "project_id", "project_source", "prompt", "register_as", "time", "title"
    ]);
    assert.equal(entry.launcher, "antigravity");
    assert.equal(entry.from, "wren");
    assert.equal(entry.conversation_id, CONVERSATION_ID);
    assert.equal(entry.project_id, "sidecar-proj");
    assert.equal(entry.project_source, "sidecar");
    assert.equal(entry.register_as, "gemini-reviewer");
    assert.equal(entry.prompt, buildPromptWithPreamble({ prompt: "Review the plan", from: "wren" }));

    // 11j: the token appears nowhere outside the env passed to execFile
    console.log("  Testing the session token never leaks...");
    for (const dir of [okDir, regDir]) {
      for (const file of [".sessions.jsonl", ".config.json"]) {
        const filePath = path.join(dir, file);
        if (fs.existsSync(filePath)) leakChecks.push(fs.readFileSync(filePath, "utf8"));
      }
    }
    leakChecks.push(...capturedStderr);
    for (const text of leakChecks) {
      assert.ok(!text.includes(SENTINEL_TOKEN), `session token leaked into: ${text.slice(0, 200)}`);
    }
  } finally {
    console.error = originalConsoleError;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // 11k: end-to-end through the MCP server with a stub agentapi
  console.log("  Testing end-to-end MCP start_antigravity_session...");
  const e2eDir = path.join(agDir, "e2e-mcp");
  ensureDirectory(e2eDir);
  writeSession(e2eDir, { project_id: "e2e-sidecar-proj" });
  const argsFile = path.join(e2eDir, "agentapi-args.bin");
  const envFile = path.join(e2eDir, "agentapi-env.txt");
  const stubAgentapi = path.join(e2eDir, "stub_agentapi.sh");
  fs.writeFileSync(stubAgentapi, `#!/bin/sh
printf '%s\\0' "$@" > "${argsFile}"
printf '%s' "$ANTIGRAVITY_PROJECT_ID" > "${envFile}"
printf '{\\n  "response": {\\n    "newConversation": {\\n      "prompt": "x",\\n      "conversationId": "${CONVERSATION_ID}"\\n    }\\n  }\\n}\\n'
`, { mode: 0o755 });

  const childEnv = { ...process.env, DEADDROP_DIR: e2eDir, DEADDROP_AGENTAPI_PATH: stubAgentapi };
  for (const key of ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_PROJECT_ID"]) delete childEnv[key];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "index.js"), "--agent=rook"],
    env: childEnv
  });
  const client = new Client({ name: "antigravity-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "start_antigravity_session");
    assert.ok(tool, "start_antigravity_session must be listed");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["from", "model", "project", "prompt", "register_as", "title"]);
    assert.ok(!("profile" in tool.inputSchema.properties), "profile is not supported yet");
    assert.deepEqual(tool.inputSchema.required, ["prompt"]);
    assert.deepEqual(tool.inputSchema.properties.model.enum, ["flash_lite", "flash", "pro"]);
    assert.match(tool.description, /came from an agent, not Sarah/);

    const res = await client.callTool({
      name: "start_antigravity_session",
      arguments: { prompt: "Second opinion on #25", title: "deaddrop-test: ignore", register_as: "e2e-gemini" }
    });
    assert.ok(!res.isError, res.content[0].text);
    const text = res.content[0].text;
    assert.match(text, new RegExp(`Started Antigravity conversation ${CONVERSATION_ID} titled 'deaddrop-test: ignore'`));
    assert.match(text, /Model: agentapi default \(flash\)/);
    assert.match(text, /Project: e2e-sidecar-proj, from the Dead Drop sidecar's session file\./);
    assert.match(text, /Registered as Dead Drop recipient 'e2e-gemini'/);
    assert.ok(!text.includes(SENTINEL_TOKEN));

    const stubArgs = fs.readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(stubArgs, [
      "new-conversation",
      "--title=deaddrop-test: ignore",
      "--",
      buildPromptWithPreamble({ prompt: "Second opinion on #25", from: "rook" })
    ]);
    assert.equal(fs.readFileSync(envFile, "utf8"), "e2e-sidecar-proj");

    const badRes = await client.callTool({
      name: "start_antigravity_session",
      arguments: { prompt: "p", register_as: "claude" }
    });
    assert.equal(badRes.isError, true);
    assert.match(badRes.content[0].text, /Error starting Antigravity conversation: register_as 'claude' is already an agent/);
  } finally {
    await client.close();
  }

  console.log("✓ All start_antigravity_session tests passed");
}
