import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { relayStore, type TaskCapability } from "./store.js";
import {
  getAllowedRoot,
  listLocalFiles,
  readLocalBinary,
  readLocalFile,
  searchLocalFiles,
} from "./localFiles.js";
import {
  getImageMimeType,
  isRasterImage,
  registerMediaFile,
} from "./media.js";
import { notifyWindows, runAgyPrint } from "./autoResponder.js";

function okJson(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Error: ${message}`,
      },
    ],
  };
}

const capabilityEnum = z.enum([
  "general",
  "google-photos",
  "local-files",
  "workspace",
  "browser",
  "deep-research",
  "create-image",
  "create-video",
  "create-music",
  "guided-learning",
]);

const executionModeEnum = z
  .enum(["task", "chat"])
  .optional()
  .describe(
    "Gemini Web App execution surface: 'task' (default — uses Gemini Task mode with sandboxing, sub-agents, step execution, and Neon/Hydrogen) or 'chat' (standard Chat mode with Thinking level)"
  );

const taskModelEnum = z
  .enum(["hydrogen", "neon"])
  .optional()
  .describe(
    "Gemini Task mode model (no effort switcher): 'hydrogen' (default, fast/everyday) or 'neon' (deeper multi-step analysis & sub-agents)"
  );

const webModelEnum = z
  .enum(["auto", "4_hydrogen", "4_neon", "hydrogen", "neon"])
  .optional()
  .describe(
    "Gemini Web App model: in Task mode use 'hydrogen' or 'neon'; in Chat mode use '4_hydrogen' (Everyday help, default), '4_neon' (Deeper analysis), or 'auto'"
  );

const thinkingLevelEnum = z
  .enum(["low", "medium", "high"])
  .optional()
  .describe(
    "Chat mode ONLY — Gemini Thinking level / effort: 'low' (Fast), 'medium' (Balanced, default), or 'high' (Extra thorough). Ignored in Task mode."
  );

export function createRelayMcpServer(publicBaseUrl?: string): McpServer {
  const server = new McpServer({
    name: "agent-relay-mcp",
    version: "2.2.0",
  });

  // -------------------------------------------------------------------------
  // 1. CALL GEMINI (Auto-responds via local Antigravity CLI; queues for
  //    Gemini Web App when forceWebApp=true or capability='google-photos')
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_call_gemini",
    {
      title: "Call Gemini (Auto-Responder / Web App Relay)",
      description:
        "Send a task to Gemini and automatically receive the result. General tasks auto-execute immediately via local Antigravity CLI (no API key). Set forceWebApp: true (or capability: 'google-photos') to route specifically through the Gemini Web App.",
      inputSchema: {
        prompt: z.string().describe("Clear instruction for Gemini to execute"),
        fromAgent: z
          .string()
          .optional()
          .describe("Name of the calling agent (default: 'antigravity')"),
        capability: capabilityEnum
          .optional()
          .describe("Capability tag (default: 'general')"),
        forceWebApp: z
          .boolean()
          .optional()
          .describe(
            "If true, queues for the Gemini Web App instead of auto-executing via local CLI (default: false)"
          ),
        executionMode: executionModeEnum,
        model: z
          .string()
          .optional()
          .describe(
            "Optional local CLI fallback model (default: 'Gemini 4 Hydrogen (Medium)')"
          ),
        webModel: webModelEnum,
        thinkingLevel: thinkingLevelEnum,
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional structured context or metadata"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("When forceWebApp is true, seconds to wait for Gemini Web App (default: 0)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({
      prompt,
      fromAgent,
      capability,
      forceWebApp,
      executionMode,
      model,
      webModel,
      thinkingLevel,
      context,
      waitSeconds,
    }) => {
      try {
        const cap = (capability as TaskCapability) ?? "general";
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const useWebApp = Boolean(forceWebApp) || cap === "google-photos" || bridgeLive;
        const resolvedMode = executionMode ?? "task";

        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: cap,
          executionMode: resolvedMode,
          webModel: webModel ?? (resolvedMode === "task" ? "hydrogen" : "4_hydrogen"),
          thinkingLevel: resolvedMode === "chat" ? thinkingLevel ?? "medium" : undefined,
          prompt,
          context,
        });

        if (!useWebApp) {
          // Fallback auto-execute via local Antigravity CLI when Chrome extension is not connected
          const fullPrompt = context
            ? `${prompt}\n\nContext JSON:\n${JSON.stringify(context, null, 2)}`
            : prompt;

          try {
            const selectedModel = model || "Gemini 4 Hydrogen (Medium)";
            const output = await runAgyPrint({
              prompt: fullPrompt,
              model: selectedModel,
              timeoutSeconds: 180,
            });
            const completed = relayStore.submitResult({
              taskId: task.id,
              status: "completed",
              result: output,
              resultData: {
                autoExecutedBy: "agy-cli",
                source: "local-antigravity-cli (Chrome bridge offline)",
                model: selectedModel,
              },
            });
            return okJson({
              autoResponded: true,
              engine: "agy-cli",
              task: completed,
            });
          } catch (execErr) {
            const msg = execErr instanceof Error ? execErr.message : String(execErr);
            const failed = relayStore.submitResult({
              taskId: task.id,
              status: "failed",
              error: msg,
            });
            return okJson({
              autoResponded: false,
              error: msg,
              task: failed,
            });
          }
        }

        // Real Gemini Web App route (auto-triggered by Chrome extension when bridgeLive=true!)
        if (!bridgeLive) {
          notifyWindows(
            `Gemini Web App Task (${task.id})`,
            `${cap}: ${prompt.slice(0, 120)}`
          );
        }

        const effectiveWait = waitSeconds ?? (bridgeLive ? 90 : 0);
        if (effectiveWait > 0) {
          const waited = await relayStore.waitForResult(task.id, effectiveWait);
          return okJson({
            autoResponded: !waited.timedOut,
            engine: "gemini-webapp-extension",
            bridgeLive,
            ...waited,
          });
        }

        return okJson({
          autoResponded: false,
          bridgeLive,
          task,
          nextStep: `Task queued for gemini-app (${task.id}). Poll with relay_wait_for_result(taskId: "${task.id}").`,
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 2. GOOGLE PHOTOS (ALWAYS routed through Gemini Web App + Windows Notify)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_google_photos",
    {
      title: "Google Photos via Gemini Web App",
      description:
        "MANDATORY route for any Google Photos request (searching photos, finding albums, reading photo dates/locations/memories). Always routes through the Gemini Web App, which holds the user's connected Google Photos integration, and sends a desktop notification.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "What to search, find, or summarize in Google Photos (e.g. 'Find photos from Japan in October 2025')"
          ),
        fromAgent: z
          .string()
          .optional()
          .describe("Name of the calling agent (default: 'antigravity')"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Seconds to wait for Gemini Web App's Google Photos result (default: 0)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, fromAgent, waitSeconds }) => {
      try {
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "google-photos",
          prompt: `[GOOGLE PHOTOS REQUEST] Use your connected Google Photos app to fulfill this request and return the exact details/links via relay_submit_result:\n\n${query}`,
          context: { requiredConnector: "google-photos", query },
        });

        notifyWindows(`Google Photos Request (${task.id})`, query);

        if (waitSeconds && waitSeconds > 0) {
          const waited = await relayStore.waitForResult(task.id, waitSeconds);
          return okJson(waited);
        }

        return okJson({
          task,
          notified: true,
          nextStep: `Google Photos task routed to gemini-app (${task.id}). Desktop notification sent — tell Gemini Web App to check pending relay tasks, then call relay_wait_for_result(taskId: "${task.id}").`,
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 3. LOCAL COMPUTER FILES (HYBRID AUTO-RESPONDER, READ-ONLY inside LOCAL_FILES_ROOT)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_request_local_files",
    {
      title: "Access Local Computer Files (Read-Only Auto-Responder via AGY)",
      description: `Automatically answers read-only file requests inside "${getAllowedRoot()}". Fast actions (list, read, search) respond instantly (<100ms); complex actions (summarize, custom) auto-run through Antigravity (AGY). Writes are disabled by read-only policy.`,
      inputSchema: {
        action: z
          .enum(["list", "read", "search", "summarize", "custom"])
          .describe(
            "Read-only file action: 'list' (folder contents), 'read' (file text), 'search' (find files/text), 'summarize' or 'custom' (auto-runs Antigravity)"
          ),
        pathHint: z
          .string()
          .optional()
          .describe(
            "Relative path inside LOCAL_FILES_ROOT (e.g. 'gemini-browser-mcp/README.md') or full path under the allowed root"
          ),
        instruction: z
          .string()
          .optional()
          .describe("Search query (for 'search') or detailed question (for 'summarize'/'custom')"),
        recursive: z
          .boolean()
          .optional()
          .describe("For action: 'list', whether to list subdirectories recursively (default: false)"),
        filenameOnly: z
          .boolean()
          .optional()
          .describe(
            "For action: 'search', match filenames only (defaults to true automatically for extensions like '.png' or '.svg')"
          ),
        fromAgent: z
          .string()
          .optional()
          .describe("Calling agent name (default: 'gemini-app')"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, pathHint, instruction, recursive, filenameOnly, fromAgent }) => {
      try {
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "gemini-app",
          toAgent: "antigravity",
          capability: "local-files",
          prompt: `[LOCAL FILES READ-ONLY] Action: ${action}${
            pathHint ? ` | Path: ${pathHint}` : ""
          }${instruction ? ` | Instruction: ${instruction}` : ""}`,
          context: { action, pathHint, recursive, filenameOnly },
        });

        // Fast direct read-only file worker (<100ms)
        if (action === "list") {
          const listing = listLocalFiles(pathHint, recursive ?? false);
          const completed = relayStore.submitResult({
            taskId: task.id,
            status: "completed",
            result: JSON.stringify(listing, null, 2),
            resultData: { autoExecutedBy: "local-file-worker", ...listing },
          });
          return okJson({ autoResponded: true, engine: "local-file-worker", taskId: completed.id, data: listing });
        }

        if (action === "read") {
          if (!pathHint) {
            throw new Error("'pathHint' is required when action is 'read'.");
          }

          const mimeType = getImageMimeType(pathHint);
          const base = (
            publicBaseUrl || `http://localhost:${process.env.PORT || 3001}`
          ).replace(/\/+$/, "");

          // Native image support (.png, .jpg, .jpeg, .webp, .gif):
          // Returns BOTH an MCP image block AND a public HTTPS imageUrl/markdown tag!
          if (mimeType && isRasterImage(pathHint)) {
            const bin = readLocalBinary(pathHint);
            const token = registerMediaFile(bin.path, mimeType);
            const imageUrl = `${base}/media/${token}`;
            const completed = relayStore.submitResult({
              taskId: task.id,
              status: "completed",
              result: imageUrl,
              resultData: {
                autoExecutedBy: "local-file-worker",
                relativePath: bin.relativePath,
                mimeType,
                sizeBytes: bin.sizeBytes,
                imageUrl,
              },
            });

            const content: Array<
              | { type: "image"; data: string; mimeType: string }
              | { type: "text"; text: string }
            > = [];

            // Include inline MCP image block if under 2MB so Gemini can visually inspect it
            if (!bin.truncated && bin.sizeBytes <= 2 * 1024 * 1024) {
              content.push({
                type: "image",
                data: bin.buffer.toString("base64"),
                mimeType,
              });
            }

            content.push({
              type: "text",
              text: JSON.stringify(
                {
                  autoResponded: true,
                  engine: "local-file-worker",
                  taskId: completed.id,
                  data: {
                    relativePath: bin.relativePath,
                    mimeType,
                    sizeBytes: bin.sizeBytes,
                    imageUrl,
                    markdown: `![${bin.relativePath}](${imageUrl})`,
                    note: "Display or link this image directly to the user using imageUrl or the markdown snippet.",
                  },
                },
                null,
                2
              ),
            });

            return { content };
          }

          const file = readLocalFile(pathHint);
          let imageUrl: string | undefined;
          if (mimeType) {
            // SVG: also expose a direct HTTPS URL so Gemini can embed it without dumping 90KB of XML
            const token = registerMediaFile(file.path, mimeType);
            imageUrl = `${base}/media/${token}`;
          }

          const completed = relayStore.submitResult({
            taskId: task.id,
            status: "completed",
            result: file.content,
            resultData: {
              autoExecutedBy: "local-file-worker",
              relativePath: file.relativePath,
              sizeBytes: file.sizeBytes,
              truncated: file.truncated,
              ...(imageUrl ? { imageUrl } : {}),
            },
          });
          return okJson({
            autoResponded: true,
            engine: "local-file-worker",
            taskId: completed.id,
            data: {
              ...file,
              ...(imageUrl
                ? {
                    imageUrl,
                    markdown: `![${file.relativePath}](${imageUrl})`,
                  }
                : {}),
            },
          });
        }

        if (action === "search") {
          const query = instruction?.trim();
          if (!query) {
            throw new Error("'instruction' (the search query) is required when action is 'search'.");
          }
          const found = searchLocalFiles(query, pathHint, filenameOnly);
          const completed = relayStore.submitResult({
            taskId: task.id,
            status: "completed",
            result: JSON.stringify(found, null, 2),
            resultData: { autoExecutedBy: "local-file-worker", ...found },
          });
          return okJson({ autoResponded: true, engine: "local-file-worker", taskId: completed.id, data: found });
        }

        // Complex action ('summarize' or 'custom') -> auto-trigger Antigravity (AGY) in read-only mode
        const agyPrompt = [
          `You are handling a READ-ONLY local file request from ${fromAgent ?? "gemini-app"}.`,
          `Allowed directory: ${getAllowedRoot()}`,
          `STRICT POLICY: Do NOT modify, create, or delete any files. Read-only inspection only.`,
          pathHint ? `Target path hint: ${pathHint}` : "",
          `Task (${action}): ${instruction || "Inspect and summarize the target path."}`,
        ]
          .filter(Boolean)
          .join("\n");

        const output = await runAgyPrint({
          prompt: agyPrompt,
          model: "Gemini 4 Hydrogen (Medium)",
          timeoutSeconds: 180,
          addAllowedDir: true,
        });

        const completed = relayStore.submitResult({
          taskId: task.id,
          status: "completed",
          result: output,
          resultData: { autoExecutedBy: "agy-cli", readOnly: true },
        });

        return okJson({
          autoResponded: true,
          engine: "agy-cli",
          task: completed,
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 4. GENERIC MULTI-AGENT DISPATCH (any agent -> any agent)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_send_task",
    {
      title: "Send Task to Any Connected Agent",
      description:
        "Send a task from any agent to any other agent connected to this relay (e.g. 'gemini-app', 'antigravity', 'claude', 'any').",
      inputSchema: {
        fromAgent: z.string().describe("Sender agent identifier"),
        toAgent: z
          .string()
          .describe("Target agent identifier (e.g. 'gemini-app', 'antigravity', 'any')"),
        prompt: z.string().describe("Task instruction"),
        capability: capabilityEnum.optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        waitSeconds: z.number().int().min(0).max(120).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ fromAgent, toAgent, prompt, capability, context, waitSeconds }) => {
      try {
        const task = relayStore.createTask({
          fromAgent,
          toAgent,
          capability: (capability as TaskCapability) ?? "general",
          prompt,
          context,
        });
        if (toAgent.toLowerCase() === "gemini-app") {
          notifyWindows(`Gemini Task from ${fromAgent}`, prompt.slice(0, 120));
        }
        if (waitSeconds && waitSeconds > 0) {
          return okJson(await relayStore.waitForResult(task.id, waitSeconds));
        }
        return okJson({ task });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 5. WORKER INBOX: GET / CLAIM PENDING TASKS
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_get_pending_tasks",
    {
      title: "Get Pending Relay Tasks (Agent Inbox)",
      description:
        "Check pending tasks waiting for an agent (e.g. forAgent: 'gemini-app' or 'antigravity'). Set claim: true to mark them in_progress while you work on them.",
      inputSchema: {
        forAgent: z
          .string()
          .optional()
          .describe("Agent name to check inbox for (e.g. 'gemini-app', 'antigravity', or 'all')"),
        capability: capabilityEnum.optional(),
        claim: z
          .boolean()
          .optional()
          .describe("If true, marks returned tasks as in_progress (default: true)"),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ forAgent, capability, claim, limit }) => {
      try {
        const tasks = relayStore.getPendingTasks({
          forAgent: forAgent ?? "all",
          capability: capability as TaskCapability | undefined,
          claim: claim ?? true,
          claimedBy: forAgent ?? "worker",
          limit: limit ?? 10,
        });
        return okJson({
          count: tasks.length,
          tasks,
          reminder:
            tasks.length > 0
              ? "After completing each task, call relay_submit_result with its taskId and result."
              : "No pending tasks in inbox.",
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 6. SUBMIT RESULT BACK TO CALLING AGENT
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_submit_result",
    {
      title: "Submit Completed Relay Task Result",
      description:
        "Submit the result (or error) of a relay task so the calling agent immediately receives it.",
      inputSchema: {
        taskId: z.string().describe("Task ID (e.g. 'task-a1b2c3d4')"),
        result: z.string().optional().describe("Text/Markdown result for the calling agent"),
        resultData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional structured JSON payload"),
        status: z
          .enum(["completed", "failed"])
          .optional()
          .describe("Final status (default: 'completed')"),
        error: z.string().optional().describe("Error message if status is 'failed'"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, result, resultData, status, error }) => {
      try {
        const task = relayStore.submitResult({
          taskId,
          result,
          resultData,
          status,
          error,
        });
        return okJson({ submitted: true, task });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 7. CHECK OR WAIT FOR TASK RESULT
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_wait_for_result",
    {
      title: "Wait for Relay Task Result",
      description:
        "Wait (long-poll up to 120 seconds) for another agent to submit the result for a taskId, or check immediately with waitSeconds: 0.",
      inputSchema: {
        taskId: z.string().describe("Task ID to wait for"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Max seconds to wait (default: 30)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, waitSeconds }) => {
      try {
        const res = await relayStore.waitForResult(taskId, waitSeconds ?? 30);
        return okJson(res);
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 8. LIST RECENT TASKS
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_list_tasks",
    {
      title: "List Relay Tasks",
      description: "Inspect recent tasks across all connected agents.",
      inputSchema: {
        status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
        toAgent: z.string().optional(),
        fromAgent: z.string().optional(),
        capability: capabilityEnum.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ status, toAgent, fromAgent, capability, limit }) => {
      try {
        return okJson({
          stats: relayStore.stats(),
          tasks: relayStore.listTasks({
            status,
            toAgent,
            fromAgent,
            capability: capability as TaskCapability | undefined,
            limit: limit ?? 20,
          }),
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 9. DEEP RESEARCH (2-Step Plan Approval via Gemini Web App)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_deep_research",
    {
      title: "Gemini Deep Research (2-Step Plan Approval)",
      description:
        "USE THIS TOOL whenever the user asks for Deep Research, a comprehensive multi-source investigation, or an in-depth research report. Triggers Gemini Web App's 'Deep research' tool, waits for Gemini to generate the research plan, and returns the plan (status: awaiting_approval) BEFORE starting research. Present the plan to the user, then call relay_approve_deep_research(taskId, approved: true) to start.",
      inputSchema: {
        topic: z.string().describe("Detailed research topic or question for Gemini Deep Research"),
        webModel: webModelEnum,
        thinkingLevel: thinkingLevelEnum,
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Seconds to wait for Gemini to return the research plan (default: 60)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ topic, webModel, thinkingLevel, fromAgent, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "deep-research",
          geminiTool: "deep_research",
          webModel: webModel ?? "4_hydrogen",
          thinkingLevel: thinkingLevel ?? "medium",
          prompt: topic,
        });

        if (!bridgeLive) {
          notifyWindows(`Deep Research Plan (${task.id})`, topic.slice(0, 120));
        }

        const waited = await relayStore.waitForPlan(task.id, waitSeconds ?? (bridgeLive ? 60 : 0));
        return okJson({
          bridgeLive,
          ...waited,
          nextStep:
            waited.task.status === "awaiting_approval"
              ? `Present task.researchPlan to the user. Once they approve, call relay_approve_deep_research(taskId: "${task.id}", approved: true).`
              : `Waiting for Gemini Web App to generate the Deep Research plan (taskId: "${task.id}").`,
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 10. APPROVE / CANCEL DEEP RESEARCH PLAN
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_approve_deep_research",
    {
      title: "Approve or Cancel Deep Research Plan",
      description:
        "Step 2 of Deep Research. After showing the user the plan from relay_deep_research, call this with approved: true to click 'Start research' in Gemini Web App (or approved: false to cancel).",
      inputSchema: {
        taskId: z.string().describe("The Deep Research taskId returned by relay_deep_research"),
        approved: z.boolean().describe("true to start research, false to cancel"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Seconds to wait for the final research report (default: 120; poll relay_wait_for_result if it takes longer)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, approved, waitSeconds }) => {
      try {
        const task = relayStore.approveDeepResearch(taskId, approved);
        if (!approved) {
          return okJson({ cancelled: true, task });
        }
        const waited = await relayStore.waitForResult(taskId, waitSeconds ?? 120);
        return okJson({
          approved: true,
          ...waited,
          nextStep: waited.timedOut
            ? `Deep Research is still running in Gemini Web App. Call relay_wait_for_result(taskId: "${taskId}", waitSeconds: 120) to keep waiting.`
            : "Deep Research report completed.",
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 11. CREATE IMAGE (Gemini Web App -> saved to generated-media)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_create_image",
    {
      title: "Create Image via Gemini Web App",
      description:
        "USE THIS TOOL whenever the user asks to generate, create, or draw an image, illustration, poster, or artwork via Gemini. Selects 'Create image' in Gemini Web App, saves the generated image to generated-media/, and returns both the local filePath and HTTPS mediaUrl.",
      inputSchema: {
        prompt: z.string().describe("Detailed image generation prompt"),
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        waitSeconds: z.number().int().min(0).max(120).optional().describe("Seconds to wait (default: 90)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt, fromAgent, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "create-image",
          executionMode: "task",
          geminiTool: "create_image",
          prompt,
        });
        if (!bridgeLive) notifyWindows(`Create Image (${task.id})`, prompt.slice(0, 120));
        const waited = await relayStore.waitForResult(task.id, waitSeconds ?? (bridgeLive ? 90 : 0));
        return okJson({ bridgeLive, ...waited });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 12. CREATE VIDEO (Gemini Web App -> saved to generated-media)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_create_video",
    {
      title: "Create Video via Gemini Web App",
      description:
        "USE THIS TOOL whenever the user asks to generate or create a video, clip, or animation via Gemini. Selects 'Create video' in Gemini Web App, saves the generated video to generated-media/, and returns both the local filePath and HTTPS mediaUrl.",
      inputSchema: {
        prompt: z.string().describe("Detailed video generation prompt"),
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        waitSeconds: z.number().int().min(0).max(120).optional().describe("Seconds to wait (default: 120)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt, fromAgent, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "create-video",
          executionMode: "chat",
          geminiTool: "create_video",
          prompt,
        });
        if (!bridgeLive) notifyWindows(`Create Video (${task.id})`, prompt.slice(0, 120));
        const waited = await relayStore.waitForResult(task.id, waitSeconds ?? (bridgeLive ? 120 : 0));
        return okJson({ bridgeLive, ...waited });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 13. CREATE MUSIC (Gemini Web App -> saved to generated-media)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_create_music",
    {
      title: "Create Music via Gemini Web App",
      description:
        "USE THIS TOOL whenever the user asks to generate or compose music, a song, soundtrack, jingle, or audio track via Gemini. Selects 'Create music' in Gemini Web App, saves the generated audio to generated-media/, and returns both the local filePath and HTTPS mediaUrl.",
      inputSchema: {
        prompt: z.string().describe("Detailed music/audio generation prompt (genre, mood, tempo, instruments)"),
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        waitSeconds: z.number().int().min(0).max(120).optional().describe("Seconds to wait (default: 120)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt, fromAgent, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "create-music",
          executionMode: "chat",
          geminiTool: "create_music",
          prompt,
        });
        if (!bridgeLive) notifyWindows(`Create Music (${task.id})`, prompt.slice(0, 120));
        const waited = await relayStore.waitForResult(task.id, waitSeconds ?? (bridgeLive ? 120 : 0));
        return okJson({ bridgeLive, ...waited });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 14. GUIDED LEARNING (Gemini Web App)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_guided_learning",
    {
      title: "Guided Learning via Gemini Web App",
      description:
        "USE THIS TOOL whenever the user asks for Guided Learning, interactive tutoring, or step-by-step study coaching via Gemini Web App.",
      inputSchema: {
        topic: z.string().describe("Topic or learning goal"),
        webModel: webModelEnum,
        thinkingLevel: thinkingLevelEnum,
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        waitSeconds: z.number().int().min(0).max(120).optional().describe("Seconds to wait (default: 90)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ topic, webModel, thinkingLevel, fromAgent, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "guided-learning",
          geminiTool: "guided_learning",
          webModel: webModel ?? "4_hydrogen",
          thinkingLevel: thinkingLevel ?? "medium",
          prompt: topic,
        });
        if (!bridgeLive) notifyWindows(`Guided Learning (${task.id})`, topic.slice(0, 120));
        const waited = await relayStore.waitForResult(task.id, waitSeconds ?? (bridgeLive ? 90 : 0));
        return okJson({ bridgeLive, ...waited });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 15. SET GEMINI WEB APP MODEL & THINKING LEVEL
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_set_gemini_mode",
    {
      title: "Set Gemini Web App Model & Thinking Level",
      description:
        "Switch the active model ('auto', '4_hydrogen' Everyday help, '4_neon' Deeper analysis) and Thinking level ('low', 'medium', 'high') inside the open Gemini Web App tab.",
      inputSchema: {
        webModel: webModelEnum,
        thinkingLevel: thinkingLevelEnum,
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        waitSeconds: z.number().int().min(0).max(30).optional().describe("Seconds to wait (default: 15)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ webModel, thinkingLevel, fromAgent, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "general",
          geminiTool: "set_mode",
          webModel: webModel ?? "4_hydrogen",
          thinkingLevel: thinkingLevel ?? "medium",
          prompt: `Set Gemini mode to ${webModel ?? "4_hydrogen"} / ${thinkingLevel ?? "medium"}`,
        });
        const waited = await relayStore.waitForResult(task.id, waitSeconds ?? (bridgeLive ? 15 : 0));
        return okJson({ bridgeLive, ...waited });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 16. RUN GEMINI TASK (Dedicated Task Mode: Sub-agents, Sandboxing, Steps)
  // -------------------------------------------------------------------------
  server.registerTool(
    "relay_run_gemini_task",
    {
      title: "Run Multi-Step Gemini Task (Task Mode: Hydrogen / Neon)",
      description:
        "PRIMARY TOOL for complex, multi-step, sandboxed, or sub-agent work inside Gemini Web App's 'Task' tab (with access to Browser MCP, DevTools, Firecrawl, and Local Agent Connector). Task mode supports 'hydrogen' or 'neon' (no effort switcher). Use relay_deep_research only for Deep Research (Chat mode).",
      inputSchema: {
        prompt: z
          .string()
          .describe("Detailed multi-step task brief for Gemini Task mode to execute"),
        taskModel: taskModelEnum,
        fromAgent: z.string().optional().describe("Calling agent name (default: 'antigravity')"),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional structured context JSON"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Seconds to wait for Gemini Task mode to submit the result (default: 120)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt, taskModel, fromAgent, context, waitSeconds }) => {
      try {
        const bridgeLive = relayStore.isWebAppBridgeConnected();
        const task = relayStore.createTask({
          fromAgent: fromAgent ?? "antigravity",
          toAgent: "gemini-app",
          capability: "general",
          executionMode: "task",
          webModel: taskModel ?? "hydrogen",
          prompt,
          context,
        });

        if (!bridgeLive) {
          notifyWindows(`Gemini Task (${task.id})`, prompt.slice(0, 120));
        }

        const waited = await relayStore.waitForResult(
          task.id,
          waitSeconds ?? (bridgeLive ? 120 : 0)
        );
        return okJson({
          bridgeLive,
          executionMode: "task",
          taskModel: taskModel ?? "hydrogen",
          ...waited,
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  return server;
}
