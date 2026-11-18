/*
 * WalletConnect E2E against the REAL relay, with the wallet served at the
 * production Android origin https://appassets.androidplatform.net (the
 * relay sees that Origin on the wallet's WebSocket).
 *
 * Node plays the dApp with @walletconnect/sign-client and the extension's
 * default project id. Flow:
 *   1. onboard (seed import), lock the wallet
 *   2. dApp connect() -> wc: URI -> shell receives it as a native `qrResult`
 *   3. nothing is approved automatically: the wallet asks to unlock (like an
 *      injected-site connection), then shows the "Connect app" review
 *   4. Connect -> dApp gets a session with the wallet account
 *   5. dApp personal_sign -> approval overlay -> Sign -> signature recovers
 *   6. deep-link, plain wc: link and pasted-link connects each show the review,
 *      Connect, and return to the calling app exactly once
 *   7. Reject -> the dApp's approval() rejects and the wallet returns once
 */
import { createWalletContext, screenshot, overlayFrame, mainUiFrame, approvalFrame as findApproval } from "./harness.mjs";
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

const DAPP_NAME = "WalletChan Android E2E dApp";

/** The connection review for our dApp, in whichever wallet frame shows it. */
async function connectionReview(shell, timeout = 60_000) {
  const frame = await findApproval(shell, "Connect app", timeout);
  await frame.getByRole("heading", { name: DAPP_NAME, exact: true }).waitFor({ timeout: 10_000 });
  return frame;
}

/** Clicks a review action once the screen transition settled (one match). */
async function reviewAction(frame, name) {
  const button = frame.getByRole("button", { name, exact: true });
  const deadline = Date.now() + 10_000;
  while ((await button.count()) !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await button.click();
}

/** Tracks whether a dApp approval() promise has settled. */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

/** Waits for the first `backUnhandled` after `mark`, then checks no second one follows. */
async function expectSingleReturn(native, mark, label) {
  const isBack = (cmd) => cmd.cmd === "backUnhandled" && native.commands.indexOf(cmd) >= mark;
  await native.waitFor(isBack, 15_000, label);
  await new Promise((r) => setTimeout(r, 2_500));
  const count = native.commands.slice(mark).filter((cmd) => cmd.cmd === "backUnhandled").length;
  if (count !== 1) throw new Error(`${label}: expected exactly one backUnhandled, got ${count}`);
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
    const firstApproval = approval();
    const firstState = track(firstApproval);
    await w.native.toShell({ type: "qrResult", text: uri });
    // Nothing is approved automatically. Like an injected-site connection,
    // the review is shown once the wallet is unlocked.
    await w.shell.waitForTimeout(4_000);
    assert(!firstState.settled, "proposal must not be approved before the user decides");
    await ui.getByLabel("Enter password to unlock", { exact: true }).waitFor({ timeout: 10_000 });
    await screenshot(w.shell, "wc-01-locked-proposal-asks-unlock");
    await ui.getByLabel("Enter password to unlock", { exact: true }).fill(PASSWORD);
    await ui.getByRole("button", { name: "Unlock", exact: true }).click();
    const review = await connectionReview(w.shell);
    await review.getByTestId("walletconnect-verify-badge").waitFor({ timeout: 10_000 });
    await w.shell.waitForTimeout(800);
    await screenshot(w.shell, "wc-01b-connection-review");
    assert(!firstState.settled, "still not approved while the review is on screen");
    assert(!/Waiting for the dApp/i.test(await toastText(w.shell)), "no 'Waiting for the dApp' toast during the review");
    pass("wc: a scanned proposal is not auto-approved; the wallet shows the Connect app review after unlock");
    await reviewAction(review, "Connect");
    const session = await withTimeout(firstApproval, 90_000, "session approval");
    await screenshot(w.shell, "wc-01c-connected");
    pass("wc: Connect in the review establishes the session");
    await w.native.waitFor((cmd) => cmd.cmd === "wcSessions" && cmd.count >= 1, 15_000, "wcSessions count reported to native");
    pass("wc: active session count reported to native (keeps the relay alive in the background)");

    const accounts = session.namespaces.eip155.accounts.map((a) => a.split(":")[2].toLowerCase());
    assert(accounts.includes(TEST_ADDRESS.toLowerCase()), "session accounts " + accounts.join(","));
    await screenshot(w.shell, "wc-02-connected");
    pass(`wc: dApp session established over the real relay (${session.namespaces.eip155.accounts.length} accounts)`);

    // Mobile dApps bring the wallet forward with the wallet's redirect metadata.
    const redirect = session.peer && session.peer.metadata && session.peer.metadata.redirect;
    assert(redirect && redirect.native === "walletchan://", "wallet advertises redirect.native walletchan:// (got " + JSON.stringify(redirect) + ")");
    pass("wc: wallet metadata advertises redirect.native walletchan://");

    const message = "Log in to WalletChan Android E2E";
    const hexMessage = "0x" + Buffer.from(message, "utf8").toString("hex");
    const requestSentAt = Date.now();
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
    const approvalFrame = await findApproval(w.shell, "Signature request", 60_000);
    console.log(`    timing: dApp request -> signature screen visible in ${Date.now() - requestSentAt} ms`);
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
    const secondReview = await connectionReview(w.shell);
    assert(!w.native.commands.slice(pairMark).some((cmd) => cmd.cmd === "backUnhandled"), "no return while the review is showing");
    await reviewAction(secondReview, "Connect");
    const secondSession = await withTimeout(second.approval(), 90_000, "second session approval");
    assert(secondSession.topic !== session.topic, "new session");
    assert(
      secondSession.namespaces.eip155.accounts.some((a) => a.toLowerCase().endsWith(TEST_ADDRESS.toLowerCase())),
      "deep-link session uses the wallet account",
    );
    await expectSingleReturn(w.native, pairMark, "return to the calling app after pairing");
    pass("wc: walletchan://wc?uri= deep link shows the review, connects, and returns to the calling app once");

    // Android "open with WalletChan" for a plain `wc:` link from a dApp in Chrome.
    const fourth = await dapp.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged"] },
      },
    });
    const wcMark = w.native.commands.length;
    const linkAt = Date.now();
    await w.native.toShell({ type: "deepLink", url: fourth.uri, source: "external" });
    // Film the gap between the link and the Connect screen.
    const film = (async () => {
      for (let i = 0; i < 40; i++) {
        await w.shell.screenshot({ path: `${process.cwd()}/web/test/.tmp/wc-gap-${String(i).padStart(2, "0")}-${Date.now() - linkAt}ms.png` }).catch(() => {});
        if (await w.shell.evaluate(() => window.__wcReviewSeen === true).catch(() => false)) break;
        await w.shell.waitForTimeout(100);
      }
    })();
    const fourthReview = await connectionReview(w.shell);
    const reviewAt = Date.now();
    await w.shell.evaluate(() => (window.__wcReviewSeen = true));
    await film;
    const broadcastAt = await w.shell.evaluate(() => window.__walletchanShell.debug.timings.proposalBroadcastAt);
    console.log(`    timing: wc: link -> proposal reached the wallet ${broadcastAt - linkAt} ms -> Connect screen visible ${reviewAt - linkAt} ms`);
    await reviewAction(fourthReview, "Connect");
    const fourthSession = await withTimeout(fourth.approval(), 90_000, "wc: link session approval");
    assert(fourthSession.topic !== session.topic, "new session");
    await expectSingleReturn(w.native, wcMark, "return to the browser after a wc: link connect");
    const toastAfterConnect = await w.shell.evaluate(() => document.getElementById("wc-toast").classList.contains("visible") ? document.getElementById("wc-toast").textContent : "");
    assert(toastAfterConnect === "", "no toast in the connect flow (got: " + toastAfterConnect + ")");
    pass("wc: a plain wc: link from another app shows the review, connects, and returns once");

    // Rejecting in the review: the dApp's approval() rejects and we still return once.
    const rejected = await dapp.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged"] },
      },
    });
    const rejectedState = track(rejected.approval());
    const rejectMark = w.native.commands.length;
    await w.native.toShell({ type: "deepLink", url: "walletchan://wc?uri=" + encodeURIComponent(rejected.uri), source: "external" });
    const rejectReview = await connectionReview(w.shell);
    await reviewAction(rejectReview, "Reject");
    await screenshot(w.shell, "wc-05-rejected");
    const rejectDeadline = Date.now() + 30_000;
    while (!rejectedState.settled && Date.now() < rejectDeadline) await w.shell.waitForTimeout(200);
    assert(rejectedState.settled && rejectedState.error, "dApp approval() rejects after the user rejects");
    assert(/reject/i.test(String(rejectedState.error && (rejectedState.error.message || rejectedState.error))), "rejection reason: " + String(rejectedState.error && rejectedState.error.message));
    await expectSingleReturn(w.native, rejectMark, "return to the calling app after rejecting");
    pass("wc: rejecting the review rejects the dApp's approval() and returns to the calling app once");

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
    const thirdReview = await connectionReview(w.shell);
    await reviewAction(thirdReview, "Connect");
    const thirdSession = await withTimeout(third.approval(), 90_000, "pasted-link session approval");
    assert(thirdSession.topic !== session.topic, "new session");
    await screenshot(w.shell, "wc-04-pasted-link-connected");
    await expectSingleReturn(w.native, pasteMark, "return to the browser after a pasted-link connect");
    pass("wc: pasting the link shows the review, connects, and returns to the browser once");

    // Regression: after a WebView restart WalletKit re-announces the existing
    // sessions; that must not count as "connected" for a new link and send the
    // user back before they tap Connect.
    const afterRestart = await dapp.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged"] },
      },
    });
    const afterRestartApproval = afterRestart.approval();
    afterRestartApproval.catch(() => {});
    await w.shell.reload();
    await mainUiFrame(w.shell);
    const restartMark = w.native.commands.length;
    await w.native.toShell({ type: "deepLink", url: afterRestart.uri, source: "external" });
    const restartReview = await connectionReview(w.shell);
    await w.shell.waitForTimeout(4_000);
    assert(
      !w.native.commands.slice(restartMark).some((cmd) => cmd.cmd === "backUnhandled"),
      "no return to the browser before Connect is tapped (after a restart)",
    );
    await reviewAction(restartReview, "Connect");
    await withTimeout(afterRestartApproval, 90_000, "session approval after restart");
    await expectSingleReturn(w.native, restartMark, "return after Connect following a restart");
    pass("wc: after a restart, a new link waits on the Connect screen until Connect is tapped");

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
