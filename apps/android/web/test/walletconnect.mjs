/*
 * WalletConnect E2E against the REAL relay, with the wallet served at the
 * production Android origin https://appassets.androidplatform.net (the
 * relay sees that Origin on the wallet's WebSocket).
 *
 * Node plays the dApp with @walletconnect/sign-client and the extension's
 * default project id. Flow:
 *   1. onboard (seed import), lock the wallet
 *   2. dApp connect() -> wc: URI -> shell receives it as a native `qrResult`
 *   3. shell asks to unlock first; unlock in the wallet UI; pairing proceeds
 *   4. dApp gets a session with the wallet account
 *   5. dApp personal_sign -> approval overlay -> Sign -> signature recovers
 */
import { createWalletContext, screenshot, overlayFrame, mainUiFrame } from "./harness.mjs";
import { onboard, failureArtifacts, PASSWORD, TEST_ADDRESS } from "./e2e.mjs";
import { ethers, signClientModule } from "./deps.mjs";

// apps/extension/src/chrome/walletConnect/client.ts DEFAULT_PROJECT_ID
const PROJECT_ID = "56262dba600174595278ffdf73ceb06f";

function memoryStorage() {
  const map = new Map();
  return {
    async getKeys() {
      return [...map.keys()];
    },
    async getEntries() {
      return [...map.entries()];
    },
    async getItem(key) {
      return map.get(key);
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)),
  ]);
}

async function toastText(shell) {
  return shell.evaluate(() => {
    const el = document.getElementById("wc-toast");
    return el && el.classList.contains("visible") ? el.textContent : "";
  });
}

async function waitForToast(shell, pattern, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await toastText(shell);
    if (pattern.test(last)) return last;
    await shell.waitForTimeout(150);
  }
  throw new Error(`toast ${pattern} not shown (last: "${last}")`);
}

export async function runWalletConnectSuite(browser, { pass, assert, relevantErrors }) {
  const w = await createWalletContext(browser, { origin: "appassets", name: "wc" });
  // Record what the relay socket does (origin rejections show up here).
  const socketEvents = [];
  w.shell.on("websocket", (ws) => {
    socketEvents.push(`open ${ws.url().split("?")[0]}`);
    ws.on("close", () => socketEvents.push(`close ${ws.url().split("?")[0]}`));
    ws.on("socketerror", (error) => socketEvents.push(`error ${error}`));
  });
  const { SignClient } = signClientModule();
  let dapp = null;
  try {
    await w.openShell();
    assert(w.walletOrigin === "https://appassets.androidplatform.net", "served at the Android origin");
    const ui = await onboard(w, "import", "wc");
    pass("wc: wallet onboarded at https://appassets.androidplatform.net");

    // Start locked: the shell must ask for unlock before pairing.
    await ui.getByRole("button", { name: "Lock wallet" }).click();
    await ui.getByLabel("Enter password to unlock", { exact: true }).waitFor({ timeout: 20_000 });

    dapp = await SignClient.init({
      projectId: PROJECT_ID,
      metadata: {
        name: "WalletChan Android E2E dApp",
        description: "Automated WalletConnect test",
        url: "https://walletchan.com",
        icons: [],
      },
      storage: memoryStorage(),
      logger: "error",
    });
    const { uri, approval } = await dapp.connect({
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign", "eth_sendTransaction", "eth_signTypedData_v4"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });
    assert(/^wc:/.test(uri), "dApp produced a wc: URI");

    // The native QR scanner returns the URI to the shell.
    await w.shell.click("#wc-fab-scan").catch(() => {}); // hidden while locked; scan is also reachable via deep link
    await w.native.toShell({ type: "qrResult", text: uri });
    await waitForToast(w.shell, /Unlock WalletChan/i, 15_000);
    await screenshot(w.shell, "wc-01-unlock-to-connect");
    pass("wc: scanning while locked asks to unlock first");

    await ui.getByLabel("Enter password to unlock", { exact: true }).fill(PASSWORD);
    await ui.getByRole("button", { name: "Unlock", exact: true }).click();

    const session = await withTimeout(approval(), 90_000, "session approval");
    const accounts = session.namespaces.eip155.accounts.map((a) => a.split(":")[2].toLowerCase());
    assert(accounts.includes(TEST_ADDRESS.toLowerCase()), "session accounts " + accounts.join(","));
    await waitForToast(w.shell, /Connected to/i, 20_000);
    await screenshot(w.shell, "wc-02-connected");
    pass(`wc: dApp session established over the real relay (${session.namespaces.eip155.accounts.length} accounts)`);

    // Mobile dApps bring the wallet forward with the wallet's redirect metadata.
    const redirect = session.peer && session.peer.metadata && session.peer.metadata.redirect;
    assert(redirect && redirect.native === "walletchan://", "wallet advertises redirect.native walletchan:// (got " + JSON.stringify(redirect) + ")");
    pass("wc: wallet metadata advertises redirect.native walletchan://");

    const message = "Log in to WalletChan Android E2E";
    const hexMessage = "0x" + Buffer.from(message, "utf8").toString("hex");
    const signaturePromise = dapp.request({
      topic: session.topic,
      chainId: "eip155:1",
      request: { method: "personal_sign", params: [hexMessage, TEST_ADDRESS] },
    });
    signaturePromise.catch(() => {});
    // Like a dApp in the phone's browser: after sending the request it opens
    // our redirect link. Once the request is handled we must step aside so
    // Android returns to that app.
    const commandMark = w.native.commands.length;
    await w.native.toShell({ type: "deepLink", url: "walletchan://wc?requestId=1&sessionTopic=" + session.topic, source: "external" });
    const approvalFrame = await overlayFrame(w.shell, "/index.html", 60_000);
    await approvalFrame.getByRole("heading", { name: "Signature request" }).waitFor({ timeout: 60_000 });
    await w.shell.waitForTimeout(800);
    await screenshot(w.shell, "wc-03-signature-request");
    await approvalFrame.getByRole("button", { name: "Sign", exact: true }).click();
    const signature = await withTimeout(signaturePromise, 60_000, "personal_sign result");
    const recovered = ethers().verifyMessage(message, signature);
    assert(recovered.toLowerCase() === TEST_ADDRESS.toLowerCase(), "signature recovers to " + recovered);
    pass("wc: personal_sign approved in the wallet, signature recovers to " + recovered);
    await w.native.waitFor(
      (cmd) => cmd.cmd === "backUnhandled" && w.native.commands.indexOf(cmd) >= commandMark,
      10_000,
      "return to the calling app (backUnhandled)",
    );
    pass("wc: after approving a request opened via walletchan:// the wallet returns to the calling app");

    // Connecting from a dApp on the phone: `walletchan://wc?uri=…` pairs, then returns.
    const second = await dapp.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged"] },
      },
    });
    const pairMark = w.native.commands.length;
    await w.native.toShell({ type: "deepLink", url: "walletchan://wc?uri=" + encodeURIComponent(second.uri), source: "external" });
    const secondSession = await withTimeout(second.approval(), 90_000, "second session approval");
    assert(secondSession.topic !== session.topic, "new session");
    await w.native.waitFor(
      (cmd) => cmd.cmd === "backUnhandled" && w.native.commands.indexOf(cmd) >= pairMark,
      15_000,
      "return to the calling app after pairing",
    );
    pass("wc: connecting via walletchan://wc?uri= deep link pairs and returns to the calling app");

    // Android "open with WalletChan" for a plain `wc:` link from a dApp in Chrome.
    const fourth = await dapp.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged"] },
      },
    });
    const wcMark = w.native.commands.length;
    await w.native.toShell({ type: "deepLink", url: fourth.uri, source: "external" });
    const fourthSession = await withTimeout(fourth.approval(), 90_000, "wc: link session approval");
    assert(fourthSession.topic !== session.topic, "new session");
    await w.native.waitFor(
      (cmd) => cmd.cmd === "backUnhandled" && w.native.commands.indexOf(cmd) >= wcMark,
      15_000,
      "return to the browser after a wc: link connect",
    );
    pass("wc: connecting via a plain wc: link from another app pairs and returns to the browser");

    // Connecting by pasting the link into WalletChan's own WalletConnect screen
    // (WalletChan isn't in dApps' wallet lists, so this is the common phone flow).
    const third = await dapp.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged"] },
      },
    });
    const ui3 = await mainUiFrame(w.shell);
    await ui3.getByText("More", { exact: true }).first().click();
    await ui3.getByText("WalletConnect", { exact: true }).first().click();
    const uriInput = ui3.getByPlaceholder("wc:...");
    await uriInput.waitFor({ timeout: 15_000 });
    await ui3.getByText("Active sessions", { exact: true }).first().waitFor({ timeout: 15_000 });
    const pasteMark = w.native.commands.length;
    // A real paste (WalletChan connects immediately on paste, no button press).
    await uriInput.evaluate((el, text) => {
      el.focus();
      const data = new DataTransfer();
      data.setData("text", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, third.uri);
    const thirdSession = await withTimeout(third.approval(), 90_000, "pasted-link session approval");
    assert(thirdSession.topic !== session.topic, "new session");
    await waitForToast(w.shell, /returning to your browser/i, 20_000);
    await screenshot(w.shell, "wc-04-pasted-link-connected");
    await w.native.waitFor(
      (cmd) => cmd.cmd === "backUnhandled" && w.native.commands.indexOf(cmd) >= pasteMark,
      15_000,
      "return to the browser after a pasted-link connect",
    );
    pass("wc: connecting by pasting the link in WalletChan returns to the browser");

    const errors = relevantErrors(w.consoleErrors);
    if (errors.length) console.log("    console errors:\n      " + errors.slice(0, 20).join("\n      "));
  } catch (error) {
    console.log("    relay sockets: " + (socketEvents.join(" | ") || "none"));
    await failureArtifacts(w, "wc");
    throw error;
  } finally {
    if (dapp) {
      try {
        await dapp.core.relayer.transportClose();
      } catch {
        /* ignore */
      }
    }
    await w.dumpConsole().catch(() => {});
    await w.context.close();
  }
}
