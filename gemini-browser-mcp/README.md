# gemini-browser-mcp

A **Streamable HTTP MCP server** built for the **Gemini Web App (`gemini.google.com/devmode`)** that combines three web capabilities in a single endpoint (`/mcp`):

1. **Playwright Browser Control** (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_press_key`, `browser_screenshot`, `browser_tabs`, `browser_wait`)
2. **Chrome DevTools Protocol (CDP)** (`devtools_console_logs`, `devtools_network_requests`, `devtools_evaluate`, `devtools_cdp_command`)
3. **Firecrawl** (`firecrawl_scrape`, `firecrawl_search`, `firecrawl_map`, `firecrawl_crawl`)

---

## 1. Quick Start (Local on Windows)

```powershell
# 1. Copy env template and fill in FIRECRAWL_API_KEY (optional)
copy .env.example .env

# 2. Install dependencies & Chromium binary
npm install
npx playwright install chromium

# 3. Build and start the MCP server
npm run build
npm start
```

Your local server is now running at:
- MCP endpoint: `http://localhost:3000/mcp`
- Health check: `http://localhost:3000/health`

---

## 2. Expose Over HTTPS for Gemini Web App

Gemini Web App (`gemini.google.com/devmode`) requires a **public HTTPS URL** with a trusted TLS certificate.

Since `cloudflared` is installed, run in a second terminal:

```powershell
npm run tunnel
# or directly:
cloudflared tunnel --url http://localhost:3000
```

Copy the generated `https://<something>.trycloudflare.com` URL and append `/mcp`:

```text
https://<something>.trycloudflare.com/mcp
```

---

## 3. Connect to Gemini Web App (`gemini.google.com/devmode`)

1. Open **`https://gemini.google.com/devmode`** on a desktop browser (personal Google Account with **Gemini Apps Activity** enabled).
2. Add a new custom MCP server and paste your HTTPS endpoint:
   `https://<something>.trycloudflare.com/mcp`
3. Verify the 16 tools appear in the **Tool schemas** tab.
4. Start chatting — Gemini can now browse live pages, inspect Chrome DevTools console/network logs, take screenshots, and scrape/search with Firecrawl.

> **Security tip:** Quick `trycloudflare.com` URLs are temporary and public while running. Close the tunnel when you're done, or deploy behind OAuth / `MCP_AUTH_TOKEN` for permanent use.

---

## 4. Optional: Attach to Your Real Local Chrome (DevTools Mode)

Instead of launching a fresh headless Chromium, you can connect this MCP server to a running Chrome window via Chrome DevTools Protocol:

1. Start Chrome with remote debugging enabled:
   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-mcp-profile"
   ```
2. Set `CDP_ENDPOINT=http://127.0.0.1:9222` in `.env` and restart the server.

---

## 5. Run with Docker (Local Docker Desktop or Google Cloud Run)

```powershell
# Copy .env first
copy .env.example .env

# Run MCP server in Docker
docker compose up --build

# Or run MCP server + automatic Cloudflare HTTPS tunnel together:
docker compose --profile tunnel up --build
```

The `Dockerfile` is also directly deployable to **Google Cloud Run** (`gcloud run deploy gemini-browser-mcp --source . --allow-unauthenticated`).
