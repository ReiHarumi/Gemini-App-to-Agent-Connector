import { spawn } from "node:child_process";
import path from "node:path";
import { getAllowedRoot } from "./localFiles.js";

const AGY_BIN =
  process.env.AGY_BIN?.trim() ||
  path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe");

export interface AgyRunOptions {
  prompt: string;
  model?: string;
  effort?: string;
  timeoutSeconds?: number;
  addAllowedDir?: boolean;
}

/**
 * Runs a single non-interactive prompt via the locally installed Antigravity CLI (`agy.exe -p`).
 * Uses your existing Antigravity subscription — no Gemini API key or deprecated Gemini CLI OAuth needed.
 */
export function runAgyPrint(options: AgyRunOptions): Promise<string> {
  const timeoutSec = Math.max(15, Math.min(options.timeoutSeconds ?? 120, 300));
  const model =
    options.model || process.env.AGY_MODEL?.trim() || "Gemini 4 Hydrogen (Medium)";
  const effort = options.effort || process.env.AGY_EFFORT?.trim() || "";

  const args = [
    "-p",
    options.prompt,
    "--model",
    model,
    "--print-timeout",
    `${timeoutSec}s`,
    "--disable-slash-commands",
  ];

  if (effort) {
    args.push("--effort", effort);
  }

  if (options.addAllowedDir) {
    args.push("--add-dir", getAllowedRoot());
  }

  return new Promise((resolve, reject) => {
    const child = spawn(AGY_BIN, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const killTimer = setTimeout(() => {
      child.kill();
      reject(new Error(`agy CLI timed out after ${timeoutSec + 10}s`));
    }, (timeoutSec + 10) * 1000);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`Failed to launch agy CLI (${AGY_BIN}): ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const trimmedOut = stdout.trim();
      if (code === 0 && trimmedOut) {
        resolve(trimmedOut);
        return;
      }
      if (trimmedOut && !trimmedOut.includes("AGY_ERROR:")) {
        resolve(trimmedOut);
        return;
      }
      reject(
        new Error(
          `agy CLI exited with code ${code}: ${(stderr || stdout || "No output").trim().slice(0, 600)}`
        )
      );
    });
  });
}

/**
 * Fires a lightweight Windows desktop notification when a task requires the Gemini Web App
 * (e.g. Google Photos requests). Non-blocking and best-effort.
 */
export function notifyWindows(title: string, message: string): void {
  if (process.platform !== "win32") return;
  const safeTitle = title.replace(/['"`$]/g, " ").slice(0, 80);
  const safeMsg = message.replace(/['"`$\r\n]/g, " ").slice(0, 200);

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${safeTitle}'
$n.BalloonTipText = '${safeMsg}'
$n.Visible = $true
$n.ShowBalloonTip(6000)
Start-Sleep -Seconds 7
$n.Dispose()
`;

  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psScript],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    child.unref();
  } catch {
    // best-effort notification only
  }
}
