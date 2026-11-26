# Gemini App to Agent Connector

A self-hosted, OAuth 2.0-secured two-way MCP bridge connecting **Google Gemini Web App** (`gemini.google.com/devmode`) with local AI coding agents (Antigravity, Claude, Cursor, or any MCP-compatible client) — with **Playwright + Chrome DevTools + Firecrawl** browser automation, **5-tab parallel execution**, and a silent **Windows Hidden Icons tray launcher**.

## Architecture

| Component | Port | Purpose |
| :--- | :---: | :--- |
| `gemini-browser-mcp/` | `3000` | Streamable HTTP MCP server giving Gemini Web App Playwright browser control, Chrome DevTools (CDP), local Readability/Turndown or Firecrawl scraping, and HTTPS screenshot hosting. |
| `agent-relay-mcp/` | `3001` | Two-way multi-agent MCP hub (16 tools) routing **Task mode** (`Hydrogen`/`Neon`, `Create image`, `Google Photos`), **Chat mode** (`Deep research` with 2-step approval, `Create video`, `Create music`, `Guided learning`), and read-only local file access with OAuth 2.0 + localhost-only SSE push (`/bridge/stream`). |
| `gemini-relay-extension/` | Chrome MV3 | Manifest V3 extension that connects to `127.0.0.1:3001/bridge/stream`, auto-dismisses DevMode's app modal, switches `Task` / `Chat` mode & models, runs up to **5 parallel Gemini tabs**, auto-captures generated media, and auto-reloads on updates. |
| `mcp-tray-launcher/` | Windows | Silent Windows Hidden Icons tray launcher (`mcp-tray.ps1` + `start-hidden.vbs`) with 10s watchdog auto-restart and **Hide/Show Chrome to Tray** controls. |

## Quick Start (1-Command Cross-Platform Setup)

Works on **Windows, macOS, and Linux** — or hand this repo URL to your AI coding agent (Claude, Antigravity, Cursor), which will follow [AGENTS.md](./AGENTS.md) and [llms.txt](./llms.txt) automatically:

```bash
git clone https://github.com/ReiHarumi/Gemini-App-to-Agent-Connector.git
cd Gemini-App-to-Agent-Connector
node setup.mjs --local-files-root "/path/to/dedicated-safe-folder" --public-host "https://<your-machine>.<your-tailnet>.ts.net"
```

`setup.mjs` generates strong random OAuth 2.0 credentials for both servers, writes both `.env` files, installs dependencies, builds both MCPs, and prints your exact copy-paste Gemini DevMode setup block.

> **Important:** Both MCP servers **fail closed** (`503`) on external traffic until OAuth credentials are set in `.env`. Always point `LOCAL_FILES_ROOT` at a dedicated non-sensitive folder (secret files like `.env`, `oauth-tokens.json`, `*.key`, and escaping symlinks are also hard-blocked). See [SECURITY.md](./SECURITY.md).

### 1. Start Both Servers
- **macOS / Linux / Windows:** Run `npm start` inside `gemini-browser-mcp/` and `agent-relay-mcp/` (or `docker compose up` for Browser MCP).
- **Windows (optional silent tray):** Double-click `mcp-tray-launcher/start-hidden.vbs` to run both servers invisibly in Hidden Icons with **Hide/Show Chrome to Tray**.

### 2. Expose Permanently Over HTTPS (Tailscale Funnel)
```powershell
tailscale funnel --bg 3000
tailscale funnel --bg --set-path=/relay 3001
```
Your permanent HTTPS endpoints will be:
- Browser MCP: `https://<your-machine>.<your-tailnet>.ts.net/mcp`
- Agent Relay MCP: `https://<your-machine>.<your-tailnet>.ts.net/relay/mcp`

### 3. Load the Chrome Extension
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `gemini-relay-extension/`.
3. Open `https://gemini.google.com/devmode` and connect both MCP URLs with your OAuth 2.0 credentials.

### 4. Connect Local Agents (`mcp_config.json`)
Local agents on `127.0.0.1` connect directly with zero OAuth overhead:
```json
{
  "mcpServers": {
    "agent-relay": {
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

### 5. Optional: Auto-Start Silently in Windows Hidden Icons Tray
Double-click `mcp-tray-launcher/start-hidden.vbs` (or register it in Windows Task Scheduler `AtLogOn`).

## Security Model
- **OAuth 2.0 (RFC 8414 + RFC 9728 + PKCE)** required on all external/Tailscale Funnel `/mcp` traffic; tokens persisted locally in `data/oauth-tokens.json` (gitignored).
- **`/bridge/*` endpoints** strictly locked to `127.0.0.1` (`403 Forbidden` from external hosts).
- **Local file worker** enforces strict **read-only** path sandboxing inside `LOCAL_FILES_ROOT`.
- **Hosted media/screenshots** use 96-bit random tokens with a 15-minute TTL.

## License
[MIT](./LICENSE)
