# AGENTS.md — AI Agent Setup & Maintenance Guide

This file is designed so any AI coding agent (Claude Code, Antigravity, Cursor, Codex, etc.) can install, configure, and troubleshoot **Gemini App to Agent Connector** for a user in under 2 minutes.

## Repository Layout
- `setup.mjs` — Cross-platform Node.js bootstrapper (generates OAuth 2.0 secrets, writes `.env`, installs & builds both servers).
- `gemini-browser-mcp/` — Streamable HTTP MCP server on port `3000` (Playwright, Chrome DevTools CDP, local Readability/Turndown or Firecrawl scraping, HTTPS screenshots).
- `agent-relay-mcp/` — Streamable HTTP MCP hub on port `3001` (16 tools: Task mode `relay_run_gemini_task`, Chat mode `relay_deep_research` with 2-step approval, `relay_create_image`, `relay_create_video`, `relay_create_music`, `relay_google_photos`, read-only `relay_request_local_files`, localhost-only SSE push `/bridge/stream`).
- `gemini-relay-extension/` — Chrome Manifest V3 extension (SSE push listener, 5-tab parallel pool, auto-dismisses DevMode modal, auto-reloads on disk changes).
- `mcp-tray-launcher/` — Optional Windows-only Hidden Icons tray launcher (`mcp-tray.ps1` + `start-hidden.vbs`).

## Automated Setup Procedure (For Agents)
1. Ask the user for:
   - A **dedicated, non-sensitive folder** to expose read-only as `LOCAL_FILES_ROOT` (never point it at `$HOME` or a folder containing `.env` / secrets).
   - Their HTTPS tunnel URL (recommended: `tailscale funnel --bg 3000` and `tailscale funnel --bg --set-path=/relay 3001`).
2. Run:
   ```bash
   node setup.mjs --local-files-root "<safe-folder>" --public-host "https://<machine>.<tailnet>.ts.net"
   ```
3. Start both servers (`npm start` in `gemini-browser-mcp/` and `agent-relay-mcp/`, or `mcp-tray-launcher/start-hidden.vbs` on Windows, or `docker compose up` for Browser MCP).
4. Register `http://127.0.0.1:3001/mcp` in the user's local MCP client config (no OAuth required on `127.0.0.1`).
5. Give the user the generated OAuth Client ID & Client Secret printed by `setup.mjs` to add in `https://gemini.google.com/devmode`.
6. Instruct the user to load `gemini-relay-extension/` unpacked in `chrome://extensions`.

## Security Invariants (Do Not Weaken)
- **Fail-closed auth:** External requests without valid OAuth 2.0 Bearer tokens MUST fail with `401` (or `503` if unconfigured). Never remove `oauth.authMiddleware`.
- **Localhost-only bridge:** `/bridge/*` endpoints MUST remain wrapped in `localhostOnlyMiddleware` (`403` externally).
- **Read-only local file sandbox:** `localFiles.ts` resolves symlinks via `realpathSync` and denies `.env*`, `oauth-tokens.json`, `relay-store.json`, `*.pem`, `*.key`, `.git/`.

## Troubleshooting UI Selector Drift
Because `gemini-relay-extension/content.js` drives the `gemini.google.com` web UI, Google UI updates may change button labels or DOM structure. Inspect `findComposer()`, `findSendButton()`, `findToolsButton()`, `findModelPickerButton()`, and `selectExecutionMode()` in `gemini-relay-extension/content.js`.
