// Session approval advertises the same ERC-5792 atomic capability as
// wallet_getCapabilities, best effort and never at the cost of the approval.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { createChromeStorageHarness } from "../helpers/chromeStorageHarness";
import type { Account } from "../../src/chrome/types";
import { handleWalletGetCapabilities } from "../../src/chrome/batchTxHandlers";
import { approveWalletConnectProposalForAccount } from "../../src/chrome/walletConnect/sessionProposal";
import {
  approvedEip155ChainIds,
  buildWalletConnectScopedProperties,
} from "../../src/chrome/walletConnect/sessionCapabilities";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const BANKR_ACCOUNT = {
  id: "bankr-1",
  type: "bankr",
  address: ADDRESS,
  displayName: "Bankr",
  createdAt: 1,
} as Account;
const PK_ACCOUNT = {
  id: "pk-1",
  type: "privateKey",
  address: ADDRESS,
  displayName: "Key",
  createdAt: 1,
} as Account;

function proposal(id: number) {
  return {
    id,
    params: {
      id,
      expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      pairingTopic: "pairing",
      relays: [{ protocol: "irn" }],
      proposer: {
        publicKey: "key",
        metadata: { name: "dApp", description: "", url: "https://dapp.example", icons: [] },
      },
      requiredNamespaces: {},
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:1", "eip155:8453", "eip155:11155111"],
          methods: ["eth_sendTransaction", "wallet_sendCalls", "wallet_getCapabilities"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    },
  };
}

function fakeKit() {
  const calls: Array<[string, any]> = [];
  return {
    calls,
    approveSession: async (args: any) => {
      calls.push(["approve", structuredClone(args)]);
    },
    rejectSession: async (args: any) => {
      calls.push(["reject", structuredClone(args)]);
    },
  };
}

test("approved eip155 chains are read from both namespace key forms", () => {
  assert.deepEqual(
    approvedEip155ChainIds({
      eip155: { chains: ["eip155:1", "eip155:8453", "eip155:x", "solana:1"] },
      "eip155:10": { methods: [] },
      cosmos: { chains: ["cosmos:1"] },
    }).sort((a, b) => a - b),
    [1, 10, 8453],
  );
  assert.deepEqual(approvedEip155ChainIds(null), []);
});

test("scoped properties mirror the capability probe for approved atomic chains only", async () => {
  const namespaces = { eip155: { chains: ["eip155:1", "eip155:8453"] } };
  const seen: unknown[] = [];
  const scoped = await buildWalletConnectScopedProperties(
    PK_ACCOUNT,
    namespaces,
    async (address, chainIds, account) => {
      seen.push([address, chainIds, account?.id]);
      return {
        "0x1": { atomic: { status: "supported" }, atomicBatch: { supported: true } },
        "0x2105": { paymasterService: { supported: true } },
        "0xa": { atomic: { status: "supported" } },
      };
    },
  );
  assert.deepEqual(seen, [[ADDRESS, ["0x1", "0x2105"], "pk-1"]]);
  // Only the standard EIP-5792 atomic capability is advertised.
  assert.deepEqual(scoped, { "eip155:1": { atomic: { status: "supported" } } });
  assert.deepEqual(
    await buildWalletConnectScopedProperties(PK_ACCOUNT, namespaces, async () => ({
      "0x1": { atomic: { status: "ready" } },
      "0x2105": { atomic: { status: "unsupported" } },
    })),
    { "eip155:1": { atomic: { status: "ready" } } },
  );
});

test("a failed, slow, or empty probe omits the advertisement", async () => {
  const namespaces = { eip155: { chains: ["eip155:1"] } };
  assert.equal(
    await buildWalletConnectScopedProperties(PK_ACCOUNT, namespaces, async () => {
      throw new Error("rpc down");
    }),
    undefined,
  );
  assert.equal(
    await buildWalletConnectScopedProperties(
      PK_ACCOUNT,
      namespaces,
      () => new Promise(() => undefined),
      10,
    ),
    undefined,
  );
  assert.equal(
    await buildWalletConnectScopedProperties(PK_ACCOUNT, namespaces, async () => ({})),
    undefined,
  );
});

test("session approval scopedProperties carry the same atomic capability as wallet_getCapabilities", async () => {
  const harness = createChromeStorageHarness({ local: { accounts: [BANKR_ACCOUNT] } });
  try {
    const kit = fakeKit();
    const result = await approveWalletConnectProposalForAccount(
      kit,
      proposal(1),
      BANKR_ACCOUNT,
      async () => undefined,
      () => undefined,
    );
    assert.deepEqual(result, { success: true });
    const [kind, args] = kit.calls[0];
    assert.equal(kind, "approve");
    const approvedChains = approvedEip155ChainIds(args.namespaces);
    assert.ok(approvedChains.length > 0);

    const capabilities = await handleWalletGetCapabilities(
      ADDRESS,
      approvedChains.map((chainId) => `0x${chainId.toString(16)}` as `0x${string}`),
      BANKR_ACCOUNT,
    );
    const expected = Object.fromEntries(
      approvedChains
        .filter((chainId) => capabilities[`0x${chainId.toString(16)}`]?.atomic)
        .map((chainId) => [
          `eip155:${chainId}`,
          { atomic: capabilities[`0x${chainId.toString(16)}`].atomic },
        ]),
    );
    assert.ok(Object.keys(expected).length > 0, "Bankr advertises atomic chains");
    assert.deepEqual(args.scopedProperties, expected);
    for (const key of Object.keys(args.scopedProperties)) {
      assert.ok(args.namespaces.eip155.chains.includes(key), `${key} is approved`);
    }
  } finally {
    harness.restore();
  }
});

test("session approval still succeeds when the capability probe throws", async () => {
  const harness = createChromeStorageHarness({ local: { accounts: [BANKR_ACCOUNT] } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: { port: 0 } },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { "@": path.join(root, "src") } },
    plugins: [{
      name: "throwing-capability-probe",
      enforce: "pre",
      resolveId(source, importer) {
        return source === "../batchTxHandlers" &&
          importer?.endsWith("/walletConnect/sessionCapabilities.ts")
          ? "\0throwing-capability-probe"
          : null;
      },
      load(id) {
        return id === "\0throwing-capability-probe"
          ? "export const handleWalletGetCapabilities = async () => { throw new Error('probe failed'); };"
          : null;
      },
    }],
  });
  try {
    const { approveWalletConnectProposalForAccount: approve } = await server.ssrLoadModule(
      "/src/chrome/walletConnect/sessionProposal.ts",
    );
    const kit = fakeKit();
    let rejected = 0;
    const result = await approve(kit, proposal(2), BANKR_ACCOUNT, async () => undefined, () => {
      rejected += 1;
    });
    assert.deepEqual(result, { success: true });
    assert.equal(rejected, 0);
    assert.equal(kit.calls.length, 1);
    assert.equal(kit.calls[0][0], "approve");
    assert.ok(kit.calls[0][1].namespaces.eip155.chains.length > 0);
    assert.equal("scopedProperties" in kit.calls[0][1], false);
  } finally {
    await server.close();
    harness.restore();
  }
});
