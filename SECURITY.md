# Security Policy

## Security Architecture
- **Fail-Closed External Auth:** Both `gemini-browser-mcp` and `agent-relay-mcp` refuse external requests with `503 Service Unavailable` if `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` (or `MCP_AUTH_TOKEN`) are unset. Local `127.0.0.1` requests (without `X-Forwarded-*` headers) are allowed directly for local AI agents.
- **OAuth 2.0 Hardening:** Uses constant-time secret comparison (`crypto.timingSafeEqual`), enforces PKCE `S256` only, and validates `redirect_uri` against an HTTPS allowlist (`*.google.com` + optional `OAUTH_ALLOWED_REDIRECT_ORIGINS`).
- **Localhost-Only Extension Bridge:** `/bridge/*` endpoints are strictly restricted to `127.0.0.1` (`403 Forbidden` externally).
- **Read-Only Local File Sandboxing:** `LOCAL_FILES_ROOT` must be explicitly configured. Symlinks are resolved with `fs.realpathSync()` to prevent directory escapes, and secret files (`.env*`, `oauth-tokens.json`, `relay-store.json`, `*.pem`, `*.key`, `credentials.json`, `.git/`) are hard-blocked.
- **Ephemeral Media Tokens:** Hosted screenshots and generated media use 96-bit random tokens with a 15-minute TTL.

## Important Caveats
- **Point `LOCAL_FILES_ROOT` at a dedicated non-sensitive folder** — never point it at your home directory or a folder containing secrets.
- **UI Automation Fragility:** `gemini-relay-extension` interacts with the `gemini.google.com` DOM and may require selector updates when Google updates the web UI.

## Reporting a Vulnerability
Please report security issues privately to the repository maintainers via GitHub Security Advisories rather than opening a public issue.
