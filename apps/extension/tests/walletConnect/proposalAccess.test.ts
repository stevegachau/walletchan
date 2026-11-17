// Only the trusted wallet UI may list, approve, or reject WalletConnect proposals.
import assert from "node:assert/strict";
import test from "node:test";

import { createChromeStorageHarness } from "../helpers/chromeStorageHarness";
import { classifyBackgroundMessage } from "../../src/chrome/background/messageAccessPolicy";
import { createBackgroundMessagePipeline } from "../../src/chrome/background/messagePipeline";

const PROPOSAL_MESSAGES = [
  { type: "walletConnectGetPendingProposals" },
  { type: "walletConnectApproveProposal", proposalId: 1_700_000_000_000_001 },
  { type: "walletConnectRejectProposal", proposalId: 1_700_000_000_000_001 },
];

test("proposal decisions are classified as wallet-UI-only", () => {
  for (const message of PROPOSAL_MESSAGES) {
    assert.equal(classifyBackgroundMessage(message.type), "wallet-ui", message.type);
  }
});

test("pages, frames, and ENS documents cannot reach proposal decisions", () => {
  const harness = createChromeStorageHarness();
  (globalThis.chrome as any).runtime.getURL = (path: string) =>
    `chrome-extension://walletchan/${path.replace(/^\//, "")}`;
  const touched: string[] = [];
  // Any route access means the audience gate let the message through.
  const routes = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        return () => ({ handled: true, keepChannelOpen: false });
      },
    },
  );
  try {
    const pipeline = createBackgroundMessagePipeline(routes as any);
    const untrustedSenders: chrome.runtime.MessageSender[] = [
      { url: "https://evil.example/", origin: "https://evil.example", frameId: 0, tab: { id: 7 } as chrome.tabs.Tab },
      { url: "chrome-extension://walletchan/index.html", frameId: 3 },
      { url: "chrome-extension://walletchan/ens-interstitial.html", frameId: 0 },
      { url: "chrome-extension://another-extension/index.html", frameId: 0 },
    ];
    for (const sender of untrustedSenders) {
      for (const message of PROPOSAL_MESSAGES) {
        let response: unknown;
        pipeline(message, sender, (value) => {
          response = value;
        });
        assert.deepEqual(response, { success: false, error: "Unauthorized" }, `${message.type} from ${sender.url}`);
      }
    }
    assert.deepEqual(touched, []);

    // Positive control: the trusted wallet UI document reaches the routers.
    pipeline(PROPOSAL_MESSAGES[0], { url: "chrome-extension://walletchan/index.html", frameId: 0 }, () => {});
    assert.ok(touched.length > 0);
  } finally {
    harness.restore();
  }
});
