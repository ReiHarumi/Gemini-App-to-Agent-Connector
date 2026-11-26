import "dotenv/config";
import path from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { browserManager } from "./browser.js";
import { firecrawlClient } from "./firecrawl.js";
import { resolveScreenshotPath } from "./screenshots.js";
import { createOAuthModule } from "./oauth.js";

const PORT = Number(process.env.PORT || 3000);
const oauth = createOAuthModule({
  serverName: "Gemini Browser MCP",
  mountPrefix: "",
  storeFile: path.resolve(process.cwd(), "data", "oauth-tokens.json"),
});

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
    exposedHeaders: ["Mcp-Session-Id"],
  })
);
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

oauth.registerRoutes(app);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "gemini-browser-mcp",
    transport: "streamable-http",
    endpoint: "/mcp",
    cdpEndpointConfigured: Boolean(process.env.CDP_ENDPOINT?.trim()),
    firecrawlMode: firecrawlClient.mode,
    oauthEnabled: oauth.enabled,
  });
});

// Serve captured screenshots over HTTPS so Gemini can embed/link them in chat
app.get("/screenshots/:filename", (req: Request, res: Response) => {
  const filename = Array.isArray(req.params.filename)
    ? req.params.filename[0]
    : req.params.filename;
  const filePath = resolveScreenshotPath(filename);
  if (!filePath) {
    res.status(404).json({ error: "Screenshot not found" });
    return;
  }
  const contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(filePath);
});

function getPublicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const protoHeader = (req.headers["x-forwarded-proto"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
    req.headers.host ||
    `localhost:${PORT}`;
  const proto = protoHeader || (host.endsWith(".ts.net") ? "https" : req.protocol || "http");
  return `${proto}://${host}`;
}

// Streamable HTTP MCP endpoint (Gemini Web App / Developer Mode compatible)
app.post("/mcp", oauth.authMiddleware, async (req: Request, res: Response) => {
  const rpcMethod = req.body?.method ?? "unknown";
  const toolName = req.body?.params?.name ? ` (${req.body.params.name})` : "";
  console.log(`[${new Date().toISOString()}] POST /mcp -> ${rpcMethod}${toolName}`);

  const server = createMcpServer(getPublicBaseUrl(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode for cloud-to-local reliability
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP POST /mcp error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: req.body?.id ?? null,
      });
    }
  }
});

// Per Streamable HTTP spec, return 405 on GET/DELETE in stateless mode
app.get("/mcp", oauth.authMiddleware, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method Not Allowed: this server runs in stateless Streamable HTTP mode. Use POST /mcp.",
    },
    id: null,
  });
});

app.delete("/mcp", oauth.authMiddleware, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method Not Allowed: stateless server has no sessions to delete.",
    },
    id: null,
  });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`gemini-browser-mcp listening on http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`OAuth 2.0: ${oauth.enabled ? "ENABLED" : "disabled"}`);
});

async function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down...`);
  httpServer.close();
  await browserManager.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
