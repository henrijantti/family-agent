import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../config.js";

// HTML to PNG with headless Chromium over the DevTools protocol, no npm
// packages: start the browser, open the page, wait for the font, measure the
// page height and capture it. The page is our own HTML with everything
// inlined; it loads nothing from the network.

/** CHROME_BIN, else a system Chromium/Chrome, else one installed by Playwright. */
export function chromePath(): string {
  const fixed = [env("CHROME_BIN"), "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/snap/bin/chromium"];
  for (const p of fixed) if (p && existsSync(p)) return p;
  for (const root of [join(homedir(), ".cache/ms-playwright"), "/opt/pw-browsers"]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = join(root, d, "chrome-linux64/chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No Chromium found: install one (npx playwright install chromium) or set CHROME_BIN");
}

export async function screenshot(html: string, width = 600, scale = 2, timeoutMs = 45_000): Promise<Buffer> {
  const profile = mkdtempSync(join(tmpdir(), "fa-shot-"));
  const proc = spawn(
    chromePath(),
    [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability",
      // No network at all: the page is inlined, and Chrome's own update and metrics calls go nowhere.
      "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ],
    // Own process group, so the renderer and helper processes go with it.
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async () => {
      const wsUrl = await new Promise<string>((resolve, reject) => {
        let buf = "";
        proc.stderr!.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
          if (m) resolve(m[1]);
        });
        proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}): ${buf.slice(-400)}`)));
        proc.on("error", reject);
      });
      const cdp = await Cdp.connect(wsUrl);
      try {
        const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        const s = (method: string, params?: object) => cdp.send<any>(method, params, sessionId);
        await s("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: scale, mobile: false });
        await s("Page.enable");
        const { frameId } = await s("Page.getFrameTree").then((r: any) => ({ frameId: r.frameTree.frame.id }));
        await s("Page.setDocumentContent", { frameId, html });
        const height = (await s("Runtime.evaluate", {
          expression: "document.fonts.ready.then(() => Math.ceil(document.documentElement.scrollHeight))",
          awaitPromise: true,
          returnByValue: true,
        })).result.value as number;
        await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
        const { data } = await s("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
        return Buffer.from(data, "base64");
      } finally {
        await cdp.send("Browser.close").catch(() => {});
        cdp.close();
      }
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`screenshot timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    });
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    const exited = proc.exitCode === null ? new Promise((r) => proc.once("exit", r)) : Promise.resolve();
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // a leftover temp profile is harmless; the OS cleans /tmp
    }
  }
}

/** Minimal DevTools client on Node's built-in WebSocket. */
class Cdp {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const w = msg.id !== undefined ? this.waiting.get(msg.id) : undefined;
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message}`));
      else w.resolve(msg.result);
    });
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error("DevTools connection failed")));
    });
  }
  send<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.ws.close();
  }
}
