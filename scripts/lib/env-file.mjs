/**
 * Minimal, surgical `.env` text editing.
 *
 * `.env.local` is co-owned: Convex writes CONVEX_DEPLOYMENT and the
 * NEXT_PUBLIC_* URLs into it, Vercel adds its own entries, and
 * `npm run setup:worktree` adds PORT. So editing is line-scoped — read one
 * name, rewrite one name — rather than parse-and-reserialize, which would
 * discard the comments and blank-line grouping the other writers rely on.
 *
 * Value parsing matches `dotenv` (what `dotenv -e .env.local` will do at
 * runtime) for the cases that appear in this file: optional quotes, and an
 * inline `#` comment on unquoted values.
 */

const ASSIGNMENT = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;

function parseValue(rawValue) {
  const quoted = rawValue.match(/^(['"`])([\s\S]*?)\1/);
  if (quoted) {
    return quoted[2];
  }
  return rawValue.replace(/\s+#.*$/, "").trim();
}

/** The value assigned to `name`, or null if the file does not assign it. */
export function readEnvVar(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(ASSIGNMENT);
    if (match && match[1] === name) {
      return parseValue(match[2]);
    }
  }
  return null;
}

/**
 * `text` with `name` set to `value`: replaced in place if already assigned,
 * otherwise appended as a new blank-line-separated entry, optionally preceded
 * by `comment`. The comment is for first-time readers of the file, so it is
 * only written alongside a new entry — never re-added on a rewrite.
 */
export function upsertEnvVar(text, name, value, comment) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => {
    const match = line.match(ASSIGNMENT);
    return match !== null && match[1] === name;
  });

  if (index !== -1) {
    lines[index] = `${name}=${value}`;
    return lines.join("\n");
  }

  const entry = comment
    ? `${comment}\n${name}=${value}\n`
    : `${name}=${value}\n`;
  if (text === "") {
    return entry;
  }
  return `${text.replace(/\n*$/, "")}\n\n${entry}`;
}
