import { chromium, errors, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { formatSnapshot, takeSnapshot, type RawSnapshot } from "./snapshot.js";

export interface BrowserOptions {
  baseUrl: string;
  headless?: boolean;
  /** Animate a visible cursor and type at human speed. For live demos and recordings; slower. */
  humanize?: boolean;
  recordVideoDir?: string;
  /** "chrome" uses the installed Google Chrome; undefined uses Playwright's bundled Chromium. */
  channel?: string;
}

/** A browser action that did not do what was asked. The message is written for the model. */
export class ActionError extends Error {}

// tsx/esbuild wraps named functions in __name(); define it so the snapshot function runs in the page.
const SNAPSHOT_JS = `(() => { const __name = (f) => f; return (${takeSnapshot.toString()})(); })()`;

const CURSOR_JS = `(([x, y]) => {
  let c = document.getElementById('__ld_cursor');
  if (!c) {
    c = document.createElement('div'); c.id = '__ld_cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(59,91,219,.35);border:2px solid #3b5bdb;pointer-events:none;transition:left .35s ease,top .35s ease,transform .15s;left:50%;top:50%';
    document.body.appendChild(c);
  }
  c.style.left = x + 'px'; c.style.top = y + 'px';
  setTimeout(() => { c.style.transform = 'scale(1.6)'; setTimeout(() => { c.style.transform = 'scale(1)'; }, 150); }, 380);
})`;

export class BrowserSession {
  private lastDoc: string | null = null;

  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    readonly page: Page,
    private opts: BrowserOptions,
  ) {}

  static async launch(opts: BrowserOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: opts.headless ?? true, channel: opts.channel });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: opts.recordVideoDir ? { dir: opts.recordVideoDir, size: { width: 1280, height: 800 } } : undefined,
    });
    const page = await context.newPage();
    // The agent may only see and touch the CRM; any other origin is blocked at the network layer.
    const origin = new URL(opts.baseUrl).origin;
    await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    await page.goto(opts.baseUrl);
    return new BrowserSession(browser, context, page, opts);
  }

  /** False once the window or page has been closed (e.g. by the person watching). */
  get isOpen(): boolean {
    return !this.page.isClosed() && this.browser.isConnected();
  }

  get url(): string {
    return this.page.url();
  }

  async snapshot(): Promise<RawSnapshot> {
    const snap = (await this.page.evaluate(SNAPSHOT_JS)) as RawSnapshot;
    this.lastDoc = snap.doc;
    return snap;
  }

  async observe(): Promise<string> {
    return formatSnapshot(await this.snapshot());
  }

  /** What a ref points at, if it exists on the current page. Used by the approval gate. */
  async describeRef(ref: string): Promise<{ consequential: string | null; text: string } | null> {
    const el = await this.resolve(ref).catch(() => null);
    if (!el) return null;
    return el.evaluate((n) => ({ consequential: (n as HTMLElement).dataset.consequential ?? null, text: (n.textContent ?? "").trim() }));
  }

  async click(ref: string): Promise<string> {
    const el = await this.resolve(ref);
    await this.pointAt(el);
    try {
      await el.click({ timeout: 2500 });
    } catch (err) {
      throw new ActionError(`Click on ${ref} did not land: ${explain(err)}`);
    }
    return this.settle();
  }

  async fill(ref: string, text: string): Promise<string> {
    const el = await this.resolve(ref);
    await this.pointAt(el);
    try {
      const type = await el.evaluate((n) => (n as HTMLInputElement).type);
      if (this.opts.humanize && !["date", "number"].includes(type)) {
        await el.fill("", { timeout: 2500 });
        await el.pressSequentially(text, { delay: 35 });
      } else {
        await el.fill(text, { timeout: 2500 });
      }
    } catch (err) {
      throw new ActionError(`Typing into ${ref} failed: ${explain(err)}`);
    }
    return this.settle(false);
  }

  async select(ref: string, option: string): Promise<string> {
    const el = await this.resolve(ref);
    await this.pointAt(el);
    try {
      await el.selectOption({ label: option }, { timeout: 2500 }).catch(() => el.selectOption(option, { timeout: 2500 }));
    } catch (err) {
      throw new ActionError(`Selecting "${option}" in ${ref} failed: ${explain(err)}`);
    }
    return this.settle(false);
  }

  async press(key: string): Promise<string> {
    await this.page.keyboard.press(key);
    return this.settle();
  }

  async navigate(path: string): Promise<string> {
    const base = new URL(this.opts.baseUrl);
    const target = new URL(path, base);
    if (target.origin !== base.origin) throw new ActionError(`Navigation outside the demo app is not allowed (${target.origin}).`);
    await this.page.goto(target.toString(), { waitUntil: "domcontentloaded" });
    return this.settle();
  }

  async wait(seconds: number, forText?: string): Promise<string> {
    const ms = Math.min(Math.max(seconds, 0.2), 10) * 1000;
    if (forText) {
      await this.page
        .getByText(forText)
        .first()
        .waitFor({ timeout: ms })
        .catch(() => {
          throw new ActionError(`"${forText}" did not appear within ${ms / 1000}s.`);
        });
    } else {
      await this.page.waitForTimeout(ms);
    }
    return this.observe();
  }

  async screenshot(): Promise<string> {
    return (await this.page.screenshot({ type: "jpeg", quality: 60 })).toString("base64");
  }

  async close(): Promise<string | null> {
    const video = this.page.video();
    await this.context.close();
    await this.browser.close();
    return video ? video.path() : null;
  }

  private async resolve(ref: string): Promise<Locator> {
    if (!/^e\d+$/.test(ref)) throw new ActionError(`"${ref}" is not an element ref. Use a ref like e12 from the latest page state.`);
    const doc = await this.page.evaluate("window.__ld && window.__ld.doc").catch(() => null);
    if (!this.lastDoc || doc !== this.lastDoc) {
      throw new ActionError(`The page changed since you last saw it, so ${ref} is stale. Read the current page state below and use its refs.\n\n${await this.observe()}`);
    }
    const el = this.page.locator(`[data-ld-ref="${ref}"]`);
    if ((await el.count()) === 0) throw new ActionError(`No element ${ref} on the current page.\n\n${await this.observe()}`);
    return el.first();
  }

  private async pointAt(el: Locator): Promise<void> {
    if (!this.opts.humanize) return;
    const box = await el.boundingBox().catch(() => null);
    if (!box) return;
    await this.page.evaluate(`${CURSOR_JS}([${box.x + box.width / 2}, ${box.y + box.height / 2}])`).catch(() => {});
    await this.page.waitForTimeout(450);
  }

  /** Let the page react (navigation, fetches), then report what it looks like now. */
  private async settle(mayNavigate = true): Promise<string> {
    if (mayNavigate) {
      await this.page.waitForTimeout(150);
      await this.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    return this.observe();
  }
}

function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const covering = msg.split("\n").find((l) => l.includes("intercepts pointer events"));
  if (covering) return `another element is covering it (${covering.trim().replace(/^- /, "").slice(0, 160)}). A dialog or overlay is probably open.`;
  if (err instanceof errors.TimeoutError) return `timed out waiting for the element to be ready (${msg.split("\n")[0].slice(0, 160)})`;
  return msg.split("\n")[0].slice(0, 200);
}
