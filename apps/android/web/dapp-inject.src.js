/*
 * WalletChan Android dApp bridge (template).
 *
 * scripts/package-web.mjs turns this file into web/dapp-inject.js (and
 * www/android/dapp-inject.js) by splicing in the extension build's content
 * script (static/js/inject.js) and in-page provider (static/js/inpage.js).
 * The native dApp browser injects the result at document start into every
 * page (WebViewCompat.addDocumentStartJavaScript).
 *
 * Android WebView has no isolated world, so the content script and the
 * provider both run in the page's main world:
 *   - the content script gets a private `chrome` object (a function
 *     parameter, never a page global) that talks to the wallet through the
 *     native `WalletChanDapp` bridge;
 *   - the content script normally injects inpage.js with a <script src>
 *     tag; here that tag is intercepted and the bundled provider is run
 *     inline exactly once, synchronously at document start. As in Chrome,
 *     `window.ethereum` / EIP-6963 announcements appear once the content
 *     script's init handshake with the wallet completes.
 *
 * Wire protocol (see ARCHITECTURE.md):
 *   page -> native  WalletChanDapp.postMessage(JSON.stringify({requestId, message}))
 *   native -> page  {kind:"response", requestId, response, error?}
 *                   {kind:"event", message, eventId?}       chrome.tabs.sendMessage
 *                   {kind:"storageChanged", area, changes}  filtered storage.onChanged
 *   Storage reads and event replies are carried as special `message` shapes
 *   ({__walletchanStorage:{…}} / {__walletchanEventReply:id,…}) that the
 *   wallet shell handles itself; native forwards them like any other message.
 */
(function () {
  "use strict";

  var __wcAssetOrigin = "https://appassets.androidplatform.net";
  if (location.origin === __wcAssetOrigin) return; // the wallet itself
  if (window.top !== window) return; // main frame only (bridge is main-frame only)
  if (window.__walletchanDappInjected) return;
  try {
    Object.defineProperty(window, "__walletchanDappInjected", { value: true });
  } catch (__wcError) {
    window.__walletchanDappInjected = true;
  }

  var __wcBridge = window.WalletChanDapp;
  if (!__wcBridge || typeof __wcBridge.postMessage !== "function") return;
  // Hide the bridge object from page scripts (best effort: page JS that runs
  // later cannot pick it up; the wallet still treats every dApp message as
  // untrusted and the origin is attached natively).
  try {
    delete window.WalletChanDapp;
  } catch (__wcError) {
    /* not configurable */
  }

  // -------------------------------------------------------------------------
  // Minimal content-script chrome.* (runtime messaging + whitelisted storage)
  // -------------------------------------------------------------------------

  function __wcMakeChrome() {
    var pending = new Map();
    var nextRequestId = 1;
    var lastError = null;

    function makeEvent() {
      var listeners = [];
      return {
        addListener: function (fn) {
          if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
        },
        removeListener: function (fn) {
          var index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        },
        hasListener: function (fn) {
          return listeners.indexOf(fn) >= 0;
        },
        hasListeners: function () {
          return listeners.length > 0;
        },
        _listeners: listeners,
      };
    }

    function post(message) {
      return new Promise(function (resolve, reject) {
        var requestId = "r" + nextRequestId++;
        var json;
        try {
          json = JSON.stringify({ requestId: requestId, message: message === undefined ? null : message });
        } catch (error) {
          reject(error);
          return;
        }
        pending.set(requestId, { resolve: resolve, reject: reject });
        try {
          __wcBridge.postMessage(json);
        } catch (error) {
          pending.delete(requestId);
          reject(new Error("Extension context invalidated."));
        }
      });
    }

    function withLastError(callback, args, message) {
      lastError = message ? { message: message } : null;
      try {
        callback.apply(null, args);
      } catch (error) {
        console.error(error);
      } finally {
        lastError = null;
      }
    }

    function settle(promise, callback) {
      if (typeof callback !== "function") return promise;
      promise.then(
        function (value) {
          withLastError(callback, value === undefined ? [] : [value], null);
        },
        function (error) {
          withLastError(callback, [], error && error.message ? error.message : String(error));
        },
      );
      return undefined;
    }

    var onMessage = makeEvent();
    var onStorageChanged = makeEvent();

    function storageCall(area, op, extra) {
      var request = { area: area, op: op };
      for (var key in extra) request[key] = extra[key];
      return post({ __walletchanStorage: request });
    }

    function makeArea(area) {
      return {
        get: function (keys, callback) {
          if (typeof keys === "function") {
            callback = keys;
            keys = null;
          }
          return settle(
            storageCall(area, "get", { keys: keys === undefined ? null : keys }).then(function (value) {
              return value || {};
            }),
            callback,
          );
        },
        set: function (items, callback) {
          return settle(storageCall(area, "set", { items: items }), callback);
        },
        remove: function (keys, callback) {
          return settle(storageCall(area, "remove", { keys: keys }), callback);
        },
        onChanged: makeEvent(),
      };
    }

    var runtime = {
      id: "kpmiabaddjcfeoihmplfgbbcnmcpeobg",
      getURL: function (path) {
        return __wcAssetOrigin + "/" + String(path === undefined ? "" : path).replace(/^\/+/, "");
      },
      sendMessage: function () {
        var args = Array.prototype.slice.call(arguments);
        var callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
        var message = args.length >= 2 && typeof args[0] === "string" ? args[1] : args[0];
        var promise = post(message);
        if (typeof callback === "function") {
          promise.then(
            function (response) {
              withLastError(callback, [response], null);
            },
            function (error) {
              withLastError(callback, [undefined], error.message);
            },
          );
          return undefined;
        }
        return promise.catch(function (error) {
          if (/message port closed/i.test(error.message)) return undefined;
          throw error;
        });
      },
      onMessage: onMessage,
      connect: function () {
        throw new Error("runtime.connect is not available in the Android dApp browser");
      },
    };
    Object.defineProperty(runtime, "lastError", {
      enumerable: true,
      get: function () {
        return lastError ? { message: lastError.message } : undefined;
      },
    });

    var storage = {
      local: makeArea("local"),
      sync: makeArea("sync"),
      onChanged: onStorageChanged,
    };

    function fire(listeners, args) {
      listeners.slice().forEach(function (fn) {
        try {
          fn.apply(null, args);
        } catch (error) {
          console.error("Error in WalletChan content-script listener:", error);
        }
      });
    }

    /** Native -> page messages. */
    function onBridgeMessage(event) {
      var payload;
      try {
        payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch (error) {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      if (payload.kind === "response") {
        var entry = pending.get(payload.requestId);
        if (!entry) return;
        pending.delete(payload.requestId);
        if (payload.error) entry.reject(new Error(payload.error));
        else entry.resolve(payload.response);
      } else if (payload.kind === "storageChanged") {
        fire(onStorageChanged._listeners, [payload.changes, payload.area]);
        if (storage[payload.area]) fire(storage[payload.area].onChanged._listeners, [payload.changes]);
      } else if (payload.kind === "event") {
        var eventId = payload.eventId;
        var responded = false;
        var keepOpen = false;
        var sendResponse = function (response) {
          if (responded || !eventId) return;
          responded = true;
          post({ __walletchanEventReply: eventId, response: response }).catch(function () {});
        };
        var sender = { id: runtime.id, origin: __wcAssetOrigin, url: __wcAssetOrigin + "/" };
        onMessage._listeners.slice().forEach(function (fn) {
          try {
            var result = fn(payload.message, sender, sendResponse);
            if (result === true || (result && typeof result.then === "function")) keepOpen = true;
          } catch (error) {
            console.error("Error in WalletChan runtime.onMessage listener:", error);
          }
        });
        if (eventId && !responded && !keepOpen) {
          responded = true;
          post({ __walletchanEventReply: eventId, noResponse: true }).catch(function () {});
        }
      }
    }

    if (typeof __wcBridge.addEventListener === "function") {
      __wcBridge.addEventListener("message", onBridgeMessage);
    } else {
      __wcBridge.onmessage = onBridgeMessage;
    }

    // Register this page's reply channel with native right away (a message
    // without a `message` key is not forwarded), so wallet events such as
    // chrome.tabs.sendMessage can reach the page before it sends anything.
    try {
      __wcBridge.postMessage(JSON.stringify({ ready: true }));
    } catch (error) {
      /* bridge gone */
    }

    return { runtime: runtime, storage: storage };
  }

  var __wcContentChrome = __wcMakeChrome();
  var __wcInpageUrl = __wcContentChrome.runtime.getURL("/static/js/inpage.js");
  var __wcInpageRan = false;

  /** The extension's in-page provider, run in the page world exactly once. */
  function __wcRunInpage() {
    if (__wcInpageRan) return;
    __wcInpageRan = true;
    try {
      (function () {
        /*__WALLETCHAN_INPAGE__*/
      }).call(window);
    } catch (error) {
      console.error("[WalletChan] in-page provider failed", error);
    }
  }

  /** The extension's content script with its own private `chrome`. */
  function __wcRunContentScript(chrome) {
    /*__WALLETCHAN_CONTENT_SCRIPT__*/
  }

  // The content script injects the provider with
  //   (document.head ?? document.documentElement).prepend(<script src=inpage.js>)
  // while it runs synchronously. Swap in a stand-in `document.head` for that
  // moment so the tag is never inserted (no second copy, works even before
  // <html> exists), run the bundled provider instead and fire the tag's
  // onload so the content script continues with its normal init handshake.
  var __wcFakeHead = {
    prepend: function () {
      var nodes = Array.prototype.slice.call(arguments);
      nodes.forEach(function (node) {
        if (node && node.tagName === "SCRIPT" && node.src === __wcInpageUrl) {
          __wcRunInpage();
          setTimeout(function () {
            if (typeof node.onload === "function") node.onload.call(node, new Event("load"));
          }, 0);
          return;
        }
        var parent = document.head || document.documentElement;
        if (parent) parent.prepend(node);
      });
    },
  };

  function __wcStartContentScript() {
    var headOverridden = false;
    try {
      Object.defineProperty(document, "head", {
        configurable: true,
        get: function () {
          return __wcFakeHead;
        },
      });
      headOverridden = true;
    } catch (error) {
      /* fall back to the provider having been run directly */
    }
    try {
      __wcRunContentScript(__wcContentChrome);
    } catch (error) {
      console.error("[WalletChan] content script failed", error);
    } finally {
      if (headOverridden) delete document.head;
    }
  }

  // The provider's listeners go in immediately; window.ethereum itself is
  // announced after the content script's init handshake (as in Chrome).
  __wcRunInpage();

  // Chrome runs document_start content scripts once <html> exists; parts of
  // the content script observe document.documentElement. A document-start
  // script can run earlier than that, so wait for the root element. The
  // observer fires in the microtask checkpoint the parser performs before
  // executing the page's first script.
  if (document.documentElement) {
    __wcStartContentScript();
  } else {
    var __wcRootObserver = new MutationObserver(function () {
      if (!document.documentElement) return;
      __wcRootObserver.disconnect();
      __wcStartContentScript();
    });
    __wcRootObserver.observe(document, { childList: true });
  }
})();
