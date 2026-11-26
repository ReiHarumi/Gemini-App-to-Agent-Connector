# Gemini App to Agent Connector

A self-hosted, OAuth 2.0-secured two-way MCP bridge connecting **Google Gemini Web App** (`gemini.google.com/devmode`) with local AI coding agents (Antigravity, Claude, Cursor, or any MCP-compatible client) — with **Playwright + Chrome DevTools + Firecrawl** browser automation, **5-tab parallel execution**, and a silent **Windows Hidden Icons tray launcher**.

## Architecture

| Component | Port | Purpose |
| :--- | :---: | :--- |
| `gemini-browser-mcp/` | `3000` | Streamable HTTP MCP server giving Gemini Web App Playwright browser control, Chrome DevTools (CDP), local Readability/Turndown or Firecrawl scraping, and HTTPS screenshot hosting. |
| `agent-relay-mcp/` | `3001` | Two-way multi-agent MCP hub (16 tools) routing **Task mode** (`Hydrogen`/`Neon`, `Create image`, `Google Photos`), **Chat mode** (`Deep research` with 2-step approval, `Create video`, `Create music`, `Guided learning`), and read-only local file access with OAuth 2.0 + localhost-only SSE push (`/bridge/stream`). |
| `gemini-relay-extension/` | Chrome MV3 | Manifest V3 extension that connects to `127.0.0.1:3001/bridge/stream`, auto-dismisses DevMode's app modal, switches `Task` / `Chat` mode & models, runs up to **5 parallel Gemini tabs**, auto-captures generated media, and auto-reloads on updates. |
| `mcp-tray-launcher/` | Windows | Silent Windows Hidden Icons tray launcher (`mcp-tray.ps1` + `start-hidden.vbs`) with 10s watchdog auto-restart and **Hide/Show Chrome to Tray** controls. |

## Quick Start

### 1. Install & Build Both MCP Servers
```powershell
cd gemini-browser-mcp
copy .env.example .env
npm install
npx playwright install chromium
npm run build

cd ..\agent-relay-mcp
copy .env.example .env
npm install
npm run build
```

Fill in `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `LOCAL_FILES_ROOT`, and `PUBLIC_BASE_URL` in each `.env`.

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
