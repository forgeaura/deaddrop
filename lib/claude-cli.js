import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import {
  DEFAULT_DEADDROP_DIR,
  ensureDirectory,
  formatLocalISO
} from "./messages.js";
import { loadConfig, DEFAULT_CONFIG, DEFAULT_MODEL } from "./settings-server.js";
import { findBlockingPattern } from "./model-policy.js";

export const DEFAULT_CLAUDE_ALLOWED_MODES = ["auto", "default", "acceptEdits", "plan"];
export const VALID_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const VALID_HANDOFF_MODES = ["desktop", "background"];

/**
 * Strips ANSI 7-bit and 8-bit escape codes.
 */
export function stripAnsi(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

/**
 * Compares two semver version strings (e.g. "2.1.299" vs "2.1.99").
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareSemver(a, b) {
  const parse = (v) => (v || "").split(".").map((part) => parseInt(part, 10) || 0);
  const pA = parse(a);
  const pB = parse(b);
  const len = Math.max(pA.length, pB.length);
  for (let i = 0; i < len; i++) {
    const numA = pA[i] || 0;
    const numB = pB[i] || 0;
    if (numA !== numB) return numA - numB;
  }
  return (a || "").localeCompare(b || "");
}

/**
 * Formats process execution errors with exit code, err.code, stderr, and stdout
 * to ensure failures are easily diagnosable (addressing Issue #18 lessons).
 */
export function formatExecError(err, stdout = "", stderr = "") {
  const lines = [];
  if (err?.message) {
    lines.push(err.message);
  } else {
    lines.push("Command failed");
  }
  if (err?.code !== undefined) {
    lines.push(`exit code / error code: ${err.code}`);
  }
  if (err?.signal) {
    lines.push(`signal: ${err.signal}`);
  }
  if (err?.killed) {
    lines.push("process was killed (timeout or signal)");
  }
  const cleanStderr = stripAnsi(stderr || "").trim();
  const cleanStdout = stripAnsi(stdout || "").trim();
  if (cleanStderr) {
    lines.push(`stderr:\n${cleanStderr}`);
  }
  if (cleanStdout) {
    lines.push(`stdout:\n${cleanStdout}`);
  }
  return lines.join("\n");
}

/**
 * Resolves the Claude Code CLI executable in order of precedence:
 * 1. env.DEADDROP_CLAUDE_PATH
 * 2. agents.claude.cli_path in .config.json
 * 3. claude found on PATH (walked manually, never using `which`)
 * 4. Newest (semver-sorted) match in ~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude
 * 
 * Throws a clear Error if no executable is found.
 */
export function resolveClaudeExecutable({
  agentConfig,
  config,
  env = process.env,
  homeDir = os.homedir(),
  pathExistsFn = fs.existsSync,
  readdirSyncFn = fs.readdirSync,
  statSyncFn = fs.statSync,
  accessSyncFn = fs.accessSync
} = {}) {
  // 1. env.DEADDROP_CLAUDE_PATH
  if (env.DEADDROP_CLAUDE_PATH && env.DEADDROP_CLAUDE_PATH.trim()) {
    return env.DEADDROP_CLAUDE_PATH.trim();
  }

  // 2. agentConfig.cli_path or config.agents.claude.cli_path
  const resolvedAgentConfig = agentConfig || config?.agents?.claude;
  if (resolvedAgentConfig?.cli_path && typeof resolvedAgentConfig.cli_path === "string" && resolvedAgentConfig.cli_path.trim()) {
    return resolvedAgentConfig.cli_path.trim();
  }

  // 3. claude found on PATH (walked manually)
  const pathEnv = env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "claude");
    try {
      if (pathExistsFn(candidate)) {
        if (accessSyncFn) {
          accessSyncFn(candidate, fs.constants.X_OK);
        }
        return candidate;
      }
    } catch {
      // candidate not executable or accessible, continue
    }
  }

  // 4. Newest match in macOS desktop-bundle glob:
  // ~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude
  // Never use claude-code-vm (Linux binary sibling)
  const baseBundleDir = path.join(homeDir, "Library", "Application Support", "Claude", "claude-code");
  try {
    if (pathExistsFn(baseBundleDir)) {
      const versions = readdirSyncFn(baseBundleDir)
        .filter((entry) => {
          const entryPath = path.join(baseBundleDir, entry);
          try {
            return statSyncFn(entryPath).isDirectory();
          } catch {
            return false;
          }
        })
        .sort((a, b) => compareSemver(b, a)); // newest first

      for (const ver of versions) {
        const verDir = path.join(baseBundleDir, ver);
        let hashes = [];
        try {
          hashes = readdirSyncFn(verDir).filter((entry) => {
            const entryPath = path.join(verDir, entry);
            try {
              return statSyncFn(entryPath).isDirectory();
            } catch {
              return false;
            }
          });
        } catch {
          continue;
        }

        for (const h of hashes) {
          const candidate = path.join(verDir, h, "claude.app", "Contents", "MacOS", "claude");
          try {
            if (pathExistsFn(candidate)) {
              if (accessSyncFn) {
                accessSyncFn(candidate, fs.constants.X_OK);
              }
              return candidate;
            }
          } catch {
            // candidate not accessible, continue
          }
        }
      }
    }
  } catch {
    // ignore filesystem read error and fall through
  }

  throw new Error(
    "Claude Code CLI executable not found.\n" +
    "Searched: DEADDROP_CLAUDE_PATH, agents.claude.cli_path, PATH, and ~/Library/Application Support/Claude/claude-code/\n" +
    "Please ensure Claude Code is installed, run 'claude auth login', or set DEADDROP_CLAUDE_PATH in your environment or cli_path in .config.json."
  );
}

/**
 * Builds the prompt with the fixed safety preamble (used for background mode).
 */
export function buildPromptWithPreamble({ prompt, from = "unknown" }) {
  const preamble =
    `[Started via Dead Drop by ${from}. These instructions came from another agent, not directly from Sarah. ` +
    `Actions requiring Sarah's decision (merging PRs, production database, spending money, deleting data) ` +
    `still require Sarah directly.]`;
  return `${preamble}\n\n${prompt}`;
}

/**
 * Builds the minimal bootstrap prompt for desktop handoff mode.
 */
export function buildDesktopBootstrapPrompt({ prompt, from = "unknown" }) {
  const preamble =
    `[Started via Dead Drop by ${from}. These instructions came from another agent, not directly from Sarah. ` +
    `Actions requiring Sarah's decision (merging PRs, production database, spending money, deleting data) ` +
    `still require Sarah directly.]`;
  const instruction = `You were created by ${from} via Dead Drop. Your task will arrive as the next message. Reply with one line: READY. Use no tools.`;

  let result = `${preamble}\n\n${instruction}`;
  if (prompt && typeof prompt === "string" && prompt.trim().length > 0) {
    result += `\n\nContext (do not act on it yet):\n${prompt.trim()}`;
  }
  return result;
}

/**
 * Builds the argument array for the Claude Code CLI launch.
 */
export function buildClaudeArgs({
  name,
  model,
  effort,
  permissionMode,
  fullPrompt
}) {
  const args = ["--bg", "-n", name, "--model", model];
  if (effort) {
    args.push("--effort", effort);
  }
  args.push("--permission-mode", permissionMode);
  args.push(fullPrompt);
  return args;
}

/**
 * Strips ANSI codes and extracts the short ID from stdout (e.g. 'backgrounded · b73a79df · name').
 * Tolerates preceding lines such as 'Starting background service…'.
 */
export function parseShortId(stdout) {
  const clean = stripAnsi(stdout || "");
  const match = clean.match(/(?:^|\n)\s*backgrounded\s*·\s*(\S+)\s*·/i);
  if (!match) {
    throw new Error(`Failed to parse short session ID from Claude CLI output.\nRaw output:\n${clean.trim()}`);
  }
  return match[1].toLowerCase();
}

/**
 * Looks up the full sessionId (UUID) by querying `claude agents --json --all`.
 * Retries up to maxRetries times (default 10) with retryDelayMs (default 500ms).
 * Strictly matches on short id only (no name fallback).
 */
export async function lookupSessionId({
  claudeExec,
  cwd,
  shortId,
  maxRetries = 10,
  retryDelayMs = 500,
  execFileFn = execFile,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const normalizedShortId = (shortId || "").toLowerCase();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFileFn(
          claudeExec,
          ["agents", "--json", "--all"],
          { cwd, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
          (err, out, errOut) => {
            if (err) {
              reject({ err, stdout: out, stderr: errOut });
            } else {
              resolve({ stdout: out, stderr: errOut });
            }
          }
        );
      });

      const cleanStdout = stripAnsi(stdout || "").trim();
      const firstBracket = cleanStdout.indexOf("[");
      const lastBracket = cleanStdout.lastIndexOf("]");
      if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        const jsonStr = cleanStdout.slice(firstBracket, lastBracket + 1);
        const sessions = JSON.parse(jsonStr);
        if (Array.isArray(sessions)) {
          const match = sessions.find((s) => {
            return Boolean(normalizedShortId && s.id && String(s.id).toLowerCase() === normalizedShortId);
          });

          if (match && match.sessionId) {
            return match.sessionId;
          }
        }
      }
    } catch {
      // retry on error or parse failure
    }

    if (attempt < maxRetries) {
      await sleepFn(retryDelayMs);
    }
  }

  return null;
}

/**
 * Polls `claude agents --json --all` until the session with shortId has status "idle".
 * Returns true if idle reached within timeout, false on timeout.
 */
export async function waitForSessionIdle({
  claudeExec,
  cwd,
  shortId,
  maxWaitRetries = 90,
  waitDelayMs = 1000,
  execFileFn = execFile,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const normalizedShortId = (shortId || "").toLowerCase();

  for (let attempt = 1; attempt <= maxWaitRetries; attempt++) {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFileFn(
          claudeExec,
          ["agents", "--json", "--all"],
          { cwd, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
          (err, out, errOut) => {
            if (err) {
              reject({ err, stdout: out, stderr: errOut });
            } else {
              resolve({ stdout: out, stderr: errOut });
            }
          }
        );
      });

      const cleanStdout = stripAnsi(stdout || "").trim();
      const firstBracket = cleanStdout.indexOf("[");
      const lastBracket = cleanStdout.lastIndexOf("]");
      if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        const jsonStr = cleanStdout.slice(firstBracket, lastBracket + 1);
        const sessions = JSON.parse(jsonStr);
        if (Array.isArray(sessions)) {
          const match = sessions.find((s) => {
            return Boolean(normalizedShortId && s.id && String(s.id).toLowerCase() === normalizedShortId);
          });

          if (match && match.status === "idle") {
            return true;
          }
        }
      }
    } catch {
      // retry on error or parse failure
    }

    if (attempt < maxWaitRetries) {
      await sleepFn(waitDelayMs);
    }
  }

  return false;
}

/**
 * Appends a log line to <deaddropDir>/.sessions.jsonl.
 */
export function logSessionSpawn({
  deaddropDir = DEFAULT_DEADDROP_DIR,
  entry
}) {
  ensureDirectory(deaddropDir);
  const sessionsLogPath = path.join(deaddropDir, ".sessions.jsonl");
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(sessionsLogPath, line, { encoding: "utf8", mode: 0o600 });
}

/**
 * Starts a new Claude Code session unattended.
 * Supports desktop handoff mode (starts background bootstrap turn, waits for idle,
 * stops session, and opens in Claude desktop app) and background mode.
 */
export async function startClaudeSession({
  folder,
  prompt,
  name,
  model,
  effort,
  permissionMode,
  permission_mode,
  handoff,
  from,
  deaddropDir = DEFAULT_DEADDROP_DIR,
  config,
  env = process.env,
  platform = process.platform,
  execFileFn = execFile,
  sleepFn,
  claudeExec: overrideClaudeExec
} = {}) {
  // 1. Folder validation (lives in library for protection of all callers)
  if (!folder || typeof folder !== "string" || !folder.trim()) {
    throw new Error("Missing required parameter: 'folder'");
  }
  const trimmedFolder = folder.trim();
  if (!path.isAbsolute(trimmedFolder)) {
    throw new Error(`folder must be an absolute path: "${trimmedFolder}"`);
  }
  const resolvedFolder = path.resolve(trimmedFolder);
  if (!fs.existsSync(resolvedFolder)) {
    throw new Error(`folder does not exist: "${resolvedFolder}"`);
  }
  const stat = fs.statSync(resolvedFolder);
  if (!stat.isDirectory()) {
    throw new Error(`folder is not a directory: "${resolvedFolder}"`);
  }

  // 2. Resolve configuration & handoff mode
  const activeConfig = config || loadConfig(deaddropDir);
  const claudeConfig = activeConfig?.agents?.claude || {};

  const resolvedHandoff = handoff || claudeConfig.default_handoff || "desktop";
  if (!VALID_HANDOFF_MODES.includes(resolvedHandoff)) {
    throw new Error(`Invalid handoff mode '${resolvedHandoff}'. Allowed modes: ${VALID_HANDOFF_MODES.join(", ")}`);
  }

  // 3. Validate prompt: required for background mode, optional for desktop mode
  if (resolvedHandoff === "background") {
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("Missing required parameter: 'prompt' (required when handoff is 'background')");
    }
  }

  // 4. Flag injection guardrails: name, model
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().startsWith("-")) {
      throw new Error(`Invalid session name '${name}': must not be empty or start with '-'`);
    }
  }
  const resolvedName = (name && name.trim()) || `deaddrop-${Date.now()}`;

  if (model !== undefined) {
    if (typeof model !== "string" || !model.trim() || model.trim().startsWith("-")) {
      throw new Error(`Invalid model '${model}': must not be empty or start with '-'`);
    }
  }

  // 5. Validate effort enum
  if (effort !== undefined && effort !== null) {
    if (!VALID_EFFORT_LEVELS.includes(effort)) {
      throw new Error(`Invalid effort '${effort}': must be one of ${VALID_EFFORT_LEVELS.join(", ")}`);
    }
  }

  // 6. Permission mode guardrail
  const resolvedModel = (model && model.trim()) || claudeConfig.default_model || DEFAULT_MODEL;

  // 6a. Model denylist: checked on the resolved model, before the executable is resolved or anything spawns
  const blockingPattern = findBlockingPattern(
    resolvedModel,
    claudeConfig.blocked_models === undefined ? [] : claudeConfig.blocked_models,
    "agents.claude.blocked_models"
  );
  if (blockingPattern !== null) {
    throw new Error(
      `Model '${resolvedModel}' is blocked by agents.claude.blocked_models (pattern '${blockingPattern}'). Choose another model, e.g. ${DEFAULT_MODEL}.`
    );
  }

  const requestedMode = permissionMode || permission_mode || claudeConfig.default_permission_mode || "auto";
  const allowedModes = claudeConfig.allowed_permission_modes ||
    DEFAULT_CONFIG.agents.claude.allowed_permission_modes ||
    DEFAULT_CLAUDE_ALLOWED_MODES;

  if (!allowedModes.includes(requestedMode)) {
    throw new Error(
      `Permission mode '${requestedMode}' is not allowed. Allowed modes: ${allowedModes.join(", ")}`
    );
  }

  // 7. Resolve Claude executable
  const claudeExec = overrideClaudeExec || resolveClaudeExecutable({
    agentConfig: claudeConfig,
    config: activeConfig
  });

  // 8. Prompt construction (bootstrap for desktop mode, full prompt for background mode)
  const sender = from || "unknown";
  let fullPrompt;
  if (resolvedHandoff === "desktop") {
    fullPrompt = buildDesktopBootstrapPrompt({ prompt, from: sender });
  } else {
    fullPrompt = buildPromptWithPreamble({ prompt, from: sender });
  }

  // 9. Arg construction
  const args = buildClaudeArgs({
    name: resolvedName,
    model: resolvedModel,
    effort: effort || null,
    permissionMode: requestedMode,
    fullPrompt
  });

  // 10. Execute spawn via execFile (60s timeout, 10MB buffer)
  let stdout, stderr;
  try {
    const res = await new Promise((resolve, reject) => {
      execFileFn(
        claudeExec,
        args,
        {
          cwd: resolvedFolder,
          timeout: 60000,
          maxBuffer: 10 * 1024 * 1024
        },
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
    stderr = res.stderr;
  } catch (failure) {
    const formatted = formatExecError(failure.err, failure.stdout, failure.stderr);
    throw new Error(`Failed to start Claude Code session:\n${formatted}`);
  }

  // 11. Parse short ID from stdout
  const shortId = parseShortId(stdout);

  // 12. Look up sessionId via agents --json --all (10 tries x 500ms, 15s timeout, 10MB buffer)
  const sessionId = await lookupSessionId({
    claudeExec,
    cwd: resolvedFolder,
    shortId,
    maxRetries: 10,
    retryDelayMs: 500,
    execFileFn,
    sleepFn
  });

  // 13. Handoff flow
  let outcome = "background";
  let desktopId = null;

  if (resolvedHandoff === "desktop") {
    if (!sessionId) {
      // sessionId could not be confirmed: skip stop & open, report background
      outcome = "background";
    } else if (platform !== "darwin") {
      // Non-darwin: skip BOTH stop and open (stopping without opening just kills it), report background
      outcome = "background";
    } else {
      // Poll agents --json --all until status is idle (90s timeout, 1s interval)
      const isIdle = await waitForSessionIdle({
        claudeExec,
        cwd: resolvedFolder,
        shortId,
        maxWaitRetries: 90,
        waitDelayMs: 1000,
        execFileFn,
        sleepFn
      });

      if (!isIdle) {
        // Timed out waiting for idle: do NOT stop it, keep running in background
        outcome = "still_running";
      } else {
        // Scope the stop narrowly: re-read agents --json --all right before stop.
        // Require that the entry is still idle and sessionId matches.
        let canStop = false;
        try {
          const { stdout: checkOut } = await new Promise((resolve, reject) => {
            execFileFn(
              claudeExec,
              ["agents", "--json", "--all"],
              { cwd: resolvedFolder, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
              (err, out, errOut) => {
                if (err) reject(err);
                else resolve({ stdout: out });
              }
            );
          });
          const cleanCheck = stripAnsi(checkOut || "").trim();
          const firstB = cleanCheck.indexOf("[");
          const lastB = cleanCheck.lastIndexOf("]");
          if (firstB !== -1 && lastB !== -1 && lastB > firstB) {
            const sessions = JSON.parse(cleanCheck.slice(firstB, lastB + 1));
            const currentEntry = sessions.find((s) => s.id && String(s.id).toLowerCase() === shortId.toLowerCase());
            if (currentEntry && currentEntry.status === "idle" && currentEntry.sessionId === sessionId) {
              canStop = true;
            }
          }
        } catch {
          canStop = false;
        }

        if (!canStop) {
          // Entry went busy or changed sessionId between idle check and stop -> no stop
          outcome = "still_running";
        } else {
          // Stop the session
          try {
            await new Promise((resolve, reject) => {
              execFileFn(
                claudeExec,
                ["stop", shortId],
                { cwd: resolvedFolder, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
                (err, out, errOut) => {
                  if (err) reject({ err, stdout: out, stderr: errOut });
                  else resolve({ stdout: out, stderr: errOut });
                }
              );
            });
          } catch (stopErr) {
            const formatted = formatExecError(stopErr.err, stopErr.stdout, stopErr.stderr);
            throw new Error(`Failed to stop Claude session '${shortId}' for desktop handoff:\n${formatted}`);
          }

          // Open in Claude desktop app
          desktopId = `local_${sessionId}`;
          const resumeUrl = `claude://resume?session=${sessionId}`;
          try {
            const openBin = env.DEADDROP_OPEN_BIN || "open";
            await new Promise((resolve, reject) => {
              execFileFn(openBin, [resumeUrl], { timeout: 10000 }, (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
            outcome = "handed_off";
          } catch {
            // open failed after successful stop: don't throw, outcome is stopped_not_opened
            outcome = "stopped_not_opened";
          }
        }
      }
    }
  } else {
    outcome = "background";
  }

  // 14. Log to .sessions.jsonl
  logSessionSpawn({
    deaddropDir,
    entry: {
      time: formatLocalISO(new Date()),
      from: sender,
      folder: resolvedFolder,
      name: resolvedName,
      model: resolvedModel,
      effort: effort || null,
      permission_mode: requestedMode,
      handoff: resolvedHandoff,
      outcome,
      id: shortId,
      sessionId,
      prompt: fullPrompt
    }
  });

  return {
    id: shortId,
    sessionId,
    desktopId,
    outcome,
    handoff: resolvedHandoff,
    name: resolvedName,
    folder: resolvedFolder,
    model: resolvedModel,
    effort: effort || null,
    permissionMode: requestedMode
  };
}
