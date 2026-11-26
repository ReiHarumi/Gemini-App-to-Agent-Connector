import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { assertSafeHttpUrl, browserManager } from "./browser.js";

export interface FirecrawlScrapeOptions {
  formats?: Array<"markdown" | "html" | "links" | "screenshot">;
  onlyMainContent?: boolean;
  waitFor?: number;
}

export interface FirecrawlSearchOptions {
  limit?: number;
  scrapeMarkdown?: boolean;
}

export interface FirecrawlMapOptions {
  search?: string;
  limit?: number;
}

export interface FirecrawlCrawlOptions {
  limit?: number;
  maxDepth?: number;
  onlyMainContent?: boolean;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["script", "style", "noscript", "iframe"]);

class FirecrawlClient {
  get mode(): "cloud" | "self-hosted" | "local-playwright" {
    if (process.env.FIRECRAWL_API_URL?.trim()) return "self-hosted";
    if (process.env.FIRECRAWL_API_KEY?.trim()) return "cloud";
    return "local-playwright";
  }

  private get baseUrl(): string {
    const custom = process.env.FIRECRAWL_API_URL?.trim();
    return (custom || "https://api.firecrawl.dev").replace(/\/+$/, "");
  }

  private get apiKey(): string {
    return process.env.FIRECRAWL_API_KEY?.trim() || "";
  }

  private async request<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const key = this.apiKey;
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = json?.error || json?.message || res.statusText || text;
      throw new Error(`Firecrawl API error (${res.status}): ${msg}`);
    }

    return json as T;
  }

  private async localScrape(url: string, options: FirecrawlScrapeOptions = {}): Promise<any> {
    const safeUrl = assertSafeHttpUrl(url);
    const onlyMain = options.onlyMainContent ?? true;
    const formats = options.formats ?? ["markdown"];

    return browserManager.withTemporaryPage(async (page) => {
      const response = await page.goto(safeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (options.waitFor && options.waitFor > 0) {
        await page.waitForTimeout(Math.min(options.waitFor, 10000));
      } else {
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      }

      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      const html = await page.content();

      const dom = new JSDOM(html, { url: finalUrl });
      const doc = dom.window.document;

      const links = Array.from(doc.querySelectorAll("a[href]"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => h.startsWith("http://") || h.startsWith("https://"));
      const uniqueLinks = Array.from(new Set(links));

      let articleHtml = doc.body?.innerHTML || html;
      let articleTitle = title;
      if (onlyMain) {
        const reader = new Readability(doc.cloneNode(true) as Document);
        const parsed = reader.parse();
        if (parsed?.content) {
          articleHtml = parsed.content;
          if (parsed.title) articleTitle = parsed.title;
        }
      }

      const markdown = turndown.turndown(articleHtml).trim();
      const data: Record<string, unknown> = {
        metadata: {
          title: articleTitle,
          sourceURL: finalUrl,
          statusCode: response?.status() ?? null,
          engine: "local-playwright",
        },
      };

      if (formats.includes("markdown")) data.markdown = markdown;
      if (formats.includes("html")) data.html = articleHtml;
      if (formats.includes("links")) data.links = uniqueLinks;

      return { success: true, data };
    });
  }

  async scrape(url: string, options: FirecrawlScrapeOptions = {}): Promise<any> {
    const safeUrl = assertSafeHttpUrl(url);
    if (this.mode === "local-playwright") {
      return this.localScrape(safeUrl, options);
    }
    return this.request("/v1/scrape", {
      url: safeUrl,
      formats: options.formats ?? ["markdown"],
      onlyMainContent: options.onlyMainContent ?? true,
      waitFor: options.waitFor,
    });
  }

  async search(query: string, options: FirecrawlSearchOptions = {}): Promise<any> {
    if (this.mode !== "local-playwright") {
      return this.request("/v1/search", {
        query,
        limit: options.limit ?? 5,
        ...(options.scrapeMarkdown
          ? { scrapeOptions: { formats: ["markdown"] } }
          : {}),
      });
    }

    const limit = options.limit ?? 5;
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const results = await browserManager.withTemporaryPage(async (page) => {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      return page.evaluate((max: number) => {
        const items: Array<{ title: string; url: string; description: string }> = [];
        const nodes = document.querySelectorAll(".result");
        for (const node of nodes) {
          if (items.length >= max) break;
          const a = node.querySelector("a.result__a") as HTMLAnchorElement | null;
          const snippet = node.querySelector(".result__snippet");
          if (!a) continue;
          let href = a.href;
          try {
            const u = new URL(href);
            const uddg = u.searchParams.get("uddg");
            if (uddg) href = uddg;
          } catch {
            // keep raw href
          }
          if (!href.startsWith("http://") && !href.startsWith("https://")) continue;
          items.push({
            title: (a.textContent || "").trim(),
            url: href,
            description: (snippet?.textContent || "").trim(),
          });
        }
        return items;
      }, limit);
    });

    if (options.scrapeMarkdown && results.length > 0) {
      const enriched = [];
      for (const item of results) {
        try {
          const scraped = await this.localScrape(item.url, {
            formats: ["markdown"],
            onlyMainContent: true,
          });
          enriched.push({
            ...item,
            markdown: (scraped.data?.markdown || "").slice(0, 8000),
          });
        } catch (err) {
          enriched.push({
            ...item,
            scrapeError: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { success: true, engine: "local-playwright", data: enriched };
    }

    return { success: true, engine: "local-playwright", data: results };
  }

  async map(url: string, options: FirecrawlMapOptions = {}): Promise<any> {
    const safeUrl = assertSafeHttpUrl(url);
    if (this.mode !== "local-playwright") {
      return this.request("/v1/map", {
        url: safeUrl,
        search: options.search,
        limit: options.limit ?? 50,
      });
    }

    const baseOrigin = new URL(safeUrl).origin;
    const scraped = await this.localScrape(safeUrl, { formats: ["links"] });
    let links: string[] = (scraped.data?.links || []).filter((l: string) =>
      l.startsWith(baseOrigin)
    );

    if (options.search) {
      const needle = options.search.toLowerCase();
      links = links.filter((l) => l.toLowerCase().includes(needle));
    }

    const limit = options.limit ?? 50;
    return {
      success: true,
      engine: "local-playwright",
      links: links.slice(0, limit),
    };
  }

  async crawl(url: string, options: FirecrawlCrawlOptions = {}): Promise<any> {
    const safeUrl = assertSafeHttpUrl(url);
    if (this.mode !== "local-playwright") {
      const start = await this.request<{ success: boolean; id?: string; url?: string }>(
        "/v1/crawl",
        {
          url: safeUrl,
          limit: options.limit ?? 5,
          maxDepth: options.maxDepth ?? 2,
          scrapeOptions: {
            formats: ["markdown"],
            onlyMainContent: options.onlyMainContent ?? true,
          },
        }
      );

      if (!start.id) return start;

      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = await this.request<any>(`/v1/crawl/${start.id}`, undefined, "GET");
        if (
          status.status === "completed" ||
          status.status === "failed" ||
          status.status === "cancelled"
        ) {
          return status;
        }
      }

      return {
        status: "timeout",
        id: start.id,
        message: "Crawl is still running on Firecrawl; increase timeout or lower limit.",
      };
    }

    // Local BFS crawl using Playwright + Readability + Turndown
    const limit = Math.min(options.limit ?? 5, 20);
    const maxDepth = Math.min(options.maxDepth ?? 2, 5);
    const baseOrigin = new URL(safeUrl).origin;

    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: safeUrl, depth: 0 }];
    const pages: any[] = [];

    while (queue.length > 0 && pages.length < limit) {
      const current = queue.shift()!;
      const normalized = current.url.split("#")[0];
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      try {
        const res = await this.localScrape(normalized, {
          formats: ["markdown", "links"],
          onlyMainContent: options.onlyMainContent ?? true,
        });
        pages.push({
          url: res.data?.metadata?.sourceURL || normalized,
          title: res.data?.metadata?.title || "",
          markdown: res.data?.markdown || "",
        });

        if (current.depth < maxDepth && Array.isArray(res.data?.links)) {
          for (const nextUrl of res.data.links as string[]) {
            const clean = nextUrl.split("#")[0];
            if (clean.startsWith(baseOrigin) && !visited.has(clean)) {
              queue.push({ url: clean, depth: current.depth + 1 });
            }
          }
        }
      } catch (err) {
        pages.push({
          url: normalized,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      success: true,
      status: "completed",
      engine: "local-playwright",
      completed: pages.length,
      data: pages,
    };
  }
}

export const firecrawlClient = new FirecrawlClient();
