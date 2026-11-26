import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface MediaEntry {
  token: string;
  filePath: string;
  mimeType: string;
  createdAt: number;
}

const GENERATED_MEDIA_DIR =
  process.env.GENERATED_MEDIA_DIR?.trim() ||
  path.resolve(process.cwd(), "..", "generated-media");

const MEDIA_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

const MAX_MEDIA_ENTRIES = 150;
const mediaMap = new Map<string, MediaEntry>();

export function getGeneratedMediaDir(): string {
  return path.resolve(GENERATED_MEDIA_DIR);
}

export function getImageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_MIME_MAP[ext] ?? null;
}

export function isRasterImage(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
}

export function registerMediaFile(filePath: string, mimeType: string): string {
  const ext = path.extname(filePath).toLowerCase() || MIME_TO_EXT[mimeType] || ".bin";
  const token = `${crypto.randomBytes(12).toString("hex")}${ext}`;
  mediaMap.set(token, {
    token,
    filePath,
    mimeType,
    createdAt: Date.now(),
  });

  if (mediaMap.size > MAX_MEDIA_ENTRIES) {
    const oldestKey = mediaMap.keys().next().value;
    if (oldestKey) mediaMap.delete(oldestKey);
  }
  return token;
}

export function saveGeneratedMedia(
  buffer: Buffer,
  mimeType: string,
  taskId: string
): {
  filePath: string;
  filename: string;
  token: string;
  mimeType: string;
  sizeBytes: number;
} {
  const dir = getGeneratedMediaDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cleanMime = mimeType.split(";")[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[cleanMime] || ".bin";
  const filename = `${Date.now()}-${taskId}${ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  const token = registerMediaFile(filePath, cleanMime);
  return {
    filePath,
    filename,
    token,
    mimeType: cleanMime,
    sizeBytes: buffer.length,
  };
}

const MEDIA_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function lookupMediaFile(token: string): MediaEntry | null {
  if (!/^[a-f0-9]+\.(png|jpg|jpeg|webp|gif|svg|mp4|webm|mp3|wav|ogg|m4a)$/.test(token)) {
    return null;
  }
  const entry = mediaMap.get(token);
  if (!entry || Date.now() - entry.createdAt > MEDIA_TTL_MS || !fs.existsSync(entry.filePath)) {
    if (entry) mediaMap.delete(token);
    return null;
  }
  return entry;
}
