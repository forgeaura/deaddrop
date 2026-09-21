#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { SESSION_FILENAME, isPidAlive } from "../lib/messages.js";

export const DEFAULT_DEADDROP_DIR = process.env.DEADDROP_DIR || path.join(os.homedir(), "deaddrop");
export { SESSION_FILENAME };

export function getSessionFilePath(dir = DEFAULT_DEADDROP_DIR) {
  return path.join(dir, SESSION_FILENAME);
}

export function exportSession({
  address = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  deaddropDir = DEFAULT_DEADDROP_DIR,
  pid = process.pid,
  ppid = process.ppid,
} = {}) {
  if (!address || !csrfToken) {
    console.error(
      `[Dead Drop Sidecar] Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN in environment. ` +
      `Is this process running as an Antigravity sidecar?`
    );
    return null;
  }

  if (!fs.existsSync(deaddropDir)) {
    fs.mkdirSync(deaddropDir, { recursive: true });
  }

  const sessionData = {
    address,
    csrf_token: csrfToken,
    pid,
    ppid,
    updated_at: new Date().toISOString(),
  };

  const sessionFile = getSessionFilePath(deaddropDir);
  const tempFile = `${sessionFile}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tempFile, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, sessionFile);
    fs.chmodSync(sessionFile, 0o600);
  } catch (err) {
    console.error(`[Dead Drop Sidecar] Failed to write session file ${sessionFile}: ${err.message}`);
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {}
    return null;
  }

  console.error(`[Dead Drop Sidecar] Exported active Antigravity session to ${sessionFile} (PID: ${pid})`);
  return sessionData;
}

export function cleanupSession(dirOrOpts = DEFAULT_DEADDROP_DIR, maybePid = process.pid, maybeIsPidAliveFn = isPidAlive) {
  let deaddropDir = DEFAULT_DEADDROP_DIR;
  let pid = process.pid;
  let isPidAliveFn = isPidAlive;

  if (typeof dirOrOpts === "string") {
    deaddropDir = dirOrOpts;
    if (typeof maybePid === "number") {
      pid = maybePid;
    }
    if (typeof maybeIsPidAliveFn === "function") {
      isPidAliveFn = maybeIsPidAliveFn;
    }
  } else if (dirOrOpts && typeof dirOrOpts === "object") {
    deaddropDir = dirOrOpts.deaddropDir || DEFAULT_DEADDROP_DIR;
    pid = dirOrOpts.pid !== undefined ? dirOrOpts.pid : process.pid;
    isPidAliveFn = dirOrOpts.isPidAliveFn || isPidAlive;
  }

  const sessionFile = getSessionFilePath(deaddropDir);
  try {
    if (fs.existsSync(sessionFile)) {
      try {
        const raw = fs.readFileSync(sessionFile, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === pid) {
          fs.unlinkSync(sessionFile);
          console.error(`[Dead Drop Sidecar] Cleaned up session file on exit.`);
          return true;
        } else if (data.pid && isPidAliveFn(data.pid)) {
          console.error(`[Dead Drop Sidecar] Session file is owned by live process PID ${data.pid}, leaving file intact.`);
          return false;
        } else {
          fs.unlinkSync(sessionFile);
          console.error(`[Dead Drop Sidecar] Cleaned up stale session file (dead PID ${data.pid}) on exit.`);
          return true;
        }
      } catch {
        fs.unlinkSync(sessionFile);
        return true;
      }
    }
  } catch (err) {
    console.error(`[Dead Drop Sidecar] Failed to cleanup session file: ${err.message}`);
    return false;
  }
  return false;
}

export function reconcileSession({
  address = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  deaddropDir = DEFAULT_DEADDROP_DIR,
  pid = process.pid,
  ppid = process.ppid,
  isPidAliveFn = isPidAlive,
} = {}) {
  if (!address || !csrfToken) {
    console.error(
      `[Dead Drop Sidecar] Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN in environment. ` +
      `Is this process running as an Antigravity sidecar?`
    );
    return { action: "error", error: "missing_credentials" };
  }

  if (!fs.existsSync(deaddropDir)) {
    fs.mkdirSync(deaddropDir, { recursive: true });
  }

  const sessionFile = getSessionFilePath(deaddropDir);

  if (!fs.existsSync(sessionFile)) {
    const session = exportSession({ address, csrfToken, deaddropDir, pid, ppid });
    return { action: "healed", reason: "missing", session };
  }

  let data;
  try {
    const raw = fs.readFileSync(sessionFile, "utf8");
    data = JSON.parse(raw);
  } catch {
    console.error(`[Dead Drop Sidecar] Corrupted session file detected. Re-exporting active session.`);
    const session = exportSession({ address, csrfToken, deaddropDir, pid, ppid });
    return { action: "healed", reason: "corrupted", session };
  }

  if (!data || typeof data !== "object" || typeof data.pid !== "number") {
    console.error(`[Dead Drop Sidecar] Invalid session data detected. Re-exporting active session.`);
    const session = exportSession({ address, csrfToken, deaddropDir, pid, ppid });
    return { action: "healed", reason: "corrupted", session };
  }

  if (data.pid === pid) {
    // Current file already matches this process's PID; nothing to heal, skip write entirely.
    return { action: "none", session: data };
  }

  const alive = isPidAliveFn(data.pid);
  if (!alive) {
    console.error(
      `[Dead Drop Sidecar] Detected stale session file with dead PID ${data.pid}. Re-asserting active session (PID: ${pid}).`
    );
    const session = exportSession({ address, csrfToken, deaddropDir, pid, ppid });
    return { action: "healed", reason: "dead_pid", previousPid: data.pid, session };
  }

  // Sibling collision: both processes are alive.
  if (data.pid > pid) {
    console.error(
      `[Dead Drop Sidecar] Detected live newer sibling sidecar PID ${data.pid} (our PID: ${pid}). Yielding.`
    );
    return { action: "yield", reason: "higher_pid_sibling", higherPid: data.pid };
  } else {
    console.error(
      `[Dead Drop Sidecar] Won tie-break against older sibling PID ${data.pid} (our PID: ${pid}). Re-asserting active session.`
    );
    const session = exportSession({ address, csrfToken, deaddropDir, pid, ppid });
    return { action: "healed", reason: "won_tiebreak", previousPid: data.pid, session };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const deaddropDir = DEFAULT_DEADDROP_DIR;
  const initial = reconcileSession({ deaddropDir });
  if (initial.action === "yield") {
    console.error(`[Dead Drop Sidecar] Yielded on startup to newer live session (PID: ${initial.higherPid}). Exiting.`);
    process.exit(0);
  }
  if (initial.action === "error") {
    process.exit(1);
  }

  let cleanedUp = false;
  const handleExit = (signal) => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.error(`[Dead Drop Sidecar] Received ${signal}, exiting...`);
    cleanupSession(deaddropDir);
    process.exit(0);
  };

  process.on("SIGTERM", () => handleExit("SIGTERM"));
  process.on("SIGINT", () => handleExit("SIGINT"));

  const checkInterval = setInterval(() => {
    // 1. Check parent process liveness
    if (process.ppid && process.ppid > 1) {
      try {
        process.kill(process.ppid, 0);
      } catch {
        console.error(`[Dead Drop Sidecar] Parent process ${process.ppid} is no longer running. Exiting.`);
        clearInterval(checkInterval);
        handleExit("PPID_GONE");
        return;
      }
    }

    // 2. Reconcile session file lease
    const result = reconcileSession({ deaddropDir });
    if (result.action === "yield") {
      clearInterval(checkInterval);
      handleExit("SUPERSEDED");
    }
  }, 5000);

  if (checkInterval.unref) checkInterval.unref();

  setInterval(() => {}, 1000 * 60 * 60);
}
