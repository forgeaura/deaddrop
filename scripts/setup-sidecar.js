#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SIDECAR_DIR = path.join(os.homedir(), ".gemini", "config", "sidecars", "deaddrop");
export const DEFAULT_SIDECAR_CONFIG_PATH = path.join(DEFAULT_SIDECAR_DIR, "sidecar.json");
export const DEFAULT_SIDECAR_SCRIPT_PATH = path.resolve(__dirname, "../bin/sidecar.js");

export function setupSidecar({
  sidecarDir = DEFAULT_SIDECAR_DIR,
  sidecarConfigPath = DEFAULT_SIDECAR_CONFIG_PATH,
  sidecarScriptPath = DEFAULT_SIDECAR_SCRIPT_PATH,
  nodeExecutable = process.execPath,
  deaddropDir = process.env.DEADDROP_DIR,
  uninstall = false,
} = {}) {
  if (uninstall) {
    if (fs.existsSync(sidecarConfigPath)) {
      fs.unlinkSync(sidecarConfigPath);
      console.log(`[Dead Drop] Removed sidecar configuration: ${sidecarConfigPath}`);
    } else {
      console.log(`[Dead Drop] No sidecar configuration found at: ${sidecarConfigPath}`);
    }
    return { uninstalled: true };
  }

  if (!fs.existsSync(sidecarDir)) {
    fs.mkdirSync(sidecarDir, { recursive: true });
  }

  const config = {
    command: nodeExecutable,
    args: [sidecarScriptPath],
    restart_policy: "always",
    description: "Exports active Antigravity session address and token for Dead Drop wake-up",
  };

  if (deaddropDir) {
    config.env = { DEADDROP_DIR: deaddropDir };
  }

  fs.writeFileSync(sidecarConfigPath, JSON.stringify(config, null, 2), "utf8");
  console.log(`[Dead Drop] Successfully registered Antigravity sidecar at: ${sidecarConfigPath}`);
  console.log(`Antigravity will automatically launch this sidecar to export session credentials to your mailbox.`);
  return { config, path: sidecarConfigPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const uninstall = process.argv.includes("--uninstall");
  setupSidecar({ uninstall });
}
