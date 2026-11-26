# Contributing

Contributions are welcome — especially:
- Updated DOM selectors in `gemini-relay-extension/content.js` when Google updates the Gemini Web App UI.
- macOS / Linux background service wrappers (`launchd` plist / `systemd` unit) alongside the Windows tray launcher.
- Additional MCP tools or security improvements.

## Local Development
1. Fork and clone the repository.
2. Run `node setup.mjs --local-files-root "./test-sandbox"`.
3. Never commit `.env`, `data/`, `logs/`, `screenshots/`, or personal hostnames.
4. Ensure `npm run typecheck` passes in both `agent-relay-mcp/` and `gemini-browser-mcp/` before opening a PR.

Please follow our [Code of Conduct](./CODE_OF_CONDUCT.md).
