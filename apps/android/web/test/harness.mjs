/*
 * Playwright harness for the WalletChan Android web runtime.
 *
 * - Serves apps/android/app/src/main/assets/www (output of package-web.mjs)
 *   either from a local static server at http://localhost:<port> or, with
 *   `origin: "appassets"`, at the real Android origin
 *   https://appassets.androidplatform.net (requests fulfilled from disk via
 *   context.route, so the page — and the Origin header of its WebSockets —
 *   is exactly what the app uses).
 * - Injects a mock `WalletChanNative` bridge into wallet-origin frames
 *   (addInitScript + exposeBinding) that implements `http` with Node fetch
 *   (honouring HTTPS_PROXY) and records every other command.
 * - Simulates the native dApp browser: a second page gets a mock
 *   `WalletChanDapp` plus dapp-inject.js, and its messages are forwarded to
 *   the shell as `dappMessage` exactly like the native side would.
 */
import { createRequire } from "node:module";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
export const androidDir = path.resolve(here, "..", "..");
export const wwwDir = path.join(androidDir, "app/src/main/assets/www");
export const tmpDir = path.join(here, ".tmp");
export const APPASSETS_ORIGIN = "https://appassets.androidplatform.net";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".zkey": "application/octet-stream",
  ".vkey": "application/json",
};

export async function readAsset(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\/+$/, "") || "/index.html";
  const file = path.join(wwwDir, path.normalize(clean).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(wwwDir)) return null;
  try {
    const body = await fs.readFile(file);
    return { body, contentType: MIME[path.extname(file)] || "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Static server for `dir` (default: www). Resolves { url, close }. */
export function startStaticServer({ dir = null, html = null, host = "127.0.0.1", hostname = "localhost" } = {}) {
  const server = http.createServer(async (req, res) => {
    if (html) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const asset = dir ? null : await readAsset(new URL(req.url, "http://x").pathname);
    if (!asset) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store" });
    res.end(asset.body);
  });
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({ url: `http://${hostname}:${port}`, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Node-side fetch for the mock native `http` command (uses NODE_USE_ENV_PROXY). */
async function performHttp(cmd) {
  const reply = { type: "http", id: cmd.id };
  try {
    const response = await fetch(cmd.url, {
      method: cmd.method,
      headers: cmd.headers || {},
      body: cmd.bodyBase64 ? Buffer.from(cmd.bodyBase64, "base64") : undefined,
      redirect: cmd.redirect === "manual" ? "manual" : "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    Object.assign(reply, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      url: response.url || cmd.url,
      bodyBase64: body.length ? body.toString("base64") : null,
    });
  } catch (error) {
    Object.assign(reply, { ok: false, status: 0, statusText: "", headers: {}, bodyBase64: null, error: String(error.cause || error.message || error) });
  }
  return reply;
}

const NATIVE_MOCK_SOURCE = (walletOrigin) => `
(() => {
  if (location.origin !== ${JSON.stringify(walletOrigin)}) return;
  const listeners = [];
  const native = {
    onmessage: null,
    postMessage(data) {
      if (typeof data !== "string") throw new TypeError("WalletChanNative only accepts strings");
      window.__wcNativePost(data);
    },
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
    removeEventListener(type, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
  Object.defineProperty(window, "__wcNativeDeliver", { value(json) {
    const event = { data: json };
    if (typeof native.onmessage === "function") native.onmessage(event);
    listeners.forEach((fn) => fn(event));
  }});
  window.WalletChanNative = native;
})();
`;

const DAPP_MOCK_SOURCE = `
(() => {
  if (window.top !== window) return;
  const listeners = [];
  const bridge = {
    onmessage: null,
    postMessage(data) {
      if (typeof data !== "string") throw new TypeError("WalletChanDapp only accepts strings");
      window.__wcDappPost(data);
    },
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
    removeEventListener() {},
  };
  Object.defineProperty(window, "__wcDappDeliver", { value(json) {
    const event = { data: json };
    if (typeof bridge.onmessage === "function") bridge.onmessage(event);
    listeners.forEach((fn) => fn(event));
  }});
  Object.defineProperty(window, "WalletChanDapp", { value: bridge, configurable: true, writable: true });
})();
`;

/**
 * Creates a browser context wired like the Android app.
 * Returns helpers: { context, shell, native, openShell, openDapp, ... }.
 */
export async function createWalletContext(browser, { origin = "localhost", serverUrl, name = "ctx" } = {}) {
  const walletOrigin = origin === "appassets" ? APPASSETS_ORIGIN : serverUrl;
  const context = await browser.newContext({
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36",
  });

  if (origin === "appassets") {
    await context.route(`${APPASSETS_ORIGIN}/**`, async (route) => {
      const asset = await readAsset(new URL(route.request().url()).pathname);
      if (!asset) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ status: 200, body: asset.body, headers: { "content-type": asset.contentType } });
    });
  }

  const native = {
    commands: [], // every non-http command
    http: [], // { method, url, status }
    shellFrame: null,
    dappPage: null,
    dappTabId: 1000,
    waiters: [],
    record(cmd) {
      this.commands.push(cmd);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(cmd)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(cmd);
        }
      }
    },
    waitFor(predicate, timeout = 30_000, label = "native command") {
      const existing = this.commands.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        this.waiters.push(waiter);
        setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            reject(new Error(`timed out waiting for ${label}`));
          }
        }, timeout);
      });
    },
    async toShell(message) {
      if (!this.shellFrame) throw new Error("shell has not said hello");
      await this.shellFrame.evaluate((json) => window.__wcNativeDeliver(json), JSON.stringify(message));
    },
  };

  await context.exposeBinding("__wcNativePost", async (source, json) => {
    const cmd = JSON.parse(json);
    if (cmd.cmd === "http") {
      const reply = await performHttp(cmd);
      native.http.push({ method: cmd.method, url: cmd.url, status: reply.status, error: reply.error, body: cmd.bodyBase64 ? Buffer.from(cmd.bodyBase64, "base64").toString("utf8").slice(0, 400) : null });
      try {
        await source.frame.evaluate((replyJson) => window.__wcNativeDeliver(replyJson), JSON.stringify(reply));
      } catch {
        /* frame gone */
      }
      return;
    }
    if (cmd.cmd === "hello") {
      if (source.frame === source.page.mainFrame()) {
        native.shellFrame = source.frame;
        native.toShell({ type: "hello", sdkInt: 34, appVersion: "test" }).catch(() => {});
      }
    }
    native.record(cmd);
    if (cmd.cmd === "toDapp" && native.dappPage && cmd.tabId === native.dappTabId) {
      native.dappPage.evaluate((payloadJson) => window.__wcDappDeliver(payloadJson), JSON.stringify(cmd.payload)).catch(() => {});
    }
  });
  await context.addInitScript({ content: NATIVE_MOCK_SOURCE(walletOrigin) });

  const consoleErrors = [];
  const attachConsole = (page, label) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text()}`);
    });
    page.on("pageerror", (error) => consoleErrors.push(`[${label}] pageerror: ${error.message}\n${(error.stack || "").split("\n").slice(1, 4).join("\n")}`));
  };

  const shell = await context.newPage();
  attachConsole(shell, name);

  async function openShell() {
    await shell.goto(`${walletOrigin}/android/shell.html`);
    await waitForFrame(shell, (url) => url.endsWith("/android/background.html"));
  }

  /** Opens a dApp page wired through the simulated native dApp browser. */
  async function openDapp(dappUrl) {
    const page = await context.newPage();
    attachConsole(page, "dapp");
    native.dappPage = page;
    const tabId = ++native.dappTabId;
    await page.exposeBinding("__wcDappPost", async (source, json) => {
      if (source.frame !== page.mainFrame()) return; // native accepts main frame only
      const parsed = JSON.parse(json);
      if (!("message" in parsed)) return; // reply-channel registration only (native does not forward)
      const { requestId, message } = parsed;
      const url = page.url();
      await native.toShell({
        type: "dappMessage",
        tabId,
        url,
        origin: new URL(url).origin,
        title: await page.title().catch(() => ""),
        requestId,
        message,
      });
    });
    await page.addInitScript({ content: DAPP_MOCK_SOURCE });
    await page.addInitScript({ path: path.join(wwwDir, "android/dapp-inject.js") });
    page.on("load", () => {
      native.toShell({ type: "dappTab", tabId, url: page.url(), title: "", status: "complete" }).catch(() => {});
    });
    await native.toShell({ type: "dappVisible", visible: true });
    await page.goto(dappUrl);
    return page;
  }

  /** Writes every captured console error to .tmp/<name>-console.txt. */
  async function dumpConsole() {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, `${name}-console.txt`), consoleErrors.join("\n") + "\n");
  }

  return { context, shell, native, openShell, openDapp, consoleErrors, walletOrigin, dumpConsole };
}

export async function waitForFrame(page, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => predicate(f.url()));
    if (frame) return frame;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("frame not found");
}

/** The top-most overlay frame whose URL matches, or the main UI frame. */
export async function overlayFrame(page, pathPart, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const handles = await page.$$("iframe.wc-overlay");
    for (const handle of handles.reverse()) {
      const frame = await handle.contentFrame();
      if (frame && frame.url().includes(pathPart)) return frame;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`overlay ${pathPart} not found`);
}

export async function mainUiFrame(page) {
  const handle = await page.waitForSelector("iframe#wc-ui", { state: "attached" });
  for (let i = 0; i < 100; i++) {
    const frame = await handle.contentFrame();
    if (frame && frame.url().endsWith("/index.html")) return frame;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("main UI frame not ready");
}

export async function screenshot(page, name) {
  await fs.mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
