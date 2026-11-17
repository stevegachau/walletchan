/*
 * WalletChan Android chrome.* polyfill.
 *
 * Injected by scripts/package-web.mjs as the FIRST element of <head> in every
 * HTML page of the extension build, so it runs before any extension code.
 *
 * Roles (decided from where the document lives):
 *   shell       top frame /android/shell.html — nothing to do here, shell.js
 *               owns the runtime.
 *   background  hidden iframe running static/js/background.js (the MV3
 *               "service worker").
 *   ui          the full-screen wallet UI iframe (index.html). Behaves like
 *               Chrome's side panel: it is not a tab and window.close() is a
 *               no-op.
 *   overlay     a chrome.windows.create / chrome.tabs.create window. Its
 *               window.close() closes the overlay.
 *   offscreen   chrome.offscreen document.
 *   subframe    an iframe nested inside one of the above.
 *   orphan      an extension page without a shell (e.g. opened directly in
 *               the dApp browser). Gets an inert chrome object.
 *
 * All chrome.* calls are forwarded to the shell (window.top.__walletchanShell).
 * Data crosses the frame boundary as JSON strings, which reproduces Chrome's
 * JSON-style message serialization and keeps objects in the right realm.
 *
 * chrome.sidePanel is intentionally NOT provided: the extension then takes
 * its Firefox-style popup path (approvals open as overlay windows), which
 * maps cleanly onto a phone.
 */
(function () {
  "use strict";

  if (window.__walletchanShimInstalled) return;
  window.__walletchanShimInstalled = true;

  // Lets extension code opt into Android-only behaviour, e.g. advertising the
  // `walletchan://` app link as WalletConnect `redirect.native` metadata.
  Object.defineProperty(window, "__WALLETCHAN_PLATFORM__", { value: "android", enumerable: false });

  const ORIGIN = location.origin;
  const PATH = location.pathname;
  const isTop = window.top === window;

  // ---------------------------------------------------------------------------
  // Role detection
  // ---------------------------------------------------------------------------

  if (isTop && PATH === "/android/shell.html") return; // shell.js takes over

  let shell = null;
  if (!isTop) {
    try {
      shell = window.top.__walletchanShell || null;
    } catch {
      shell = null; // cross-origin top (an extension page framed by a website)
    }
  }

  if (!shell && isTop && /^\/(index|onboarding|popup-init)\.html$/.test(PATH) && !/[?&]standalone=1\b/.test(location.search)) {
    // A wallet page opened on its own: boot the shell, which hosts it.
    location.replace("/android/shell.html");
    return;
  }

  // ---------------------------------------------------------------------------
  // Transport to the shell
  // ---------------------------------------------------------------------------

  const NOT_AVAILABLE = "WalletChan runtime is not available in this context.";
  let ctxInfo = null;
  let transport;

  if (shell) {
    ctxInfo = JSON.parse(shell.registerContext(window, { url: location.href }));
    const contextId = ctxInfo.contextId;
    transport = {
      sendMessage: (json, cb) => shell.runtimeSendMessage(contextId, json, cb),
      connect: (name) => shell.runtimeConnect(contextId, name),
      portPost: (portId, json) => shell.portPostMessage(contextId, portId, json),
      portDisconnect: (portId) => shell.portDisconnect(contextId, portId),
      call: (method, argsJson) => shell.call(contextId, method, argsJson),
      http: (json, key) => shell.httpRequest(json, key),
      httpAbort: (key) => shell.httpAbort(key),
      getViews: (filterJson) => Array.from(shell.getViews(JSON.parse(filterJson))),
      hasNativeHttp: () => ctxInfo.hasNativeHttp,
      setDispatcher: (dispatcher) => shell.setDispatcher(contextId, dispatcher),
      unregister: () => shell.unregisterContext(contextId),
    };
  } else {
    ctxInfo = { role: "orphan", extensionId: "walletchan", manifest: null, windowId: -1, tabId: null };
    transport = {
      sendMessage: (json, cb) => setTimeout(() => cb(undefined, NOT_AVAILABLE), 0),
      connect: () => null,
      portPost: () => false,
      portDisconnect: () => undefined,
      call: () => Promise.reject(NOT_AVAILABLE),
      http: () => Promise.reject(NOT_AVAILABLE),
      httpAbort: () => undefined,
      getViews: () => [],
      hasNativeHttp: () => false,
      setDispatcher: () => undefined,
      unregister: () => undefined,
    };
  }

  const role = ctxInfo.role;

  // ---------------------------------------------------------------------------
  // Helpers: events, lastError, callback-or-promise
  // ---------------------------------------------------------------------------

  let currentLastError = null;

  function makeEvent() {
    const listeners = [];
    return {
      addListener(fn) {
        if (typeof fn === "function" && !listeners.includes(fn)) listeners.push(fn);
      },
      removeListener(fn) {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      },
      hasListener(fn) {
        return listeners.includes(fn);
      },
      hasListeners() {
        return listeners.length > 0;
      },
      _listeners: listeners,
      _fire(...args) {
        for (const fn of listeners.slice()) {
          try {
            fn(...args);
          } catch (error) {
            console.error("Error in event handler:", error);
          }
        }
      },
    };
  }

  /** Runs a chrome callback with runtime.lastError set (Chrome semantics). */
  function invokeCallback(callback, args, errorMessage) {
    currentLastError = errorMessage ? { message: String(errorMessage) } : null;
    try {
      callback(...args);
    } catch (error) {
      console.error("Error in chrome API callback:", error);
    } finally {
      currentLastError = null;
    }
  }

  /** Chrome APIs: callback when the last argument is a function, else a Promise. */
  function settle(promise, callback) {
    if (typeof callback === "function") {
      promise.then(
        (value) => invokeCallback(callback, value === undefined ? [] : [value], null),
        (error) => invokeCallback(callback, [], error && error.message ? error.message : String(error)),
      );
      return undefined;
    }
    return promise;
  }

  function splitCallback(args) {
    const list = Array.from(args);
    const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
    while (list.length && list[list.length - 1] === undefined) list.pop();
    return { list, callback };
  }

  function apiCall(method, args) {
    return new Promise((resolve, reject) => {
      let argsJson;
      try {
        argsJson = JSON.stringify(args);
      } catch (error) {
        reject(error);
        return;
      }
      transport.call(method, argsJson).then(
        (json) => resolve(json === undefined || json === null ? undefined : JSON.parse(json)),
        (error) => reject(new Error(error && error.message ? error.message : String(error))),
      );
    });
  }

  /** Builds `fn(...args, callback?)` that calls shell API `method`. */
  function apiFn(method, transform) {
    return function () {
      const { list, callback } = splitCallback(arguments);
      const promise = apiCall(method, list);
      return settle(transform ? promise.then(transform) : promise, callback);
    };
  }

  // ---------------------------------------------------------------------------
  // runtime
  // ---------------------------------------------------------------------------

  const eventsByName = Object.create(null);
  function namedEvent(name) {
    const event = makeEvent();
    eventsByName[name] = event;
    return event;
  }

  const onMessage = namedEvent("runtime.onMessage");
  const onConnect = namedEvent("runtime.onConnect");
  const localPorts = new Map();

  function getURL(path) {
    return ORIGIN + "/" + String(path === undefined ? "" : path).replace(/^\/+/, "");
  }

  function sendMessage() {
    const { list, callback } = splitCallback(arguments);
    let extensionId;
    let message;
    if (list.length >= 3) [extensionId, message] = list;
    else if (list.length === 2 && (typeof list[0] === "string" || list[0] === null) && typeof list[1] !== "undefined" && (typeof list[1] !== "object" || list[1] === null || !("includeTlsChannelId" in list[1]))) {
      [extensionId, message] = list;
    } else message = list[0];

    const promise = new Promise((resolve, reject) => {
      if (extensionId && extensionId !== ctxInfo.extensionId) {
        reject(new Error("Could not establish connection. Receiving end does not exist."));
        return;
      }
      let json;
      try {
        json = JSON.stringify(message === undefined ? null : message);
      } catch (error) {
        reject(new Error("Error in invocation of runtime.sendMessage: " + error.message));
        return;
      }
      transport.sendMessage(json, (responseJson, error) => {
        if (error) reject(new Error(error));
        else resolve(responseJson === undefined ? undefined : JSON.parse(responseJson));
      });
    });

    if (typeof callback === "function") {
      promise.then(
        (response) => invokeCallback(callback, [response], null),
        (error) => invokeCallback(callback, [undefined], error.message),
      );
      return undefined;
    }
    // Promise form: "no listener responded" resolves undefined (MV3 Chrome);
    // "no receiver at all" rejects.
    return promise.catch((error) => {
      if (/message port closed/i.test(error.message)) return undefined;
      throw error;
    });
  }

  function makePort(portId, name, sender) {
    let disconnected = portId === null;
    const port = {
      name,
      sender,
      onMessage: makeEvent(),
      onDisconnect: makeEvent(),
      postMessage(message) {
        if (disconnected) throw new Error("Attempting to use a disconnected port object");
        transport.portPost(portId, JSON.stringify(message === undefined ? null : message));
      },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        localPorts.delete(portId);
        transport.portDisconnect(portId);
      },
      _remoteDisconnect(errorMessage) {
        if (disconnected) return;
        disconnected = true;
        localPorts.delete(portId);
        currentLastError = errorMessage ? { message: errorMessage } : null;
        try {
          port.onDisconnect._fire(port);
        } finally {
          currentLastError = null;
        }
      },
    };
    if (portId !== null) localPorts.set(portId, port);
    return port;
  }

  function connect() {
    const list = Array.from(arguments);
    const connectInfo = typeof list[0] === "object" && list[0] !== null ? list[0] : list[1] || {};
    const portId = transport.connect(connectInfo.name || "");
    const port = makePort(portId, connectInfo.name || "", undefined);
    if (portId === null) setTimeout(() => {
      currentLastError = { message: NOT_AVAILABLE };
      try {
        port.onDisconnect._fire(port);
      } finally {
        currentLastError = null;
      }
    }, 0);
    return port;
  }

  const ContextType = {
    TAB: "TAB",
    POPUP: "POPUP",
    BACKGROUND: "BACKGROUND",
    OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT",
    SIDE_PANEL: "SIDE_PANEL",
    DEVELOPER_TOOLS: "DEVELOPER_TOOLS",
  };

  const runtime = {
    id: ctxInfo.extensionId,
    getURL,
    getManifest: () => (ctxInfo.manifest ? JSON.parse(JSON.stringify(ctxInfo.manifest)) : null),
    sendMessage,
    connect,
    onMessage,
    onConnect,
    onInstalled: namedEvent("runtime.onInstalled"),
    onStartup: namedEvent("runtime.onStartup"),
    onSuspend: namedEvent("runtime.onSuspend"),
    onUpdateAvailable: namedEvent("runtime.onUpdateAvailable"),
    onMessageExternal: makeEvent(),
    onConnectExternal: makeEvent(),
    getContexts: apiFn("runtime.getContexts"),
    getPlatformInfo: apiFn("runtime.getPlatformInfo"),
    reload: () => void apiCall("runtime.reload", []),
    openOptionsPage: apiFn("runtime.openOptionsPage"),
    setUninstallURL: apiFn("runtime.setUninstallURL"),
    requestUpdateCheck: (cb) => settle(Promise.resolve({ status: "no_update" }), cb),
    ContextType,
    OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
    PlatformOs: { ANDROID: "android" },
  };
  Object.defineProperty(runtime, "lastError", {
    enumerable: true,
    get: () => (currentLastError ? { message: currentLastError.message } : undefined),
  });

  // ---------------------------------------------------------------------------
  // storage
  // ---------------------------------------------------------------------------

  const storageOnChanged = namedEvent("storage.onChanged");
  const areaEvents = {};

  function makeArea(area) {
    const onChanged = makeEvent();
    areaEvents[area] = onChanged;
    const withKeys = (method) =>
      function (keys, callback) {
        if (typeof keys === "function") {
          callback = keys;
          keys = null;
        }
        return settle(apiCall(method, [area, keys === undefined ? null : keys]), callback);
      };
    return {
      get: withKeys("storage.get"),
      getBytesInUse: withKeys("storage.getBytesInUse"),
      set(items, callback) {
        return settle(apiCall("storage.set", [area, items]), callback);
      },
      remove(keys, callback) {
        return settle(apiCall("storage.remove", [area, keys]), callback);
      },
      clear(callback) {
        return settle(apiCall("storage.clear", [area]), callback);
      },
      getKeys(callback) {
        return settle(apiCall("storage.getKeys", [area]), callback);
      },
      setAccessLevel(options, callback) {
        return settle(Promise.resolve(), callback);
      },
      onChanged,
      QUOTA_BYTES: area === "sync" ? 102400 : 10485760,
    };
  }

  const storage = {
    local: makeArea("local"),
    sync: makeArea("sync"),
    session: makeArea("session"),
    onChanged: storageOnChanged,
    AccessLevel: { TRUSTED_CONTEXTS: "TRUSTED_CONTEXTS", TRUSTED_AND_UNTRUSTED_CONTEXTS: "TRUSTED_AND_UNTRUSTED_CONTEXTS" },
  };

  // ---------------------------------------------------------------------------
  // tabs / windows / alarms / notifications / action / offscreen / dnr
  // ---------------------------------------------------------------------------

  const tabs = {
    TAB_ID_NONE: -1,
    query: apiFn("tabs.query"),
    get: apiFn("tabs.get"),
    getCurrent: apiFn("tabs.getCurrent"),
    create: apiFn("tabs.create"),
    update: apiFn("tabs.update"),
    remove: apiFn("tabs.remove"),
    reload: apiFn("tabs.reload"),
    sendMessage: apiFn("tabs.sendMessage"),
    onCreated: namedEvent("tabs.onCreated"),
    onUpdated: namedEvent("tabs.onUpdated"),
    onRemoved: namedEvent("tabs.onRemoved"),
    onActivated: namedEvent("tabs.onActivated"),
    onReplaced: namedEvent("tabs.onReplaced"),
  };

  const windows = {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: apiFn("windows.get"),
    getCurrent: apiFn("windows.getCurrent"),
    getLastFocused: apiFn("windows.getLastFocused"),
    getAll: apiFn("windows.getAll"),
    create: apiFn("windows.create"),
    update: apiFn("windows.update"),
    remove: apiFn("windows.remove"),
    onCreated: namedEvent("windows.onCreated"),
    onRemoved: namedEvent("windows.onRemoved"),
    onFocusChanged: namedEvent("windows.onFocusChanged"),
  };

  const alarms = {
    create: apiFn("alarms.create"),
    get: apiFn("alarms.get"),
    getAll: apiFn("alarms.getAll"),
    clear: apiFn("alarms.clear"),
    clearAll: apiFn("alarms.clearAll"),
    onAlarm: namedEvent("alarms.onAlarm"),
  };

  const notifications = {
    create: apiFn("notifications.create"),
    update: apiFn("notifications.update"),
    clear: apiFn("notifications.clear"),
    getAll: apiFn("notifications.getAll"),
    getPermissionLevel: apiFn("notifications.getPermissionLevel"),
    onClicked: namedEvent("notifications.onClicked"),
    onClosed: namedEvent("notifications.onClosed"),
    onButtonClicked: namedEvent("notifications.onButtonClicked"),
    TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
  };

  const action = {
    setBadgeText: apiFn("action.setBadgeText"),
    getBadgeText: apiFn("action.getBadgeText"),
    setBadgeBackgroundColor: apiFn("action.setBadgeBackgroundColor"),
    getBadgeBackgroundColor: apiFn("action.getBadgeBackgroundColor"),
    setBadgeTextColor: apiFn("action.setBadgeTextColor"),
    setTitle: apiFn("action.setTitle"),
    getTitle: apiFn("action.getTitle"),
    setIcon: apiFn("action.setIcon"),
    setPopup: apiFn("action.setPopup"),
    getPopup: apiFn("action.getPopup"),
    enable: apiFn("action.enable"),
    disable: apiFn("action.disable"),
    openPopup: apiFn("action.openPopup"),
    onClicked: namedEvent("action.onClicked"),
  };

  const offscreen = {
    createDocument: apiFn("offscreen.createDocument"),
    closeDocument: apiFn("offscreen.closeDocument"),
    hasDocument: apiFn("offscreen.hasDocument"),
    Reason: {
      TESTING: "TESTING",
      AUDIO_PLAYBACK: "AUDIO_PLAYBACK",
      IFRAME_SCRIPTING: "IFRAME_SCRIPTING",
      DOM_SCRAPING: "DOM_SCRAPING",
      BLOBS: "BLOBS",
      DOM_PARSER: "DOM_PARSER",
      USER_MEDIA: "USER_MEDIA",
      DISPLAY_MEDIA: "DISPLAY_MEDIA",
      WEB_RTC: "WEB_RTC",
      CLIPBOARD: "CLIPBOARD",
      LOCAL_STORAGE: "LOCAL_STORAGE",
      WORKERS: "WORKERS",
      BATTERY_STATUS: "BATTERY_STATUS",
      MATCH_MEDIA: "MATCH_MEDIA",
      GEOLOCATION: "GEOLOCATION",
    },
  };

  // The Android WebView has no request interception for extension rules; ENS
  // gateway rules are recorded but have no effect.
  const declarativeNetRequest = {
    updateDynamicRules: apiFn("dnr.updateDynamicRules"),
    getDynamicRules: apiFn("dnr.getDynamicRules"),
    updateSessionRules: apiFn("dnr.updateSessionRules"),
    getSessionRules: apiFn("dnr.getSessionRules"),
    RuleActionType: {
      BLOCK: "block",
      REDIRECT: "redirect",
      ALLOW: "allow",
      UPGRADE_SCHEME: "upgradeScheme",
      MODIFY_HEADERS: "modifyHeaders",
      ALLOW_ALL_REQUESTS: "allowAllRequests",
    },
    ResourceType: {
      MAIN_FRAME: "main_frame",
      SUB_FRAME: "sub_frame",
      STYLESHEET: "stylesheet",
      SCRIPT: "script",
      IMAGE: "image",
      FONT: "font",
      OBJECT: "object",
      XMLHTTPREQUEST: "xmlhttprequest",
      PING: "ping",
      CSP_REPORT: "csp_report",
      MEDIA: "media",
      WEBSOCKET: "websocket",
      WEBTRANSPORT: "webtransport",
      WEBBUNDLE: "webbundle",
      OTHER: "other",
    },
  };

  const extension = {
    inIncognitoContext: false,
    getViews(filter) {
      return transport.getViews(JSON.stringify(filter || {}));
    },
    getBackgroundPage: () => null,
  };

  const i18n = {
    getMessage: () => "",
    getUILanguage: () => navigator.language || "en",
    getAcceptLanguages: (cb) => settle(Promise.resolve([navigator.language || "en"]), cb),
  };

  const chromeApi = {
    runtime,
    storage,
    tabs,
    windows,
    alarms,
    notifications,
    action,
    offscreen,
    declarativeNetRequest,
    extension,
    i18n,
  };

  try {
    Object.defineProperty(window, "chrome", { value: chromeApi, configurable: true, writable: true, enumerable: true });
  } catch {
    window.chrome = chromeApi;
  }

  // ---------------------------------------------------------------------------
  // Dispatcher: the shell calls into this frame through these functions
  // ---------------------------------------------------------------------------

  transport.setDispatcher({
    /** Returns { listeners, keepOpen } like Chrome's onMessage bookkeeping. */
    onMessage(messageJson, senderJson, respond) {
      const listeners = onMessage._listeners.slice();
      if (listeners.length === 0) return { listeners: 0, keepOpen: false };
      const message = JSON.parse(messageJson);
      const sender = JSON.parse(senderJson);
      let responded = false;
      let keepOpen = false;
      const sendResponse = (response) => {
        if (responded) return;
        responded = true;
        let json;
        try {
          json = response === undefined ? undefined : JSON.stringify(response);
        } catch (error) {
          console.error("sendResponse: response is not serializable", error);
          json = undefined;
        }
        respond(json);
      };
      for (const listener of listeners) {
        try {
          const result = listener(message, sender, sendResponse);
          // `return true` (or a Promise, which Chrome treats as truthy)
          // keeps the channel open for an asynchronous sendResponse.
          if (result === true || (result && typeof result.then === "function")) keepOpen = true;
        } catch (error) {
          console.error("Error in runtime.onMessage listener:", error);
        }
      }
      return { listeners: listeners.length, keepOpen: keepOpen && !responded };
    },
    onConnect(infoJson) {
      if (!onConnect.hasListeners()) return false;
      const info = JSON.parse(infoJson);
      const port = makePort(info.portId, info.name, info.sender);
      onConnect._fire(port);
      return true;
    },
    onPortMessage(portId, messageJson) {
      const port = localPorts.get(portId);
      if (port) port.onMessage._fire(JSON.parse(messageJson), port);
    },
    onPortDisconnect(portId, errorMessage) {
      const port = localPorts.get(portId);
      if (port) port._remoteDisconnect(errorMessage || null);
    },
    onStorageChanged(changesJson, area) {
      const changes = JSON.parse(changesJson);
      storageOnChanged._fire(changes, area);
      if (areaEvents[area]) areaEvents[area]._fire(changes);
    },
    onEvent(name, argsJson) {
      const event = eventsByName[name];
      if (event && event.hasListeners()) event._fire(...JSON.parse(argsJson));
    },
  });

  window.addEventListener("pagehide", () => transport.unregister());

  if (role === "orphan") return;

  // ---------------------------------------------------------------------------
  // Cross-origin fetch through the native HTTP bridge
  // ---------------------------------------------------------------------------
  //
  // Extension pages have host_permissions, so Chrome performs cross-origin
  // requests without CORS. A WebView page cannot, so cross-origin requests
  // are executed natively when the bridge exists. (The bundles do not use
  // XMLHttpRequest; WebSockets are not subject to CORS.)

  const originalFetch = window.fetch.bind(window);
  const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
  let nextHttpKey = 1;

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function abortError(signal) {
    return signal && signal.reason !== undefined ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
  }

  async function nativeFetch(request) {
    const signal = request.signal;
    if (signal && signal.aborted) throw abortError(signal);
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const payload = {
      method,
      url: request.url,
      headers,
      bodyBase64: body && body.byteLength ? bytesToBase64(body) : null,
      // Native follows nothing for "error"/"manual"; the 3xx is handled below.
      redirect: request.redirect === "follow" ? "follow" : "manual",
    };

    const clientKey = "k" + nextHttpKey++;
    const replyJson = await new Promise((resolve, reject) => {
      const onAbort = () => {
        transport.httpAbort(clientKey);
        reject(abortError(signal));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      transport.http(JSON.stringify(payload), clientKey).then(
        (json) => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(json);
        },
        (error) => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(new TypeError("Failed to fetch" + (error ? " (" + String(error) + ")" : "")));
        },
      );
    });
    const reply = JSON.parse(replyJson);
    if (reply.error || !reply.status) throw new TypeError("Failed to fetch" + (reply.error ? " (" + reply.error + ")" : ""));
    const isRedirect = reply.status >= 300 && reply.status < 400;
    if (isRedirect && request.redirect === "error") throw new TypeError("Failed to fetch (redirect not allowed)");

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(reply.headers || {})) {
      try {
        responseHeaders.append(key, String(value));
      } catch {
        /* skip invalid header names */
      }
    }
    const responseBody =
      NULL_BODY_STATUS.has(reply.status) || method === "HEAD" || !reply.bodyBase64 ? null : base64ToBytes(reply.bodyBase64);
    const response = new Response(responseBody, {
      status: reply.status,
      statusText: String(reply.statusText || "").replace(/[^\t\x20-\x7e\x80-\xff]/g, ""),
      headers: responseHeaders,
    });
    const finalUrl = reply.url || request.url;
    Object.defineProperty(response, "url", { value: finalUrl });
    Object.defineProperty(response, "redirected", { value: reply.redirected ?? finalUrl !== request.url });
    return response;
  }

  window.fetch = function fetch(input, init) {
    let request;
    try {
      request = new Request(input, init);
    } catch (error) {
      return Promise.reject(error);
    }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return originalFetch(request);
    }
    const crossOrigin = (url.protocol === "https:" || url.protocol === "http:") && url.origin !== ORIGIN;
    if (!crossOrigin || !transport.hasNativeHttp()) return originalFetch(request);
    return nativeFetch(request);
  };

  // ---------------------------------------------------------------------------
  // window.open / window.close / links
  // ---------------------------------------------------------------------------

  function openUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch {
      return;
    }
    if (url.origin === ORIGIN) {
      void apiCall("tabs.create", [{ url: url.href }]).catch(() => undefined);
    } else {
      void apiCall("shell.openUrl", [url.href]).catch(() => undefined);
    }
  }

  window.open = function open(url) {
    if (url) openUrl(url);
    return null;
  };

  if (role === "overlay" || role === "ui" || role === "offscreen") {
    window.close = function close() {
      void apiCall("shell.closeSelf", []).catch(() => undefined);
    };
  }

  // Links that would leave the wallet document: route them like window.open.
  // Runs in the bubble phase on window so the app's own handlers win.
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    let url;
    try {
      url = new URL(anchor.href, location.href);
    } catch {
      return;
    }
    if (url.protocol === "javascript:") return;
    const sameOrigin = url.origin === ORIGIN;
    const newContext = anchor.target && anchor.target !== "_self";
    if (sameOrigin && !newContext) return; // in-document navigation
    if (anchor.hasAttribute("download") && sameOrigin) return;
    event.preventDefault();
    openUrl(url.href);
  });

  // ---------------------------------------------------------------------------
  // Phone layout: the popup UI hardcodes a 360x600 canvas; fill the screen.
  // ---------------------------------------------------------------------------

  if (role === "ui" || role === "overlay") {
    const style = document.createElement("style");
    style.id = "walletchan-android-layout";
    let css = "html{width:100% !important;min-width:0 !important;-webkit-tap-highlight-color:transparent;}";
    if (/^\/(index|popup-init)\.html$/.test(PATH)) {
      css += "html{height:100% !important;}html,body{overscroll-behavior:none;}";
    }
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
})();
