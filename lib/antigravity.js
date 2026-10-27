import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import {
  DEFAULT_DEADDROP_DIR,
  formatLocalISO,
  getAgentapiExecutable,
  resolveAntigravitySession,
  resolveAntigravityProjectId,
  buildAgentapiEnv,
  parseAgentapiOutput,
  describeAgentapiFailure,
  readMessages
} from "./messages.js";
import { loadConfig, saveConfig, readConfigFromDisk, DEFAULT_CONFIG } from "./settings-server.js";
import { buildPromptWithPreamble, logSessionSpawn } from "./claude-cli.js";
import { redactSecrets } from "./exec-utils.js";

// The tiers `agentapi new-conversation --model=` accepts. Omitting --model
// gives agentapi's own default, "flash".
export const VALID_ANTIGRAVITY_MODELS = ["flash_lite", "flash", "pro"];

// Recipient names register_as may never take, on top of every agent already in
// .config.json or DEFAULT_CONFIG and every name already used in the mailbox.
export const RESERVED_RECIPIENT_NAMES = ["all", "sarah", "unknown"];

const RECIPIENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Antigravity's own project registry: one <project id>.json per project, with
// `name` and `projectResources.resources[].gitFolder.folderUri`. Read-only.
export const DEFAULT_ANTIGRAVITY_PROJECTS_DIR = path.join(os.homedir(), ".gemini", "config", "projects");

/**
 * Lists Antigravity projects as { id, name, folders } from the registry.
 * Unreadable entries are skipped; a missing directory gives [].
 */
export function listAntigravityProjects({ projectsDir = DEFAULT_ANTIGRAVITY_PROJECTS_DIR } = {}) {
  let files;
  try {
    files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const projects = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(projectsDir, file), "utf8"));
      const id = typeof data?.id === "string" && data.id ? data.id : file.replace(/\.json$/, "");
      const resources = Array.isArray(data?.projectResources?.resources) ? data.projectResources.resources : [];
      const folders = [];
      for (const resource of resources) {
        const uri = resource?.gitFolder?.folderUri;
        if (typeof uri === "string" && uri.startsWith("file://")) {
          try {
            folders.push(path.resolve(new URL(uri).pathname));
          } catch {
            // ignore a malformed URI
          }
        }
      }
      projects.push({ id, name: typeof data?.name === "string" ? data.name : "", folders });
    } catch {
      // skip unreadable project files
    }
  }
  return projects;
}

/**
 * Resolves the `project` tool param against the registry: an exact project
 * name, or an absolute folder matching one of a project's git folders.
 * Unknown or ambiguous values throw.
 */
export function resolveProjectParam(project, { projectsDir = DEFAULT_ANTIGRAVITY_PROJECTS_DIR } = {}) {
  const wanted = project.trim();
  const projects = listAntigravityProjects({ projectsDir });

  let matches;
  if (path.isAbsolute(wanted)) {
    const folder = path.resolve(wanted);
    matches = projects.filter((p) => p.folders.includes(folder));
  } else {
    matches = projects.filter((p) => p.name === wanted);
  }

  if (matches.length === 0) {
    const names = projects.map((p) => p.name).filter(Boolean).sort();
    throw new Error(
      `Unknown Antigravity project '${wanted}'. Pass an exact project name or an absolute folder of one. ` +
      `Known projects: ${names.length ? names.join(", ") : "(none found in " + projectsDir + ")"}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Antigravity project '${wanted}' is ambiguous: it matches ${matches.map((p) => `${p.name} (${p.id})`).join(", ")}`
    );
  }
  return { projectId: matches[0].id, name: matches[0].name, source: "param" };
}

/**
 * Throws unless `name` is a valid, unused Dead Drop recipient name. A name is
 * used if it's an agent in .config.json or DEFAULT_CONFIG, reserved, or the
 * `to` or `from` of any message in the mailbox (recipients like `wren` get
 * mail without having a config entry).
 */
export function assertRecipientNameAvailable(name, { deaddropDir = DEFAULT_DEADDROP_DIR } = {}) {
  if (typeof name !== "string" || !RECIPIENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid register_as '${name}': use 1-64 lowercase letters, digits or '-', not starting with '-'`
    );
  }

  if (RESERVED_RECIPIENT_NAMES.includes(name)) {
    throw new Error(`register_as '${name}' is reserved`);
  }

  const onDisk = readConfigFromDisk(deaddropDir);
  if (onDisk.status === "invalid") {
    throw new Error(`Cannot check register_as '${name}': config file at ${onDisk.path} is not valid JSON; fix it by hand`);
  }
  const configured = new Set([
    ...Object.keys(DEFAULT_CONFIG.agents),
    ...Object.keys(onDisk.config?.agents && typeof onDisk.config.agents === "object" ? onDisk.config.agents : {})
  ].map((key) => key.toLowerCase()));
  if (configured.has(name)) {
    throw new Error(`register_as '${name}' is already an agent in .config.json; refusing to overwrite it`);
  }

  const messages = readMessages({ for: "all", unread_only: false, limit: Number.MAX_SAFE_INTEGER, deaddropDir });
  const used = messages.some((msg) =>
    String(msg.to).toLowerCase() === name || String(msg.from).toLowerCase() === name
  );
  if (used) {
    throw new Error(`register_as '${name}' already sends or receives Dead Drop mail; refusing to take it over`);
  }
}

/**
 * Builds the argv for `agentapi new-conversation`. Flags use the --key=value
 * form, and `--` always precedes the prompt so it can never be read as a flag.
 */
export function buildNewConversationArgs({ model, title, fullPrompt }) {
  const args = ["new-conversation"];
  if (model) args.push(`--model=${model}`);
  if (title) args.push(`--title=${title}`);
  args.push("--", fullPrompt);
  return args;
}

/**
 * Extracts the conversation id from `agentapi new-conversation` stdout:
 * {"response":{"newConversation":{"prompt":"...","conversationId":"<uuid>"}}}
 */
export function parseNewConversationOutput(stdout, { secrets = [] } = {}) {
  const parsed = parseAgentapiOutput(stdout);
  const conversationId = parsed?.response?.newConversation?.conversationId;
  if (typeof conversationId === "string" && /^[A-Za-z0-9-]{8,}$/.test(conversationId)) {
    return conversationId;
  }
  if (typeof parsed?.error === "string" && parsed.error.trim()) {
    throw new Error(`agentapi reported an error: ${redactSecrets(parsed.error.trim(), secrets)}`);
  }
  throw new Error(
    `Failed to parse conversation id from agentapi output.\nRaw output:\n${redactSecrets(String(stdout || "").trim(), secrets)}`
  );
}

function assertOptionalFlagValue(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("-")) {
    throw new Error(`Invalid ${label} '${value}': must not be empty or start with '-'`);
  }
  return value.trim();
}

/**
 * Starts a new Antigravity conversation with `agentapi new-conversation`,
 * optionally registers it as a Dead Drop recipient, and logs it to
 * .sessions.jsonl. All validation happens before agentapi runs.
 */
export async function startAntigravitySession({
  prompt,
  title,
  model,
  project,
  register_as,
  from,
  deaddropDir = DEFAULT_DEADDROP_DIR,
  config,
  projectsDir = DEFAULT_ANTIGRAVITY_PROJECTS_DIR,
  execFileFn = execFile
} = {}) {
  // 1. Validate everything before anything spawns
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Missing required parameter: 'prompt'");
  }
  const resolvedTitle = assertOptionalFlagValue(title, "title");
  const resolvedProject = assertOptionalFlagValue(project, "project");
  if (model !== undefined && model !== null && !VALID_ANTIGRAVITY_MODELS.includes(model)) {
    throw new Error(`Invalid model '${model}': must be one of ${VALID_ANTIGRAVITY_MODELS.join(", ")}`);
  }
  const resolvedModel = model || null;

  let registerName = null;
  if (register_as !== undefined && register_as !== null) {
    registerName = typeof register_as === "string" ? register_as.trim() : register_as;
    assertRecipientNameAvailable(registerName, { deaddropDir });
  }

  const activeConfig = config || loadConfig(deaddropDir);

  // 2. Session (address + token) from the env or the sidecar's session file
  const session = resolveAntigravitySession({ deaddropDir });
  if (session.valid === false) {
    throw new Error(session.reason);
  }
  const secrets = [session.csrfToken];

  // 3. Project id: param > agents.antigravity.project_id > sidecar
  const explicit = resolvedProject ? resolveProjectParam(resolvedProject, { projectsDir }) : undefined;
  const { projectId, source: projectSource } = resolveAntigravityProjectId({
    explicit,
    config: activeConfig,
    session
  });
  if (!projectId) {
    throw new Error(
      "No Antigravity project id. Pass 'project' (an Antigravity project name or folder), " +
      "set agents.antigravity.project_id in .config.json, or restart the Dead Drop sidecar so it exports project_id."
    );
  }
  const projectName = explicit?.name ||
    listAntigravityProjects({ projectsDir }).find((p) => p.id === projectId)?.name ||
    null;

  // 4. Prompt with the "came from an agent, not Sarah" preamble
  const sender = from || "unknown";
  const fullPrompt = buildPromptWithPreamble({ prompt, from: sender });

  // 5. Run agentapi (token only in env)
  const agentapiPath = getAgentapiExecutable({ config: activeConfig });
  const args = buildNewConversationArgs({ model: resolvedModel, title: resolvedTitle, fullPrompt });
  const env = buildAgentapiEnv({ session, projectId });

  let stdout;
  try {
    const res = await new Promise((resolve, reject) => {
      execFileFn(
        agentapiPath,
        args,
        { env, timeout: 60000, maxBuffer: 1024 * 1024 },
        (err, out, errOut) => {
          if (err) {
            reject({ err, stdout: out, stderr: errOut });
          } else {
            resolve({ stdout: out, stderr: errOut });
          }
        }
      );
    });
    stdout = res.stdout;
  } catch (failure) {
    const formatted = describeAgentapiFailure(failure.err, failure.stdout, failure.stderr, { secrets });
    throw new Error(`Failed to start Antigravity conversation:\n${formatted}`);
  }

  const conversationId = parseNewConversationOutput(stdout, { secrets });

  // 6. Optional mailbox registration. The conversation already exists, so a
  // late failure is reported in the result rather than thrown.
  let registeredAs = null;
  let registerError = null;
  if (registerName) {
    try {
      assertRecipientNameAvailable(registerName, { deaddropDir });
      saveConfig(deaddropDir, {
        [registerName]: {
          wake_on_mail: true,
          wake_method: "agentapi",
          conversation_id: conversationId,
          project_id: projectId
        }
      });
      registeredAs = registerName;
    } catch (err) {
      registerError = redactSecrets(err.message, secrets);
    }
  }

  // 7. Log to .sessions.jsonl
  logSessionSpawn({
    deaddropDir,
    entry: {
      time: formatLocalISO(new Date()),
      launcher: "antigravity",
      from: sender,
      title: resolvedTitle || null,
      model: resolvedModel,
      project_id: projectId,
      project_source: projectSource,
      conversation_id: conversationId,
      register_as: registeredAs,
      prompt: fullPrompt
    }
  });

  return {
    conversationId,
    title: resolvedTitle || null,
    model: resolvedModel,
    projectId,
    projectName,
    projectSource,
    registeredAs,
    registerError
  };
}
