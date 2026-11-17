// WalletConnect session proposals require an explicit user decision.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildApprovedNamespaces } from "@walletconnect/utils";

import { createChromeStorageHarness } from "../helpers/chromeStorageHarness";
import type { Account } from "../../src/chrome/types";
import { getStoredNetworksInfo, getVisibleChains } from "../../src/lib/chains";
import {
  createWalletConnectProposalDecisionHandlers,
  WALLETCONNECT_PROPOSAL_USER_REJECTED_MESSAGE,
} from "../../src/chrome/walletConnect/proposalDecisions";
import {
  NEW_PENDING_WALLETCONNECT_PROPOSAL_MESSAGE,
  buildPendingWalletConnectProposal,
  handleWalletConnectSessionProposal,
} from "../../src/chrome/walletConnect/proposalIntake";
import {
  MAX_PENDING_WALLETCONNECT_PROPOSALS,
  WALLETCONNECT_PENDING_PROPOSALS_KEY,
  clearPendingWalletConnectProposals,
  getPendingWalletConnectProposals,
} from "../../src/chrome/walletConnect/proposalStorage";
import { normalizeWalletConnectProposal } from "../../src/chrome/walletConnect/proposal";
import { WALLETCONNECT_SUPPORTED_EVENTS } from "../../src/chrome/walletConnect/sessionPolicy";
import { getWalletConnectMethodsForAccount } from "../../src/chrome/walletConnect/sessionAccountPolicy";
import { WALLET_LOCAL_STORAGE_KEYS } from "../../src/chrome/walletResetStorage";
import {
  resetPendingRequestResolutionClaimsForTests,
  runPendingRequestResolution,
} from "../../src/chrome/requests/pendingRequestResolution";
import { createBackgroundWalletConnectSessionMessageRouter } from "../../src/chrome/background/walletConnectSessionRouter";
import { pendingResolutionConflict } from "../../src/chrome/background/composition/pendingResolution";

const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";
const SEED_ACCOUNT: Account = {
  id: "seed-a",
  type: "seedPhrase",
  address: ADDRESS_A,
  displayName: "Seed A",
  createdAt: 1,
  seedGroupId: "group",
  derivationIndex: 0,
} as Account;
const PK_ACCOUNT: Account = {
  id: "pk-b",
  type: "privateKey",
  address: ADDRESS_B,
  displayName: "Key B",
  createdAt: 2,
} as Account;
const VIEW_ONLY: Account = {
  id: "watch",
  type: "impersonator",
  address: ADDRESS_B,
  displayName: "Watch",
  createdAt: 3,
} as Account;

let nextId = 1_700_000_000_000_100;

function rawProposal(overrides: {
  id?: number;
  expiryTimestamp?: number;
  verified?: Record<string, unknown>;
} = {}) {
  const id = overrides.id ?? nextId++;
  return {
    id,
    params: {
      id,
      expiryTimestamp:
        overrides.expiryTimestamp ?? Math.floor(Date.now() / 1000) + 300,
      pairingTopic: "pairing-topic",
      relays: [{ protocol: "irn" }],
      proposer: {
        publicKey: "proposer-key",
        metadata: {
          name: "Example dApp",
          description: "Example description",
          url: "https://app.example.com",
          icons: ["https://app.example.com/icon.png", "javascript:alert(1)"],
        },
      },
      requiredNamespaces: {},
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:1", "eip155:8453"],
          methods: ["personal_sign", "eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    },
    verifyContext: {
      verified: overrides.verified ?? {
        validation: "VALID",
        origin: "https://app.example.com",
        verifyUrl: "https://verify.walletconnect.org",
      },
    },
  };
}

function fakeKit() {
  const pending: Record<number, any> = {};
  const calls: Array<[string, any]> = [];
  return {
    pending,
    calls,
    // Like WalletKit (`signClient.proposal.getAll()`), an array of structs.
    getPendingSessionProposals: () => Object.values(pending),
    approveSession: async (args: any) => {
      calls.push(["approve", args]);
      delete pending[args.id];
    },
    rejectSession: async (args: any) => {
      calls.push(["reject", args]);
      delete pending[args.id];
    },
  };
}

function setup(accounts: Account[] = [SEED_ACCOUNT, PK_ACCOUNT], activeId = "seed-a") {
  resetPendingRequestResolutionClaimsForTests();
  const harness = createChromeStorageHarness({
    local: { accounts },
    sync: { activeAccountId: activeId },
  });
  const surfaces: unknown[] = [];
  const browser = globalThis.chrome as any;
  browser.runtime.getURL = (path: string) => `chrome-extension://walletchan/${path.replace(/^\//, "")}`;
  const focused = { id: 1, state: "normal", left: 0, top: 0, width: 1200, height: 800 };
  browser.windows = {
    WINDOW_ID_NONE: -1,
    getAll: async () => [],
    get: async () => focused,
    getLastFocused: async () => focused,
    getCurrent: async () => focused,
    create: async (options: unknown) => {
      surfaces.push(options);
      return { id: 2, tabs: [] };
    },
    update: async () => focused,
  };
  const kit = fakeKit();
  const rejections: unknown[] = [];
  let sessionsChanged = 0;
  const handlers = createWalletConnectProposalDecisionHandlers({
    ensureWalletKit: async () => kit,
    onSessionsChanged: async () => {
      sessionsChanged += 1;
    },
    onProposalRejected: (rejection) => rejections.push(rejection),
  });
  async function receive(proposal = rawProposal()) {
    kit.pending[proposal.id] = proposal.params;
    await handleWalletConnectSessionProposal(kit, proposal);
    return proposal;
  }
  return {
    harness,
    surfaces,
    kit,
    handlers,
    rejections,
    receive,
    sessionsChanged: () => sessionsChanged,
  };
}

test("a session proposal is recorded and surfaced, never auto-approved", async () => {
  const ctx = setup();
  try {
    const proposal = await ctx.receive();
    assert.deepEqual(ctx.kit.calls, [], "no approve or reject on arrival");
    const pending = await getPendingWalletConnectProposals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, proposal.id);
    assert.equal(pending[0].name, "Example dApp");
    assert.equal(pending[0].url, "https://app.example.com");
    assert.deepEqual(pending[0].icons, ["https://app.example.com/icon.png"]);
    assert.deepEqual(pending[0].optionalChainIds, [1, 8453]);
    assert.deepEqual(pending[0].requiredChainIds, []);
    assert.deepEqual(pending[0].methods, ["personal_sign", "eth_sendTransaction"]);
    assert.deepEqual(pending[0].verification, {
      validation: "VALID",
      origin: "https://app.example.com",
      isScam: false,
    });
    assert.ok(pending[0].expiresAt > Date.now());
    const announced = ctx.harness.runtimeMessages.find(
      (message: any) => message?.type === NEW_PENDING_WALLETCONNECT_PROPOSAL_MESSAGE,
    ) as any;
    assert.equal(announced?.proposal?.id, proposal.id);
    assert.match(NEW_PENDING_WALLETCONNECT_PROPOSAL_MESSAGE, /^newPending[A-Za-z]*Request$/);
    assert.equal(ctx.surfaces.length, 1, "the review surface was opened");
  } finally {
    ctx.harness.restore();
  }
});

test("Connect approves with the active account and the unchanged namespace policy", async () => {
  const ctx = setup();
  try {
    const proposal = await ctx.receive();
    // The previous auto-approval computed exactly these namespaces.
    const networksInfo = await getStoredNetworksInfo();
    const chains = getVisibleChains(networksInfo, "seedPhrase").map(
      (chain) => `eip155:${chain.chainId}`,
    );
    const supportedNamespaces = {
      eip155: {
        chains,
        accounts: chains.map((chain) => `${chain}:${ADDRESS_A}`),
        methods: getWalletConnectMethodsForAccount(SEED_ACCOUNT as any),
        events: WALLETCONNECT_SUPPORTED_EVENTS,
      },
    };
    const expected = buildApprovedNamespaces({
      proposal: normalizeWalletConnectProposal(
        proposal.params as any,
        supportedNamespaces,
      ),
      supportedNamespaces,
    });

    const result = await ctx.handlers.handleWalletConnectApproveProposal(
      proposal.id,
      "seed-a",
    );
    assert.deepEqual(result, { success: true });
    assert.equal(ctx.kit.calls.length, 1);
    const [kind, args] = ctx.kit.calls[0];
    assert.equal(kind, "approve");
    assert.equal(args.id, proposal.id);
    assert.deepEqual(args.namespaces, expected);
    assert.ok(
      args.namespaces.eip155.accounts.includes(`eip155:1:${ADDRESS_A}`),
    );
    assert.ok(
      !JSON.stringify(args.namespaces).toLowerCase().includes(ADDRESS_B.toLowerCase()),
      "only the active account is exposed",
    );
    assert.deepEqual(await getPendingWalletConnectProposals(), []);
    assert.equal(ctx.sessionsChanged(), 1);
  } finally {
    ctx.harness.restore();
  }
});

test("Connect uses the account the user switched to before approving", async () => {
  const ctx = setup();
  try {
    const proposal = await ctx.receive();
    ctx.harness.stores.sync.activeAccountId = "pk-b";
    const result = await ctx.handlers.handleWalletConnectApproveProposal(
      proposal.id,
      "pk-b",
    );
    assert.deepEqual(result, { success: true });
    const accounts: string[] = ctx.kit.calls[0][1].namespaces.eip155.accounts;
    assert.ok(accounts.length > 0);
    assert.ok(accounts.every((entry) => entry.endsWith(`:${ADDRESS_B}`)));
  } finally {
    ctx.harness.restore();
  }
});

test("a changed active account fails closed without consuming the proposal", async () => {
  const ctx = setup();
  try {
    const proposal = await ctx.receive();
    const result = await ctx.handlers.handleWalletConnectApproveProposal(
      proposal.id,
      "pk-b",
    );
    assert.equal(result.success, false);
    assert.equal((result as any).code, "accountChanged");
    assert.deepEqual(ctx.kit.calls, []);
    assert.equal((await getPendingWalletConnectProposals()).length, 1);
  } finally {
    ctx.harness.restore();
  }
});

test("view-only accounts are rejected exactly as before", async () => {
  const ctx = setup([VIEW_ONLY], "watch");
  try {
    const proposal = await ctx.receive();
    const result = await ctx.handlers.handleWalletConnectApproveProposal(proposal.id);
    assert.equal(result.success, false);
    assert.deepEqual(ctx.kit.calls, [
      ["reject", { id: proposal.id, reason: { code: 4001, message: "No signing account is active" } }],
    ]);
    assert.deepEqual(await getPendingWalletConnectProposals(), []);
  } finally {
    ctx.harness.restore();
  }
});

test("Reject answers the dapp with 5000 User rejected and broadcasts the outcome", async () => {
  const ctx = setup();
  try {
    const proposal = await ctx.receive();
    const result = await ctx.handlers.handleWalletConnectRejectProposal(proposal.id);
    assert.deepEqual(result, { success: true });
    assert.deepEqual(ctx.kit.calls, [
      ["reject", { id: proposal.id, reason: { code: 5000, message: "User rejected" } }],
    ]);
    assert.deepEqual(await getPendingWalletConnectProposals(), []);
    assert.deepEqual(
      ctx.harness.runtimeMessages.filter(
        (message: any) => message?.type === WALLETCONNECT_PROPOSAL_USER_REJECTED_MESSAGE,
      ),
      [
        {
          type: WALLETCONNECT_PROPOSAL_USER_REJECTED_MESSAGE,
          proposalId: proposal.id,
          name: "Example dApp",
          url: "https://app.example.com",
        },
      ],
    );
    // A second decision finds nothing to act on.
    const again = await ctx.handlers.handleWalletConnectApproveProposal(proposal.id);
    assert.equal((again as any).code, "notFound");
    assert.equal(ctx.kit.calls.length, 1);
  } finally {
    ctx.harness.restore();
  }
});

test("expired proposals fail closed, are cleaned up, and are hidden from the list", async () => {
  const ctx = setup();
  try {
    const proposal = await ctx.receive();
    const stored = ctx.harness.stores.local[WALLETCONNECT_PENDING_PROPOSALS_KEY] as any[];
    stored[0].expiresAt = Date.now() - 1;
    const result = await ctx.handlers.handleWalletConnectApproveProposal(proposal.id);
    assert.equal((result as any).code, "expired");
    assert.ok(!ctx.kit.calls.some(([kind]) => kind === "approve"));
    assert.equal(ctx.harness.stores.local[WALLETCONNECT_PENDING_PROPOSALS_KEY], undefined);

    const second = await ctx.receive();
    (ctx.harness.stores.local[WALLETCONNECT_PENDING_PROPOSALS_KEY] as any[])[0].expiresAt = 0;
    assert.deepEqual(await getPendingWalletConnectProposals(), []);
    assert.equal(ctx.harness.stores.local[WALLETCONNECT_PENDING_PROPOSALS_KEY], undefined);

    // A record whose SDK proposal already expired cannot be approved either.
    const third = await ctx.receive();
    delete ctx.kit.pending[third.id];
    const missing = await ctx.handlers.handleWalletConnectApproveProposal(third.id);
    assert.equal((missing as any).code, "expired");
    assert.ok(second.id !== third.id);

    // An arrival that is already past its expiry is answered, not queued.
    const stale = await ctx.receive(rawProposal({ expiryTimestamp: 1 }));
    assert.deepEqual(await getPendingWalletConnectProposals(), []);
    assert.deepEqual(ctx.kit.calls.at(-1), [
      "reject",
      { id: stale.id, reason: { code: 5000, message: "Connection request expired" } },
    ]);
  } finally {
    ctx.harness.restore();
  }
});

test("double clicks and Connect/Reject races resolve to exactly one decision", async () => {
  const ctx = setup();
  try {
    const route = createBackgroundWalletConnectSessionMessageRouter({
      handleWalletConnectGetSessions: async () => ({}),
      handleWalletConnectPair: async () => ({}),
      handleWalletConnectDisconnectSession: async () => ({}),
      handleWalletConnectSwitchChain: async () => ({}),
      ...ctx.handlers,
      runPendingRequestResolution,
      pendingResolutionConflict,
    });
    const send = (message: Record<string, unknown>) =>
      new Promise<any>((resolve) => route(message, resolve));

    const proposal = await ctx.receive();
    const results = await Promise.all([
      send({ type: "walletConnectApproveProposal", proposalId: proposal.id, accountId: "seed-a" }),
      send({ type: "walletConnectApproveProposal", proposalId: proposal.id, accountId: "seed-a" }),
      send({ type: "walletConnectRejectProposal", proposalId: proposal.id }),
    ]);
    assert.equal(results.filter((result) => result.success).length, 1);
    assert.equal(ctx.kit.calls.length, 1);
    assert.equal(ctx.kit.calls[0][0], "approve");

    const listed = await send({ type: "walletConnectGetPendingProposals" });
    assert.deepEqual(listed, { success: true, proposals: [] });
    const invalid = await send({ type: "walletConnectRejectProposal", proposalId: "1" });
    assert.equal(invalid.code, "invalid");
  } finally {
    ctx.harness.restore();
  }
});

test("pending proposals are bounded and duplicate relay deliveries are not queued twice", async () => {
  const ctx = setup();
  try {
    const first = await ctx.receive();
    await ctx.receive(first);
    assert.equal((await getPendingWalletConnectProposals()).length, 1);
    for (let index = 1; index < MAX_PENDING_WALLETCONNECT_PROPOSALS; index += 1) {
      await ctx.receive();
    }
    assert.equal(
      (await getPendingWalletConnectProposals()).length,
      MAX_PENDING_WALLETCONNECT_PROPOSALS,
    );
    const overflow = await ctx.receive();
    assert.equal(
      (await getPendingWalletConnectProposals()).length,
      MAX_PENDING_WALLETCONNECT_PROPOSALS,
    );
    assert.deepEqual(ctx.kit.calls, [
      [
        "reject",
        {
          id: overflow.id,
          reason: {
            code: 5000,
            message: "Too many pending WalletConnect connection requests",
          },
        },
      ],
    ]);
  } finally {
    ctx.harness.restore();
  }
});

test("Verify context is sanitized and malformed stored records fail closed", async () => {
  const scam = buildPendingWalletConnectProposal(
    rawProposal({
      verified: { validation: "INVALID", origin: "javascript:alert(1)", isScam: true },
    }),
  );
  assert.deepEqual(scam?.verification, {
    validation: "INVALID",
    origin: "",
    isScam: true,
  });
  const odd = buildPendingWalletConnectProposal(
    rawProposal({ verified: { validation: "TRUST_ME", origin: 42 } }),
  );
  assert.deepEqual(odd?.verification, { validation: "UNKNOWN", origin: "", isScam: false });
  assert.equal(buildPendingWalletConnectProposal({ id: "1", params: {} }), null);

  const harness = createChromeStorageHarness({
    local: { [WALLETCONNECT_PENDING_PROPOSALS_KEY]: [{ id: 5, name: "x" }, "junk"] },
  });
  try {
    assert.deepEqual(await getPendingWalletConnectProposals(), []);
    assert.equal(harness.stores.local[WALLETCONNECT_PENDING_PROPOSALS_KEY], undefined);
  } finally {
    harness.restore();
  }
});

test("wallet and WalletConnect resets clear pending proposals", async () => {
  assert.ok(
    (WALLET_LOCAL_STORAGE_KEYS as readonly string[]).includes(
      WALLETCONNECT_PENDING_PROPOSALS_KEY,
    ),
  );
  const ctx = setup();
  try {
    await ctx.receive();
    await clearPendingWalletConnectProposals();
    assert.equal(ctx.harness.stores.local[WALLETCONNECT_PENDING_PROPOSALS_KEY], undefined);
  } finally {
    ctx.harness.restore();
  }
  const client = await readFile(
    new URL("../../src/chrome/walletConnect/client.ts", import.meta.url),
    "utf8",
  );
  const reset = client.slice(client.indexOf("export async function resetWalletConnectForWalletReset"));
  assert.ok(
    reset.indexOf("clearPendingWalletConnectProposals()") > 0 &&
      reset.indexOf("clearPendingWalletConnectProposals()") <
        reset.indexOf("WALLETCONNECT_STORAGE_NAMESPACE_KEY]: replacementNamespace"),
    "WalletConnect reset clears pending proposals before rotating the namespace",
  );
  assert.doesNotMatch(
    client.slice(client.indexOf("const proposal = (value: any)"), client.indexOf("const expired = (value: any)")),
    /approveSession|approveWalletConnectProposalForAccount/,
    "the session_proposal listener never approves",
  );
});
