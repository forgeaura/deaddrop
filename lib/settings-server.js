import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DEADDROP_DIR, ensureDirectory, readMessages } from "./messages.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HTML_FILE_PATH = path.join(__dirname, "settings.html");

export const DEFAULT_MODEL = "claude-haiku-5-5";

export const DEFAULT_CONFIG = {
  agents: {
    antigravity: {
      wake_on_mail: true,
      wake_method: "agentapi",
      conversation_id: ""
    },
    claude: {
      wake_on_mail: false,
      wake_method: "unsupported",
      default_model: DEFAULT_MODEL,
      blocked_models: [],
      default_permission_mode: "auto",
      allowed_permission_modes: ["auto", "default", "acceptEdits", "plan"],
      default_handoff: "desktop"
    }
  }
};

// Fields the settings HTTP API may read back but never write (see POST /api/config).
export const CONFIG_FILE_ONLY_FIELDS = ["default_model", "blocked_models"];

export function getConfigFilePath(deaddropDir = DEFAULT_DEADDROP_DIR) {
  return path.join(deaddropDir, ".config.json");
}

function invalidConfigMessage(configPath) {
  return `Config file at ${configPath} is not valid JSON; fix it by hand`;
}

/**
 * Reads .config.json exactly as it is on disk, with no defaults merged in.
 * Used by the settings UI so a save can only ever send back what the file holds.
 * status: "ok" | "missing" | "invalid"
 */
export function readConfigFromDisk(deaddropDir = DEFAULT_DEADDROP_DIR) {
  const configPath = getConfigFilePath(deaddropDir);
  if (!fs.existsSync(configPath)) {
    return { status: "missing", config: {}, path: configPath };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "invalid", config: {}, path: configPath };
    }
    return { status: "ok", config: parsed, path: configPath };
  } catch {
    return { status: "invalid", config: {}, path: configPath };
  }
}

/**
 * Runtime config for launches. A missing file or a file without an agents
 * object means defaults. An unparseable file throws: falling back to defaults
 * would silently drop the user's blocked_models.
 */
export function loadConfig(deaddropDir = DEFAULT_DEADDROP_DIR) {
  const onDisk = readConfigFromDisk(deaddropDir);
  if (onDisk.status === "invalid") {
    throw new Error(invalidConfigMessage(onDisk.path));
  }
  if (onDisk.status === "missing" || !onDisk.config.agents || typeof onDisk.config.agents !== "object") {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  return onDisk.config;
}

export function saveConfig(deaddropDir = DEFAULT_DEADDROP_DIR, newAgents = {}) {
  ensureDirectory(deaddropDir);
  const configPath = getConfigFilePath(deaddropDir);

  // Never overwrite a file we cannot parse: that would silently drop the user's settings.
  let currentConfig = {};
  if (fs.existsSync(configPath)) {
    const onDisk = readConfigFromDisk(deaddropDir);
    if (onDisk.status !== "ok") {
      throw new Error(invalidConfigMessage(configPath));
    }
    currentConfig = onDisk.config;
  }

  if (!currentConfig.agents || typeof currentConfig.agents !== "object") {
    currentConfig.agents = {};
  }

  // Merge updated fields per agent, preserving unmanaged properties (like agentapi_path)
  for (const [key, incoming] of Object.entries(newAgents)) {
    if (!incoming || typeof incoming !== "object") continue;

    const existingAgent = currentConfig.agents[key] || {};
    const wakeMethod = incoming.wake_method || existingAgent.wake_method;
    if (!wakeMethod) {
      throw new Error(`Missing required 'wake_method' for agent '${key}' (no existing on-disk record)`);
    }
    const isUnsupported = wakeMethod === "unsupported";

    currentConfig.agents[key] = {
      ...existingAgent,
      ...incoming,
      wake_method: wakeMethod,
      wake_on_mail: isUnsupported ? false : Boolean(incoming.wake_on_mail)
    };

    if (wakeMethod === "agentapi" && incoming.conversation_id !== undefined) {
      currentConfig.agents[key].conversation_id = String(incoming.conversation_id || "").trim();
    }
  }

  // Write atomically using temporary file and rename
  const tmpPath = path.join(deaddropDir, `.config.json.tmp.${process.pid}.${Date.now()}`);
  const jsonContent = JSON.stringify(currentConfig, null, 2) + "\n";
  fs.writeFileSync(tmpPath, jsonContent, "utf8");
  fs.renameSync(tmpPath, configPath);

  return currentConfig;
}

export function createSettingsRequestHandler({ deaddropDir = DEFAULT_DEADDROP_DIR } = {}) {
  return async function handleRequest(req, res) {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // Route: GET /
    if (method === "GET" && pathname === "/") {
      try {
        const html = fs.readFileSync(HTML_FILE_PATH, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error: Failed to load settings page");
      }
      return;
    }

    // Route: GET /api/state
    if (method === "GET" && pathname === "/api/state") {
      try {
        // On-disk config only: the UI saves back whatever it is given, so defaults must not appear here.
        const onDisk = readConfigFromDisk(deaddropDir);
        const rawMessages = readMessages({
          for: "all",
          unread_only: false,
          limit: 30,
          deaddropDir
        });

        const messages = rawMessages.map((msg) => ({
          id: msg.id,
          filename: msg.filename,
          date: msg.date,
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          re_issue: msg.re_issue,
          read: msg.read,
          read_at: msg.read_at
        }));

        const responsePayload = {
          mailboxDir: path.resolve(deaddropDir),
          config: onDisk.config,
          config_status: onDisk.status,
          config_path: onDisk.path,
          messages
        };

        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        });
        res.end(JSON.stringify(responsePayload));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Route: POST /api/config
    if (method === "POST" && pathname === "/api/config") {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          // 1 MB limit
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
          req.destroy();
        }
      });

      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || typeof parsed !== "object" || !parsed.agents || typeof parsed.agents !== "object") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid payload: 'agents' object is required" }));
            return;
          }

          // Validate individual agent configs against existing on-disk records
          const configPath = getConfigFilePath(deaddropDir);
          let onDiskAgents = {};
          if (fs.existsSync(configPath)) {
            try {
              const raw = fs.readFileSync(configPath, "utf8");
              const parsedOnDisk = JSON.parse(raw);
              if (parsedOnDisk && typeof parsedOnDisk.agents === "object") {
                onDiskAgents = parsedOnDisk.agents;
              }
            } catch {
              onDiskAgents = {};
            }
          }

          for (const [key, agent] of Object.entries(parsed.agents)) {
            if (!agent || typeof agent !== "object") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Invalid agent configuration for '${key}'` }));
              return;
            }
            const existingAgent = onDiskAgents[key];
            const wakeMethod = agent.wake_method || (existingAgent && existingAgent.wake_method);
            if (!wakeMethod) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: `Missing required 'wake_method' for agent '${key}' (no existing on-disk record)`
              }));
              return;
            }
            if (agent.wake_on_mail !== undefined && typeof agent.wake_on_mail !== "boolean") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `wake_on_mail must be a boolean for agent '${key}'` }));
              return;
            }
            if (agent.conversation_id !== undefined && typeof agent.conversation_id !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `conversation_id must be a string for agent '${key}'` }));
              return;
            }
          }

          // default_model and blocked_models are config-file-only: any local process can reach this
          // listener, so drop them from every incoming agent. saveConfig keeps whatever is on disk.
          const forwardedAgents = {};
          for (const [key, agent] of Object.entries(parsed.agents)) {
            const forwarded = { ...agent };
            for (const field of CONFIG_FILE_ONLY_FIELDS) {
              delete forwarded[field];
            }
            forwardedAgents[key] = forwarded;
          }

          let updatedConfig;
          try {
            updatedConfig = saveConfig(deaddropDir, forwardedAgents);
          } catch (err) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, config: updatedConfig }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Failed to parse JSON: ${err.message}` }));
        }
      });
      return;
    }

    // 404 Not Found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}

export function startSettingsServer({
  port = 3344,
  deaddropDir = DEFAULT_DEADDROP_DIR,
  isCli = false
} = {}) {
  ensureDirectory(deaddropDir);
  const requestHandler = createSettingsRequestHandler({ deaddropDir });
  const server = http.createServer(requestHandler);

  const HOST = "127.0.0.1"; // Strictly loopback only

  return new Promise((resolve, reject) => {
    function tryListen(targetPort) {
      const onError = (err) => {
        if (err.code === "EADDRINUSE" && targetPort !== 0) {
          console.warn(`[Dead Drop] Port ${targetPort} is in use; falling back to an available port...`);
          server.removeListener("error", onError);
          tryListen(0);
        } else {
          server.removeListener("error", onError);
          reject(err);
        }
      };

      server.once("error", onError);
      server.listen(targetPort, HOST, () => {
        server.removeListener("error", onError);
        const assignedPort = server.address().port;
        const url = `http://${HOST}:${assignedPort}/`;

        if (isCli) {
          console.log(`[Dead Drop] Settings server listening at ${url}`);
          console.log(`[Dead Drop] Mailbox: ${path.resolve(deaddropDir)}`);
          console.log("Press Ctrl+C to stop.");

          let shuttingDown = false;
          const shutdown = () => {
            if (shuttingDown) return;
            shuttingDown = true;
            console.log("\n[Dead Drop] Stopping settings server...");
            server.close(() => {
              console.log("[Dead Drop] Settings server stopped.");
              process.exit(0);
            });
            setTimeout(() => process.exit(0), 1000).unref();
          };

          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
        }

        resolve({
          server,
          port: assignedPort,
          url,
          close: () => new Promise((res) => server.close(res))
        });
      });
    }

    tryListen(port);
  });
}
