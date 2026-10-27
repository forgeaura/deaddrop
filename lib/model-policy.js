/**
 * Model denylist matching for `blocked_models` config arrays.
 *
 * Patterns are whole-string globs: `*` matches any run of characters
 * (including newlines), everything else is literal, and matching is
 * case-insensitive. `"sonnet"` blocks only `sonnet`; `"*sonnet*"` blocks
 * any model containing it.
 *
 * Malformed input throws rather than being ignored, so a broken denylist
 * blocks instead of failing open.
 */

function globToRegExp(pattern) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`, "i");
}

/**
 * Returns the first pattern in `patterns` that matches `model`, or null.
 * Throws if `model` is not a non-empty string or `patterns` is not an array
 * of non-empty strings. `label` names the config key in that error.
 */
export function findBlockingPattern(model, patterns, label = "blocked_models") {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }

  const candidate = model.trim();
  for (const pattern of patterns) {
    if (globToRegExp(pattern.trim()).test(candidate)) {
      return pattern;
    }
  }
  return null;
}
