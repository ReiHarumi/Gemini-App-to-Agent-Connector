import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: number;
}

export interface OAuthConfig {
  serverName: string;
  mountPrefix: string;
  storeFile: string;
}

function isLocalDirectRequest(req: Request): boolean {
  if (req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]) {
    return false;
  }
  const ip = req.socket.remoteAddress || req.ip || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function createOAuthModule(config: OAuthConfig) {
  const clientId = process.env.OAUTH_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.OAUTH_CLIENT_SECRET?.trim() || "";
  const staticToken = process.env.MCP_AUTH_TOKEN?.trim() || "";
  const enabled = Boolean(clientId && clientSecret);

  const authCodes = new Map<string, AuthCode>();
  const tokensByAccess = new Map<string, TokenRecord>();
  const tokensByRefresh = new Map<string, TokenRecord>();

  function loadTokens(): void {
    try {
      if (!fs.existsSync(config.storeFile)) return;
      const list = JSON.parse(fs.readFileSync(config.storeFile, "utf8")) as TokenRecord[];
      for (const rec of list) {
        tokensByAccess.set(rec.accessToken, rec);
        tokensByRefresh.set(rec.refreshToken, rec);
      }
    } catch {
      // ignore
    }
  }

  function saveTokens(): void {
    try {
      const dir = path.dirname(config.storeFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        config.storeFile,
        JSON.stringify(Array.from(tokensByAccess.values()), null, 2),
        "utf8"
      );
    } catch {
      // ignore
    }
  }

  loadTokens();

  function getBaseUrl(req: Request): string {
    const proto =
      (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
      (req.headers.host?.endsWith(".ts.net") ? "https" : req.protocol || "http");
    const host =
      (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
      req.headers.host ||
      "localhost";
    const prefix =
      config.mountPrefix && (host.endsWith(".ts.net") || req.path.startsWith(config.mountPrefix))
        ? config.mountPrefix
        : "";
    return `${proto}://${host}${prefix}`;
  }

  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (isLocalDirectRequest(req)) {
      next();
      return;
    }

    if (!enabled && !staticToken) {
      next();
      return;
    }

    const authHeader = req.headers.authorization || "";
    const bearerMatch = authHeader.match(/^bearer\s+(.+)$/i);
    if (bearerMatch) {
      const token = bearerMatch[1].trim();
      if (staticToken && token === staticToken) {
        next();
        return;
      }
      const rec = tokensByAccess.get(token);
      if (rec && rec.expiresAt > Date.now()) {
        next();
        return;
      }
      console.warn(`[OAuth 401] ${req.method} ${req.path} — unrecognized or expired Bearer token (known tokens: ${tokensByAccess.size})`);
    } else {
      console.warn(`[OAuth 401] ${req.method} ${req.path} — missing Authorization Bearer header`);
    }

    const base = getBaseUrl(req);
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="${config.serverName}", resource_metadata="${base}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32302,
        message: "Unauthorized: valid OAuth 2.0 Bearer token required.",
      },
      id: null,
    });
  }

  function registerRoutes(app: Express): void {
    const p = config.mountPrefix;
    const paths = (suffix: string) => (p ? [suffix, `${p}${suffix}`] : [suffix]);

    app.get(paths("/.well-known/oauth-protected-resource"), (req: Request, res: Response) => {
      const base = getBaseUrl(req);
      res.json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
      });
    });

    app.get(paths("/.well-known/oauth-authorization-server"), (req: Request, res: Response) => {
      const base = getBaseUrl(req);
      res.json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256", "plain"],
      });
    });

    app.get(paths("/oauth/authorize"), (req: Request, res: Response) => {
      const reqClientId = String(req.query.client_id || "");
      const redirectUri = String(req.query.redirect_uri || "");
      const state = String(req.query.state || "");
      const codeChallenge = String(req.query.code_challenge || "");
      const codeChallengeMethod = String(req.query.code_challenge_method || "");

      if (!enabled || reqClientId !== clientId) {
        res.status(400).send("Invalid client_id");
        return;
      }
      if (!redirectUri) {
        res.status(400).send("Missing redirect_uri");
        return;
      }

      const code = crypto.randomBytes(24).toString("hex");
      authCodes.set(code, {
        code,
        clientId: reqClientId,
        redirectUri,
        codeChallenge: codeChallenge || undefined,
        codeChallengeMethod: codeChallengeMethod || undefined,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html>
<html><head><title>Authorize ${config.serverName}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1e293b;padding:28px;border-radius:12px;max-width:420px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
a.btn{display:inline-block;margin-top:16px;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}</style>
</head><body><div class="card">
<h2>Authorize ${config.serverName}</h2>
<p>Grant Gemini Web App access to your private Browser MCP server?</p>
<a class="btn" href="${target.toString()}">Approve &amp; Connect</a>
</div></body></html>`);
    });

    app.post(paths("/oauth/token"), (req: Request, res: Response) => {
      if (!enabled) {
        res.status(400).json({ error: "oauth_not_configured" });
        return;
      }

      let reqClientId = String(req.body?.client_id || "");
      let reqClientSecret = String(req.body?.client_secret || "");

      const authHeader = req.headers.authorization || "";
      if (authHeader.startsWith("Basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        if (sep !== -1) {
          reqClientId = decoded.slice(0, sep);
          reqClientSecret = decoded.slice(sep + 1);
        }
      }

      if (reqClientId !== clientId || reqClientSecret !== clientSecret) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }

      const grantType = String(req.body?.grant_type || "");

      if (grantType === "authorization_code") {
        const code = String(req.body?.code || "");
        const rec = authCodes.get(code);
        authCodes.delete(code);
        if (!rec || rec.expiresAt < Date.now()) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        if (rec.codeChallenge) {
          const verifier = String(req.body?.code_verifier || "");
          const expected =
            rec.codeChallengeMethod === "S256"
              ? crypto.createHash("sha256").update(verifier).digest("base64url")
              : verifier;
          if (expected !== rec.codeChallenge) {
            res.status(400).json({ error: "invalid_grant" });
            return;
          }
        }

        const accessToken = crypto.randomBytes(32).toString("hex");
        const refreshToken = crypto.randomBytes(32).toString("hex");
        const expiresIn = 30 * 24 * 3600;
        const tokenRec: TokenRecord = {
          accessToken,
          refreshToken,
          clientId,
          expiresAt: Date.now() + expiresIn * 1000,
        };
        tokensByAccess.set(accessToken, tokenRec);
        tokensByRefresh.set(refreshToken, tokenRec);
        saveTokens();

        res.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: expiresIn,
          refresh_token: refreshToken,
        });
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = String(req.body?.refresh_token || "");
        const existing = tokensByRefresh.get(refreshToken);
        if (!existing) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        tokensByAccess.delete(existing.accessToken);
        const newAccess = crypto.randomBytes(32).toString("hex");
        const expiresIn = 30 * 24 * 3600;
        const updated: TokenRecord = {
          accessToken: newAccess,
          refreshToken,
          clientId,
          expiresAt: Date.now() + expiresIn * 1000,
        };
        tokensByAccess.set(newAccess, updated);
        tokensByRefresh.set(refreshToken, updated);
        saveTokens();

        res.json({
          access_token: newAccess,
          token_type: "Bearer",
          expires_in: expiresIn,
          refresh_token: refreshToken,
        });
        return;
      }

      res.status(400).json({ error: "unsupported_grant_type" });
    });
  }

  return { enabled, authMiddleware, registerRoutes };
}
