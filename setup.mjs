#!/usr/bin/env node
/**
 * Cross-platform (Windows / macOS / Linux) 1-command bootstrapper for
 * Gemini App to Agent Connector.
 *
 * Usage:
 *   node setup.mjs
 *   node setup.mjs --local-files-root "/path/to/safe/folder" --public-host "https://my-pc.tailnet.ts.net"
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(flag, fallback = "") {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const localFilesRoot = getArg("--local-files-root", "");
const publicHost = getArg("--public-host", "").replace(/\/+$/, "");
const skipInstall = args.includes("--skip-install");

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function upsertEnv(envPath, defaults) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const result = {};

  for (const [key, val] of Object.entries(defaults)) {
    const regex = new RegExp(`^${key}=(.*)$`, "m");
    const match = content.match(regex);
    if (match && match[1].trim()) {
      result[key] = match[1].trim();
    } else if (match) {
      content = content.replace(regex, `${key}=${val}`);
      result[key] = val;
    } else {
      content += `${content.endsWith("\n") || !content ? "" : "\n"}${key}=${val}\n`;
      result[key] = val;
    }
  }

  fs.writeFileSync(envPath, content, "utf8");
  return result;
}

console.log("=== Gemini App to Agent Connector — Automated Setup ===\n");

const browserDir = path.join(__dirname, "gemini-browser-mcp");
const relayDir = path.join(__dirname, "agent-relay-mcp");

// 1. Generate strong OAuth 2.0 credentials for both MCP servers
const browserEnv = upsertEnv(path.join(browserDir, ".env"), {
  PORT: "3000",
  HEADLESS: "true",
  OAUTH_CLIENT_ID: `gemini-browser-${randomHex(8)}`,
  OAUTH_CLIENT_SECRET: randomHex(24),
});

const relayEnv = upsertEnv(path.join(relayDir, ".env"), {
  PORT: "3001",
  PUBLIC_BASE_URL: publicHost ? `${publicHost}/relay` : "",
  LOCAL_FILES_ROOT: localFilesRoot,
  OAUTH_CLIENT_ID: `gemini-relay-${randomHex(8)}`,
  OAUTH_CLIENT_SECRET: randomHex(24),
});

if (!skipInstall) {
  console.log("1/3 Installing & building gemini-browser-mcp...");
  execSync("npm install && npm run build", { cwd: browserDir, stdio: "inherit" });

  console.log("\n2/3 Installing & building agent-relay-mcp...");
  execSync("npm install && npm run build", { cwd: relayDir, stdio: "inherit" });

  console.log("\n3/3 Ensuring Playwright Chromium is installed...");
  try {
    execSync("npx playwright install chromium", { cwd: browserDir, stdio: "inherit" });
  } catch {
    console.warn("Note: Playwright browser install failed or skipped — run `npx playwright install chromium` inside gemini-browser-mcp/ later.");
  }
}

console.log("\n========================================================");
console.log("SETUP COMPLETE! Next steps:");
console.log("========================================================\n");
console.log("1. Start both servers:");
console.log("   Terminal 1: cd gemini-browser-mcp && npm start");
console.log("   Terminal 2: cd agent-relay-mcp && npm start");
if (process.platform === "win32") {
  console.log("   (Or on Windows, double-click mcp-tray-launcher/start-hidden.vbs to run silently in Hidden Icons!)");
}
console.log("\n2. Expose permanently over HTTPS with Tailscale Funnel:");
console.log("   tailscale funnel --bg 3000");
console.log("   tailscale funnel --bg --set-path=/relay 3001");
console.log("\n3. Load Chrome Extension:");
console.log(`   chrome://extensions -> Developer mode -> Load unpacked -> ${path.join(__dirname, "gemini-relay-extension")}`);
console.log("\n4. Add both MCPs in https://gemini.google.com/devmode with these generated OAuth 2.0 credentials:\n");
console.log("   [Gemini Browser MCP]");
console.log(`   URL:           ${publicHost || "https://<your-machine>.<your-tailnet>.ts.net"}/mcp`);
console.log(`   Client ID:     ${browserEnv.OAUTH_CLIENT_ID}`);
console.log(`   Client Secret: ${browserEnv.OAUTH_CLIENT_SECRET}\n`);
console.log("   [Agent Relay MCP]");
console.log(`   URL:           ${publicHost || "https://<your-machine>.<your-tailnet>.ts.net"}/relay/mcp`);
console.log(`   Client ID:     ${relayEnv.OAUTH_CLIENT_ID}`);
console.log(`   Client Secret: ${relayEnv.OAUTH_CLIENT_SECRET}\n`);
if (!relayEnv.LOCAL_FILES_ROOT) {
  console.log("NOTE: Set LOCAL_FILES_ROOT in agent-relay-mcp/.env to a dedicated non-sensitive folder if you want Gemini to read local files.");
}
