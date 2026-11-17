// Background WalletConnect-session transport contract.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BACKGROUND_WALLETCONNECT_SESSION_MESSAGE_TYPES,
  createBackgroundWalletConnectSessionMessageRouter,
} from "../../src/chrome/background/walletConnectSessionRouter";

function responseCapture() {
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { response, sendResponse: resolve };
}

test("WalletConnect session transport stays focused and declares every route", async () => {
  const source = await readFile(
    new URL(
      "../../src/chrome/background/walletConnectSessionRouter.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(source.split(/\r?\n/).length <= 400);
  const switchTypes = [...source.matchAll(/^ {6}case ["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(switchTypes)].sort(),
    [...BACKGROUND_WALLETCONNECT_SESSION_MESSAGE_TYPES].sort(),
  );
});

test("WalletConnect routes preserve handler inputs, results, and async channels", async () => {
  const calls: unknown[][] = [];
  const route = createBackgroundWalletConnectSessionMessageRouter({
    handleWalletConnectGetSessions: async () => {
      calls.push(["sessions"]);
      return { sessions: ["topic"] };
    },
    handleWalletConnectPair: async (uri) => {
      calls.push(["pair", uri]);
      return { paired: uri };
    },
    handleWalletConnectDisconnectSession: async (topic) => {
      calls.push(["disconnect", topic]);
      return { disconnected: topic };
    },
    handleWalletConnectSwitchChain: async (chainName) => {
      calls.push(["chain", chainName]);
      return { chainName };
    },
    handleWalletConnectGetPendingProposals: async () => {
      calls.push(["proposals"]);
      return { proposals: [] };
    },
    handleWalletConnectApproveProposal: async (proposalId, accountId) => {
      calls.push(["approve", proposalId, accountId]);
      return { approved: proposalId };
    },
    handleWalletConnectRejectProposal: async (proposalId) => {
      calls.push(["reject", proposalId]);
      return { rejected: proposalId };
    },
    runPendingRequestResolution: (async (options: any) => {
      calls.push(["claim", options.family, options.requestId, options.action]);
      return options.resolve();
    }) as any,
    pendingResolutionConflict: () => ({ success: false }),
  });
  const messages = [
    { type: "walletConnectGetSessions" },
    { type: "walletConnectPair", uri: "wc:pair" },
    { type: "walletConnectDisconnectSession", topic: "topic" },
    { type: "walletConnectSwitchChain", chainName: "Base" },
    { type: "walletConnectGetPendingProposals" },
    { type: "walletConnectApproveProposal", proposalId: 7, accountId: "a" },
    { type: "walletConnectRejectProposal", proposalId: 8 },
  ];
  const expected = [
    { sessions: ["topic"] },
    { paired: "wc:pair" },
    { disconnected: "topic" },
    { chainName: "Base" },
    { proposals: [] },
    { approved: 7 },
    { rejected: 8 },
  ];

  for (let index = 0; index < messages.length; index += 1) {
    const capture = responseCapture();
    assert.deepEqual(route(messages[index], capture.sendResponse), {
      handled: true,
      keepChannelOpen: true,
    });
    assert.deepEqual(await capture.response, expected[index]);
  }
  assert.deepEqual(calls, [
    ["sessions"],
    ["pair", "wc:pair"],
    ["disconnect", "topic"],
    ["chain", "Base"],
    ["proposals"],
    ["claim", "sessionProposal", "7", "confirm"],
    ["approve", 7, "a"],
    ["claim", "sessionProposal", "8", "reject"],
    ["reject", 8],
  ]);
  assert.deepEqual(route({ type: "unrelated" }, () => {}), { handled: false });
});
