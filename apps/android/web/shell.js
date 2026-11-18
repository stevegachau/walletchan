/*
 * WalletChan Android shell runtime.
 *
 * Loaded by /android/shell.html, the top-level document of the main WebView.
 * The shell plays the part of the browser for the unmodified MV3 extension
 * build: it owns chrome.storage (IndexedDB backed), the runtime message bus
 * and ports, alarms, the windows/tabs model, notifications, the hidden
 * background "service worker" iframe, the full-screen wallet UI iframe,
 * overlay "windows" (chrome.windows.create / chrome.tabs.create of extension
 * pages) and the offscreen document iframe.
 *
 * Every wallet frame runs /android/chrome-shim.js first, which finds this
 * object as `window.top.__walletchanShell` and builds `chrome.*` on top of it.
 *
 * Cross-realm rule: data crossing between the shell and a frame is always
 * passed as a JSON string and parsed in the receiving realm. That mirrors
 * Chrome's JSON-like message serialization and avoids leaking shell-realm
 * objects (where `instanceof Array/Object` would fail) into extension code.
 *
 * Native bridge (see apps/android/ARCHITECTURE.md): `window.WalletChanNative`
 * exists inside the Android app (and is mocked by the Playwright harness).
 * Without it the shell still works on desktop Chromium for development, with
 * plain fetch and window.open fallbacks.
 */
(function () {
  "use strict";

  if (window.__walletchanShell) return;

  const ORIGIN = location.origin;
  const EXTENSION_ID = "kpmiabaddjcfeoihmplfgbbcnmcpeobg";
  const MAIN_WINDOW_ID = 1;
  const PORT_CLOSED = "The message port closed before a response was received.";
  const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
  const STORAGE_DB = "walletchan-chrome-storage";
  const PERSISTENT_AREAS = ["local", "sync"];

  const log = (...args) => console.log("[walletchan-shell]", ...args);
  const warn = (...args) => console.warn("[walletchan-shell]", ...args);

  // ---------------------------------------------------------------------------
  // Native bridge
  // ---------------------------------------------------------------------------

  const nativeBridge = window.WalletChanNative || null;
  const pendingHttp = new Map();
  let nextHttpId = 1;

  function nativePost(message) {
    if (!nativeBridge) {
      log("native (absent):", message.cmd, message.url || "");
      return false;
    }
    try {
      nativeBridge.postMessage(JSON.stringify(message));
      return true;
    } catch (error) {
      warn("native postMessage failed", error);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const toJson = (value) => (value === undefined ? undefined : JSON.stringify(value));
  const parseJson = (json) => (json === undefined || json === null ? undefined : JSON.parse(json));

  function extensionPath(url) {
    try {
      const parsed = new URL(url, ORIGIN + "/");
      return parsed.origin === ORIGIN ? parsed.pathname : null;
    } catch {
      return null;
    }
  }

  function isExtensionUrl(url) {
    return extensionPath(url) !== null;
  }

  function absoluteExtensionUrl(url) {
    return new URL(url, ORIGIN + "/").href;
  }

  /** chrome match pattern / glob -> RegExp ("*" matches anything). */
  function patternToRegExp(pattern) {
    const escaped = String(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$");
  }

  function urlMatches(url, patterns) {
    if (patterns === undefined) return true;
    if (!url) return false;
    const list = Array.isArray(patterns) ? patterns : [patterns];
    return list.some((pattern) => patternToRegExp(pattern).test(url));
  }

  // ---------------------------------------------------------------------------
  // Toast (WalletConnect feedback etc.)
  // ---------------------------------------------------------------------------

  let toastTimer = null;
  function showToast(text, kind = "info", durationMs = 3500) {
    const el = document.getElementById("wc-toast");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    el.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    if (durationMs > 0) {
      toastTimer = setTimeout(() => el.classList.remove("visible"), durationMs);
    }
  }

  function hideToast() {
    const el = document.getElementById("wc-toast");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    if (el) el.classList.remove("visible");
  }

  // ---------------------------------------------------------------------------
  // Storage (chrome.storage.local / sync persisted in IndexedDB, session in memory)
  // ---------------------------------------------------------------------------

  /** area -> Map(key -> JSON string) */
  const storageAreas = { local: new Map(), sync: new Map(), session: new Map() };
  const meta = new Map();
  let db = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(STORAGE_DB, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const name of [...PERSISTENT_AREAS, "meta"]) {
          if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function loadStore(name, target) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readonly");
      const store = tx.objectStore(name);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      tx.oncomplete = () => {
        keysRequest.result.forEach((key, index) => target.set(String(key), valuesRequest.result[index]));
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Writes `puts` (key -> JSON string) and deletes `deletes` in one transaction. */
  function persist(name, puts, deletes, clearAll = false) {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      const store = tx.objectStore(name);
      if (clearAll) store.clear();
      for (const key of deletes) store.delete(key);
      for (const [key, json] of puts) store.put(json, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function normalizeKeys(keys) {
    if (keys === null || keys === undefined) return { all: true };
    if (typeof keys === "string") return { list: [keys] };
    if (Array.isArray(keys)) return { list: keys.map(String) };
    if (typeof keys === "object") return { list: Object.keys(keys), defaults: keys };
    throw new Error("Invalid storage keys");
  }

  function storageGet(area, keys) {
    const map = storageAreas[area];
    const result = {};
    const spec = normalizeKeys(keys);
    if (spec.all) {
      for (const [key, json] of map) result[key] = JSON.parse(json);
      return result;
    }
    for (const key of spec.list) {
      if (map.has(key)) result[key] = JSON.parse(map.get(key));
      else if (spec.defaults && spec.defaults[key] !== undefined) result[key] = clone(spec.defaults[key]);
    }
    return result;
  }

  async function storageSet(area, items) {
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      throw new Error("Invalid storage items");
    }
    const map = storageAreas[area];
    const changes = {};
    const puts = [];
    for (const key of Object.keys(items)) {
      const json = JSON.stringify(items[key]);
      if (json === undefined) continue; // Chrome ignores undefined/function values
      const old = map.get(key);
      map.set(key, json);
      puts.push([key, json]);
      if (old !== json) {
        changes[key] = { newValue: JSON.parse(json) };
        if (old !== undefined) changes[key].oldValue = JSON.parse(old);
      }
    }
    emitStorageChanged(area, changes);
    if (PERSISTENT_AREAS.includes(area)) await persist(area, puts, []);
    else if (area === "session" && puts.length) mirrorSession({ op: "set", items: Object.fromEntries(puts) });
  }

  /**
   * chrome.storage.session lives in the shell's memory, which dies whenever
   * Android kills/recreates the WebView renderer (common while the user is in
   * another app). Chrome keeps storage.session across service-worker restarts
   * and only drops it when the browser exits, and the extension relies on that
   * to restore an unlocked session. So mirror it into the app process's memory
   * (never disk); `hello` hands it back after a WebView restart.
   */
  function mirrorSession(op) {
    nativePost(Object.assign({ cmd: "sessionStore" }, op));
  }

  async function storageRemove(area, keys) {
    const map = storageAreas[area];
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys.map(String) : [];
    const changes = {};
    const deletes = [];
    for (const key of list) {
      if (!map.has(key)) continue;
      changes[key] = { oldValue: JSON.parse(map.get(key)) };
      map.delete(key);
      deletes.push(key);
    }
    emitStorageChanged(area, changes);
    if (PERSISTENT_AREAS.includes(area) && deletes.length) await persist(area, [], deletes);
    else if (area === "session" && deletes.length) mirrorSession({ op: "remove", keys: deletes });
  }

  async function storageClear(area) {
    const map = storageAreas[area];
    const changes = {};
    for (const [key, json] of map) changes[key] = { oldValue: JSON.parse(json) };
    map.clear();
    emitStorageChanged(area, changes);
    if (PERSISTENT_AREAS.includes(area)) await persist(area, [], [], true);
    else if (area === "session") mirrorSession({ op: "clear" });
  }

  function storageBytesInUse(area, keys) {
    const map = storageAreas[area];
    const spec = normalizeKeys(keys);
    let total = 0;
    for (const [key, json] of map) {
      if (spec.all || spec.list.includes(key)) total += key.length + json.length;
    }
    return total;
  }

  function emitStorageChanged(area, changes) {
    if (Object.keys(changes).length === 0) return;
    const changesJson = JSON.stringify(changes);
    // Chrome delivers onChanged asynchronously, after the write call returns.
    setTimeout(() => {
      for (const ctx of contexts.values()) {
        safeDispatch(ctx, "onStorageChanged", changesJson, area);
      }
      forwardStorageChangeToDapp(area, changes);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Contexts (one per extension document: background, ui, overlay, offscreen)
  // ---------------------------------------------------------------------------

  /**
   * ctx = { id, role, win, frame, windowId, tabId, url, frameId,
   *         dispatcher, documentId }
   */
  const contexts = new Map();
  let nextContextId = 1;

  /** Managed iframes: element -> { role, windowId, tabId } */
  const managedFrames = new Map();

  function frameInfoForWindow(win) {
    for (const [frame, info] of managedFrames) {
      if (frame.contentWindow === win) return { frame, info };
    }
    return null;
  }

  function contextTypeFor(ctx) {
    switch (ctx.role) {
      case "background":
        return "BACKGROUND";
      case "offscreen":
        return "OFFSCREEN_DOCUMENT";
      case "ui":
        return "SIDE_PANEL";
      default:
        return "TAB";
    }
  }

  function registerContext(win, hint) {
    const found = frameInfoForWindow(win);
    let role;
    let windowId = MAIN_WINDOW_ID;
    let tabId;
    let frameId = 0;
    if (found) {
      role = found.info.role;
      windowId = found.info.windowId ?? MAIN_WINDOW_ID;
      tabId = found.info.tabId;
    } else {
      // A nested frame inside a wallet document (e.g. an iframe inside the UI).
      role = "subframe";
      frameId = nextContextId + 100;
      let parentCtx = null;
      for (const ctx of contexts.values()) {
        try {
          if (ctx.win === win.parent) parentCtx = ctx;
        } catch {
          /* ignore */
        }
      }
      if (parentCtx) {
        windowId = parentCtx.windowId;
        tabId = parentCtx.tabId;
      }
    }
    const id = nextContextId++;
    const url = role === "background" ? ORIGIN + "/static/js/background.js" : String(hint && hint.url);
    const ctx = {
      id,
      role,
      win,
      frame: found ? found.frame : null,
      windowId,
      tabId,
      url,
      frameId,
      dispatcher: null,
      documentId: "doc-" + id + "-" + Math.random().toString(36).slice(2),
    };
    contexts.set(id, ctx);
    if (tabId !== undefined && overlayTabs.has(tabId)) {
      const tab = overlayTabs.get(tabId);
      tab.url = url;
    }
    return JSON.stringify({
      contextId: id,
      role,
      windowId,
      tabId: tabId ?? null,
      extensionId: EXTENSION_ID,
      manifest: manifest,
      hasNativeHttp: Boolean(nativeBridge),
    });
  }

  function setDispatcher(contextId, dispatcher) {
    const ctx = contexts.get(contextId);
    if (ctx) ctx.dispatcher = dispatcher;
  }

  function unregisterContext(contextId) {
    const ctx = contexts.get(contextId);
    if (!ctx) return;
    contexts.delete(contextId);
    // Disconnect every port this context took part in.
    for (const port of [...ports.values()]) {
      if (port.opener === contextId) {
        closePort(port, contextId);
      } else if (port.receivers.has(contextId)) {
        port.receivers.delete(contextId);
        if (port.receivers.size === 0) closePort(port, contextId);
      }
    }
    // Any message waiting on this context for an async response.
    for (const pending of pendingResponses) pending.contextGone(contextId);
  }

  function unregisterFrameContexts(frame) {
    for (const ctx of [...contexts.values()]) {
      if (ctx.frame === frame) unregisterContext(ctx.id);
    }
  }

  /** Calls a frame dispatcher method, tolerating dead (removed) frames. */
  function safeDispatch(ctx, method, ...args) {
    const dispatcher = ctx.dispatcher;
    if (!dispatcher || typeof dispatcher[method] !== "function") return undefined;
    try {
      return dispatcher[method](...args);
    } catch (error) {
      warn("dispatch to context failed", ctx.role, method, error);
      return undefined;
    }
  }

  function senderForContext(ctx) {
    const sender = {
      id: EXTENSION_ID,
      url: ctx.url,
      origin: ORIGIN,
      documentId: ctx.documentId,
      documentLifecycle: "active",
    };
    // Wallet documents are top-level documents (frameId 0). The background
    // service worker has no frameId in Chrome.
    if (ctx.role !== "background") sender.frameId = ctx.frameId;
    return sender;
  }

  function trustedUiSender() {
    return {
      id: EXTENSION_ID,
      url: ORIGIN + "/index.html",
      origin: ORIGIN,
      frameId: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Runtime messaging
  // ---------------------------------------------------------------------------

  const pendingResponses = new Set();
  const busObservers = [];
  let backgroundReady = false;
  const queuedUntilBackground = [];

  /**
   * Delivers a runtime message to every extension context except `fromId`.
   * `respond(responseJson, errorMessage)` is called exactly once.
   */
  function deliverRuntimeMessage(fromId, messageJson, sender, respond, options = {}) {
    if (!backgroundReady && !options.skipQueue) {
      queuedUntilBackground.push(() => deliverRuntimeMessage(fromId, messageJson, sender, respond, options));
      return;
    }
    let settled = false;
    const settle = (json, error) => {
      if (settled) return;
      settled = true;
      pendingResponses.delete(pending);
      try {
        respond(json, error);
      } catch (err) {
        warn("respond failed", err);
      }
    };
    const waitingOn = new Set();
    const pending = {
      contextGone(contextId) {
        if (waitingOn.delete(contextId) && waitingOn.size === 0) settle(undefined, PORT_CLOSED);
      },
    };

    // Let the shell observe bus traffic (e.g. WalletConnect session updates).
    for (const observer of busObservers) {
      try {
        observer(JSON.parse(messageJson), sender);
      } catch {
        /* ignore */
      }
    }

    setTimeout(() => {
      const senderJson = JSON.stringify(sender);
      let listeners = 0;
      for (const ctx of [...contexts.values()]) {
        if (ctx.id === fromId) continue;
        if (options.only && !options.only(ctx)) continue;
        const result = safeDispatch(ctx, "onMessage", messageJson, senderJson, (json) => settle(json));
        if (!result) continue;
        listeners += result.listeners || 0;
        if (result.keepOpen && !settled) waitingOn.add(ctx.id);
      }
      if (settled) return;
      if (listeners === 0) settle(undefined, NO_RECEIVER);
      else if (waitingOn.size === 0) settle(undefined, PORT_CLOSED);
      else pendingResponses.add(pending);
    }, 0);
  }

  function runtimeSendMessage(contextId, messageJson, callback) {
    const ctx = contexts.get(contextId);
    if (!ctx) {
      callback(undefined, "Extension context invalidated.");
      return;
    }
    if (ctx.role === "ui" && inlineRequest) {
      let type = null;
      try {
        type = JSON.parse(messageJson).type;
      } catch {
        type = null;
      }
      if (type) callback = trackDecision(type, callback);
    }
    deliverRuntimeMessage(contextId, messageJson, senderForContext(ctx), callback);
  }

  /** Sends a message as the trusted wallet UI (used by the shell itself). */
  function sendAsWalletUi(message) {
    return new Promise((resolve, reject) => {
      deliverRuntimeMessage(
        null,
        JSON.stringify(message),
        trustedUiSender(),
        (json, error) => (error ? reject(new Error(error)) : resolve(parseJson(json))),
        { only: (ctx) => ctx.role === "background" },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Ports (chrome.runtime.connect / onConnect)
  // ---------------------------------------------------------------------------

  /** port = { id, name, opener, receivers:Set, closed } */
  const ports = new Map();
  let nextPortId = 1;

  function runtimeConnect(contextId, name) {
    const ctx = contexts.get(contextId);
    // `queued`: messages the opener posts before the port is connected. Chrome
    // delivers those once the other end's onConnect has run; dropping them
    // lost the wallet UI's keepalive registration on every start (a 2 s stall
    // before first paint, and the open UI never paused auto-lock).
    const port = { id: "p" + nextPortId++, name: String(name || ""), opener: contextId, receivers: new Set(), closed: false, started: false, queued: [] };
    ports.set(port.id, port);
    const start = () => {
      if (port.closed) return;
      const infoJson = JSON.stringify({ portId: port.id, name: port.name, sender: ctx ? senderForContext(ctx) : {} });
      for (const target of [...contexts.values()]) {
        if (target.id === contextId) continue;
        const accepted = safeDispatch(target, "onConnect", infoJson);
        if (accepted) port.receivers.add(target.id);
      }
      port.started = true;
      if (port.receivers.size === 0) {
        port.queued = [];
        closePort(port, null, NO_RECEIVER);
        return;
      }
      for (const messageJson of port.queued.splice(0)) deliverPortMessage(port, [...port.receivers], messageJson);
    };
    setTimeout(() => {
      if (backgroundReady) start();
      else queuedUntilBackground.push(start);
    }, 0);
    return port.id;
  }

  function deliverPortMessage(port, targets, messageJson) {
    setTimeout(() => {
      for (const targetId of targets) {
        const target = contexts.get(targetId);
        if (target) safeDispatch(target, "onPortMessage", port.id, messageJson);
      }
    }, 0);
  }

  function portPostMessage(contextId, portId, messageJson) {
    const port = ports.get(portId);
    if (!port || port.closed) return false;
    if (contextId === port.opener && !port.started) {
      port.queued.push(messageJson); // delivered once onConnect has run
      return true;
    }
    deliverPortMessage(port, contextId === port.opener ? [...port.receivers] : [port.opener], messageJson);
    return true;
  }

  function portDisconnect(contextId, portId) {
    const port = ports.get(portId);
    if (!port || port.closed) return;
    if (contextId === port.opener) {
      closePort(port, contextId);
    } else {
      port.receivers.delete(contextId);
      if (port.receivers.size === 0) closePort(port, contextId);
    }
  }

  /** Closes a port and fires onDisconnect everywhere except `initiatorId`. */
  function closePort(port, initiatorId, errorMessage) {
    if (port.closed) return;
    port.closed = true;
    ports.delete(port.id);
    const targets = [port.opener, ...port.receivers].filter((id) => id !== initiatorId);
    setTimeout(() => {
      for (const targetId of targets) {
        const target = contexts.get(targetId);
        if (target) safeDispatch(target, "onPortDisconnect", port.id, errorMessage || null);
      }
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Generic events (tabs/windows/alarms/notifications/runtime lifecycle)
  // ---------------------------------------------------------------------------

  function emitEvent(name, args, onlyRole) {
    const argsJson = JSON.stringify(args);
    setTimeout(() => {
      for (const ctx of [...contexts.values()]) {
        if (onlyRole && ctx.role !== onlyRole) continue;
        safeDispatch(ctx, "onEvent", name, argsJson);
      }
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Windows & tabs model
  // ---------------------------------------------------------------------------
  //
  // Window 1 is the phone's "browser window". It holds the dApp browser tab
  // (when native reports one). The full-screen wallet UI behaves like
  // Chrome's side panel of window 1 (it is not a tab). Every overlay created
  // with chrome.windows.create / chrome.tabs.create of an extension URL is
  // its own window with a single tab.

  const overlayWindows = new Map(); // windowId -> { id, type, tabId, frame, returnToDapp, createdAt }
  const overlayTabs = new Map(); // tabId -> { id, windowId, url, title, status }
  let nextWindowId = 2;
  let nextTabId = 2;
  let focusedWindowId = MAIN_WINDOW_ID;
  let dappTab = null; // { id, url, title, status }
  // WalletConnect deep link awaiting its approval window (see armReturnToCaller).
  const RETURN_WINDOW_MS = 90_000;
  let pendingReturn = null; // { source: "external" | "dapp", until: number }
  let dappVisible = false;

  function screenGeometry() {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function dappTabObject() {
    if (!dappTab) return null;
    return {
      id: dappTab.id,
      index: 0,
      windowId: MAIN_WINDOW_ID,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      audible: false,
      discarded: false,
      autoDiscardable: true,
      incognito: false,
      groupId: -1,
      url: dappTab.url,
      pendingUrl: undefined,
      title: dappTab.title || dappTab.url,
      status: dappTab.status || "complete",
      ...screenGeometry(),
    };
  }

  // Chrome windows always have an active tab and the extension relies on it
  // (e.g. `tabs.query({active, currentWindow})[0].id`). Without a dApp tab,
  // window 1 shows a synthetic "New Tab".
  const NEW_TAB_ID = 1;
  function newTabObject() {
    return {
      id: NEW_TAB_ID,
      index: 0,
      windowId: MAIN_WINDOW_ID,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      audible: false,
      discarded: false,
      autoDiscardable: true,
      incognito: false,
      groupId: -1,
      url: "chrome://newtab/",
      title: "New Tab",
      status: "complete",
      ...screenGeometry(),
    };
  }

  function mainTabObject() {
    return dappTabObject() || newTabObject();
  }

  function overlayTabObject(tab) {
    return {
      id: tab.id,
      index: 0,
      windowId: tab.windowId,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      audible: false,
      discarded: false,
      autoDiscardable: true,
      incognito: false,
      groupId: -1,
      url: tab.url,
      title: tab.title || "WalletChan",
      status: tab.status,
      ...screenGeometry(),
    };
  }

  function allTabs() {
    const tabs = [];
    tabs.push(mainTabObject());
    for (const tab of overlayTabs.values()) tabs.push(overlayTabObject(tab));
    return tabs;
  }

  function windowObject(windowId, populate) {
    if (windowId === MAIN_WINDOW_ID) {
      const win = {
        id: MAIN_WINDOW_ID,
        type: "normal",
        state: "maximized",
        focused: focusedWindowId === MAIN_WINDOW_ID,
        incognito: false,
        alwaysOnTop: false,
        ...screenGeometry(),
      };
      if (populate) win.tabs = [mainTabObject()];
      return win;
    }
    const overlay = overlayWindows.get(windowId);
    if (!overlay) return null;
    const win = {
      id: overlay.id,
      type: overlay.type,
      state: "maximized",
      focused: focusedWindowId === overlay.id,
      incognito: false,
      alwaysOnTop: false,
      ...screenGeometry(),
    };
    if (populate) win.tabs = [overlayTabObject(overlayTabs.get(overlay.tabId))];
    return win;
  }

  function allWindowIds() {
    return [MAIN_WINDOW_ID, ...overlayWindows.keys()];
  }

  function topOverlay() {
    let top = null;
    for (const overlay of overlayWindows.values()) {
      if (!top || overlay.zIndex > top.zIndex) top = overlay;
    }
    return top;
  }

  let overlayZ = 10;

  function focusOverlay(windowId) {
    const overlay = overlayWindows.get(windowId);
    if (!overlay) return;
    overlay.zIndex = ++overlayZ;
    overlay.frame.style.zIndex = String(overlay.zIndex);
    setFocusedWindow(windowId);
    if (dappVisible) {
      overlay.returnToDapp = true;
      nativePost({ cmd: "showWallet" });
    }
  }

  function setFocusedWindow(windowId) {
    if (focusedWindowId === windowId) return;
    focusedWindowId = windowId;
    emitEvent("windows.onFocusChanged", [windowId]);
  }

  function createOverlay(url, type) {
    const absolute = absoluteExtensionUrl(url);
    const path = extensionPath(absolute);

    // Only one onboarding surface at a time (the background opens it on
    // install and the UI also asks for it).
    if (path === "/onboarding.html") {
      for (const overlay of overlayWindows.values()) {
        const tab = overlayTabs.get(overlay.tabId);
        if (tab && extensionPath(tab.url) === "/onboarding.html") {
          focusOverlay(overlay.id);
          return windowObject(overlay.id, true);
        }
      }
    }

    // Finishing onboarding opens the wallet (index.html) in a popup window.
    // On a phone the full-screen wallet UI *is* the wallet, so close the
    // onboarding overlay and reload the wallet UI instead of stacking a second
    // copy on top.
    if (path === "/index.html" && hasOnboardingOverlay()) {
      for (const overlay of [...overlayWindows.values()]) {
        const tab = overlayTabs.get(overlay.tabId);
        if (tab && extensionPath(tab.url) === "/onboarding.html") removeOverlay(overlay.id, { role: "ui" }); // reloaded just below
      }
      reloadMainUi();
      nativePost({ cmd: "showWallet" });
      return windowObject(MAIN_WINDOW_ID, true);
    }

    const windowId = nextWindowId++;
    const tabId = nextTabId++;
    const frame = document.createElement("iframe");
    frame.className = "wc-frame wc-overlay";
    frame.setAttribute("allow", "clipboard-read; clipboard-write; camera; publickey-credentials-get *; publickey-credentials-create *");
    frame.dataset.wcRole = "overlay";
    managedFrames.set(frame, { role: "overlay", windowId, tabId });
    const overlay = {
      id: windowId,
      type: type === "popup" ? "popup" : "normal",
      tabId,
      frame,
      returnToDapp: false,
      // Set when a WalletConnect deep link from another app (or the dApp
      // browser) is waiting for this approval: "external" | "dapp" | null.
      returnToCaller: null,
      openedAt: Date.now(),
      zIndex: ++overlayZ,
    };
    if (pendingReturn && Date.now() < pendingReturn.until && !isOnboardingUrl(absolute)) {
      overlay.returnToCaller = pendingReturn.source;
    }
    if (!isOnboardingUrl(absolute)) {
      // Native posts this only if the app isn't in the foreground.
      nativePost({ cmd: "requestAttention", title: "WalletChan", message: "A dApp is waiting for your approval. Tap to review." });
    }
    frame.style.zIndex = String(overlay.zIndex);
    overlayWindows.set(windowId, overlay);
    overlayTabs.set(tabId, { id: tabId, windowId, url: absolute, title: "WalletChan", status: "loading" });
    frame.addEventListener("load", () => {
      const tab = overlayTabs.get(tabId);
      if (!tab) return;
      try {
        tab.title = frame.contentDocument.title || tab.title;
        tab.url = frame.contentWindow.location.href;
      } catch {
        /* ignore */
      }
      tab.status = "complete";
      emitEvent("tabs.onUpdated", [tabId, { status: "complete" }, overlayTabObject(tab)]);
    });
    frame.src = absolute;
    document.getElementById("wc-overlays").appendChild(frame);
    requestAnimationFrame(() => frame.classList.add("open"));

    emitEvent("windows.onCreated", [windowObject(windowId, false)]);
    emitEvent("tabs.onCreated", [overlayTabObject(overlayTabs.get(tabId))]);
    focusOverlay(windowId);
    if (!dappVisible) nativePost({ cmd: "showWallet" });
    updateChrome();
    return windowObject(windowId, true);
  }

  function hasOnboardingOverlay() {
    for (const overlay of overlayWindows.values()) {
      const tab = overlayTabs.get(overlay.tabId);
      if (tab && extensionPath(tab.url) === "/onboarding.html") return true;
    }
    return false;
  }

  /**
   * Closes an overlay window. `initiator` is the context that asked (if any):
   * when the wallet UI itself closes onboarding it has already re-initialised,
   * otherwise closing onboarding reloads the wallet UI so it picks up the
   * freshly created wallet.
   */
  function removeOverlay(windowId, initiator) {
    const overlay = overlayWindows.get(windowId);
    if (!overlay) return false;
    const tab = overlayTabs.get(overlay.tabId);
    const wasOnboarding = tab && extensionPath(tab.url) === "/onboarding.html";
    overlayWindows.delete(windowId);
    overlayTabs.delete(overlay.tabId);
    unregisterFrameContexts(overlay.frame);
    managedFrames.delete(overlay.frame);
    overlay.frame.remove();
    emitEvent("tabs.onRemoved", [overlay.tabId, { windowId, isWindowClosing: true }]);
    emitEvent("windows.onRemoved", [windowId]);
    const next = topOverlay();
    setFocusedWindow(next ? next.id : MAIN_WINDOW_ID);
    if (wasOnboarding && !(initiator && initiator.role === "ui")) reloadMainUi();
    // An approval opened from the dApp browser returns the user to the dApp.
    const stillReturning = [...overlayWindows.values()].some((o) => o.returnToDapp);
    if (overlay.returnToDapp && !stillReturning && dappTab) {
      nativePost({ cmd: "showDapp" });
    }
    const stillForCaller = [...overlayWindows.values()].some((o) => o.returnToCaller);
    if (overlay.returnToCaller && !stillForCaller && !overlay.returnToDapp) {
      returnToCaller(overlay.returnToCaller);
    }
    updateChrome();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Requests shown inline in the main wallet screen (side-panel mode)
  // ---------------------------------------------------------------------------

  /**
   * In side-panel mode the background announces each new request to the open
   * wallet UI (`newPending…Request`), which switches to its confirmation view.
   * Bring the wallet forward, and once the UI is back on its home screen (all
   * queued requests handled) return to whoever sent it, like closing a popup.
   */
  // { since, returnTo: "external" | "dapp" | null, leftHome, pairing }
  let inlineRequest = null;
  const INLINE_REQUEST = /^newPending[A-Za-z]*Request$|^newSafeProposalRequest$/;
  const WALLETCONNECT_PROPOSAL_REQUEST = "newPendingWalletConnectProposalRequest";

  busObservers.push((message) => {
    if (!message || typeof message.type !== "string" || !INLINE_REQUEST.test(message.type)) return;
    // A connection review started by our own pairing (QR, deep link, pasted
    // link) is returned from by that pairing once the outcome is known, so the
    // home-screen tracker must not return a second time.
    const ownedByPairing = message.type === WALLETCONNECT_PROPOSAL_REQUEST && walletConnectPairings > 0;
    // Deferred: let the overlay path (popup mode) register first, if used.
    setTimeout(() => onInlineRequest(ownedByPairing), 0);
  });

  function onInlineRequest(ownedByPairing = false) {
    if (overlayWindows.size > 0) return; // popup mode: overlays handle returning
    const armed = pendingReturn && Date.now() < pendingReturn.until ? pendingReturn.source : null;
    const returnTo = ownedByPairing ? null : dappVisible && dappTab ? "dapp" : armed;
    if (!inlineRequest) inlineRequest = { since: Date.now(), returnTo, leftHome: false, pairing: ownedByPairing, requests: 0, decided: 0 };
    if (!ownedByPairing) inlineRequest.requests += 1;
    else if (ownedByPairing) {
      inlineRequest.pairing = true;
      inlineRequest.returnTo = null;
    } else if (returnTo && !inlineRequest.returnTo && !inlineRequest.pairing) inlineRequest.returnTo = returnTo;
    nativePost({ cmd: "showWallet" });
    nativePost({ cmd: "requestAttention", title: "WalletChan", message: "A dApp is waiting for your approval. Tap to review." });
  }

  /**
   * The wallet UI's own decision messages. The background answers them only
   * after the dApp's reply is published, which can take ~6 s when the dApp's
   * tab is frozen; we return on the tap instead (after a short grace so an
   * immediate local failure keeps the user here to see it).
   */
  const DECISION_TYPES = new Set([
    "confirmTransaction", "confirmTransactionAsync", "confirmTransactionAsyncPK", "confirmImpersonatedTransaction",
    "confirmBatchTransactionAsync", "confirmBatchTransactionAsyncPK", "confirmSignatureRequest",
    "confirmErc7715PermissionRequest", "confirmCrossDappBatch", "confirmAddChain", "confirmWatchAsset",
    "confirmDappConnection", "rejectTransaction", "rejectBatchTransaction", "rejectSignatureRequest",
    "rejectErc7715PermissionRequest", "rejectCrossDappBatch", "rejectAddChain", "rejectWatchAsset",
    "rejectDappConnection", "approveSafeProposal",
  ]);
  const DECISION_GRACE_MS = 400;

  /** Wraps a UI decision's callback; returns the callback to use. */
  function trackDecision(type, callback) {
    const request = inlineRequest;
    if (!request || !request.returnTo || !DECISION_TYPES.has(type)) return callback;
    let counted = false;
    let failed = false;
    const count = () => {
      if (counted || failed || inlineRequest !== request) return;
      counted = true;
      request.decided += 1;
      if (request.decided >= request.requests) {
        inlineRequest = null;
        holdKeepAlive(30_000); // the reply is still being published
        returnToCaller(request.returnTo);
      }
    };
    setTimeout(count, DECISION_GRACE_MS);
    return (json, error) => {
      let response = null;
      try {
        response = json === undefined ? null : JSON.parse(json);
      } catch {
        response = null;
      }
      if (error || (response && typeof response === "object" && response.success === false)) failed = true;
      else count();
      callback(json, error);
    };
  }

  /** Called from the 500 ms UI tick. */
  function checkInlineRequestDone() {
    if (!inlineRequest) return;
    if (overlayWindows.size > 0) {
      inlineRequest = null;
      return;
    }
    const home = uiOnHomeScreen();
    if (!home) {
      inlineRequest.leftHome = true;
    } else if (inlineRequest.leftHome) {
      const target = inlineRequest.returnTo;
      inlineRequest = null;
      if (target) returnToCaller(target);
    } else if (Date.now() - inlineRequest.since > (inlineRequest.pairing ? 15 * 60_000 : 120_000)) {
      inlineRequest = null;
    }
  }

  // ---------------------------------------------------------------------------
  // WalletConnect liveness on Android
  // ---------------------------------------------------------------------------

  /**
   * While any WalletConnect session exists, native runs a foreground service so
   * Android doesn't freeze/kill the app (and its relay socket) in the
   * background. Requests then arrive immediately.
   */
  let reportedWcSessions = -1;
  let knownSessionCount = 0;
  let keepAliveHolds = 0;
  function reportWalletConnectSessions(count) {
    if (Number.isFinite(count)) knownSessionCount = count;
    // Pairings in progress and answers still being published count too, so
    // Android doesn't freeze the app before its reply reaches the relay.
    const n = knownSessionCount + keepAliveHolds;
    if (n === reportedWcSessions) return;
    reportedWcSessions = n;
    nativePost({ cmd: "wcSessions", count: n });
  }

  function holdKeepAlive(ms) {
    keepAliveHolds += 1;
    reportWalletConnectSessions();
    setTimeout(() => {
      keepAliveHolds -= 1;
      reportWalletConnectSessions();
    }, ms);
  }

  /** A message to show the next time the wallet is on screen. */
  let deferredToast = null;
  function showWhenVisible(text) {
    if (appVisible) showToast(text, "error", 7000);
    else deferredToast = text;
  }

  /** After returning early on Connect, report a late approval failure. */
  function watchApprovalFailure(proposalId) {
    const observer = (message) => {
      if (message && message.type === "walletConnectProposalRejected") {
        stop();
        showWhenVisible("Couldn't connect: " + ((message.rejection && message.rejection.error) || "the app's request was rejected"));
      } else if (message && message.type === "walletConnectSessionsChanged") {
        stop();
      }
    };
    const stop = () => {
      const index = busObservers.indexOf(observer);
      if (index >= 0) busObservers.splice(index, 1);
    };
    busObservers.push(observer);
    setTimeout(stop, 90_000);
    void proposalId;
  }

  async function refreshWalletConnectSessionCount() {
    const response = await sendAsWalletUi({ type: "walletConnectGetSessions" }).catch(() => null);
    if (response && Array.isArray(response.sessions)) {
      reportWalletConnectSessions(response.sessions.length);
      for (const session of response.sessions) if (session && session.topic) knownWalletConnectTopics.add(session.topic);
    }
  }

  busObservers.push((message) => {
    if (message && message.type === "walletConnectSessionsChanged" && Array.isArray(message.sessions)) {
      reportWalletConnectSessions(message.sessions.length);
    }
  });

  /** Asks the background to fetch queued relay messages right now. */
  function nudgeRelay() {
    const frame = document.querySelector('iframe[data-wc-role="background"]');
    try {
      frame && frame.contentWindow && frame.contentWindow.dispatchEvent(new Event("walletchan:relay-nudge"));
    } catch (error) {
      warn("relay nudge failed", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Returning to the app that handed us a WalletConnect link
  // ---------------------------------------------------------------------------

  /**
   * A dApp on the phone (in Chrome, or in our dApp browser) sends a WalletConnect
   * request over the relay, then opens `walletchan://…` (our advertised
   * `redirect.native`) or a `wc:…?requestId=` link to bring the wallet forward.
   * Approval windows opened shortly before/after such a link are tagged; when
   * the last of them closes we hand the user back to the dApp, like native
   * mobile wallets do.
   */

  function isOnboardingUrl(url) {
    try {
      return extensionPath(url) === "/onboarding.html";
    } catch {
      return false;
    }
  }

  function armReturnToCaller(source) {
    if (source !== "external" && source !== "dapp") return;
    pendingReturn = { source, until: Date.now() + RETURN_WINDOW_MS };
    if (inlineRequest && !inlineRequest.returnTo && !inlineRequest.pairing) inlineRequest.returnTo = source;
    // The relay may have delivered the request before the link arrived.
    for (const overlay of overlayWindows.values()) {
      const tab = overlayTabs.get(overlay.tabId);
      if (tab && isOnboardingUrl(tab.url)) continue;
      if (Date.now() - overlay.openedAt < RETURN_WINDOW_MS) overlay.returnToCaller = source;
    }
  }

  function returnToCaller(source) {
    pendingReturn = null;
    if (source === "dapp") {
      if (dappTab) nativePost({ cmd: "showDapp" });
      return;
    }
    // "external": step aside right away so Android shows the app that opened
    // us (moveTaskToBack). Speed matters more than lingering on the wallet;
    // the dApp shows the result itself.
    setTimeout(() => {
      if (!topOverlay()) nativePost({ cmd: "backUnhandled" });
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Frames: background, main UI, offscreen
  // ---------------------------------------------------------------------------

  let mainUiFrame = null;
  let offscreenFrame = null;

  function createHiddenFrame(role, src) {
    const frame = document.createElement("iframe");
    frame.className = "wc-hidden-frame";
    frame.dataset.wcRole = role;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    managedFrames.set(frame, { role, windowId: MAIN_WINDOW_ID });
    frame.src = src;
    document.getElementById("wc-hidden").appendChild(frame);
    return frame;
  }

  function startBackground() {
    return new Promise((resolve) => {
      const frame = createHiddenFrame("background", "/android/background.html");
      frame.addEventListener("load", () => resolve(frame), { once: true });
    });
  }

  function createMainUi() {
    const frame = document.createElement("iframe");
    frame.id = "wc-ui";
    frame.className = "wc-frame";
    frame.dataset.wcRole = "ui";
    frame.setAttribute("allow", "clipboard-read; clipboard-write; camera; publickey-credentials-get *; publickey-credentials-create *");
    managedFrames.set(frame, { role: "ui", windowId: MAIN_WINDOW_ID });
    frame.src = "/index.html";
    document.getElementById("wc-main").appendChild(frame);
    mainUiFrame = frame;
  }

  function reloadMainUi() {
    if (!mainUiFrame) return;
    unregisterFrameContexts(mainUiFrame);
    mainUiFrame.src = "/index.html";
  }

  // ---------------------------------------------------------------------------
  // Alarms
  // ---------------------------------------------------------------------------

  const alarms = new Map(); // name -> { name, scheduledTime, periodInMinutes, timer }

  function scheduleAlarm(alarm) {
    clearTimeout(alarm.timer);
    const delay = Math.max(0, alarm.scheduledTime - Date.now());
    // setTimeout overflows above ~24.8 days; re-arm in chunks.
    alarm.timer = setTimeout(() => {
      if (Date.now() < alarm.scheduledTime - 5) return scheduleAlarm(alarm);
      emitEvent("alarms.onAlarm", [publicAlarm(alarm)]);
      if (alarm.periodInMinutes) {
        alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60_000;
        scheduleAlarm(alarm);
      } else {
        alarms.delete(alarm.name);
      }
    }, Math.min(delay, 2 ** 31 - 1));
  }

  function publicAlarm(alarm) {
    const result = { name: alarm.name, scheduledTime: alarm.scheduledTime };
    if (alarm.periodInMinutes) result.periodInMinutes = alarm.periodInMinutes;
    return result;
  }

  // ---------------------------------------------------------------------------
  // dApp tab bridge (messages from the native dApp browser)
  // ---------------------------------------------------------------------------

  const pendingTabMessages = new Map(); // eventId -> {resolve, reject, timer}
  let nextEventId = 1;

  /** Storage keys a dApp content script may touch (no isolated world on Android). */
  const DAPP_SYNC_READ = new Set([
    "networksInfo",
    "chainName",
    "address",
    "displayAddress",
    "isArcBrowser",
    "sidePanelMode",
  ]);
  const DAPP_LOCAL_READ = new Set(["bungeeChains"]);
  const DAPP_RESULT_KEY = /^(dappConnectionResult|addChainResult|txResult|sigResult|watchAssetResult|rpcResult|capabilitiesResult|batchTxAck|callsStatusResult):[A-Za-z0-9_.:-]{1,200}$/;

  function dappMayRead(area, key) {
    if (area === "sync") return DAPP_SYNC_READ.has(key);
    if (area === "local") return DAPP_LOCAL_READ.has(key) || DAPP_RESULT_KEY.test(key);
    return false;
  }

  function dappToNative(tabId, payload) {
    nativePost({ cmd: "toDapp", tabId, payload });
  }

  async function handleDappStorage(request) {
    const { area, op } = request || {};
    if (area !== "local" && area !== "sync") throw new Error("Storage area unavailable");
    if (op === "get") {
      const spec = normalizeKeys(request.keys);
      if (spec.all) throw new Error("Access denied");
      const allowed = {};
      for (const key of spec.list) {
        if (!dappMayRead(area, key)) continue;
        Object.assign(allowed, storageGet(area, spec.defaults ? { [key]: spec.defaults[key] } : [key]));
      }
      // Explorer enhancements need an extension iframe inside the page,
      // which the Android dApp browser cannot host. Keep them off.
      if (area === "sync" && spec.list.includes("explorerEnhancementsEnabled")) {
        allowed.explorerEnhancementsEnabled = false;
      }
      return allowed;
    }
    if (op === "remove") {
      const keys = typeof request.keys === "string" ? [request.keys] : Array.isArray(request.keys) ? request.keys : [];
      await storageRemove(area, keys.filter((key) => area === "local" && DAPP_RESULT_KEY.test(key)));
      return undefined;
    }
    if (op === "set") {
      // The content script persists the dApp-selected chain by name only.
      const items = request.items || {};
      const keys = Object.keys(items);
      if (area !== "sync" || keys.length !== 1 || keys[0] !== "chainName") throw new Error("Access denied");
      const networksInfo = storageGet("sync", ["networksInfo"]).networksInfo || {};
      if (typeof items.chainName !== "string" || !Object.prototype.hasOwnProperty.call(networksInfo, items.chainName)) {
        throw new Error("Unknown chain");
      }
      await storageSet("sync", { chainName: items.chainName });
      return undefined;
    }
    throw new Error("Unsupported storage operation");
  }

  function forwardStorageChangeToDapp(area, changes) {
    if (!dappTab || (area !== "local" && area !== "sync")) return;
    const filtered = {};
    for (const key of Object.keys(changes)) {
      if (dappMayRead(area, key)) filtered[key] = changes[key];
    }
    if (Object.keys(filtered).length === 0) return;
    dappToNative(dappTab.id, { kind: "storageChanged", area, changes: filtered });
  }

  function updateDappTab(tabId, url, title, status) {
    const isNew = !dappTab || dappTab.id !== tabId;
    if (isNew && dappTab) removeDappTab(dappTab.id);
    const previous = dappTab ? { ...dappTab } : null;
    dappTab = { id: tabId, url: url || (previous && previous.url) || "", title: title || "", status: status || "complete" };
    const tab = dappTabObject();
    if (isNew) {
      emitEvent("tabs.onCreated", [tab]);
      emitEvent("tabs.onActivated", [{ tabId, windowId: MAIN_WINDOW_ID }]);
    }
    const changeInfo = {};
    if (!previous || previous.url !== dappTab.url) changeInfo.url = dappTab.url;
    if (!previous || previous.status !== dappTab.status) changeInfo.status = dappTab.status;
    if (!previous || previous.title !== dappTab.title) changeInfo.title = dappTab.title;
    if (Object.keys(changeInfo).length) emitEvent("tabs.onUpdated", [tabId, changeInfo, tab]);
  }

  function removeDappTab(tabId) {
    if (!dappTab || dappTab.id !== tabId) return;
    dappTab = null;
    for (const [eventId, pending] of pendingTabMessages) {
      clearTimeout(pending.timer);
      pending.reject(new Error(NO_RECEIVER));
      pendingTabMessages.delete(eventId);
    }
    emitEvent("tabs.onRemoved", [tabId, { windowId: MAIN_WINDOW_ID, isWindowClosing: false }]);
  }

  function handleDappMessage(msg) {
    const { tabId, url, origin, title, requestId } = msg;
    const message = msg.message;
    if (typeof tabId !== "number") return;
    if (!dappTab || dappTab.id !== tabId || (url && dappTab.url !== url)) {
      updateDappTab(tabId, url, title, "complete");
    }
    const reply = (response, error) => {
      const payload = { kind: "response", requestId, response };
      if (error) payload.error = error;
      dappToNative(tabId, payload);
    };

    if (message && typeof message === "object" && "__walletchanEventReply" in message) {
      const pending = pendingTabMessages.get(message.__walletchanEventReply);
      if (pending) {
        pendingTabMessages.delete(message.__walletchanEventReply);
        clearTimeout(pending.timer);
        if (message.noResponse) pending.reject(new Error(PORT_CLOSED));
        else pending.resolve(message.response);
      }
      return;
    }
    if (message && typeof message === "object" && "__walletchanStorage" in message) {
      handleDappStorage(message.__walletchanStorage).then(
        (result) => reply(result),
        (error) => reply(undefined, error.message || String(error)),
      );
      return;
    }

    const sender = {
      id: EXTENSION_ID,
      url,
      origin,
      frameId: 0,
      documentLifecycle: "active",
      tab: { ...dappTabObject(), url, title: title || (dappTab && dappTab.title) || url },
    };
    deliverRuntimeMessage(null, JSON.stringify(message === undefined ? null : message), sender, (json, error) => {
      reply(parseJson(json), error);
    });
  }

  function tabsSendMessage(tabId, message) {
    // Extension pages hosted in overlay tabs.
    if (overlayTabs.has(tabId)) {
      return new Promise((resolve, reject) => {
        deliverRuntimeMessage(null, JSON.stringify(message), { id: EXTENSION_ID, origin: ORIGIN, url: ORIGIN + "/" }, (json, error) => {
          if (error) reject(new Error(error));
          else resolve(parseJson(json));
        }, { only: (ctx) => ctx.tabId === tabId, skipQueue: true });
      });
    }
    if (!dappTab || dappTab.id !== tabId) return Promise.reject(new Error(NO_RECEIVER));
    return new Promise((resolve, reject) => {
      const eventId = "e" + nextEventId++;
      const timer = setTimeout(() => {
        pendingTabMessages.delete(eventId);
        reject(new Error(PORT_CLOSED));
      }, 15_000);
      pendingTabMessages.set(eventId, { resolve, reject, timer });
      dappToNative(tabId, { kind: "event", message, eventId });
    });
  }

  // ---------------------------------------------------------------------------
  // Opening URLs
  // ---------------------------------------------------------------------------

  function openUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (!nativePost({ cmd: "openDapp", url: parsed.href })) window.open(parsed.href, "_blank", "noopener");
    } else if (parsed.protocol === "mailto:" || parsed.protocol === "tel:") {
      nativePost({ cmd: "openExternal", url: parsed.href });
    } else if (parsed.protocol === "wc:" || parsed.protocol === "walletchan:") {
      handleWalletConnectText(parsed.href);
    }
  }

  /** chrome.tabs.create with a web URL: wait briefly for native to report the tab. */
  function openDappTab(url) {
    const before = dappTab ? dappTab.id : null;
    openUrl(url);
    return new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        if (dappTab && dappTab.id !== before) return resolve(dappTabObject());
        if (Date.now() - started > 1500) {
          return resolve({
            id: dappTab ? dappTab.id : -1,
            index: 0,
            windowId: MAIN_WINDOW_ID,
            active: true,
            pinned: false,
            highlighted: true,
            incognito: false,
            url,
            pendingUrl: url,
            status: "loading",
          });
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  // ---------------------------------------------------------------------------
  // API calls from frames: shell.call(contextId, method, argsJson)
  // ---------------------------------------------------------------------------

  const notifications = new Map();
  let nextNotificationId = 1;
  const badge = { text: "", color: "#000000", textColor: "#ffffff", title: "WalletChan", popup: "" };
  const dnr = { dynamic: [], session: [] };

  function callerWindowId(ctx) {
    return ctx && ctx.windowId !== undefined ? ctx.windowId : MAIN_WINDOW_ID;
  }

  function filterTabs(ctx, query = {}) {
    const currentWindowId = callerWindowId(ctx);
    return allTabs().filter((tab) => {
      if (query.active !== undefined && tab.active !== query.active) return false;
      if (query.currentWindow === true && tab.windowId !== currentWindowId) return false;
      if (query.currentWindow === false && tab.windowId === currentWindowId) return false;
      if (query.lastFocusedWindow === true && tab.windowId !== focusedWindowId) return false;
      if (query.windowId !== undefined) {
        const wanted = query.windowId === -2 ? currentWindowId : query.windowId;
        if (tab.windowId !== wanted) return false;
      }
      if (query.windowType !== undefined) {
        const win = windowObject(tab.windowId, false);
        if (!win || win.type !== query.windowType) return false;
      }
      if (query.status !== undefined && tab.status !== query.status) return false;
      if (query.url !== undefined && !urlMatches(tab.url, query.url)) return false;
      if (query.title !== undefined && !urlMatches(tab.title, query.title)) return false;
      return true;
    });
  }

  function getTab(tabId) {
    if (dappTab && dappTab.id === tabId) return dappTabObject();
    if (!dappTab && tabId === NEW_TAB_ID) return newTabObject();
    const tab = overlayTabs.get(tabId);
    if (tab) return overlayTabObject(tab);
    throw new Error("No tab with id: " + tabId + ".");
  }

  function getContexts(filter = {}) {
    const result = [];
    for (const ctx of contexts.values()) {
      if (ctx.role === "subframe") continue;
      const entry = {
        contextId: ctx.documentId,
        contextType: contextTypeFor(ctx),
        documentId: ctx.role === "background" ? undefined : ctx.documentId,
        documentOrigin: ORIGIN,
        documentUrl: ctx.url,
        frameId: ctx.role === "background" ? -1 : ctx.frameId,
        incognito: false,
        tabId: ctx.tabId ?? -1,
        windowId: ctx.role === "background" || ctx.role === "offscreen" ? -1 : ctx.windowId,
      };
      if (filter.contextTypes && !filter.contextTypes.includes(entry.contextType)) continue;
      if (filter.documentUrls && !filter.documentUrls.includes(entry.documentUrl)) continue;
      if (filter.documentOrigins && !filter.documentOrigins.includes(entry.documentOrigin)) continue;
      if (filter.tabIds && !filter.tabIds.includes(entry.tabId)) continue;
      if (filter.windowIds && !filter.windowIds.includes(entry.windowId)) continue;
      if (filter.frameIds && !filter.frameIds.includes(entry.frameId)) continue;
      if (filter.contextIds && !filter.contextIds.includes(entry.contextId)) continue;
      if (filter.incognito === true) continue;
      result.push(entry);
    }
    return result;
  }

  /** chrome.extension.getViews — returns WindowProxy objects (synchronous). */
  function getViews(filter = {}) {
    const views = [];
    for (const ctx of contexts.values()) {
      if (ctx.role !== "ui" && ctx.role !== "overlay") continue;
      // Overlays are tabs (Chrome reports popup *windows* as tabs too). The
      // full-screen UI is the side-panel equivalent: never "popup" or "tab".
      if (filter.type === "popup") continue;
      if (filter.type === "tab" && ctx.role !== "overlay") continue;
      if (filter.windowId !== undefined && filter.windowId !== ctx.windowId) continue;
      if (filter.tabId !== undefined && filter.tabId !== ctx.tabId) continue;
      views.push(ctx.win);
    }
    return views;
  }

  const api = {
    // --- storage ---------------------------------------------------------
    "storage.get": (ctx, [area, keys]) => storageGet(area, keys),
    "storage.set": (ctx, [area, items]) => storageSet(area, items),
    "storage.remove": (ctx, [area, keys]) => storageRemove(area, keys),
    "storage.clear": (ctx, [area]) => storageClear(area),
    "storage.getBytesInUse": (ctx, [area, keys]) => storageBytesInUse(area, keys),
    "storage.getKeys": (ctx, [area]) => [...storageAreas[area].keys()],

    // --- runtime ---------------------------------------------------------
    "runtime.getContexts": (ctx, [filter]) => getContexts(filter || {}),
    "runtime.reload": () => {
      setTimeout(() => location.reload(), 0);
    },
    "runtime.openOptionsPage": () => undefined,
    "runtime.setUninstallURL": () => undefined,
    "runtime.getPlatformInfo": () => ({ os: "android", arch: "arm64", nacl_arch: "arm" }),

    // --- tabs ------------------------------------------------------------
    "tabs.query": (ctx, [query]) => filterTabs(ctx, query || {}),
    "tabs.get": (ctx, [tabId]) => getTab(tabId),
    "tabs.getCurrent": (ctx) => (ctx && ctx.tabId !== undefined && overlayTabs.has(ctx.tabId) ? getTab(ctx.tabId) : undefined),
    "tabs.create": (ctx, [props]) => {
      const url = props && props.url ? String(props.url) : "";
      if (url && isExtensionUrl(url)) {
        const win = createOverlay(url, "normal");
        return win.tabs && win.tabs[0] ? win.tabs[0] : mainTabObject();
      }
      if (url) return openDappTab(new URL(url).href);
      nativePost({ cmd: "openDapp" });
      return mainTabObject();
    },
    "tabs.update": (ctx, [tabId, props]) => {
      if (typeof tabId === "object" && tabId !== null) {
        props = tabId;
        tabId = undefined;
      }
      props = props || {};
      if (tabId === undefined) {
        const current = filterTabs(ctx, { active: true, currentWindow: true })[0];
        tabId = current ? current.id : mainTabObject().id;
      }
      if (!dappTab && tabId === NEW_TAB_ID) {
        if (props.url) openUrl(new URL(props.url).href);
        return newTabObject();
      }
      if (overlayTabs.has(tabId)) {
        const tab = overlayTabs.get(tabId);
        if (props.url && isExtensionUrl(props.url)) {
          const overlay = overlayWindows.get(tab.windowId);
          overlay.frame.src = absoluteExtensionUrl(props.url);
          tab.url = absoluteExtensionUrl(props.url);
        }
        if (props.active || props.highlighted) focusOverlay(tab.windowId);
        return overlayTabObject(tab);
      }
      if (dappTab && dappTab.id === tabId) {
        if (props.url) openUrl(new URL(props.url, dappTab.url || undefined).href);
        else if (props.active) nativePost({ cmd: "showDapp" });
        return dappTabObject();
      }
      throw new Error("No tab with id: " + tabId + ".");
    },
    "tabs.remove": (ctx, [tabIds]) => {
      const list = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const tabId of list) {
        const tab = overlayTabs.get(tabId);
        if (tab) removeOverlay(tab.windowId, ctx);
        else if (dappTab && dappTab.id === tabId) {
          nativePost({ cmd: "closeDapp", tabId });
          removeDappTab(tabId);
        } else if (tabId !== NEW_TAB_ID) throw new Error("No tab with id: " + tabId + ".");
      }
    },
    "tabs.sendMessage": (ctx, [tabId, message]) => tabsSendMessage(tabId, message),
    "tabs.reload": (ctx, [tabId]) => {
      const tab = overlayTabs.get(tabId);
      if (tab) overlayWindows.get(tab.windowId).frame.contentWindow.location.reload();
    },

    // --- windows ---------------------------------------------------------
    "windows.get": (ctx, [windowId, options]) => {
      const id = windowId === -2 ? callerWindowId(ctx) : windowId;
      const win = windowObject(id, options && options.populate);
      if (!win) throw new Error("No window with id: " + windowId + ".");
      return win;
    },
    "windows.getCurrent": (ctx, [options]) => windowObject(callerWindowId(ctx), options && options.populate),
    "windows.getLastFocused": (ctx, [options]) =>
      windowObject(overlayWindows.has(focusedWindowId) ? focusedWindowId : MAIN_WINDOW_ID, options && options.populate),
    "windows.getAll": (ctx, [options]) => {
      const types = (options && options.windowTypes) || ["normal", "popup"];
      return allWindowIds()
        .map((id) => windowObject(id, options && options.populate))
        .filter((win) => win && types.includes(win.type));
    },
    "windows.create": (ctx, [data]) => {
      data = data || {};
      const url = Array.isArray(data.url) ? data.url[0] : data.url;
      if (url && isExtensionUrl(url)) return createOverlay(url, data.type || "normal");
      if (url) openUrl(new URL(url).href);
      return windowObject(MAIN_WINDOW_ID, true);
    },
    "windows.update": (ctx, [windowId, info]) => {
      const id = windowId === -2 ? callerWindowId(ctx) : windowId;
      if (overlayWindows.has(id)) {
        if (info && (info.focused || info.drawAttention)) focusOverlay(id);
        return windowObject(id, false);
      }
      if (id === MAIN_WINDOW_ID) return windowObject(id, false);
      throw new Error("No window with id: " + windowId + ".");
    },
    "windows.remove": (ctx, [windowId]) => {
      const id = windowId === -2 ? callerWindowId(ctx) : windowId;
      if (!removeOverlay(id, ctx)) {
        if (id === MAIN_WINDOW_ID) return; // never close the phone window
        throw new Error("No window with id: " + windowId + ".");
      }
    },

    // --- alarms ----------------------------------------------------------
    "alarms.create": (ctx, [name, info]) => {
      if (typeof name === "object" && name !== null) {
        info = name;
        name = "";
      }
      name = name === undefined ? "" : String(name);
      info = info || {};
      const now = Date.now();
      const scheduledTime =
        info.when !== undefined
          ? Number(info.when)
          : now + 60_000 * Number(info.delayInMinutes ?? info.periodInMinutes ?? 0);
      const existing = alarms.get(name);
      if (existing) clearTimeout(existing.timer);
      const alarm = { name, scheduledTime, periodInMinutes: info.periodInMinutes, timer: null };
      alarms.set(name, alarm);
      scheduleAlarm(alarm);
    },
    "alarms.get": (ctx, [name]) => {
      const alarm = alarms.get(name === undefined ? "" : String(name));
      return alarm ? publicAlarm(alarm) : undefined;
    },
    "alarms.getAll": () => [...alarms.values()].map(publicAlarm),
    "alarms.clear": (ctx, [name]) => {
      const key = name === undefined ? "" : String(name);
      const alarm = alarms.get(key);
      if (!alarm) return false;
      clearTimeout(alarm.timer);
      alarms.delete(key);
      return true;
    },
    "alarms.clearAll": () => {
      for (const alarm of alarms.values()) clearTimeout(alarm.timer);
      const had = alarms.size > 0;
      alarms.clear();
      return had;
    },

    // --- notifications ---------------------------------------------------
    "notifications.create": (ctx, [id, options]) => {
      if (typeof id === "object" && id !== null) {
        options = id;
        id = undefined;
      }
      const notificationId = id ? String(id) : "wc-notification-" + nextNotificationId++;
      notifications.set(notificationId, options || {});
      nativePost({
        cmd: "notify",
        id: notificationId,
        title: String((options && options.title) || "WalletChan"),
        message: String((options && options.message) || ""),
      });
      return notificationId;
    },
    "notifications.update": (ctx, [id, options]) => {
      if (!notifications.has(id)) return false;
      notifications.set(id, { ...notifications.get(id), ...options });
      return true;
    },
    "notifications.clear": (ctx, [id]) => notifications.delete(String(id)),
    "notifications.getAll": () => Object.fromEntries([...notifications.keys()].map((id) => [id, true])),
    "notifications.getPermissionLevel": () => "granted",

    // --- action ----------------------------------------------------------
    "action.setBadgeText": (ctx, [details]) => {
      badge.text = (details && details.text) || "";
    },
    "action.getBadgeText": () => badge.text,
    "action.setBadgeBackgroundColor": (ctx, [details]) => {
      badge.color = details && details.color;
    },
    "action.getBadgeBackgroundColor": () => [0, 0, 0, 255],
    "action.setBadgeTextColor": (ctx, [details]) => {
      badge.textColor = details && details.color;
    },
    "action.setTitle": (ctx, [details]) => {
      badge.title = (details && details.title) || "";
    },
    "action.getTitle": () => badge.title,
    "action.setIcon": () => undefined,
    "action.setPopup": (ctx, [details]) => {
      badge.popup = (details && details.popup) || "";
    },
    "action.getPopup": () => (badge.popup ? absoluteExtensionUrl(badge.popup) : ""),
    "action.enable": () => undefined,
    "action.disable": () => undefined,
    "action.openPopup": () => {
      nativePost({ cmd: "showWallet" });
    },

    // --- sidePanel: the main wallet screen is the panel ------------------
    "sidePanel.open": () => {
      nativePost({ cmd: "showWallet" });
    },
    "sidePanel.close": () => undefined,
    "sidePanel.setOptions": () => undefined,
    "sidePanel.getOptions": () => ({ enabled: true, path: "index.html" }),
    "sidePanel.setPanelBehavior": () => undefined,
    "sidePanel.getPanelBehavior": () => ({ openPanelOnActionClick: false }),

    // --- offscreen -------------------------------------------------------
    "offscreen.createDocument": (ctx, [params]) => {
      if (offscreenFrame) throw new Error("Only a single offscreen document may be created.");
      const url = absoluteExtensionUrl((params && params.url) || "");
      return new Promise((resolve) => {
        offscreenFrame = createHiddenFrame("offscreen", url);
        offscreenFrame.addEventListener("load", () => resolve(), { once: true });
      });
    },
    "offscreen.closeDocument": () => {
      if (!offscreenFrame) throw new Error("No current offscreen document.");
      unregisterFrameContexts(offscreenFrame);
      managedFrames.delete(offscreenFrame);
      offscreenFrame.remove();
      offscreenFrame = null;
    },
    "offscreen.hasDocument": () => Boolean(offscreenFrame),

    // --- declarativeNetRequest (no network interception on Android) ------
    "dnr.updateDynamicRules": (ctx, [options]) => updateRules(dnr, "dynamic", options),
    "dnr.getDynamicRules": () => clone(dnr.dynamic),
    "dnr.updateSessionRules": (ctx, [options]) => updateRules(dnr, "session", options),
    "dnr.getSessionRules": () => clone(dnr.session),

    // --- shell-specific --------------------------------------------------
    "shell.closeSelf": (ctx) => {
      if (!ctx) return;
      if (ctx.role === "overlay") setTimeout(() => removeOverlay(ctx.windowId), 0);
      else if (ctx.role === "offscreen") api["offscreen.closeDocument"]();
      else log("window.close() ignored for", ctx.role);
    },
    "shell.openUrl": (ctx, [url]) => openUrl(url),
  };

  function updateRules(store, kind, options) {
    options = options || {};
    const remove = new Set(options.removeRuleIds || []);
    store[kind] = store[kind].filter((rule) => !remove.has(rule.id)).concat(clone(options.addRules || []));
  }

  /** Entry point used by chrome-shim.js. Resolves/rejects with JSON strings. */
  function call(contextId, method, argsJson) {
    const ctx = contexts.get(contextId) || null;
    const handler = api[method];
    if (!handler) return Promise.reject(new Error("Unsupported API: " + method));
    return new Promise((resolve, reject) => {
      try {
        const result = handler(ctx, parseJson(argsJson) || []);
        Promise.resolve(result).then(
          (value) => resolve(toJson(value)),
          (error) => reject(error instanceof Error ? error.message : String(error)),
        );
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP through native (cross-origin fetch from wallet frames)
  // ---------------------------------------------------------------------------

  const httpIdsByClientKey = new Map();

  /**
   * Performs a native HTTP request. `clientKey` (chosen by the calling frame)
   * lets that frame cancel it with httpAbort when its AbortSignal fires.
   */
  function httpRequest(requestJson, clientKey) {
    return new Promise((resolve, reject) => {
      if (!nativeBridge) return reject("Native HTTP unavailable");
      const request = JSON.parse(requestJson);
      const id = "h" + nextHttpId++;
      if (clientKey) httpIdsByClientKey.set(clientKey, id);
      pendingHttp.set(id, {
        resolve: (json) => {
          if (clientKey) httpIdsByClientKey.delete(clientKey);
          resolve(json);
        },
        reject,
      });
      nativePost({ cmd: "http", id, ...request });
    });
  }

  function httpAbort(clientKey) {
    const id = httpIdsByClientKey.get(clientKey);
    if (!id) return;
    httpIdsByClientKey.delete(clientKey);
    nativePost({ cmd: "httpAbort", id });
  }

  // ---------------------------------------------------------------------------
  // WalletConnect pairing from QR scans and deep links
  // ---------------------------------------------------------------------------

  /** Returns a `wc:` URI from the supported QR/deep-link shapes, else null. */
  function extractWalletConnectUri(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (/^wc:/i.test(trimmed)) return trimmed;
    try {
      const parsed = new URL(trimmed);
      const nested = parsed.searchParams.get("uri");
      if (nested && /^wc:/i.test(nested.trim())) return nested.trim();
    } catch {
      /* not a URL */
    }
    return null;
  }

  let walletConnectBusy = false;
  /** Pairings (shell- or UI-initiated) still waiting for the user's decision. */
  let walletConnectPairings = 0;
  /** Session topics last reported by the background (kept current from the bus). */
  const knownWalletConnectTopics = new Set();

  busObservers.push((message) => {
    if (message && message.type === "walletConnectSessionsChanged" && Array.isArray(message.sessions)) {
      knownWalletConnectTopics.clear();
      for (const session of message.sessions) if (session && session.topic) knownWalletConnectTopics.add(session.topic);
    }
  });

  async function rememberWalletConnectTopics(target) {
    const response = await sendAsWalletUi({ type: "walletConnectGetSessions" }).catch(() => null);
    for (const session of (response && response.sessions) || []) if (session && session.topic) target.add(session.topic);
  }

  async function pairWalletConnect(uri, source) {
    nativePost({ cmd: "showWallet" });
    if (walletConnectBusy) {
      showToast("Already connecting a dApp…");
      return;
    }
    walletConnectBusy = true;
    let watcher = null;
    try {
      // Speed first, no progress toasts: pair immediately so the Connect
      // screen appears as soon as the proposal arrives. Pairing needs no
      // unlock; nothing connects until the user taps Connect. The watcher is
      // armed first; the session/account lookups run alongside the pairing
      // (topics found there can only be pre-existing sessions).
      const knownTopics = new Set(knownWalletConnectTopics);
      watcher = waitForWalletConnectOutcome(knownTopics);
      const pairing = sendAsWalletUi({ type: "walletConnectPair", uri });
      const [accounts] = await Promise.all([
        sendAsWalletUi({ type: "getAccounts" }).catch(() => null),
        rememberWalletConnectTopics(knownTopics),
      ]);
      if (!Array.isArray(accounts) || accounts.length === 0) {
        watcher.cancel();
        showToast("Set up your wallet before connecting a dApp", "error", 5000);
        return;
      }
      const result = await pairing;
      if (!result || !result.success) {
        watcher.cancel();
        showToast("WalletConnect failed: " + ((result && result.error) || "unknown error"), "error", 6000);
        return;
      }
      const outcome = await watcher.promise;
      // Opened from a dApp on this phone: go back to it after the decision.
      finishWalletConnectPairing(outcome, source === "external" || source === "dapp" ? source : null);
    } catch (error) {
      if (watcher) watcher.cancel();
      showToast("WalletConnect failed: " + (error.message || error), "error", 6000);
    } finally {
      walletConnectBusy = false;
    }
  }

  /**
   * Shows the outcome of a pairing and returns to the calling app (once) after
   * the user approved or rejected the connection. Errors stay on screen so the
   * user can read them.
   */
  function finishWalletConnectPairing(outcome, returnTo) {
    if (outcome.kind === "approvedByUser") {
      // Approval is still being published; keep the app alive meanwhile and
      // surface a failure the next time the wallet is on screen.
      holdKeepAlive(30_000);
      watchApprovalFailure(outcome.proposalId);
    }
    if (outcome.kind === "connected" || outcome.kind === "approvedByUser" || outcome.kind === "userRejected") {
      // No success/rejection toast: the dApp shows the result. Hand back
      // to the calling app at once.
      hideToast();
    } else if (outcome.kind === "rejected") {
      showToast("WalletConnect: " + (outcome.error || "connection rejected"), "error", 6000);
      return;
    } else if (outcome.kind === "timeout") {
      showToast("Waiting for the dApp… keep it open", "info");
      return;
    } else {
      hideToast();
      return;
    }
    if (returnTo) returnToCaller(returnTo);
  }

  const PROPOSAL_ARRIVAL_TIMEOUT_MS = 45_000;
  const PROPOSAL_DECISION_TIMEOUT_MS = 10 * 60_000;

  /**
   * Resolves with the first outcome of a pairing: a new session ("connected"),
   * the user's rejection ("userRejected"), a policy rejection ("rejected"), no
   * proposal within 45 s ("timeout"), or no decision before the proposal
   * expired ("undecided"). While the connection review is on screen the
   * progress toast is hidden and the wait extends to the proposal's expiry.
   */
  function waitForWalletConnectOutcome(knownTopics) {
    let observer;
    let timer;
    let proposalId = null;
    walletConnectPairings += 1;
    keepAliveHolds += 1; // released in cleanup()
    reportWalletConnectSessions();
    const promise = new Promise((resolve) => {
      const arm = (ms, kind) => {
        clearTimeout(timer);
        timer = setTimeout(() => resolve({ kind }), ms);
      };
      observer = (message) => {
        if (!message || typeof message !== "object") return;
        // The user's tap is the outcome. kit.approveSession/rejectSession wait
        // for the relay to acknowledge, which takes ~6 s when the dApp's tab
        // is frozen in the background; don't make the user wait for that.
        if (
          (message.type === "walletConnectApproveProposal" || message.type === "walletConnectRejectProposal") &&
          (proposalId === null || message.proposalId === proposalId)
        ) {
          resolve({ kind: message.type === "walletConnectApproveProposal" ? "approvedByUser" : "userRejected", proposalId });
          return;
        }
        // Every connection now goes through the Connect review, so the user's
        // tap (above) is the only "connected" signal. A sessions broadcast is
        // NOT one: on a restart WalletKit re-announces existing sessions,
        // which looked "new" and sent the user back before they tapped.
        if (message.type === "walletConnectProposalRejected") {
          resolve({ kind: "rejected", error: message.rejection && message.rejection.error });
        } else if (message.type === "walletConnectProposalUserRejected") {
          if (proposalId === null || message.proposalId === proposalId) resolve({ kind: "userRejected", name: message.name });
        } else if (message.type === WALLETCONNECT_PROPOSAL_REQUEST && message.proposal && proposalId === null) {
          proposalId = message.proposal.id;
          hideToast();
          const untilExpiry = Number(message.proposal.expiresAt) - Date.now() + 5_000;
          arm(Number.isFinite(untilExpiry) && untilExpiry > 0 ? Math.min(untilExpiry, PROPOSAL_DECISION_TIMEOUT_MS) : PROPOSAL_DECISION_TIMEOUT_MS, "undecided");
        }
      };
      busObservers.push(observer);
      arm(PROPOSAL_ARRIVAL_TIMEOUT_MS, "timeout");
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      walletConnectPairings -= 1;
      keepAliveHolds -= 1;
      reportWalletConnectSessions();
      clearTimeout(timer);
      const index = busObservers.indexOf(observer);
      if (index >= 0) busObservers.splice(index, 1);
    };
    promise.then(cleanup);
    return { promise, cancel: cleanup };
  }

  /**
   * Pairing started from the wallet's own WalletConnect screen (a pasted
   * `wc:` link). On a phone that link was almost always copied from a dApp in
   * the browser, so once the user decides, hand them back to it, like a deep
   * link. QR scans go through pairWalletConnect (walletConnectBusy) and stay
   * put: the dApp is on another device.
   */
  busObservers.push((message) => {
    if (!message || message.type !== "walletConnectPair" || walletConnectBusy) return;
    void returnAfterUiPairing();
  });

  async function returnAfterUiPairing() {
    // Watch first (synchronously) so a fast proposal is not missed; topics
    // fetched afterwards are only pre-existing sessions (no decision yet).
    const knownTopics = new Set(knownWalletConnectTopics);
    const watcher = waitForWalletConnectOutcome(knownTopics);
    await rememberWalletConnectTopics(knownTopics);
    const outcome = await watcher.promise;
    if (outcome.kind !== "connected" && outcome.kind !== "approvedByUser" && outcome.kind !== "userRejected") return;
    finishWalletConnectPairing(outcome, "external");
  }

  /** `source`: "external" | "dapp" | "wallet" for deep links, undefined for QR scans. */
  function handleWalletConnectText(text, source) {
    const uri = extractWalletConnectUri(text);
    if (!uri) return false;
    // "wc:<topic>@2?requestId=…" without a symKey is a "go to wallet" link for
    // an existing session; the approval window is (or will shortly be) open.
    if (!/[?&]symKey=/.test(uri)) {
      nativePost({ cmd: "showWallet" });
      armReturnToCaller(source);
      return true;
    }
    void pairWalletConnect(uri, source);
    return true;
  }

  function handleScanResult(text) {
    if (text === null || text === undefined) return;
    if (handleWalletConnectText(text)) return;
    try {
      const parsed = new URL(String(text).trim());
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        openUrl(parsed.href);
        return;
      }
    } catch {
      /* not a URL */
    }
    showToast("Not a WalletConnect QR code", "error");
  }

  // ---------------------------------------------------------------------------
  // Android back button
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  /**
   * Tries to go "back" inside a wallet document: close an open dialog (Escape),
   * else press a visible header back button. Returns true when handled.
   */
  function backInDocument(frame) {
    let doc;
    try {
      doc = frame.contentDocument;
    } catch {
      return false;
    }
    if (!doc || !doc.body) return false;
    const dialogs = [...doc.querySelectorAll('[role="dialog"],[role="alertdialog"],.chakra-modal__content,[aria-modal="true"]')].filter(isVisible);
    if (dialogs.length) {
      const target = doc.activeElement || doc.body;
      const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
      target.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", init));
      target.dispatchEvent(new frame.contentWindow.KeyboardEvent("keyup", init));
      return true;
    }
    const backButton = [...doc.querySelectorAll("button[aria-label],a[aria-label]")].find(
      (el) => /^(go back|back)\b/i.test(el.getAttribute("aria-label") || "") && isVisible(el) && !el.disabled,
    );
    if (backButton) {
      backButton.click();
      return true;
    }
    return false;
  }

  function handleBack() {
    const overlay = topOverlay();
    if (overlay) {
      if (!backInDocument(overlay.frame)) removeOverlay(overlay.id);
      return;
    }
    if (mainUiFrame && backInDocument(mainUiFrame)) return;
    nativePost({ cmd: "backUnhandled" });
  }

  // ---------------------------------------------------------------------------
  // Native -> shell messages
  // ---------------------------------------------------------------------------

  function onNativeMessage(raw) {
    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello":
        log("native hello", msg.sdkInt, msg.appVersion, "freshProcess:", msg.freshProcess);
        if (helloResolve) {
          helloResolve(msg);
          helloResolve = null;
        }
        break;
      case "appResumed":
        // Back from another app: fetch queued WalletConnect requests now
        // instead of on the next 20 s keepalive tick.
        nudgeRelay();
        appVisible = true;
        if (deferredToast) {
          showToast(deferredToast, "error", 7000);
          deferredToast = null;
        }
        // A prompt cancelled by leaving the app may show again — but the system
        // biometric dialog itself pauses/resumes the activity on many phones;
        // never re-prompt while a fingerprint unlock is still in progress.
        if (!bio.prompting && Date.now() - bioFilledAt > 15_000) bioAutoPrompted = false;
        break;
      case "appPaused":
        appVisible = false;
        break;
      case "biometricStatus":
      case "biometricEnroll":
      case "biometricUnlock":
      case "biometricDisable":
        onBioReply(msg);
        break;
      case "http": {
        const pending = pendingHttp.get(msg.id);
        if (pending) {
          pendingHttp.delete(msg.id);
          pending.resolve(JSON.stringify(msg));
        }
        break;
      }
      case "back":
        handleBack();
        break;
      case "dappMessage":
        handleDappMessage(msg);
        break;
      case "dappTab":
        updateDappTab(msg.tabId, msg.url, msg.title, msg.status);
        break;
      case "dappTabRemoved":
        removeDappTab(msg.tabId);
        break;
      case "dappVisible":
        // Overlays remember (returnToDapp) whether they were opened while the
        // dApp was in front, so closing them can hand the user back.
        dappVisible = Boolean(msg.visible);
        break;
      case "qrResult":
        if (msg.text) handleScanResult(msg.text);
        else if (msg.error === "no_camera") showToast("No camera available for scanning", "error");
        else if (msg.error === "permission_denied") showToast("Camera permission is needed to scan QR codes", "error", 5000);
        // "cancelled" (user backed out) and "busy" (scanner already open) stay silent.
        else if (msg.error && msg.error !== "cancelled" && msg.error !== "busy") showToast("Scan failed: " + msg.error, "error");
        break;
      case "deepLink":
        nudgeRelay();
        if (!handleWalletConnectText(msg.url, msg.source)) {
          try {
            const parsed = new URL(msg.url);
            if (parsed.protocol === "https:" || parsed.protocol === "http:") {
              openUrl(parsed.href);
            } else {
              // e.g. bare `walletchan://` or `walletchan://wc?requestId=…&sessionTopic=…`:
              // a dApp bringing the wallet forward for a pending request.
              nativePost({ cmd: "showWallet" });
              armReturnToCaller(msg.source);
            }
          } catch {
            nativePost({ cmd: "showWallet" });
          }
        }
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Shell chrome (floating buttons) and boot
  // ---------------------------------------------------------------------------

  /**
   * The floating dApp-browser / scan buttons are shown only on the wallet's
   * home screen (identified by its header "Lock wallet" button), so they never
   * cover controls on sub-screens, the unlock screen or approval overlays.
   */
  function uiOnHomeScreen() {
    if (!mainUiFrame) return false;
    try {
      const doc = mainUiFrame.contentDocument;
      const lock = doc && doc.querySelector('button[aria-label="Lock wallet"]');
      return Boolean(lock && isVisible(lock));
    } catch {
      return false;
    }
  }

  /** A Chakra toast is showing in the wallet UI (FABs would cover it). */
  function uiToastVisible() {
    if (!mainUiFrame) return false;
    try {
      const doc = mainUiFrame.contentDocument;
      return Boolean(doc && doc.querySelector('[id^="chakra-toast-manager"] li'));
    } catch {
      return false;
    }
  }

  /**
   * Speed-first WalletConnect on a phone: hide the wallet UI's own
   * "Connecting to dapp" progress toast (errors still show). The Connect
   * screen itself is the feedback.
   */
  /** Timestamps for performance tests (no secrets). */
  const timings = {};
  busObservers.push((message) => {
    if (message && message.type === WALLETCONNECT_PROPOSAL_REQUEST) timings.proposalBroadcastAt = Date.now();
  });

  const PROGRESS_TOASTS = /^\s*Connecting to dapp/i;
  const toastWatchedDocs = new WeakSet();
  function suppressProgressToasts() {
    let doc;
    try {
      doc = mainUiFrame && mainUiFrame.contentDocument;
    } catch {
      return;
    }
    if (!doc || !doc.body || toastWatchedDocs.has(doc)) return;
    toastWatchedDocs.add(doc);
    const hide = (root) => {
      for (const item of root.querySelectorAll('[id^="chakra-toast-manager"] li')) {
        if (PROGRESS_TOASTS.test(item.textContent || "")) item.style.display = "none";
      }
    };
    new doc.defaultView.MutationObserver(() => hide(doc)).observe(doc.body, { childList: true, subtree: true });
    hide(doc);
  }

  /** Hide the splash once the wallet UI (or an onboarding overlay) has painted. */
  let splashGone = false;
  function updateSplash() {
    if (splashGone) return;
    let painted = overlayWindows.size > 0;
    if (!painted && mainUiFrame) {
      try {
        const body = mainUiFrame.contentDocument && mainUiFrame.contentDocument.body;
        painted = Boolean(body && body.innerText && body.innerText.trim().length > 0);
      } catch {
        painted = false;
      }
    }
    if (!painted && performance.now() - (timings.bootStart || 0) < 15_000) return;
    splashGone = true;
    const splash = document.getElementById("wc-splash");
    if (splash) {
      splash.classList.add("gone");
      setTimeout(() => splash.remove(), 200);
    }
  }

  function updateChrome() {
    updateSplash();
    suppressProgressToasts();
    const fabs = document.getElementById("wc-fabs");
    if (fabs) fabs.hidden = overlayWindows.size > 0 || !uiOnHomeScreen() || uiToastVisible();
    checkInlineRequestDone();
    bioTick();
  }

  // ---------------------------------------------------------------------------
  // Biometric unlock (opt-in). Native keeps the password encrypted under a
  // Keystore key usable only after a fingerprint/face check (see
  // ARCHITECTURE.md "Biometric unlock"); the shell fills the wallet's own
  // unlock form with it. The password only passes through memory.
  // ---------------------------------------------------------------------------

  const bio = { available: false, enrolled: false, declined: false, wantSetup: false, prompting: false };
  const bioPending = new Map();
  let bioNextId = 1;
  let bioCapture = null; // { secret, at, viaBiometric } — last password typed into the unlock form
  let bioFilledAt = 0;
  let bioAutoPrompted = false; // auto-prompt once per appearance of the unlock screen
  let unlockScreenShown = false;
  let appVisible = true;
  const bioWatchedDocs = new WeakSet();
  const UNLOCK_INPUT = "input#unlock-password"; // UnlockView.tsx

  function bioRequest(cmd, extra) {
    return new Promise((resolve) => {
      const id = "bio" + bioNextId++;
      bioPending.set(id, resolve);
      if (!nativePost(Object.assign({ cmd, id }, extra || {}))) {
        bioPending.delete(id);
        resolve({ ok: false, error: "unavailable", available: false });
        return;
      }
      const limit = cmd === "biometricStatus" || cmd === "biometricDisable" ? 5000 : 180_000;
      setTimeout(() => {
        if (bioPending.delete(id)) resolve({ ok: false, error: "timeout" });
      }, limit);
    });
  }

  function onBioReply(msg) {
    const resolve = bioPending.get(msg.id);
    if (!resolve) return;
    bioPending.delete(msg.id);
    resolve(msg);
  }

  async function refreshBioStatus() {
    const status = await bioRequest("biometricStatus");
    bio.available = status.available === true;
    bio.enrolled = status.enrolled === true;
  }

  function persistBioDeclined(value) {
    bio.declined = value;
    meta.set("bioDeclined", JSON.stringify(value));
    persist("meta", [["bioDeclined", JSON.stringify(value)]], []).catch(() => {});
  }

  /** The wallet's unlock form (topmost surface first), if one is visible. */
  function findUnlockForm() {
    const overlays = [...overlayWindows.values()].sort((a, b) => b.zIndex - a.zIndex).map((o) => o.frame);
    for (const frame of [...overlays, mainUiFrame]) {
      if (!frame) continue;
      let doc;
      try {
        doc = frame.contentDocument;
      } catch {
        continue;
      }
      const input = doc && doc.querySelector(UNLOCK_INPUT);
      if (!input || !isVisible(input)) continue;
      const button = [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === "Unlock" && isVisible(b));
      return { frame, doc, input, button };
    }
    return null;
  }

  /** Remember what the user typed when they submit the unlock form. */
  function watchUnlockForm(form) {
    if (bioWatchedDocs.has(form.doc)) return;
    bioWatchedDocs.add(form.doc);
    const capture = () => {
      const input = form.doc.querySelector(UNLOCK_INPUT);
      const secret = input && input.value;
      if (secret) bioCapture = { secret, at: Date.now(), viaBiometric: Date.now() - bioFilledAt < 3000 };
    };
    form.doc.addEventListener(
      "click",
      (event) => {
        const button = event.target && event.target.closest && event.target.closest("button");
        if (button && button.textContent.trim() === "Unlock") capture();
      },
      true,
    );
    form.doc.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" && event.target && event.target.matches && event.target.matches(UNLOCK_INPUT)) capture();
      },
      true,
    );
    form.doc.addEventListener("submit", capture, true);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setInputValue(form, secret) {
    const win = form.frame.contentWindow;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    setter.call(form.input, secret);
    form.input.dispatchEvent(new win.Event("input", { bubbles: true }));
  }

  /** The unlock form's own "wrong password" message is showing. */
  function unlockFormSaysWrongPassword(doc) {
    const error = doc.getElementById("unlock-password-error");
    if (!error || !isVisible(error) || error.getAttribute("role") !== "alert") return false;
    return /incorrect|wrong|invalid/i.test(error.textContent || "");
  }

  /**
   * Fill the wallet's unlock form and press Unlock — reliably. On a phone the
   * form may take a while to register the value (the button stays disabled
   * until it does), so wait for an enabled button, and retry if the press
   * didn't start an unlock. Resolves "unlocked" | "wrongPassword" | "unknown".
   */
  async function fillAndSubmit(secret) {
    let submittedAt = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      let form = findUnlockForm();
      if (!form) return "unlocked";
      if (form.input.value !== secret) setInputValue(form, secret);
      bioFilledAt = Date.now();
      // Wait (≤ 3 s) for the Unlock button to become enabled.
      for (let waited = 0; waited < 3000; waited += 25) {
        form = findUnlockForm();
        if (!form) return "unlocked";
        if (form.button && !form.button.disabled && form.input.value === secret) break;
        await sleep(25);
      }
      if (!form.button || form.button.disabled) continue;
      // An "Incorrect password" left over from an earlier typed attempt must
      // not be blamed on the saved password: require it to clear first.
      let errorCleared = !unlockFormSaysWrongPassword(form.doc);
      const saysWrong = (doc) => {
        const wrong = unlockFormSaysWrongPassword(doc);
        if (!wrong) errorCleared = true;
        return wrong && errorCleared;
      };
      form.button.click();
      submittedAt = Date.now();
      // The press "took" when the form starts unlocking (button disabled /
      // "Unlocking…"), goes away, or reports an error.
      for (let waited = 0; waited < 1500; waited += 50) {
        await sleep(50);
        const now = findUnlockForm();
        if (!now) return "unlocked";
        if (saysWrong(now.doc)) return "wrongPassword";
        if (!now.button || now.button.disabled) break;
      }
      // Unlocking (PBKDF2 can take seconds on a phone): wait for the outcome.
      for (let waited = 0; waited < 60_000; waited += 200) {
        const now = findUnlockForm();
        if (!now) return "unlocked";
        if (saysWrong(now.doc)) return "wrongPassword";
        if (now.button && !now.button.disabled && Date.now() - submittedAt > 1500) break; // idle again: retry
        await sleep(200);
      }
    }
    return "unknown";
  }

  async function bioUnlock() {
    if (bio.prompting || !bio.enrolled) return;
    bio.prompting = true;
    try {
      const reply = await bioRequest("biometricUnlock");
      if (reply.ok && typeof reply.secret === "string") {
        if (!findUnlockForm()) return;
        const outcome = await fillAndSubmit(reply.secret);
        if (outcome === "wrongPassword") {
          // Only on the wallet's own "incorrect password" answer: the saved
          // password is stale (changed / wallet reset). Never on a guess.
          await bioRequest("biometricDisable");
          bio.enrolled = false;
          bio.wantSetup = true;
          showToast("Your password changed. Unlock with your password once to update fingerprint unlock.", "error", 7000);
        } else if (outcome === "unknown") {
          showToast("Fingerprint unlock didn't finish. Tap “Unlock with fingerprint” to try again.", "info", 5000);
        }
      } else if (reply.error === "invalidated" || reply.error === "not_enrolled") {
        bio.enrolled = false;
        if (reply.error === "invalidated") {
          bio.wantSetup = true;
          showToast("Fingerprints changed on this phone. Unlock with your password to set fingerprint unlock up again.", "info", 7000);
        }
      } else if (reply.error === "lockout") {
        showToast("Too many attempts. Unlock with your password.", "error", 5000);
      }
    } finally {
      bio.prompting = false;
    }
  }

  async function bioEnroll(secret) {
    const reply = await bioRequest("biometricEnroll", { secret });
    if (reply.ok) {
      bio.enrolled = true;
      bio.wantSetup = false;
      if (bio.declined) persistBioDeclined(false);
      showToast("Fingerprint unlock is on", "success");
    } else if (reply.error && reply.error !== "cancelled" && reply.error !== "busy") {
      showToast("Couldn't set up fingerprint unlock (" + reply.error + ")", "error", 5000);
    }
  }

  function showBioOffer(secret) {
    const card = document.getElementById("wc-bio-offer");
    if (!card) return;
    card.hidden = false;
    const done = () => {
      card.hidden = true;
      yes.onclick = null;
      no.onclick = null;
    };
    const yes = document.getElementById("wc-bio-offer-yes");
    const no = document.getElementById("wc-bio-offer-no");
    yes.onclick = () => {
      done();
      void bioEnroll(secret);
    };
    no.onclick = () => {
      done();
      persistBioDeclined(true);
    };
  }

  /** The unlock screen just went away: offer (or finish) biometric setup. */
  async function onUnlockScreenGone() {
    const captured = bioCapture;
    bioCapture = null;
    if (!captured || captured.viaBiometric || Date.now() - captured.at > 60_000) return;
    if (!bio.available || bio.enrolled) return;
    const unlocked = await sendAsWalletUi({ type: "isWalletUnlocked" }).catch(() => false);
    if (unlocked !== true) return;
    if (bio.wantSetup) void bioEnroll(captured.secret);
    else if (!bio.declined) showBioOffer(captured.secret);
  }

  function bioTick() {
    const controls = document.getElementById("wc-bio");
    if (!controls) return;
    const form = findUnlockForm();
    if (!form) {
      controls.hidden = true;
      if (unlockScreenShown) {
        unlockScreenShown = false;
        bioAutoPrompted = false;
        void onUnlockScreenGone();
      }
      return;
    }
    unlockScreenShown = true;
    watchUnlockForm(form);
    controls.hidden = !bio.available;
    document.getElementById("wc-bio-unlock").hidden = !bio.enrolled;
    document.getElementById("wc-bio-off").hidden = !bio.enrolled;
    document.getElementById("wc-bio-setup").hidden = bio.enrolled || bio.wantSetup;
    // Prompt straight away: a locked wallet then costs one fingerprint touch.
    if (bio.enrolled && appVisible && !bioAutoPrompted && !bio.prompting) {
      bioAutoPrompted = true;
      void bioUnlock();
    }
  }

  function bindBioControls() {
    document.getElementById("wc-bio-unlock").addEventListener("click", () => void bioUnlock());
    document.getElementById("wc-bio-off").addEventListener("click", async () => {
      await bioRequest("biometricDisable");
      bio.enrolled = false;
      showToast("Fingerprint unlock is off");
    });
    document.getElementById("wc-bio-setup").addEventListener("click", () => {
      bio.wantSetup = true;
      if (bio.declined) persistBioDeclined(false);
      showToast("Unlock with your password once to finish setting up fingerprint unlock.", "info", 5000);
    });
  }

  let manifest = null;
  let helloResolve = null;

  async function boot() {
    timings.bootStart = performance.now();
    try {
      manifest = await fetch("/manifest.json").then((r) => r.json());
    } catch (error) {
      warn("manifest load failed", error);
      manifest = { name: "WalletChan", version: "0.0.0", manifest_version: 3 };
    }

    try {
      db = await openDb();
      await Promise.all([loadStore("local", storageAreas.local), loadStore("sync", storageAreas.sync), loadStore("meta", meta)]);
      timings.storageLoaded = performance.now();
    } catch (error) {
      warn("IndexedDB unavailable, storage will not persist", error);
      db = null;
    }

    let hello = null;
    if (nativeBridge) {
      const helloReply = new Promise((resolve) => {
        helloResolve = resolve;
      });
      nativeBridge.onmessage = (event) => onNativeMessage(event && event.data);
      nativePost({ cmd: "hello" });
      // The session snapshot must be in place before the background starts.
      hello = await Promise.race([helloReply, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
    }
    // Side-panel mode makes requests appear in the running wallet screen.
    // Default it on once (older installs stored nothing or "false" only
    // because the API was missing); the user can still switch in settings.
    if (!meta.has("androidPanelModeDefaulted")) {
      storageAreas.sync.set("sidePanelMode", "true");
      storageAreas.sync.set("isArcBrowser", "false");
      meta.set("androidPanelModeDefaulted", "true");
      await Promise.all([
        persist("sync", [["sidePanelMode", "true"], ["isArcBrowser", "false"]], []),
        persist("meta", [["androidPanelModeDefaulted", "true"]], []),
      ]).catch((error) => warn("panel mode default persist failed", error));
    }

    timings.hello = performance.now();
    const restoredSession = hello && hello.session && typeof hello.session === "object" ? hello.session : null;
    if (restoredSession) {
      for (const key of Object.keys(restoredSession)) {
        if (typeof restoredSession[key] === "string") storageAreas.session.set(key, restoredSession[key]);
      }
      log("restored", storageAreas.session.size, "session storage keys after a WebView restart");
    }
    // A WebView restart inside a live app process is a "service worker
    // restart", not a browser start: don't fire runtime.onStartup for it.
    const browserStart = !hello || hello.freshProcess !== false;

    // runtime.onInstalled needs to run before a fresh install's UI decides
    // anything; otherwise boot the wallet UI in parallel with the background
    // (its messages queue until the background is ready) to cut cold start.
    const previous = meta.has("installedVersion") ? JSON.parse(meta.get("installedVersion")) : null;
    if (previous !== null) createMainUi();

    bio.declined = meta.has("bioDeclined") && JSON.parse(meta.get("bioDeclined")) === true;
    if (nativeBridge) void refreshBioStatus();

    timings.uiStarted = performance.now();
    await startBackground();
    timings.backgroundReady = performance.now();
    backgroundReady = true;
    log("background ready");

    // runtime.onInstalled / onStartup
    const version = manifest.version;
    if (previous === null) emitEvent("runtime.onInstalled", [{ reason: "install" }], "background");
    else if (previous !== version) emitEvent("runtime.onInstalled", [{ reason: "update", previousVersion: previous }], "background");
    else if (browserStart) emitEvent("runtime.onStartup", [], "background");
    if (previous !== version) {
      meta.set("installedVersion", JSON.stringify(version));
      persist("meta", [["installedVersion", JSON.stringify(version)]], []).catch((error) => warn("meta persist failed", error));
    }

    // Flush messages that raced the background start.
    for (const run of queuedUntilBackground.splice(0)) run();
    setTimeout(() => void refreshWalletConnectSessionCount(), 3000);

    // Fresh install: give onInstalled a moment to open onboarding first.
    if (previous === null) setTimeout(createMainUi, 300);

    bindBioControls();
    setInterval(updateChrome, 200);
    const splashPoll = setInterval(() => {
      updateSplash();
      if (splashGone) clearInterval(splashPoll);
    }, 50);
    document.getElementById("wc-fab-browser").addEventListener("click", () => {
      if (!nativePost({ cmd: "openDapp" })) showToast("The dApp browser is available in the Android app");
    });
    document.getElementById("wc-fab-scan").addEventListener("click", () => {
      if (!nativePost({ cmd: "scanQr" })) showToast("QR scanning is available in the Android app");
    });
    updateChrome();
  }

  // Exposed to chrome-shim.js in wallet frames (and to tests).
  window.__walletchanShell = {
    version: 1,
    origin: ORIGIN,
    extensionId: EXTENSION_ID,
    registerContext,
    setDispatcher,
    unregisterContext,
    runtimeSendMessage,
    runtimeConnect,
    portPostMessage,
    portDisconnect,
    call,
    httpRequest,
    httpAbort,
    getViews,
    get manifestJson() {
      return JSON.stringify(manifest);
    },
    // Test/debug hooks.
    debug: {
      timings,
      handleNativeMessage: onNativeMessage,
      overlayCount: () => overlayWindows.size,
      storageSnapshot: (area) => storageGet(area, null),
      sendAsWalletUi,
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
