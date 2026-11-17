#!/usr/bin/env node
/*
 * End-to-end tests for the WalletChan Android web runtime (desktop Chromium
 * standing in for the Android WebView). Run after packaging:
 *
 *   node apps/android/scripts/package-web.mjs
 *   NODE_USE_ENV_PROXY=1 node apps/android/web/test/e2e.mjs [--only name,name]
 *
 * Suites:
 *   create     onboarding "Create new wallet", home, lock/unlock, reload persistence
 *   import     onboarding seed-phrase import, RPC via native http, dApp connect
 *   walletconnect  real WalletConnect relay at https://appassets.androidplatform.net
 *
 * Screenshots land in apps/android/web/test/.tmp/.
 */
import {
  chromium,
  startStaticServer,
  createWalletContext,
  screenshot,
  overlayFrame,
  mainUiFrame,
  approvalFrame,
} from "./harness.mjs";
import { runWalletConnectSuite } from "./walletconnect.mjs";

export const PASSWORD = "Correct-Horse-Battery-42";
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";
export const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const only = (() => {
  const index = process.argv.indexOf("--only");
  return index >= 0 ? new Set(process.argv[index + 1].split(",")) : null;
})();

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ✔ ${name}`);
}
function assert(condition, message) {
  if (!condition) throw new Error("Assertion failed: " + message);
}

/** Console errors that are expected in this environment (network noise etc.). */
const IGNORED_ERRORS = [
  /Failed to load resource/i, // remote icons/avatars without network access
  /net::ERR_/i,
  /_favicon/i,
];
function relevantErrors(errors) {
  return errors.filter((e) => !IGNORED_ERRORS.some((re) => re.test(e)));
}

export async function failureArtifacts(w, name) {
  try {
    await screenshot(w.shell, `${name}-FAIL`);
    for (const frame of w.shell.frames()) {
      if (/index\.html|onboarding\.html/.test(frame.url())) {
        console.log(`    [${frame.url()}]\n` + (await frame.locator("body").ariaSnapshot()).split("\n").slice(0, 40).map((l) => "      " + l).join("\n"));
      }
    }
    console.log("    console errors:\n      " + w.consoleErrors.slice(0, 30).join("\n      "));
  } catch (e) {
    console.log("    (failure artifacts unavailable: " + e.message + ")");
  }
}

// ---------------------------------------------------------------------------
// Shared flows
// ---------------------------------------------------------------------------

async function waitForHome(ui, timeout = 60_000) {
  await ui.getByRole("button", { name: "Lock wallet" }).waitFor({ timeout });
}

/** Onboarding in the overlay; resolves with the main UI frame at home. */
export async function onboard(w, kind, label) {
  const ob = await overlayFrame(w.shell, "/onboarding.html");
  await ob.getByRole("button", { name: "Create new wallet", exact: true }).waitFor({ timeout: 30_000 });
  await screenshot(w.shell, `${label}-01-welcome`);
  if (kind === "create") {
    await ob.getByRole("button", { name: "Create new wallet", exact: true }).click();
  } else {
    await ob.getByRole("button", { name: "Import or connect existing account", exact: true }).click();
    await ob.getByRole("button", { name: /Seed Phrase/ }).click();
    await ob.getByLabel("12-word seed phrase").fill(TEST_MNEMONIC);
    await screenshot(w.shell, `${label}-02-seed`);
    await ob.getByRole("button", { name: "Continue", exact: true }).click();
    // Address picker: account #0 is preselected.
    await ob.getByText("Select Addresses", { exact: true }).waitFor({ timeout: 30_000 });
    await ob.getByText("0xf39F...2266").first().waitFor({ timeout: 30_000 });
    await screenshot(w.shell, `${label}-02b-addresses`);
    await ob.getByRole("button", { name: /^(Import|Add|Continue)\b/ }).last().click();
  }
  await ob.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await ob.getByLabel("Confirm password").fill(PASSWORD);
  await screenshot(w.shell, `${label}-03-password`);
  await ob.getByRole("button", { name: /^(Create wallet|Import wallet|Continue)$/ }).last().click();

  // The wallet UI (side-panel equivalent) re-initialises as soon as the
  // wallet exists and closes the onboarding overlay, exactly like Chrome's
  // side panel does with the onboarding tab.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (await w.shell.evaluate(() => window.__walletchanShell.debug.overlayCount())) > 0) {
    await w.shell.waitForTimeout(250);
  }
  assert((await w.shell.evaluate(() => window.__walletchanShell.debug.overlayCount())) === 0, "onboarding overlay closed");
  const ui = await mainUiFrame(w.shell);
  await waitForHome(ui);
  return ui;
}

async function lockAndUnlock(w, ui, label) {
  await ui.getByRole("button", { name: "Lock wallet" }).click();
  await ui.getByLabel("Enter password to unlock", { exact: true }).waitFor({ timeout: 20_000 });
  await screenshot(w.shell, `${label}-locked`);
  await ui.getByLabel("Enter password to unlock", { exact: true }).fill("wrong-password-123");
  await ui.getByRole("button", { name: "Unlock", exact: true }).click();
  await ui.getByText("Incorrect password", { exact: true }).waitFor({ timeout: 20_000 });
  await ui.getByLabel("Enter password to unlock", { exact: true }).fill(PASSWORD);
  await ui.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitForHome(ui);
}

export async function unlockIfNeeded(ui) {
  const field = ui.getByLabel("Enter password to unlock", { exact: true });
  const lock = ui.getByRole("button", { name: "Lock wallet" });
  await Promise.race([field.waitFor({ timeout: 60_000 }), lock.waitFor({ timeout: 60_000 })]);
  if (await field.isVisible()) {
    await field.fill(PASSWORD);
    await ui.getByRole("button", { name: "Unlock", exact: true }).click();
    await waitForHome(ui);
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

async function suiteCreate(browser, server) {
  const w = await createWalletContext(browser, { serverUrl: server.url, name: "create" });
  try {
    await w.openShell();
    const ui = await onboard(w, "create", "create");
    await w.shell.waitForTimeout(1500);
    await screenshot(w.shell, "create-04-home");
    pass("create: new wallet onboarding reaches home");

    // The floating entry points are visible on the home screen.
    assert(await w.shell.isVisible("#wc-fab-browser"), "browser button visible");
    await w.shell.click("#wc-fab-browser");
    await w.native.waitFor((c) => c.cmd === "openDapp", 5_000, "openDapp");
    pass("create: floating browser button sends openDapp");

    await lockAndUnlock(w, ui, "create-05");
    pass("create: lock, wrong password rejected, unlock");

    // Android killed the WebView renderer while the user was in another app:
    // the shell reloads, but the app process (and its session mirror) lives
    // on, like a Chrome service-worker restart. The wallet must stay unlocked.
    await w.shell.waitForTimeout(1500);
    await w.shell.reload();
    const uiRestarted = await mainUiFrame(w.shell);
    await waitForHome(uiRestarted);
    assert(!(await uiRestarted.getByLabel("Enter password to unlock", { exact: true }).isVisible()), "still unlocked after WebView restart");
    await screenshot(w.shell, "create-06a-webview-restart-unlocked");
    pass("create: WebView restart keeps the wallet unlocked (session mirrored in native memory)");

    // The whole app process was killed: storage must persist (IndexedDB) and
    // the in-memory session must not (locked, like a browser restart).
    const before = await w.shell.evaluate(() => Object.keys(window.__walletchanShell.debug.storageSnapshot("local")).length);
    w.native.killProcess();
    await w.shell.reload();
    const ui2 = await mainUiFrame(w.shell);
    await ui2.getByLabel("Enter password to unlock", { exact: true }).waitFor({ timeout: 60_000 });
    const after = await w.shell.evaluate(() => Object.keys(window.__walletchanShell.debug.storageSnapshot("local")).length);
    assert(after >= before - 2 && after > 0, `storage persisted across reload (${before} -> ${after} keys)`);
    assert((await w.shell.evaluate(() => window.__walletchanShell.debug.overlayCount())) === 0, "no onboarding after reload");
    await screenshot(w.shell, "create-06-reloaded-locked");
    await ui2.getByLabel("Enter password to unlock", { exact: true }).fill(PASSWORD);
    await ui2.getByRole("button", { name: "Unlock", exact: true }).click();
    await waitForHome(ui2);
    pass("create: app process restart keeps the wallet (locked) and unlocks");

    // Android back with nothing to go back to -> backUnhandled.
    await w.native.toShell({ type: "back" });
    await w.native.waitFor((c) => c.cmd === "backUnhandled", 5_000, "backUnhandled");
    pass("create: back on home reports backUnhandled");

    // Scanner cancelled: silent. A WalletConnect "go to wallet" deep link
    // (no symKey, in the walletchan://wc?uri= form) just brings the wallet up.
    const showWalletBefore = w.native.commands.filter((c) => c.cmd === "showWallet").length;
    await w.native.toShell({ type: "qrResult", text: null, error: "cancelled" });
    await w.shell.waitForTimeout(300);
    assert(!(await w.shell.evaluate(() => document.getElementById("wc-toast").classList.contains("visible"))), "no toast on cancel");
    const requestLink = "walletchan://wc?uri=" + encodeURIComponent("wc:0123abcd@2?requestId=1&sessionTopic=abcd");
    await w.native.toShell({ type: "deepLink", url: requestLink });
    await w.shell.waitForTimeout(300);
    assert(w.native.commands.filter((c) => c.cmd === "showWallet").length > showWalletBefore, "deep link shows wallet");
    pass("create: scanner cancel is silent; wc request deep link shows the wallet");

    // Back navigates inside the UI: open Settings, back returns home.
    await ui2.getByRole("button", { name: "Settings" }).click();
    await ui2.getByRole("heading", { name: "Settings" }).waitFor();
    await screenshot(w.shell, "create-07-settings");
    await w.native.toShell({ type: "back" });
    await waitForHome(ui2, 10_000);
    pass("create: back closes a sub-screen");

    // Fingerprint unlock (native vault mocked): offered after a password
    // unlock, then a locked wallet opens with no typing.
    w.native.bio.available = true;
    w.native.killProcess();
    await w.shell.reload();
    const uiBio = await mainUiFrame(w.shell);
    const bioField = uiBio.getByLabel("Enter password to unlock", { exact: true });
    await bioField.waitFor({ timeout: 60_000 });
    await w.shell.waitForSelector("#wc-bio-setup", { state: "visible", timeout: 10_000 });
    await bioField.fill(PASSWORD);
    await uiBio.getByRole("button", { name: "Unlock", exact: true }).click();
    await waitForHome(uiBio);
    await w.shell.waitForSelector("#wc-bio-offer", { state: "visible", timeout: 10_000 });
    await screenshot(w.shell, "create-08-fingerprint-offer");
    await w.shell.click("#wc-bio-offer-yes");
    await w.shell.waitForFunction(() => /Fingerprint unlock is on/.test(document.getElementById("wc-toast").textContent), null, { timeout: 10_000 });
    assert(w.native.bio.stored === PASSWORD, "vault received the password that unlocked the wallet");
    pass("create: after a password unlock WalletChan offers fingerprint unlock and enrolls");

    const bioMark = w.native.commands.length;
    const lockedAt = Date.now();
    await uiBio.getByRole("button", { name: "Lock wallet" }).click();
    await w.native.waitFor((c) => c.cmd === "biometricUnlock" && w.native.commands.indexOf(c) >= bioMark, 15_000, "biometric prompt");
    await waitForHome(uiBio, 30_000);
    await bioField.waitFor({ state: "hidden", timeout: 15_000 }); // unlocked without typing
    console.log(`    timing: lock -> unlocked by fingerprint in ${Date.now() - lockedAt} ms`);
    pass("create: locked wallet unlocks with one fingerprint touch (auto prompt)");

    const errors = relevantErrors(w.consoleErrors);
    if (errors.length) console.log("    console errors:\n      " + errors.slice(0, 20).join("\n      "));
    return w;
  } catch (error) {
    await failureArtifacts(w, "create");
    throw error;
  } finally {
    await w.dumpConsole().catch(() => {});
    await w.context.close();
  }
}

async function suiteImport(browser, server, dappServer) {
  const w = await createWalletContext(browser, { serverUrl: server.url, name: "import" });
  try {
    await w.openShell();
    const ui = await onboard(w, "import", "import");
    pass("import: seed phrase onboarding reaches home");

    // The imported account is the well-known first test account.
    const syncAddress = await w.shell.evaluate(() => window.__walletchanShell.debug.storageSnapshot("sync").address);
    assert(String(syncAddress).toLowerCase() === TEST_ADDRESS.toLowerCase(), `active address ${syncAddress}`);
    pass("import: active account is " + TEST_ADDRESS);

    // Portfolio / balance requests go through native http (no CORS).
    const deadline = Date.now() + 45_000;
    let rpc = null;
    while (Date.now() < deadline && !rpc) {
      rpc = w.native.http.find((h) => h.method === "POST" && h.status === 200 && /"jsonrpc"/.test(h.body || "") && /eth_(getBalance|call|blockNumber|chainId)/.test(h.body || ""));
      if (!rpc) await w.shell.waitForTimeout(500);
    }
    assert(rpc, "a JSON-RPC request went through native http");
    console.log(`    rpc via native: ${rpc.url}  (${w.native.http.length} native http requests so far)`);
    await w.shell.waitForTimeout(3000);
    await screenshot(w.shell, "import-04-home");
    pass("import: RPC/balance fetch through native http mock");

    // ---- dApp connection through dapp-inject.js ----------------------------
    const dapp = await w.openDapp(dappServer.url + "/");
    await dapp.waitForFunction(() => typeof window.ethereum === "object" && window.ethereum !== null, null, { timeout: 20_000 });
    const info = await dapp.evaluate(() => ({
      hasEthereum: typeof window.ethereum === "object" && window.ethereum !== null,
      bridgeHidden: typeof window.WalletChanDapp === "undefined",
      chromeLeak: typeof window.chrome === "object" && window.chrome !== null && "storage" in window.chrome,
      inpageScripts: document.querySelectorAll('script[src*="inpage.js"]').length,
    }));
    assert(info.hasEthereum, "window.ethereum injected");
    assert(info.bridgeHidden, "WalletChanDapp hidden from page scripts");
    assert(!info.chromeLeak, "content-script chrome is not exposed to the page");
    assert(info.inpageScripts === 0, "inpage.js not injected as a <script> tag");
    const providerCount = await dapp.evaluate(
      () =>
        new Promise((resolve) => {
          const seen = [];
          window.addEventListener("eip6963:announceProvider", (e) => seen.push(e.detail.info.rdns));
          window.dispatchEvent(new Event("eip6963:requestProvider"));
          setTimeout(() => resolve(seen), 300);
        }),
    );
    assert(providerCount.length === 1, `exactly one EIP-6963 provider announced (${providerCount.join(",")})`);
    pass("dapp: provider injected once (no inpage <script> tag), bridge and content-script chrome hidden");

    const chainId = await dapp.evaluate(() => window.ethereum.request({ method: "eth_chainId" }));
    assert(chainId === "0x1", "eth_chainId " + chainId);
    const before = await dapp.evaluate(() => window.ethereum.request({ method: "eth_accounts" }));
    assert(Array.isArray(before) && before.length === 0, "not connected yet");

    await dapp.evaluate(() => {
      window.__accounts = window.ethereum.request({ method: "eth_requestAccounts" }).then(
        (a) => ({ ok: a }),
        (e) => ({ error: e.message }),
      );
    });
    await w.native.waitFor((c) => c.cmd === "showWallet", 10_000, "showWallet");
    const approval = await approvalFrame(w.shell, "Connect site", 30_000);
    await screenshot(w.shell, "import-05-connect-approval");
    await approval.getByRole("button", { name: /^Connect(?: anyway)?$/ }).click();
    const accounts = await dapp.evaluate(() => window.__accounts);
    assert(accounts.ok && accounts.ok[0] && accounts.ok[0].toLowerCase() === TEST_ADDRESS.toLowerCase(), "accounts " + JSON.stringify(accounts));
    pass("dapp: eth_requestAccounts approved in the wallet -> " + accounts.ok[0]);
    assert((await w.shell.evaluate(() => window.__walletchanShell.debug.overlayCount())) === 0, "shown in the running wallet screen, no popup window");

    // Once the wallet is back on its home screen it hands back to the dApp.
    await w.native.waitFor((c) => c.cmd === "showDapp", 10_000, "showDapp");
    pass("dapp: approval shown inline in the wallet screen, then returned to the dApp (showDapp)");

    const after = await dapp.evaluate(() => window.ethereum.request({ method: "eth_accounts" }));
    assert(after[0] && after[0].toLowerCase() === TEST_ADDRESS.toLowerCase(), "eth_accounts after connect");
    const balance = await dapp.evaluate((a) => window.ethereum.request({ method: "eth_getBalance", params: [a, "latest"] }), TEST_ADDRESS);
    assert(/^0x[0-9a-f]+$/i.test(balance), "eth_getBalance " + balance);
    pass("dapp: read-only RPC through the wallet works (eth_getBalance " + balance + ")");

    // personal_sign from the dApp
    await dapp.evaluate((a) => {
      window.__sig = window.ethereum
        .request({ method: "personal_sign", params: ["0x48656c6c6f2066726f6d20416e64726f6964", a] })
        .then((s) => ({ ok: s }), (e) => ({ error: e.message }));
    }, TEST_ADDRESS);
    const sigFrame = await approvalFrame(w.shell, "Signature request", 30_000);
    await screenshot(w.shell, "import-06-signature");
    await sigFrame.getByRole("button", { name: "Sign", exact: true }).click();
    const sig = await dapp.evaluate(() => window.__sig);
    assert(sig.ok && /^0x[0-9a-f]{130}$/i.test(sig.ok), "signature " + JSON.stringify(sig));
    const { verifyMessage } = await import("./deps.mjs").then((m) => m.ethers());
    const recovered = verifyMessage("Hello from Android", sig.ok);
    assert(recovered.toLowerCase() === TEST_ADDRESS.toLowerCase(), "signature recovers to account");
    pass("dapp: personal_sign approved, signature recovers to " + recovered);
    await screenshot(dapp, "import-07-dapp");

    const errors = relevantErrors(w.consoleErrors);
    if (errors.length) console.log("    console errors:\n      " + errors.slice(0, 20).join("\n      "));
  } catch (error) {
    await failureArtifacts(w, "import");
    throw error;
  } finally {
    await w.dumpConsole().catch(() => {});
    await w.context.close();
  }
}

const DAPP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test dApp</title>
</head><body style="font-family:sans-serif;padding:16px"><h1>Test dApp</h1><p>WalletChan Android harness page.</p></body></html>`;

async function main() {
  const server = await startStaticServer();
  const dappServer = await startStaticServer({ html: DAPP_HTML, hostname: "127.0.0.1" });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(
    proxy ? { proxy: { server: proxy, bypass: "localhost,127.0.0.1,appassets.androidplatform.net" } } : {},
  );
  const suites = [
    ["create", () => suiteCreate(browser, server)],
    ["import", () => suiteImport(browser, server, dappServer)],
    ["walletconnect", () => runWalletConnectSuite(browser, { pass, assert, relevantErrors })],
  ];
  let failed = false;
  for (const [name, run] of suites) {
    if (only && !only.has(name)) continue;
    console.log(`\n▶ ${name}`);
    try {
      await run();
    } catch (error) {
      failed = true;
      results.push({ name, ok: false, error });
      console.log(`  ✘ ${name}: ${error.stack || error}`);
    }
  }
  await browser.close();
  await server.close();
  await dappServer.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed} checks passed, ${results.length - passed} failed`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
