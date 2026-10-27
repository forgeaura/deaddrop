// Process-execution helpers shared by the Claude and Antigravity launchers and
// the agentapi wake-up. They live here rather than in claude-cli.js because
// messages.js needs them too, and claude-cli.js already imports messages.js.

/**
 * Strips ANSI 7-bit and 8-bit escape codes.
 */
export function stripAnsi(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

/**
 * Replaces every occurrence of each secret in `text` with "<redacted>".
 * Empty or non-string secrets are ignored.
 */
export function redactSecrets(text, secrets = []) {
  let result = typeof text === "string" ? text : String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      result = result.split(secret).join("<redacted>");
    }
  }
  return result;
}

/**
 * Formats process execution errors with exit code, err.code, stderr, and stdout
 * to ensure failures are easily diagnosable (addressing Issue #18 lessons).
 * Any value in `secrets` is redacted from the result.
 */
export function formatExecError(err, stdout = "", stderr = "", { secrets = [] } = {}) {
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
  return redactSecrets(lines.join("\n"), secrets);
}
