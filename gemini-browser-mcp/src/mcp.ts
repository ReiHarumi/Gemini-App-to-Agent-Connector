import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertSafeHttpUrl, browserManager } from "./browser.js";
import { firecrawlClient } from "./firecrawl.js";
import { saveScreenshot } from "./screenshots.js";

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

function okText(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
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

/**
 * Creates a fresh McpServer instance per stateless Streamable HTTP request.
 * All instances share the singleton BrowserManager and FirecrawlClient so
 * browser tabs, DevTools logs, and page state persist across Gemini tool calls.
 */
export function createMcpServer(publicBaseUrl?: string): McpServer {
  const server = new McpServer({
    name: "gemini-browser-mcp",
    version: "1.0.0",
  });

  // =========================================================================
  // 1. PLAYWRIGHT BROWSER AUTOMATION TOOLS
  // =========================================================================

  server.registerTool(
    "browser_navigate",
    {
      title: "Playwright: Navigate Browser",
      description:
        "Use Playwright Chromium to navigate the active browser tab to an http/https URL and wait for it to load.",
      inputSchema: {
        url: z.string().url().describe("Target http:// or https:// URL"),
        waitUntil: z
          .enum(["domcontentloaded", "load", "networkidle"])
          .optional()
          .describe("Load state to wait for (default: domcontentloaded)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, waitUntil }) => {
      try {
        const safeUrl = assertSafeHttpUrl(url);
        const page = await browserManager.ensurePage();
        const response = await page.goto(safeUrl, {
          waitUntil: waitUntil ?? "domcontentloaded",
          timeout: 30000,
        });
        const title = await page.title().catch(() => "");
        return okJson({
          url: page.url(),
          title,
          status: response?.status() ?? null,
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Playwright: Page Text & Interactive Snapshot",
      description:
        "Use Playwright to extract visible page text and a list of interactive elements (links, buttons, inputs with CSS selectors) from the active tab.",
      inputSchema: {
        maxTextLength: z
          .number()
          .int()
          .min(500)
          .max(50000)
          .optional()
          .describe("Max characters of visible page text to return (default: 15000)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ maxTextLength }) => {
      try {
        const snapshot = await browserManager.getSnapshot(maxTextLength ?? 15000);
        return okJson(snapshot);
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_click",
    {
      title: "Playwright: Click Element",
      description:
        "Use Playwright to click an element on the active page by CSS selector or visible text.",
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe("CSS selector (e.g. '#submit', 'button[name=\"login\"]')"),
        text: z
          .string()
          .optional()
          .describe("Visible text of the element to click (used if selector is omitted)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ selector, text }) => {
      try {
        if (!selector && !text) {
          throw new Error("Provide either 'selector' or 'text'.");
        }
        const page = await browserManager.ensurePage();
        if (selector) {
          await page.locator(selector).first().click({ timeout: 15000 });
        } else if (text) {
          await page.getByText(text, { exact: false }).first().click({ timeout: 15000 });
        }
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return okJson({
          clicked: selector ?? text,
          url: page.url(),
          title: await page.title().catch(() => ""),
        });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Playwright: Fill Input Field",
      description: "Use Playwright to fill a text input or textarea on the active page.",
      inputSchema: {
        selector: z.string().describe("CSS selector of the input/textarea"),
        value: z.string().describe("Text value to enter"),
        submit: z
          .boolean()
          .optional()
          .describe("If true, presses Enter after filling (default: false)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ selector, value, submit }) => {
      try {
        const page = await browserManager.ensurePage();
        const locator = page.locator(selector).first();
        await locator.fill(value, { timeout: 15000 });
        if (submit) {
          await locator.press("Enter");
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
        return okJson({ filled: selector, submitted: Boolean(submit), url: page.url() });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press Keyboard Key",
      description:
        "Press a keyboard key on the active page (e.g. 'Enter', 'Escape', 'Tab', 'PageDown', 'ArrowDown').",
      inputSchema: {
        key: z.string().describe("Playwright key name"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ key }) => {
      try {
        const page = await browserManager.ensurePage();
        await page.keyboard.press(key);
        return okJson({ pressed: key, url: page.url() });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Playwright: Capture Screenshot",
      description:
        "Use Playwright to capture a screenshot of the active browser tab so you can visually inspect the page.",
      inputSchema: {
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture the entire scrollable page (default: false)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ fullPage }) => {
      try {
        const page = await browserManager.ensurePage();
        const currentUrl = page.url();
        const title = await page.title().catch(() => "");
        const buffer = await page.screenshot({
          type: "jpeg",
          quality: 80,
          fullPage: fullPage ?? false,
        });
        const { filename } = saveScreenshot(buffer, "jpg");
        const base = (publicBaseUrl || `http://localhost:${process.env.PORT || 3000}`).replace(
          /\/+$/,
          ""
        );
        const imageUrl = `${base}/screenshots/${filename}`;
        const blankNote =
          currentUrl === "about:blank"
            ? " Note: active tab is currently about:blank — call browser_navigate first."
            : "";

        return {
          content: [
            {
              type: "image" as const,
              data: buffer.toString("base64"),
              mimeType: "image/jpeg",
            },
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url: currentUrl,
                  title,
                  imageUrl,
                  markdown: `![Screenshot of ${title || currentUrl}](${imageUrl})`,
                  note:
                    "You can display or link this image directly to the user using imageUrl or the markdown snippet." +
                    blankNote,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_tabs",
    {
      title: "Manage Browser Tabs",
      description: "List open browser tabs, open a new tab, switch tabs, or close a tab.",
      inputSchema: {
        action: z.enum(["list", "new", "switch", "close"]),
        url: z.string().url().optional().describe("Optional URL when action is 'new'"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Tab index when action is 'switch' or 'close'"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, url, index }) => {
      try {
        if (action === "list") {
          return okJson(await browserManager.listTabs());
        }
        if (action === "new") {
          return okJson(await browserManager.newTab(url));
        }
        if (action === "switch") {
          if (index === undefined) throw new Error("'index' is required for switch.");
          return okJson(await browserManager.switchTab(index));
        }
        return okJson(await browserManager.closeTab(index));
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "browser_wait",
    {
      title: "Wait for Condition",
      description: "Wait for a CSS selector to appear or wait for a fixed duration in ms.",
      inputSchema: {
        selector: z.string().optional().describe("CSS selector to wait for"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30000)
          .optional()
          .describe("Timeout or sleep duration in ms (default: 5000)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ selector, timeoutMs }) => {
      try {
        const page = await browserManager.ensurePage();
        const ms = timeoutMs ?? 5000;
        if (selector) {
          await page.locator(selector).first().waitFor({ state: "visible", timeout: ms });
          return okJson({ waitedFor: selector, visible: true });
        }
        await page.waitForTimeout(ms);
        return okJson({ waitedMs: ms });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // =========================================================================
  // 2. CHROME DEVTOOLS (CDP) TOOLS
  // =========================================================================

  server.registerTool(
    "devtools_console_logs",
    {
      title: "Chrome DevTools Console Logs",
      description:
        "Read captured browser console messages (log, warn, error, pageerror) from the active browser session.",
      inputSchema: {
        level: z
          .string()
          .optional()
          .describe("Filter by level: log, warning, error, info, pageerror"),
        limit: z.number().int().min(1).max(200).optional().describe("Max entries (default: 50)"),
        clear: z.boolean().optional().describe("Clear buffer after reading (default: false)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ level, limit, clear }) => {
      try {
        return okJson(browserManager.getConsoleLogs({ level, limit, clear }));
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "devtools_network_requests",
    {
      title: "Chrome DevTools Network Requests",
      description:
        "Inspect recent network requests, HTTP statuses, and failed requests captured from the browser.",
      inputSchema: {
        urlContains: z
          .string()
          .optional()
          .describe("Only return requests whose URL contains this substring"),
        onlyErrors: z
          .boolean()
          .optional()
          .describe("Only return failed requests or status >= 400"),
        limit: z.number().int().min(1).max(200).optional().describe("Max entries (default: 50)"),
        clear: z.boolean().optional().describe("Clear buffer after reading (default: false)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ urlContains, onlyErrors, limit, clear }) => {
      try {
        return okJson(
          browserManager.getNetworkLogs({ urlContains, onlyErrors, limit, clear })
        );
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "devtools_evaluate",
    {
      title: "Evaluate JavaScript in Page",
      description:
        "Run a JavaScript expression inside the active page context (like Chrome DevTools Console) and return the serialized result.",
      inputSchema: {
        expression: z
          .string()
          .describe("JavaScript expression or IIFE to evaluate, e.g. 'document.title'"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ expression }) => {
      try {
        const page = await browserManager.ensurePage();
        const result = await page.evaluate((expr: string) => {
          // eslint-disable-next-line no-eval
          return (0, eval)(expr);
        }, expression);
        return okJson({ result: result ?? null });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "devtools_cdp_command",
    {
      title: "Run Chrome DevTools Protocol Command",
      description:
        "Send a raw Chrome DevTools Protocol (CDP) command to the active tab, e.g. 'Performance.getMetrics', 'DOM.getDocument', 'Emulation.setDeviceMetricsOverride'.",
      inputSchema: {
        method: z.string().describe("CDP method name, e.g. 'Performance.getMetrics'"),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional JSON parameters object for the CDP command"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ method, params }) => {
      try {
        const cdp = await browserManager.getCdpSession();
        const result = await cdp.send(method as any, params as any);
        return okJson(result ?? { ok: true });
      } catch (e) {
        return errResult(e);
      }
    }
  );

  // =========================================================================
  // 3. FIRECRAWL TOOLS (SCRAPE, SEARCH, MAP, CRAWL)
  // =========================================================================

  server.registerTool(
    "firecrawl_scrape",
    {
      title: "Firecrawl Scrape URL",
      description:
        "Scrape a single webpage via Firecrawl and return clean LLM-ready Markdown (faster and cleaner than manual browsing for articles/docs).",
      inputSchema: {
        url: z.string().url().describe("Target URL to scrape"),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe("Exclude navs/footers and return only main content (default: true)"),
        formats: z
          .array(z.enum(["markdown", "html", "links"]))
          .optional()
          .describe("Output formats (default: ['markdown'])"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, onlyMainContent, formats }) => {
      try {
        const res = await firecrawlClient.scrape(url, {
          onlyMainContent: onlyMainContent ?? true,
          formats: formats ?? ["markdown"],
        });
        if (res?.data?.markdown && (!formats || (formats.length === 1 && formats[0] === "markdown"))) {
          const title = res.data.metadata?.title ? `# ${res.data.metadata.title}\n\n` : "";
          return okText(`${title}${res.data.markdown}`);
        }
        return okJson(res);
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "firecrawl_search",
    {
      title: "Firecrawl Web Search",
      description:
        "Search the web using Firecrawl and optionally return scraped Markdown for each result.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z.number().int().min(1).max(10).optional().describe("Max results (default: 5)"),
        scrapeMarkdown: z
          .boolean()
          .optional()
          .describe("Also scrape full Markdown of search results (default: false)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, limit, scrapeMarkdown }) => {
      try {
        const res = await firecrawlClient.search(query, {
          limit: limit ?? 5,
          scrapeMarkdown: scrapeMarkdown ?? false,
        });
        return okJson(res);
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "firecrawl_map",
    {
      title: "Firecrawl Map Website URLs",
      description:
        "Rapidly discover URLs on a website using Firecrawl Map before scraping or crawling.",
      inputSchema: {
        url: z.string().url().describe("Base website URL to map"),
        search: z.string().optional().describe("Optional keyword to filter discovered URLs"),
        limit: z.number().int().min(1).max(200).optional().describe("Max URLs (default: 50)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, search, limit }) => {
      try {
        const res = await firecrawlClient.map(url, { search, limit: limit ?? 50 });
        return okJson(res);
      } catch (e) {
        return errResult(e);
      }
    }
  );

  server.registerTool(
    "firecrawl_crawl",
    {
      title: "Firecrawl Multi-Page Crawl",
      description:
        "Crawl multiple linked pages of a website via Firecrawl and return Markdown content.",
      inputSchema: {
        url: z.string().url().describe("Starting URL to crawl"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum pages to crawl (default: 5)"),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum link depth (default: 2)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, limit, maxDepth }) => {
      try {
        const res = await firecrawlClient.crawl(url, {
          limit: limit ?? 5,
          maxDepth: maxDepth ?? 2,
        });
        return okJson(res);
      } catch (e) {
        return errResult(e);
      }
    }
  );

  return server;
}
