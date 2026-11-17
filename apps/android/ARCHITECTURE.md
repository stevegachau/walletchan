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
- `chrome.sidePanel` is provided and side-panel mode is the default (the shell
  sets `sync.sidePanelMode = true` once, meta flag `androidPanelModeDefaulted`).
  The full-screen wallet UI is the side panel (`getContexts` → `SIDE_PANEL`, it
  answers `ping`), so approvals appear inline in the already-running UI
  (~0.4 s) instead of booting a popup per request (~3 s desktop, far slower on
  a phone). The shell watches `newPending…Request` broadcasts: it sends
  `showWallet` + `requestAttention`, and when the UI is back on its home screen
  it returns to the caller (`showDapp` for the in-app dApp browser,
  `backUnhandled` for an app that deep-linked us). If the user switches to popup
  mode in settings, approvals open as overlay windows with the same return
  behaviour. Window 1 is the phone "browser window" holding the dApp tab (or a
  synthetic New Tab, id 1).
- WalletConnect pairing needs no unlock (public addresses only); signing
  requests ask for the password in the wallet UI.

## Native bridge (main WebView)  — name: `WalletChanNative`

Installed with `WebViewCompat.addWebMessageListener(webView, "WalletChanNative",
setOf("https://appassets.androidplatform.net"), listener)`, so only our origin's
frames get it. All messages are JSON **strings**.

JS → native (`WalletChanNative.postMessage(JSON.stringify(msg))`):

| msg | meaning |
|---|---|
| `{cmd:"hello"}` | sent by shell top frame on boot. Native stores this frame's `replyProxy` as the shell channel (only if `isMainFrame`). Native replies `{type:"hello", sdkInt, appVersion, freshProcess, session}` (see "Process-lifetime session storage"). |
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
| `{cmd:"sessionStore", op:"set", items:{key: jsonString}}` | mirror `chrome.storage.session` writes into native process memory. Shell main frame only. All-or-nothing: rejected (nothing applied) if any value is not a string or the store would exceed the cap. No reply. |
| `{cmd:"sessionStore", op:"remove", keys:[key…]}` | remove keys from the native mirror (rejected if any key is not a string). Shell main frame only. No reply. |
| `{cmd:"sessionStore", op:"clear"}` | empty the native mirror. Shell main frame only. No reply. |
| `{cmd:"wcSessions", count:int}` | number of connected WalletConnect apps. `count>0` → start/update the keep-alive foreground service; `0` → stop it. Send whenever the count changes (and after boot). Clamped to 0..999. |
| `{cmd:"requestAttention", title, message}` | a dApp request is waiting. If MainActivity is not resumed now **and** still not resumed 700 ms later, native posts a heads-up notification (tap opens the app). Ignored while resumed. `title` defaults to "WalletChan" (≤200 chars), `message` ≤1000 chars. |

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
| `{type:"appResumed"}` | `MainActivity.onResume` (app back in front). Sent only if the shell is ready; never queued. |
| `{type:"appPaused"}` | `MainActivity.onPause` (user left the app, screen off, scanner/permission dialog on top). Sent only if the shell is ready; never queued. |

## Process-lifetime session storage

Chrome keeps `chrome.storage.session` across service-worker restarts and clears it
only when the browser process exits. The shell's in-memory copy dies whenever the
main WebView's renderer dies (Android kills it while the user is in another app),
and `onRenderProcessGone` → `recreateMainWebView()` reloads the shell; without a
copy the wallet loses its unlocked session. So:

- The shell mirrors every `storage.session` change to native with
  `sessionStore` (above). Native keeps it in a process-wide Kotlin `object`
  (`ProcessSessionStore`): memory only, never written to disk, never logged.
  Total size cap: 8 Mi UTF-16 code units (sum of key + value lengths); a `set`
  that would exceed it is rejected as a whole (logged without keys/values).
- The `hello` reply carries `session: {key: jsonString}` (snapshot of the
  native mirror) and `freshProcess: boolean` — `true` only for the first main-frame
  `hello` handled in this app process; `false` after a renderer-death recreation,
  a shell reload, or MainActivity being recreated in a live process. On
  `freshProcess:false` the shell restores `storage.session` from `session`
  (like a service-worker restart); on `true` there is nothing to restore (like a new
  browser process).
- Process death clears it (same as Chrome exiting).

## Background keep-alive (WalletConnect)

- While `wcSessions.count > 0`, native runs `WalletConnectService`, a
  foreground service (`foregroundServiceType="specialUse"`, subtype "Keeps the
  WalletConnect relay connection alive so dApp requests reach the wallet") whose
  only job is an ongoing, silent notification on the "Connection status" channel
  (IMPORTANCE_LOW): title "WalletChan", text "Connected to N app(s) via
  WalletConnect"; tapping brings the existing singleTask MainActivity forward
  (no recreation). This keeps the process — and the main WebView renderer, bound
  `RENDERER_PRIORITY_IMPORTANT` with `waivedWhenNotVisible=false` — out of the
  cached/frozen state so the relay websocket keeps delivering requests.
- Android 12+ refuses foreground-service starts from the background; native then
  remembers the desired count and retries on the next `onResume`. Count changes
  while the service runs only update the notification text. The service is
  stopped when the count drops to 0 and when MainActivity is destroyed (the
  WebView, and with it the relay, is gone). It is `START_NOT_STICKY`.
- Without POST_NOTIFICATIONS the service still runs (notification not shown).
  On Android 13+ native asks for the permission once when `wcSessions` reports
  a count > 0 while the app is in front (needed for `requestAttention`).
- `requestAttention` notifications use the "Requests" channel (IMPORTANCE_HIGH,
  heads-up). A newer request replaces the previous notification; it is cancelled
  in `onResume`.

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
- `onResume`/`onPause` never touch the WebViews; they only send
  `appResumed`/`appPaused`, cancel the attention notification and retry a
  deferred keep-alive start. The main WebView is (re)loaded only on create,
  after renderer death (`recreateMainWebView`, resets the shell channel) and if
  its top frame ever leaves the app origin; intents (`onNewIntent`) only deliver
  `deepLink`s.
- Back: if dApp visible → dApp history back, else close dApp browser; if wallet
  visible → send `{type:"back"}` to shell.
