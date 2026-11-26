import fs from "node:fs";
import path from "node:path";

const MAX_READ_BYTES = 100 * 1024; // 100 KB cap per file read
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 50;
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "__pycache__",
  "screenshots",
  ".obsidian",
]);

const DENIED_FILENAMES = new Set([
  ".env",
  "oauth-tokens.json",
  "relay-store.json",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
]);

function isSensitivePath(targetPath: string): boolean {
  const base = path.basename(targetPath).toLowerCase();
  if (DENIED_FILENAMES.has(base)) return true;
  if (base.startsWith(".env.") && base !== ".env.example") return true;
  if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12")) return true;
  const segments = targetPath.split(path.sep).map((s) => s.toLowerCase());
  if (segments.includes(".git") || segments.includes(".ssh")) return true;
  return false;
}

export function getAllowedRoot(): string {
  const configured = process.env.LOCAL_FILES_ROOT?.trim();
  if (!configured) {
    throw new Error(
      "LOCAL_FILES_ROOT is not configured. Set LOCAL_FILES_ROOT in agent-relay-mcp/.env to a dedicated read-only folder before using local file tools."
    );
  }
  return fs.realpathSync(path.resolve(configured));
}

/**
 * Resolves a requested path strictly inside the allowed read-only root,
 * resolving symlinks via realpathSync and blocking secret/credential files.
 */
export function resolveAllowedPath(pathHint?: string): string {
  const root = getAllowedRoot();
  if (!pathHint || !pathHint.trim()) {
    return root;
  }

  const trimmed = pathHint.trim();
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(root, trimmed);

  if (!fs.existsSync(candidate)) {
    throw new Error(`Path does not exist: "${pathHint}"`);
  }

  const realCandidate = fs.realpathSync(candidate);
  const normRoot = root.toLowerCase();
  const normCandidate = realCandidate.toLowerCase();

  if (
    normCandidate !== normRoot &&
    !normCandidate.startsWith(normRoot + path.sep.toLowerCase())
  ) {
    throw new Error(
      `Access denied: "${pathHint}" resolves outside the allowed read-only root.`
    );
  }

  if (isSensitivePath(realCandidate)) {
    throw new Error(
      `Access denied: "${path.basename(realCandidate)}" is blocked by the secret-file deny list.`
    );
  }

  return realCandidate;
}

export function listLocalFiles(pathHint?: string, recursive = false): {
  root: string;
  target: string;
  entries: Array<{ name: string; relativePath: string; type: "file" | "dir"; size?: number }>;
  truncated: boolean;
} {
  const root = getAllowedRoot();
  const target = resolveAllowedPath(pathHint);

  if (!fs.existsSync(target)) {
    throw new Error(`Path does not exist: "${target}"`);
  }

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return {
      root,
      target,
      entries: [
        {
          name: path.basename(target),
          relativePath: path.relative(root, target),
          type: "file",
          size: stat.size,
        },
      ],
      truncated: false,
    };
  }

  const entries: Array<{
    name: string;
    relativePath: string;
    type: "file" | "dir";
    size?: number;
  }> = [];
  let truncated = false;

  function walk(dir: string, depth: number): void {
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (isSensitivePath(full)) continue;
      const rel = path.relative(root, full);
      if (item.isDirectory()) {
        entries.push({ name: item.name, relativePath: rel, type: "dir" });
        if (recursive && depth < 4) {
          walk(full, depth + 1);
        }
      } else {
        let size: number | undefined;
        try {
          size = fs.statSync(full).size;
        } catch {
          // ignore
        }
        entries.push({ name: item.name, relativePath: rel, type: "file", size });
      }
    }
  }

  walk(target, 0);
  return { root, target, entries, truncated };
}

export function readLocalFile(pathHint: string): {
  path: string;
  relativePath: string;
  sizeBytes: number;
  truncated: boolean;
  content: string;
} {
  const root = getAllowedRoot();
  const target = resolveAllowedPath(pathHint);

  if (!fs.existsSync(target)) {
    throw new Error(`File not found: "${target}"`);
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    throw new Error(
      `"${target}" is a directory, not a file. Use action: "list" to inspect directories.`
    );
  }

  const fd = fs.openSync(target, "r");
  try {
    const readLen = Math.min(stat.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    return {
      path: target,
      relativePath: path.relative(root, target),
      sizeBytes: stat.size,
      truncated: stat.size > MAX_READ_BYTES,
      content: buf.toString("utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readLocalBinary(pathHint: string, maxBytes = 4 * 1024 * 1024): {
  path: string;
  relativePath: string;
  sizeBytes: number;
  truncated: boolean;
  buffer: Buffer;
} {
  const root = getAllowedRoot();
  const target = resolveAllowedPath(pathHint);

  if (!fs.existsSync(target)) {
    throw new Error(`File not found: "${target}"`);
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    throw new Error(
      `"${target}" is a directory, not a file. Use action: "list" to inspect directories.`
    );
  }

  const readLen = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readLen);
  const fd = fs.openSync(target, "r");
  try {
    fs.readSync(fd, buf, 0, readLen, 0);
  } finally {
    fs.closeSync(fd);
  }

  return {
    path: target,
    relativePath: path.relative(root, target),
    sizeBytes: stat.size,
    truncated: stat.size > maxBytes,
    buffer: buf,
  };
}

export function searchLocalFiles(
  query: string,
  pathHint?: string,
  filenameOnly?: boolean
): {
  root: string;
  query: string;
  mode: "filename-only" | "filename-and-content";
  matches: Array<{
    relativePath: string;
    matchType: "filename" | "content";
    snippet?: string;
  }>;
  truncated: boolean;
} {
  const root = getAllowedRoot();
  const target = resolveAllowedPath(pathHint);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    throw new Error("Search query cannot be empty.");
  }

  // If the user searches for a file extension (e.g. ".png", ".svg", ".pdf"),
  // default to fast filename-only search so docs mentioning ".png" don't drown out real files.
  const isBareExtension = /^\.[a-z0-9]{1,6}$/i.test(needle);
  const onlyNames = filenameOnly ?? isBareExtension;

  const filenameMatches: Array<{
    relativePath: string;
    matchType: "filename" | "content";
    snippet?: string;
  }> = [];
  const contentMatches: Array<{
    relativePath: string;
    matchType: "filename" | "content";
    snippet?: string;
  }> = [];
  let truncated = false;

  function walk(dir: string, depth: number): void {
    if (filenameMatches.length >= MAX_SEARCH_MATCHES || depth > 6) {
      if (filenameMatches.length >= MAX_SEARCH_MATCHES) truncated = true;
      return;
    }
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (filenameMatches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        return;
      }
      if (item.isDirectory()) {
        if (IGNORED_DIRS.has(item.name) || item.name === ".obsidian") continue;
        const full = path.join(dir, item.name);
        if (item.name.toLowerCase().includes(needle)) {
          filenameMatches.push({
            relativePath: path.relative(root, full),
            matchType: "filename",
          });
        }
        walk(full, depth + 1);
      } else {
        const full = path.join(dir, item.name);
        if (isSensitivePath(full)) continue;
        const rel = path.relative(root, full);
        if (item.name.toLowerCase().includes(needle)) {
          filenameMatches.push({ relativePath: rel, matchType: "filename" });
          continue;
        }
        if (onlyNames || contentMatches.length >= MAX_SEARCH_MATCHES) continue;
        // Check small text files for content matches
        try {
          const stat = fs.statSync(full);
          if (stat.size > 128 * 1024) continue;
          const ext = path.extname(item.name).toLowerCase();
          if (
            ![
              ".txt",
              ".md",
              ".json",
              ".ts",
              ".tsx",
              ".js",
              ".jsx",
              ".py",
              ".html",
              ".css",
              ".csv",
              ".yml",
              ".yaml",
            ].includes(ext)
          ) {
            continue;
          }
          const text = fs.readFileSync(full, "utf8");
          const idx = text.toLowerCase().indexOf(needle);
          if (idx !== -1) {
            const start = Math.max(0, idx - 60);
            const end = Math.min(text.length, idx + needle.length + 100);
            contentMatches.push({
              relativePath: rel,
              matchType: "content",
              snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
            });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(target, 0);
  const combined = [...filenameMatches, ...contentMatches].slice(0, MAX_SEARCH_MATCHES);
  if (filenameMatches.length + contentMatches.length > MAX_SEARCH_MATCHES) {
    truncated = true;
  }
  return {
    root,
    query,
    mode: onlyNames ? "filename-only" : "filename-and-content",
    matches: combined,
    truncated,
  };
}
