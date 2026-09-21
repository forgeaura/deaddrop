#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { SESSION_FILENAME } from "../lib/messages.js";

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

export function cleanupSession(deaddropDir = DEFAULT_DEADDROP_DIR) {
  const sessionFile = getSessionFilePath(deaddropDir);
  try {
    if (fs.existsSync(sessionFile)) {
      try {
        const raw = fs.readFileSync(sessionFile, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === process.pid) {
          fs.unlinkSync(sessionFile);
          console.error(`[Dead Drop Sidecar] Cleaned up session file on exit.`);
        }
      } catch {
        fs.unlinkSync(sessionFile);
      }
    }
  } catch (err) {
    console.error(`[Dead Drop Sidecar] Failed to cleanup session file: ${err.message}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const deaddropDir = DEFAULT_DEADDROP_DIR;
  const session = exportSession({ deaddropDir });
  if (!session) {
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

  if (process.ppid && process.ppid > 1) {
    const ppidCheckInterval = setInterval(() => {
      try {
        process.kill(process.ppid, 0);
      } catch {
        console.error(`[Dead Drop Sidecar] Parent process ${process.ppid} is no longer running. Exiting.`);
        clearInterval(ppidCheckInterval);
        handleExit("PPID_GONE");
      }
    }, 5000);
    if (ppidCheckInterval.unref) ppidCheckInterval.unref();
  }

  setInterval(() => {}, 1000 * 60 * 60);
}
