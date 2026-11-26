import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRelayMcpServer } from "./mcp.js";
import { relayStore } from "./store.js";
import { getAllowedRoot } from "./localFiles.js";
import { lookupMediaFile, saveGeneratedMedia } from "./media.js";
import { createOAuthModule, localhostOnlyMiddleware } from "./oauth.js";

const PORT = Number(process.env.PORT || 3001);
const oauth = createOAuthModule({
  serverName: "Local Agent Connector (agent-relay-mcp)",
  mountPrefix: "/relay",
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
app.use(express.json({ limit: "64mb" }));
app.use(express.urlencoded({ extended: true }));

oauth.registerRoutes(app);

const SERVER_VERSION = "2.3.0";
const EXTENSION_DIR =
  process.env.EXTENSION_DIR?.trim() ||
  path.resolve(process.cwd(), "..", "gemini-relay-extension");

function getExtensionSignature(): { version: string; signature: string } {
  try {
    const manifestPath = path.join(EXTENSION_DIR, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const version = String(manifest.version || SERVER_VERSION);
    const files = ["manifest.json", "background.js", "content.js", "popup.html", "popup.js"];
    const mtimes = files
      .map((f) => {
        try {
          return Math.floor(fs.statSync(path.join(EXTENSION_DIR, f)).mtimeMs);
        } catch {
          return 0;
        }
      })
      .join("-");
    return { version, signature: `${version}:${mtimes}` };
  } catch {
    return { version: SERVER_VERSION, signature: SERVER_VERSION };
  }
}

function safeAllowedRootLabel(): string {
  try {
    return getAllowedRoot();
  } catch {
    return "unconfigured (set LOCAL_FILES_ROOT in .env)";
  }
}

function healthHandler(_req: Request, res: Response) {
  const extInfo = getExtensionSignature();
  res.json({
    status: "ok",
    server: "agent-relay-mcp",
    version: SERVER_VERSION,
    extensionVersion: extInfo.version,
    transport: "streamable-http",
    endpoints: ["/mcp", "/relay/mcp"],
    webAppBridgeConnected: relayStore.isWebAppBridgeConnected(),
    autoResponder: {
      generalGemini: relayStore.isWebAppBridgeConnected()
        ? "gemini-webapp-task-mode (live)"
        : "agy-cli (Gemini 4 Hydrogen (Medium))",
      localFiles: `read-only (${safeAllowedRootLabel()})`,
      googlePhotos: relayStore.isWebAppBridgeConnected()
        ? "gemini-webapp-task-mode (live)"
        : "gemini-app + windows-notification",
    },
    stats: relayStore.stats(),
    oauthEnabled: oauth.enabled,
  });
}

function bridgeNextHandler(_req: Request, res: Response) {
  const extInfo = getExtensionSignature();
  const claimed = relayStore.claimNextForBridge();
  if (!claimed) {
    res.json({
      hasTask: false,
      bridgeConnected: true,
      extensionVersion: extInfo.version,
      extensionSignature: extInfo.signature,
    });
    return;
  }

  const { action, task } = claimed;

  if (action === "approve_deep_research") {
    console.log(`[${new Date().toISOString()}] BRIDGE APPROVE DEEP RESEARCH -> ${task.id}`);
    res.json({
      hasTask: true,
      bridgeAction: "approve_deep_research",
      extensionVersion: extInfo.version,
      extensionSignature: extInfo.signature,
      task: {
        id: task.id,
        capability: task.capability,
        executionMode: "chat",
        geminiTool: task.geminiTool,
      },
    });
    return;
  }

  const isNativeTool = Boolean(task.geminiTool);
  const extra =
    task.capability === "google-photos"
      ? " using your connected Google Photos app"
      : "";

  const triggerPrompt = isNativeTool
    ? task.prompt
    : `Check pending relay task ${task.id} via relay_get_pending_tasks(forAgent: "gemini-app"), complete it${extra}, and submit the full result back using relay_submit_result(taskId: "${task.id}", result: ...).`;

  const executionMode =
    task.executionMode ??
    (task.geminiTool === "deep_research" ||
    task.geminiTool === "guided_learning" ||
    task.geminiTool === "create_video" ||
    task.geminiTool === "create_music"
      ? "chat"
      : "task");

  console.log(
    `[${new Date().toISOString()}] BRIDGE DISPATCH -> ${task.id} [${executionMode}] (${task.capability}${
      task.geminiTool ? ` / ${task.geminiTool}` : ""
    })`
  );
  res.json({
    hasTask: true,
    bridgeAction: task.geminiTool === "set_mode" ? "set_mode" : "dispatch",
    extensionVersion: extInfo.version,
    extensionSignature: extInfo.signature,
    task: {
      id: task.id,
      capability: task.capability,
      executionMode,
      geminiTool: task.geminiTool ?? null,
      webModel: task.webModel ?? (executionMode === "task" ? "hydrogen" : "4_hydrogen"),
      thinkingLevel: executionMode === "chat" ? task.thinkingLevel ?? "medium" : null,
      fromAgent: task.fromAgent,
      triggerPrompt,
    },
  });
}

function bridgePlanHandler(req: Request, res: Response) {
  try {
    const taskId = Array.isArray(req.params.taskId)
      ? req.params.taskId[0]
      : req.params.taskId;
    const planText = String(req.body?.plan || "").trim();
    if (!planText) {
      res.status(400).json({ error: "Missing 'plan' text" });
      return;
    }
    const task = relayStore.submitResearchPlan(taskId, planText);
    console.log(`[${new Date().toISOString()}] BRIDGE PLAN RECEIVED -> ${taskId} (${planText.length} chars)`);
    res.json({ ok: true, task });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

function bridgeCompleteHandler(req: Request, res: Response) {
  try {
    const taskId = Array.isArray(req.params.taskId)
      ? req.params.taskId[0]
      : req.params.taskId;
    const result = String(req.body?.result || "").trim();
    const error = req.body?.error ? String(req.body.error) : undefined;
    const task = relayStore.submitResult({
      taskId,
      status: error ? "failed" : "completed",
      result: result || undefined,
      error,
      resultData: {
        source: "gemini-webapp-extension",
        ...(req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {}),
      },
    });
    console.log(`[${new Date().toISOString()}] BRIDGE COMPLETE -> ${taskId} (${task.status})`);
    res.json({ ok: true, task });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

function bridgeUploadHandler(req: Request, res: Response) {
  try {
    const taskId = Array.isArray(req.params.taskId)
      ? req.params.taskId[0]
      : req.params.taskId;
    const base64 = String(req.body?.base64 || "");
    const mimeType = String(req.body?.mimeType || "application/octet-stream");
    const caption = req.body?.caption ? String(req.body.caption) : "";
    if (!base64) {
      res.status(400).json({ error: "Missing 'base64' media payload" });
      return;
    }

    const buffer = Buffer.from(base64, "base64");
    const saved = saveGeneratedMedia(buffer, mimeType, taskId);
    const publicHost =
      process.env.PUBLIC_BASE_URL?.trim()?.replace(/\/+$/, "") ||
      getPublicBaseUrl(req);
    const mediaUrl = `${publicHost}/media/${saved.token}`;

    const task = relayStore.submitResult({
      taskId,
      status: "completed",
      result: caption
        ? `${caption}\n\nFile: ${saved.filePath}\nURL: ${mediaUrl}`
        : `Saved generated media to ${saved.filePath}\nURL: ${mediaUrl}`,
      resultData: {
        source: "gemini-webapp-extension",
        filePath: saved.filePath,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        mediaUrl,
      },
    });

    console.log(
      `[${new Date().toISOString()}] BRIDGE MEDIA SAVED -> ${taskId}: ${saved.filename} (${saved.sizeBytes} bytes)`
    );
    res.json({ ok: true, saved, mediaUrl, task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

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
  const isTailscale = host.endsWith(".ts.net");
  const proto = protoHeader || (isTailscale ? "https" : req.protocol || "http");
  const prefix = isTailscale || req.path.startsWith("/relay/") ? "/relay" : "";
  return `${proto}://${host}${prefix}`;
}

function mediaHandler(req: Request, res: Response) {
  const token = Array.isArray(req.params.token)
    ? req.params.token[0]
    : req.params.token;
  const entry = lookupMediaFile(token);
  if (!entry) {
    res.status(404).json({ error: "Media file not found or expired" });
    return;
  }
  res.setHeader("Content-Type", entry.mimeType);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(entry.filePath);
}

async function mcpPostHandler(req: Request, res: Response) {
  const rpcMethod = req.body?.method ?? "unknown";
  const toolName = req.body?.params?.name ? ` (${req.body.params.name})` : "";
  console.log(`[${new Date().toISOString()}] POST ${req.path} -> ${rpcMethod}${toolName}`);

  const server = createRelayMcpServer(getPublicBaseUrl(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Relay MCP error:", error);
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
}

function methodNotAllowed(_req: Request, res: Response) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method Not Allowed: stateless Streamable HTTP mode. Use POST.",
    },
    id: null,
  });
}

/**
 * Localhost-only SSE push stream for Chrome extension background service worker.
 * Eliminates background-tab setInterval throttling when Chrome is minimized or hidden to tray!
 */
function bridgeStreamHandler(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  relayStore.recordBridgeHeartbeat();
  const extInfo = getExtensionSignature();
  res.write(
    `event: ready\ndata: ${JSON.stringify({
      version: SERVER_VERSION,
      extensionVersion: extInfo.version,
      extensionSignature: extInfo.signature,
    })}\n\n`
  );

  const pushNext = () => {
    relayStore.recordBridgeHeartbeat();
    const curExt = getExtensionSignature();
    res.write(
      `event: task_available\ndata: ${JSON.stringify({
        ts: Date.now(),
        extensionVersion: curExt.version,
        extensionSignature: curExt.signature,
      })}\n\n`
    );
  };

  // Push immediately if pending tasks already exist
  if (relayStore.stats().pending > 0) {
    pushNext();
  }

  const unsubscribe = relayStore.onBridgeEvent(pushNext);

  // Keepalive ping every 10s so Chrome MV3 service worker stays awake and bridgeLive stays true
  const ping = setInterval(() => {
    relayStore.recordBridgeHeartbeat();
    const curExt = getExtensionSignature();
    res.write(
      `event: ping\ndata: ${JSON.stringify({
        ts: Date.now(),
        extensionSignature: curExt.signature,
      })}\n\n`
    );
  }, 10_000);

  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

// Support both root (/mcp, /health, /media, /bridge) and mounted path (/relay/...)
app.get(["/health", "/relay/health"], healthHandler);
app.get(["/bridge/stream", "/relay/bridge/stream"], localhostOnlyMiddleware, bridgeStreamHandler);
app.get(["/bridge/next", "/relay/bridge/next"], localhostOnlyMiddleware, bridgeNextHandler);
app.post(["/bridge/plan/:taskId", "/relay/bridge/plan/:taskId"], localhostOnlyMiddleware, bridgePlanHandler);
app.post(["/bridge/complete/:taskId", "/relay/bridge/complete/:taskId"], localhostOnlyMiddleware, bridgeCompleteHandler);
app.post(["/bridge/upload/:taskId", "/relay/bridge/upload/:taskId"], localhostOnlyMiddleware, bridgeUploadHandler);
app.get(["/media/:token", "/relay/media/:token"], mediaHandler);
app.post(["/mcp", "/relay/mcp"], oauth.authMiddleware, mcpPostHandler);
app.get(["/mcp", "/relay/mcp"], oauth.authMiddleware, methodNotAllowed);
app.delete(["/mcp", "/relay/mcp"], oauth.authMiddleware, methodNotAllowed);

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`agent-relay-mcp listening on http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down agent-relay-mcp...`);
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
