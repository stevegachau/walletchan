# WalletChan for Android (sideloadable APK)

Goal: run the unmodified WalletChan MV3 extension build (`apps/extension/build`)
inside an Android app, with a JS polyfill for the `chrome.*` extension APIs and
a thin native Android host.

## Layout

```
apps/android/
  ARCHITECTURE.md          <- this contract
  web/                     <- JS runtime (owned by the "web runtime" agent)
    shell.html             <- top-level document loaded by the main WebView
    chrome-shim.js         <- chrome.* polyfill, loaded first in every wallet HTML page
    dapp-inject.js         <- (built output) shim + content script + inpage provider for dApp pages
    ...                    <- any sources/build scripts needed
  scripts/package-web.mjs  <- copies apps/extension/build -> app/src/main/assets/www,
                              injects <script src="/android/chrome-shim.js"> as the FIRST
                              element of <head> in every *.html, copies web/ files to www/android/
  app/                     <- Android Gradle module (owned by the "native" agent)
  build.gradle.kts, settings.gradle.kts, gradle.properties, gradlew ...
```

Assets layout inside the APK: `assets/www/**` = extension build + `www/android/**`.

## Origin

The main WebView serves `assets/www/` through `androidx.webkit.WebViewAssetLoader`
at `https://appassets.androidplatform.net/` (secure context; needed for WebCrypto).
JS must derive the extension root from `location.origin` (never hardcode), so the
same code can be tested at `http://localhost:<port>/` in desktop Chromium.

## Runtime model (main WebView)

- Main WebView loads `https://appassets.androidplatform.net/android/shell.html`.
- The **shell** (top frame) owns: storage (IndexedDB-backed chrome.storage.local/sync,
  in-memory session), the message bus, alarms, windows/tabs model, and the
  background "service worker", which runs in a hidden same-origin iframe
  (`background` role) loading `static/js/background.js` as a module.
- The wallet **UI** (`index.html`, `onboarding.html`, …) runs in a full-screen
  same-origin iframe. `chrome.windows.create` / `chrome.tabs.create` with an
  extension URL open an overlay iframe ("window") on top; removing it closes it.
  `chrome.offscreen.createDocument` creates another hidden iframe.
- Every frame's `chrome-shim.js` finds the shell via `window.top` and talks to it
  directly (same origin; payloads cross as JSON strings, matching Chrome's
  JSON-style message serialization), building the correct
  `chrome.runtime.MessageSender` (`url`, `origin`, `frameId: 0` for UI documents,
  `tab` only for dApp senders). Note `src/chrome/trustedWalletUiSender.ts` requires
  `sender.url` path `/index.html` or `/onboarding.html` and frameId 0/undefined.
- Extension hosts have `host_permissions` (no CORS). The shim therefore routes
  **cross-origin** `fetch` from wallet frames through the native `http` command
  when `WalletChanNative` exists; otherwise plain fetch (desktop testing).
- External URLs (`chrome.tabs.create` with http(s) url, `window.open`) go to the
  in-app dApp browser (`openDapp`); `openExternal` is for the system browser.
- `chrome.sidePanel` is deliberately absent, so the extension uses its
  Firefox-style popup path: approvals open as overlay windows (the shell sends
  `showWallet`, and `showDapp` when the overlay that the dApp triggered closes).
  The full-screen UI is classified as the side-panel surface (inline flows, its
  `window.close()` is a no-op); overlays are popup windows / tabs. Window 1 is
  the phone "browser window" holding the dApp tab (or a synthetic New Tab, id 1).

## Native bridge (main WebView)  — name: `WalletChanNative`

Installed with `WebViewCompat.addWebMessageListener(webView, "WalletChanNative",
setOf("https://appassets.androidplatform.net"), listener)`, so only our origin's
frames get it. All messages are JSON **strings**.

JS → native (`WalletChanNative.postMessage(JSON.stringify(msg))`):

| msg | meaning |
|---|---|
| `{cmd:"hello"}` | sent by shell top frame on boot. Native stores this frame's `replyProxy` as the shell channel (only if `isMainFrame`). Native replies `{type:"hello", sdkInt, appVersion}`. |
| `{cmd:"http", id, method, url, headers:{k:v}, bodyBase64:string\|null}` | native performs the request (no CORS), replies to the same proxy `{type:"http", id, ok, status, statusText, headers:{k:v}, bodyBase64, error?:string}` (`error` set on network failure, then status 0). |
| `{cmd:"openExternal", url}` | open in system browser (http/https/mailto only). |
| `{cmd:"openDapp", url?}` | show dApp browser; load `url` if given (else show with URL bar focused). |
| `{cmd:"showWallet"}` | bring main WebView to front (e.g. approval window opened). |
| `{cmd:"showDapp"}` | bring dApp browser back to front (if a dapp tab exists). |
| `{cmd:"toDapp", tabId, payload}` | deliver `payload` (any JSON) to the dApp page's bridge, if `tabId` matches current dapp tab. |
| `{cmd:"closeDapp", tabId}` | close the dApp browser tab. |
| `{cmd:"notify", id, title, message}` | post an Android notification. |
| `{cmd:"backUnhandled"}` | shell had nothing to go back to → native `moveTaskToBack(true)`. |
| `{cmd:"log", level, message}` | forward to logcat. |

Additive details implemented by native (all optional; older callers unaffected):
- `hello` reply also carries `appVersionCode` and `debug`. After every `hello`,
  native re-sends `dappVisible` and (if a dApp tab exists) its current `dappTab`,
  so a reloaded shell can resync.
- `http` request may carry `redirect: "follow"|"manual"|"error"` (default
  `follow`; `manual` returns the 3xx as-is, `error` fails) and `timeoutMs`
  (whole-call deadline). The reply also carries `url` (final URL after
  redirects) and `redirected`. Bodies are capped at 32 MiB (`error:"response too large"`).
  gzip is decoded natively (`content-encoding` is then absent from `headers`).
  Header names in the reply are lower-case; repeated headers are joined with ", ".
- `{cmd:"httpAbort", id}` cancels an in-flight `http` (reply then has `error:"aborted"`).
- `qrResult.error` may also be `"busy"` (a scan is already open) or
  `"no_camera"`, besides `"cancelled"` / `"permission_denied"`.

Native → shell (`shellReplyProxy.postMessage(JSON.stringify(msg))`, received via
`WalletChanNative.onmessage = (e) => JSON.parse(e.data)` in the shell top frame):

| msg | meaning |
|---|---|
| `{type:"hello", ...}` / `{type:"http", ...}` | replies above. |
| `{type:"back"}` | Android back pressed while wallet is visible. Shell closes overlay / navigates UI history; else replies `backUnhandled`. |
| `{type:"dappMessage", tabId, url, origin, title, requestId, message}` | a dApp content-script `chrome.runtime.sendMessage`. `origin`/`url` come from native (trusted), never from page JS. Shell dispatches to background `onMessage` with sender `{id, url, origin, frameId:0, tab:{id:tabId, url, title, active:true, windowId:1}}` and sends the response back with `toDapp {kind:"response", requestId, response}`. |
| `{type:"dappTab", tabId, url, title, status:"loading"\|"complete"}` | dApp tab created/navigated (feeds `chrome.tabs.onUpdated`, `tabs.query/get`). |
| `{type:"dappTabRemoved", tabId}` | dApp browser closed (feeds `chrome.tabs.onRemoved`). |
| `{type:"dappVisible", visible:boolean}` | which surface is in front. |
| `{type:"deepLink", url}` | app opened via `wc:` / `walletchan:` intent. |

## dApp browser (second WebView, same Activity)

- Native top bar: URL field, back, reload, "wallet" button (→ showWallet), close.
- Single tab at a time; each new session gets a new integer `tabId` (start at 1000).
- At document start in every page (main frame), native injects the text of
  `assets/www/android/dapp-inject.js` using
  `WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))`.
- Bridge object `WalletChanDapp` via `addWebMessageListener(dappWebView,
  "WalletChanDapp", setOf("*"), ...)`. Page → native:
  `{requestId, message}` → forwarded as `dappMessage` (only from main frame;
  `origin` = `sourceOrigin.toString()`, `url` = `webView.url`).
  Native → page: `replyProxy.postMessage(JSON.stringify(payload))` where payload is
  what shell passed in `toDapp` (`{kind:"response", requestId, response}` or
  `{kind:"event", message}` for `chrome.tabs.sendMessage`).
  Native keeps the reply proxy of the most recent main-frame message (a new
  page registers itself with its first message), so `toDapp` payloads sent
  before the current page has posted anything are dropped. A page message
  without a `message` key (e.g. `{ready:true}`) only registers the reply
  channel and is not forwarded. Native also drops messages whose
  `sourceOrigin` differs from the origin of `webView.url` (navigation races)
  or is not http(s).
- JS-level payload details (opaque to native, owned by `dapp-inject.js` and
  the shell): `dapp-inject.js` posts `{ready:true}` at startup to register the
  reply channel. `toDapp` payloads are `{kind:"response", requestId, response,
  error?}` (`error` = Chrome `lastError` text), `{kind:"event", message,
  eventId}` (the page answers with a normal `{requestId, message:
  {__walletchanEventReply: eventId, response | noResponse:true}}`), and
  `{kind:"storageChanged", area, changes}`. Content-script storage access is
  carried as `message: {__walletchanStorage: {area, op, …}}` and served by the
  shell from a fixed key allowlist (never the vault).
- dApp WebView must NOT use the asset loader domain for anything but
  `https://appassets.androidplatform.net/static/js/inpage.js` style resources
  (it may intercept that domain so `chrome.runtime.getURL` URLs resolve).

## WalletConnect (first-class on mobile — users log into apps with it)

The extension already implements WalletConnect (WalletKit in the background;
UI sends `{type:"walletConnectPair", uri}`; proposals/requests surface as
approval windows). Mobile additions:

- JS → native `{cmd:"scanQr"}`: native opens a camera QR scanner (CAMERA runtime
  permission; ZXing embedded, no Play Services dependency) and replies to the
  shell `{type:"qrResult", text}` or `{type:"qrResult", text:null, error}` on cancel.
- Shell exposes a floating "Scan" entry (next to the browser entry). On a
  `qrResult` or `deepLink` whose text is a `wc:` URI (also accept
  `walletchan://wc?uri=<encoded>` and `https://…/wc?uri=<encoded>` forms), the
  shell pairs it through the trusted wallet-UI path (sender must look like
  `/index.html`, frameId 0), brings the wallet to front (native `showWallet`),
  and shows progress/errors (e.g. navigate UI to the WalletConnect view or a toast).
- Native registers intent filters for scheme `wc` and `walletchan` (VIEW,
  BROWSABLE, DEFAULT) so a dApp in the phone's browser can hand off "Open in
  wallet"; deep links received before shell `hello` are queued.
- `wc:` links clicked inside the dApp browser are handled the same way (native
  converts to `deepLink`), never navigated.
- WalletConnect requests arrive while the app is open; the relay queues messages
  while it's backgrounded. Bringing the app to foreground must not reload the
  WebView.

## Android back / lifecycle

- Single `MainActivity`, `singleTask`, both WebViews in one FrameLayout so the
  background iframe stays alive. Do not call `pauseTimers()`.
- Back: if dApp visible → dApp history back, else close dApp browser; if wallet
  visible → send `{type:"back"}` to shell.
