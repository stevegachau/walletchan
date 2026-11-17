# WalletChan for Android (sideloadable APK)

A thin native Android host that runs the **unmodified WalletChan MV3 extension
build** (`apps/extension/build`) inside Android System WebView, plus a JS
polyfill for the `chrome.*` APIs. No Capacitor/Cordova. The binding contract
between the native host and the JS runtime is [`ARCHITECTURE.md`](./ARCHITECTURE.md).

- `app/` – native host (Kotlin): `MainActivity` with two WebViews in one
  FrameLayout: the **wallet** (serves `assets/www/` at
  `https://appassets.androidplatform.net/` and loads `/android/shell.html`) and
  an in-app **dApp browser** with a native URL bar that injects the wallet's
  provider into every page.
- `web/`, `scripts/package-web.mjs` – JS runtime and the packaging script that
  fills `app/src/main/assets/www/` (generated, gitignored).

## Prerequisites

- Node 20+ and pnpm (to build the extension and package the web runtime)
- JDK 17+ (21 tested)
- Android SDK with `platforms;android-35` and `build-tools;35.0.0`.
  Point Gradle at it with `ANDROID_HOME` or `apps/android/local.properties`
  (`sdk.dir=/path/to/android-sdk`).
- The Gradle wrapper (`./gradlew`, Gradle 8.14.3) downloads everything else
  (AGP 8.13, Kotlin 2.2).

## Build

```bash
# 1. Build the extension (repo root)
pnpm install
pnpm build:extension

# 2. Package it into the Android assets (apps/android)
cd apps/android
node scripts/package-web.mjs        # -> app/src/main/assets/www/

# 3. Build the APKs
./gradlew assembleRelease           # app/build/outputs/apk/release/app-release.apk
./gradlew assembleDebug             # app/build/outputs/apk/debug/app-debug.apk (id com.walletchan.android.debug)

# Checks
./gradlew testDebugUnitTest lint
```

`versionName`/`versionCode` are derived from `apps/extension/public/manifest.json`
(`4.2.0` → `40200`). Bump the extension version before shipping an update, or
Android will refuse to install it over the previous APK.

Debug builds enable `chrome://inspect` WebView debugging; release builds don't.
R8/minification is intentionally off (the wallet code is all in assets).

### Signing

`release` is signed with `keystore/walletchan-sideload.jks`, configured by
`keystore/keystore.properties`:

```properties
storeFile=walletchan-sideload.jks
storePassword=...
keyAlias=walletchan
keyPassword=...
```

Both files are **gitignored and must never be committed**. Back them up
somewhere safe: Android only installs an update if it's signed with the
same key, so losing the keystore means users must uninstall (losing local
wallet data) to move to a newly signed build. If the properties file is
missing, `assembleRelease` produces an **unsigned** APK and logs a warning.

To create a new keystore:

```bash
keytool -genkeypair -keystore keystore/walletchan-sideload.jks -storetype PKCS12 \
  -alias walletchan -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=WalletChan Android Sideload, O=WalletChan"
```

Verify a release: `$ANDROID_HOME/build-tools/35.0.0/apksigner verify --verbose app/build/outputs/apk/release/app-release.apk`
(v2 + v3 signatures; v1 isn't needed for minSdk 26).

## Install (sideload)

- **adb:** enable Developer options → USB debugging, then
  `adb install -r app/build/outputs/apk/release/app-release.apk`
  (`-r` keeps data when updating).
- **On the phone:** copy the APK over, open it, and when prompted allow
  "Install unknown apps" for the app you opened it with (Settings → Apps →
  Special app access → Install unknown apps). Play Protect may warn about an
  unknown developer; choose "Install anyway".

Requires Android 8.0 (API 26)+ and an up-to-date **Android System WebView**
(it needs `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT`; if missing, the
app shows a screen linking to the Play Store update).

## WalletConnect

Logging into apps with WalletConnect is a first-class flow:

- **Scan:** the wallet's "Scan" entry calls `{cmd:"scanQr"}`; native opens a
  full-screen, portrait ZXing scanner (embedded, no Google Play Services),
  asks for the CAMERA permission at that moment, and replies
  `{type:"qrResult", text}` or `{type:"qrResult", text:null, error}` with
  `error` = `cancelled` | `permission_denied` | `busy` | `no_camera`. The
  scanner is a separate activity; MainActivity and its WebViews are not
  recreated (result via the Activity Result API).
- **"Open in wallet" from other apps:** the app handles `wc:` and
  `walletchan:` links (VIEW/BROWSABLE/DEFAULT). Links are delivered to the
  shell as `{type:"deepLink", url}` from both cold start and `onNewIntent`,
  queued until the shell's `hello`. Relaunching from Recents does not replay
  an old link.
- **Inside the dApp browser:** `wc:` / `walletchan:` navigations become
  `deepLink`s instead of being loaded; other non-http schemes (`intent:`,
  `tg:`, `mailto:`, `market:` …) are handed to other apps defensively
  (component/selector stripped, BROWSABLE forced, `browser_fallback_url`
  honoured) and only from the main frame or a user gesture.
- **Background/foreground:** returning to the app never reloads the WebViews.
  The activity is `singleTask` with `configChanges` covering rotation,
  dark-mode, font scale, locale, keyboard, etc.; there is no
  `onPause`/`pauseTimers` handling. The WalletConnect relay queues messages
  while the app is backgrounded.

## Web runtime (JS) and its tests

`web/` holds the JS side of the contract: `chrome-shim.js` (chrome.* polyfill,
first script of every wallet page), `shell.html`/`shell.js` (top-level shell:
storage, message bus, windows/tabs, overlays, background iframe, native
bridge, WalletConnect hand-off, floating dApp-browser/Scan buttons on the
home screen), `background.html` (hidden "service worker" document) and
`dapp-inject.src.js` (template for the generated `dapp-inject.js`).

```bash
cd apps/android
pnpm run package:web                 # = node scripts/package-web.mjs
pnpm run test:web                    # package + Playwright E2E (needs network)
# or: NODE_USE_ENV_PROXY=1 node web/test/e2e.mjs [--only create,import,walletconnect]
```

The E2E harness (`web/test/`) uses the globally installed `playwright`,
serves `assets/www` on `http://localhost:<port>` (and at
`https://appassets.androidplatform.net` via request routing for the
WalletConnect suite), mocks `WalletChanNative`/`WalletChanDapp`, and writes
screenshots and console logs to `web/test/.tmp/`.

## Native features (summary)

- `WalletChanNative` bridge (origin-restricted) with every contract command:
  `http` (OkHttp, any method, base64 bodies, transparent gzip, redirect modes,
  timeouts, 32 MiB cap), `openExternal`, `openDapp`, `showWallet`,
  `showDapp`, `toDapp`, `closeDapp`, `notify` (channel "Wallet activity";
  POST_NOTIFICATIONS asked on first use on Android 13+), `backUnhandled`,
  `log`, `scanQr`.
- Wallet WebView can't leave the app origin; web links go to the dApp browser.
  JS on, DOM storage on, file/content access off, mixed content blocked,
  Safe Browsing on, popups re-routed, web camera/mic/location requests denied.
- dApp browser: URL/search field (bare domains → https, `name.eth` → eth.limo,
  everything else → DuckDuckGo), back, reload/stop, Wallet, close; fresh WebView
  and `tabId` (from 1000) per session; injects `www/android/dapp-inject.js`
  at document start; serves only `/static/js/*` from the app origin.
- Back button per contract (dApp history → close browser; wallet → shell `back`
  → `moveTaskToBack`).
- Edge-to-edge with system-bar/cutout/IME insets applied, so nothing sits under
  the bars and inputs stay above the keyboard.
- `FLAG_SECURE` (no screenshots/screen recording, blank Recents thumbnail).
  Toggle with `AppConfig.SECURE_SCREEN`.
- No backups (`allowBackup=false`, data-extraction rules exclude everything).

## Limitations

- **Hardware wallets:** Ledger (WebHID) and Trezor (Connect/Suite) are not
  available in Android WebView.
- **Single dApp tab;** popups (`window.open`, `target=_blank`) open in the same
  tab, so flows relying on `window.opener` (some OAuth popups) may not work.
- **No emulator/device testing was possible in the build environment;** the
  APK is verified by build, unit tests, lint, `apksigner` and `aapt2` only.
- Downloads are handed to the system browser; `<input type=file>` uses the
  system picker (single file).
- The OS may still kill the app while it's in the background (memory
  pressure); the wallet then restarts from persisted storage on next launch.
- Cleartext `http://` is permitted (local nodes / LAN RPCs, http dApps), as in
  the desktop extension; the wallet UI itself is HTTPS-only (mixed content
  blocked) and only system CAs are trusted.
- Notification taps open the app but are not reported to the extension
  (`chrome.notifications.onClicked` does not fire).

## Code map

| File | Role |
|---|---|
| `MainActivity.kt` | Activity, wallet WebView, insets, back, deep links, permissions, QR, file chooser |
| `ShellBridge.kt` | `WalletChanNative` listener + command dispatch |
| `DappBrowser.kt` | dApp WebView, toolbar, `WalletChanDapp` listener, tab events |
| `HttpBridge.kt` | `http` command (OkHttp) and pure JSON mapping |
| `WwwPathHandler.kt`, `MimeTypes.kt` | asset serving with exact MIME types |
| `WebViews.kt` | shared WebView settings, chrome client, popup catcher |
| `ExternalLinks.kt` | safe hand-off of URLs/intents to other apps |
| `Notifier.kt` | notification channel + posting |
| `UrlUtils.kt` | URL-bar normalization, origins (unit-tested) |
| `QrScanActivity.kt` | portrait ZXing capture activity |
| `AppConfig.kt` | constants and toggles |
