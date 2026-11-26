# agent-relay-mcp

A **two-way multi-agent Streamable HTTP MCP hub** connecting:
- **Gemini Web App (`gemini.google.com/devmode`)** — Task mode (`Hydrogen`/`Neon`), Chat mode (`Deep research`, `Create video`, `Create music`, `Guided learning`), `Create image`, and Google Photos (`relay_google_photos`)
- **Antigravity (AGY)** — read-only local computer file access (`relay_request_local_files`) and local dev workflows
- **Any other MCP-compatible agent** (Claude, Cursor, custom scripts, etc.)

## Endpoints
- **Permanent HTTPS (via Tailscale Funnel):** `https://<your-machine>.<your-tailnet>.ts.net/relay/mcp`
- **Local (no OAuth required on `127.0.0.1`):** `http://127.0.0.1:3001/mcp`
- **Health:** `http://127.0.0.1:3001/health`

## Setup
```bash
cp .env.example .env
# Fill in LOCAL_FILES_ROOT, PUBLIC_BASE_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET
npm install
npm run build
npm start
```
