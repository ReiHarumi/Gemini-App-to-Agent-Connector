import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");
const MAX_SCREENSHOTS = 50;

function ensureDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

export function saveScreenshot(buffer: Buffer, ext: "jpg" | "png" = "jpg"): {
  filename: string;
  filePath: string;
} {
  ensureDir();
  const id = crypto.randomBytes(12).toString("hex");
  const filename = `${Date.now()}-${id}.${ext}`;
  const filePath = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  pruneOldScreenshots();
  return { filename, filePath };
}

export function resolveScreenshotPath(filename: string): string | null {
  // Strict allowlist to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/.test(filename)) {
    return null;
  }
  const fullPath = path.join(SCREENSHOTS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return fullPath;
}

function pruneOldScreenshots(): void {
  try {
    const entries = fs
      .readdirSync(SCREENSHOTS_DIR)
      .map((name) => {
        const full = path.join(SCREENSHOTS_DIR, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const old of entries.slice(MAX_SCREENSHOTS)) {
      fs.unlinkSync(old.full);
    }
  } catch {
    // ignore cleanup errors
  }
}
