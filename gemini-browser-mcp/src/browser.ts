import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Page,
  type Request as PwRequest,
  type Response as PwResponse,
} from "playwright";

export interface ConsoleEntry {
  timestamp: string;
  type: string;
  text: string;
  location?: string;
}

export interface NetworkEntry {
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failure?: string;
}

const MAX_LOG_ENTRIES = 200;

export function assertSafeHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Blocked URL protocol "${parsed.protocol}". Only http:// and https:// URLs are allowed.`
    );
  }
  return parsed.toString();
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private consoleLogs: ConsoleEntry[] = [];
  private networkLogs: NetworkEntry[] = [];
  private attachedPages = new WeakSet<Page>();
  private launchPromise: Promise<Page> | null = null;

  private get headless(): boolean {
    return process.env.HEADLESS !== "false";
  }

  private get cdpEndpoint(): string | undefined {
    const ep = process.env.CDP_ENDPOINT?.trim();
    return ep ? ep : undefined;
  }

  async ensurePage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = this.initBrowser();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  private async initBrowser(): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      if (this.cdpEndpoint) {
        this.browser = await chromium.connectOverCDP(this.cdpEndpoint);
        this.context =
          this.browser.contexts()[0] ?? (await this.browser.newContext());
      } else {
        this.browser = await chromium.launch({
          headless: this.headless,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
          ],
        });
        this.context = await this.browser.newContext({
          viewport: { width: 1280, height: 800 },
        });
      }
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
    }

    const existingPages = this.context.pages().filter((p) => !p.isClosed());
    const page = existingPages[0] ?? (await this.context.newPage());
    this.setActivePage(page);
    return page;
  }

  private setActivePage(page: Page): void {
    this.activePage = page;
    this.cdpSession = null;
    if (!this.attachedPages.has(page)) {
      this.attachedPages.add(page);
      this.attachPageListeners(page);
    }
  }

  private attachPageListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      const locationStr = loc.url
        ? `${loc.url}:${loc.lineNumber ?? 0}`
        : undefined;
      this.pushConsole({
        timestamp: new Date().toISOString(),
        type: msg.type(),
        text: msg.text(),
        location: locationStr,
      });
    });

    page.on("pageerror", (err: Error) => {
      this.pushConsole({
        timestamp: new Date().toISOString(),
        type: "pageerror",
        text: err.stack || err.message,
      });
    });

    page.on("response", (res: PwResponse) => {
      const req = res.request();
      this.pushNetwork({
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        status: res.status(),
        statusText: res.statusText(),
      });
    });

    page.on("requestfailed", (req: PwRequest) => {
      this.pushNetwork({
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText || "Request failed",
      });
    });
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleLogs.push(entry);
    if (this.consoleLogs.length > MAX_LOG_ENTRIES) {
      this.consoleLogs.splice(0, this.consoleLogs.length - MAX_LOG_ENTRIES);
    }
  }

  private pushNetwork(entry: NetworkEntry): void {
    this.networkLogs.push(entry);
    if (this.networkLogs.length > MAX_LOG_ENTRIES) {
      this.networkLogs.splice(0, this.networkLogs.length - MAX_LOG_ENTRIES);
    }
  }

  async getCdpSession(): Promise<CDPSession> {
    const page = await this.ensurePage();
    if (!this.cdpSession) {
      this.cdpSession = await page.context().newCDPSession(page);
    }
    return this.cdpSession;
  }

  getConsoleLogs(options?: {
    level?: string;
    limit?: number;
    clear?: boolean;
  }): ConsoleEntry[] {
    let logs = this.consoleLogs;
    if (options?.level) {
      const target = options.level.toLowerCase();
      logs = logs.filter((l) => l.type.toLowerCase() === target);
    }
    const limit = options?.limit ?? 50;
    const result = logs.slice(-limit);
    if (options?.clear) {
      this.consoleLogs = [];
    }
    return result;
  }

  getNetworkLogs(options?: {
    urlContains?: string;
    onlyErrors?: boolean;
    limit?: number;
    clear?: boolean;
  }): NetworkEntry[] {
    let logs = this.networkLogs;
    if (options?.urlContains) {
      const needle = options.urlContains.toLowerCase();
      logs = logs.filter((l) => l.url.toLowerCase().includes(needle));
    }
    if (options?.onlyErrors) {
      logs = logs.filter((l) => Boolean(l.failure) || (l.status ?? 0) >= 400);
    }
    const limit = options?.limit ?? 50;
    const result = logs.slice(-limit);
    if (options?.clear) {
      this.networkLogs = [];
    }
    return result;
  }

  async listTabs(): Promise<
    Array<{ index: number; title: string; url: string; active: boolean }>
  > {
    const active = await this.ensurePage();
    const pages = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    return Promise.all(
      pages.map(async (p, index) => ({
        index,
        title: await p.title().catch(() => ""),
        url: p.url(),
        active: p === active,
      }))
    );
  }

  async newTab(url?: string): Promise<{ index: number; url: string }> {
    await this.ensurePage();
    const page = await this.context!.newPage();
    this.setActivePage(page);
    if (url) {
      const safeUrl = assertSafeHttpUrl(url);
      await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    const pages = this.context!.pages().filter((p) => !p.isClosed());
    return { index: pages.indexOf(page), url: page.url() };
  }

  async switchTab(index: number): Promise<{ index: number; url: string; title: string }> {
    await this.ensurePage();
    const pages = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    if (index < 0 || index >= pages.length) {
      throw new Error(`Tab index ${index} out of range (0..${pages.length - 1})`);
    }
    const page = pages[index];
    await page.bringToFront();
    this.setActivePage(page);
    return { index, url: page.url(), title: await page.title().catch(() => "") };
  }

  async closeTab(index?: number): Promise<{ closedIndex: number; remaining: number }> {
    const active = await this.ensurePage();
    const pages = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    const targetIndex = index ?? pages.indexOf(active);
    if (targetIndex < 0 || targetIndex >= pages.length) {
      throw new Error(`Tab index ${targetIndex} out of range`);
    }
    const target = pages[targetIndex];
    await target.close();
    const remaining = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    if (remaining.length > 0) {
      this.setActivePage(remaining[Math.min(targetIndex, remaining.length - 1)]);
    } else {
      this.activePage = null;
      this.cdpSession = null;
    }
    return { closedIndex: targetIndex, remaining: remaining.length };
  }

  async getSnapshot(maxTextLength = 15000): Promise<{
    url: string;
    title: string;
    text: string;
    interactiveElements: Array<{
      tag: string;
      role?: string;
      text: string;
      selector: string;
      href?: string;
      type?: string;
    }>;
  }> {
    const page = await this.ensurePage();
    const title = await page.title().catch(() => "");
    const url = page.url();

    const data = await page.evaluate((limit: number) => {
      const bodyText = (document.body?.innerText || "").trim();
      const text =
        bodyText.length > limit
          ? `${bodyText.slice(0, limit)}\n\n...[truncated ${bodyText.length - limit} chars]`
          : bodyText;

      const candidates = Array.from(
        document.querySelectorAll(
          'a[href], button, input, textarea, select, [role="button"], [role="link"]'
        )
      );

      const interactiveElements: Array<{
        tag: string;
        role?: string;
        text: string;
        selector: string;
        href?: string;
        type?: string;
      }> = [];

      for (const el of candidates) {
        if (interactiveElements.length >= 60) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute("id");
        const name = el.getAttribute("name");
        const ariaLabel = el.getAttribute("aria-label");
        const placeholder = el.getAttribute("placeholder");
        const role = el.getAttribute("role") || undefined;
        const type = el.getAttribute("type") || undefined;
        const href =
          tag === "a" ? (el as HTMLAnchorElement).href || undefined : undefined;

        let selector = tag;
        if (id) {
          selector = `#${CSS.escape(id)}`;
        } else if (name) {
          selector = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        } else if (ariaLabel) {
          selector = `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
        } else if (placeholder) {
          selector = `${tag}[placeholder="${placeholder.replace(/"/g, '\\"')}"]`;
        }

        const label = (
          el.textContent?.trim() ||
          ariaLabel ||
          placeholder ||
          (el as HTMLInputElement).value ||
          ""
        )
          .replace(/\s+/g, " ")
          .slice(0, 120);

        interactiveElements.push({
          tag,
          role,
          text: label,
          selector,
          href,
          type,
        });
      }

      return { text, interactiveElements };
    }, maxTextLength);

    return { url, title, ...data };
  }

  async withTemporaryPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    await this.ensurePage();
    const page = await this.context!.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      if (this.cdpEndpoint) {
        // Don't kill the user's external Chrome when connected over CDP
        await this.browser.close().catch(() => {});
      } else {
        await this.browser.close().catch(() => {});
      }
    }
    this.browser = null;
    this.context = null;
    this.activePage = null;
    this.cdpSession = null;
  }
}

export const browserManager = new BrowserManager();
