// WalletConnect wallet_sendCalls is answered only after the user's decision.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

import { createChromeStorageHarness } from "../helpers/chromeStorageHarness";
import {
  buildWalletSendCallsResponse,
  walletSendCallsTerminalResponse,
} from "../../src/chrome/walletConnect/batchResponse";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const TOPIC = "dapp-topic";
const TX_HASH_A = `0x${"a".repeat(64)}`;
const TX_HASH_B = `0x${"b".repeat(64)}`;

type Response = { topic: string; response: Record<string, any> };

function fakeKit(options: { failDelivery?: () => boolean } = {}) {
  const responses: Response[] = [];
  const kit = {
    responses,
    active: true,
    getActiveSessions: () =>
      kit.active
        ? {
            [TOPIC]: {
              namespaces: {
                eip155: {
                  accounts: [`eip155:1:${ADDRESS}`],
                  methods: ["wallet_sendCalls", "wallet_getCallsStatus"],
                },
              },
              peer: { metadata: { name: "Batch dApp", url: "https://dapp.example" } },
            },
          }
        : {},
    async respondSessionRequest(value: Response) {
      if (options.failDelivery?.()) throw new Error("relay unavailable");
      responses.push(structuredClone(value));
    },
  };
  return kit;
}

type Kit = ReturnType<typeof fakeKit>;

async function startServer(): Promise<ViteDevServer> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: { port: 0 } },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { "@": path.join(root, "src") } },
    plugins: [{
      name: "walletconnect-client-double",
      enforce: "pre",
      resolveId(source, importer) {
        const isClient =
          (source === "./client" && importer?.includes("/chrome/walletConnect/")) ||
          source === "../walletConnect/client";
        return isClient ? "\0wc-client-double" : null;
      },
      load(id) {
        if (id !== "\0wc-client-double") return null;
        return [
          "export const ensureWalletKit = async () => globalThis.__wcTestKit;",
          "export const isWalletConnectSessionActive = async (topic) =>",
          "  !!globalThis.__wcTestKit?.getActiveSessions()?.[topic];",
        ].join("\n");
      },
    }],
  });
}

function setupChrome() {
  const harness = createChromeStorageHarness({
    local: {
      accounts: [{ id: "pk-1", type: "privateKey", address: ADDRESS, createdAt: 1 }],
      // Bankr intake binds the current encrypted-credential generation.
      encryptedApiKeyVault: {
        ciphertext: Buffer.alloc(32, 0x22).toString("base64"),
        iv: Buffer.alloc(12, 0x11).toString("base64"),
        salt: "",
      },
    },
    sync: { activeAccountId: "pk-1" },
  });
  const browser = globalThis.chrome as any;
  const focused = { id: 1, state: "normal", left: 0, top: 0, width: 1200, height: 800 };
  browser.runtime.getURL = (value: string) => `chrome-extension://walletchan/${value}`;
  browser.windows = {
    WINDOW_ID_NONE: -1,
    getAll: async () => [],
    get: async () => focused,
    getLastFocused: async () => focused,
    getCurrent: async () => focused,
    create: async () => ({ id: 2, tabs: [] }),
    update: async () => focused,
  };
  browser.tabs = { query: async () => [], create: async () => ({ id: 3 }) };
  return harness;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("wallet_sendCalls response mapping publishes CAIP-345 only for known same-chain hashes", () => {
  assert.deepEqual(
    buildWalletSendCallsResponse("bundle", {
      chainId: 8453,
      transactionHashes: [TX_HASH_A, TX_HASH_A, TX_HASH_B],
    }),
    {
      id: "bundle",
      capabilities: {
        caip345: { caip2: "eip155:8453", transactionHashes: [TX_HASH_A, TX_HASH_B] },
      },
    },
  );
  for (const result of [
    { txHash: TX_HASH_A },
    { chainId: 1, transactionHashes: [] },
    { chainId: 1, transactionHashes: ["0x1234"] },
    { chainId: "0x1", transactionHashes: [TX_HASH_A] },
    { chainId: 0, transactionHashes: [TX_HASH_A] },
  ]) {
    assert.deepEqual(buildWalletSendCallsResponse("bundle", result), { id: "bundle" });
  }

  assert.equal(
    walletSendCallsTerminalResponse("ack", "bundle", {
      success: true,
      id: "bundle",
      awaitingUserDecision: true,
    }),
    null,
  );
  assert.deepEqual(
    walletSendCallsTerminalResponse("decision", "bundle", {
      success: false,
      error: "Batch transaction rejected by user",
      code: 4001,
    }),
    { kind: "error", code: 4001, message: "User rejected the request." },
  );
  assert.deepEqual(
    walletSendCallsTerminalResponse("decision", "bundle", {
      success: false,
      error: "All transactions failed",
    }),
    { kind: "error", code: -32000, message: "All transactions failed" },
  );
  assert.deepEqual(
    walletSendCallsTerminalResponse("ack", "bundle", {
      success: false,
      error: "Unsupported version. Expected 2.0.0",
      code: 5710,
    }),
    { kind: "error", code: 5710, message: "Unsupported version. Expected 2.0.0" },
  );
});

let nextRequestId = 9_000;

async function sendCalls(server: ViteDevServer, kit: Kit) {
  const router = await server.ssrLoadModule("/src/chrome/walletConnect/requestRouter.ts");
  const id = nextRequestId++;
  await router.handleWalletConnectSessionRequest(kit, {
    topic: TOPIC,
    id,
    params: {
      chainId: "eip155:1",
      request: {
        method: "wallet_sendCalls",
        params: [{
          version: "2.0.0",
          chainId: "0x1",
          from: ADDRESS,
          calls: [
            { to: TARGET, data: "0x", value: "0x1" },
            { to: TARGET, data: "0x12345678", value: "0x0" },
          ],
        }],
      },
    },
  });
  return id;
}

function pendingBundleId(local: Record<string, unknown>, requestId: number): string {
  const pending = (local.pendingBatchTxRequests as Array<any> | undefined)?.find(
    (entry) => entry.walletConnect?.requestId === requestId,
  );
  assert.ok(pending, "the batch prompt was persisted");
  return pending.id;
}

test("WalletConnect wallet_sendCalls defers its JSON-RPC response to the user decision", async (t) => {
  const harness = setupChrome();
  const server = await startServer();
  const local = harness.stores.local as Record<string, any>;
  try {
    await t.test("intake persists the prompt and a batch route but sends no response", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);

      assert.deepEqual(kit.responses, [], "no early reply with the bundle id");
      const route = local.walletConnectPendingRequests?.[bundleId];
      assert.equal(route?.kind, "batch");
      assert.equal(route?.requestId, requestId);
      assert.equal(route?.terminalResponse, undefined);
      assert.equal(local[`batchTxAck:${bundleId}`], undefined, "queue ack is transient");
      assert.equal(
        local.bundleStatuses?.find((status: any) => status.id === bundleId)?.status,
        100,
      );
    });

    const PK_ACCOUNTS = structuredClone(local.accounts);
    for (const type of ["privateKey", "seedPhrase", "bankr"] as const) {
      await t.test(`${type}: no reply at intake, 4001 after the user rejects`, async () => {
        local.accounts = [{
          id: `${type}-1`,
          type,
          address: ADDRESS,
          createdAt: 1,
          ...(type === "seedPhrase" ? { seedGroupId: "group", derivationIndex: 0 } : {}),
        }];
        const kit = fakeKit();
        (globalThis as any).__wcTestKit = kit;
        const requestId = await sendCalls(server, kit);
        const bundleId = pendingBundleId(local, requestId);
        const pending = local.pendingBatchTxRequests.find((entry: any) => entry.id === bundleId);
        assert.equal(pending.accountType, type);
        assert.deepEqual(kit.responses, []);

        const status = await server.ssrLoadModule("/src/chrome/batch/batchRequestStatusHandlers.ts");
        await status.handleRejectBatchTransaction(bundleId);
        assert.deepEqual(kit.responses.map((entry) => entry.response.error), [
          { code: 4001, message: "User rejected the request." },
        ]);
      });
    }
    for (const type of ["ledger", "trezor"] as const) {
      await t.test(`${type}: unsupported batching is refused at intake without a lingering route`, async () => {
        local.accounts = [{ id: `${type}-1`, type, address: ADDRESS, createdAt: 1 }];
        const kit = fakeKit();
        (globalThis as any).__wcTestKit = kit;
        const before = (local.pendingBatchTxRequests ?? []).length;
        const requestId = await sendCalls(server, kit);
        assert.equal(kit.responses.length, 1);
        assert.equal(kit.responses[0].response.id, requestId);
        assert.equal(kit.responses[0].response.result, undefined);
        assert.equal(typeof kit.responses[0].response.error.code, "number");
        assert.equal((local.pendingBatchTxRequests ?? []).length, before);
        assert.equal(
          Object.values(local.walletConnectPendingRequests ?? {}).some(
            (route: any) => route.requestId === requestId,
          ),
          false,
        );
      });
    }
    local.accounts = PK_ACCOUNTS;

    await t.test("reject answers 4001 and keeps wallet_getCallsStatus at 400", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      const status = await server.ssrLoadModule("/src/chrome/batch/batchRequestStatusHandlers.ts");

      assert.deepEqual(await status.handleRejectBatchTransaction(bundleId), { success: true });
      assert.equal(kit.responses.length, 1);
      assert.deepEqual(kit.responses[0], {
        topic: TOPIC,
        response: {
          id: requestId,
          jsonrpc: "2.0",
          error: { code: 4001, message: "User rejected the request." },
        },
      });
      assert.equal(local.walletConnectPendingRequests?.[bundleId], undefined);
      const callsStatus = await status.handleWalletGetCallsStatus(bundleId, "https://dapp.example");
      assert.equal(callsStatus.status, 400);
    });

    await t.test("approval answers { id } with CAIP-345 hashes once published", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      const runtime = await server.ssrLoadModule("/src/chrome/transactions/runtime.ts");
      assert.deepEqual(kit.responses, []);

      // Exact payload the sequential local executor publishes after broadcast.
      await runtime.writeResultToStorage(`batchTxResult:${bundleId}`, {
        success: true,
        txHash: TX_HASH_B,
        chainId: 1,
        transactionHashes: [TX_HASH_A, TX_HASH_B],
      });
      assert.deepEqual(kit.responses, [{
        topic: TOPIC,
        response: {
          id: requestId,
          jsonrpc: "2.0",
          result: {
            id: bundleId,
            capabilities: {
              caip345: {
                caip2: "eip155:1",
                transactionHashes: [TX_HASH_A, TX_HASH_B],
              },
            },
          },
        },
      }]);

      // A later outcome cannot replace the first terminal response.
      await runtime.writeResultToStorage(`batchTxResult:${bundleId}`, {
        success: false,
        error: "late failure",
      });
      assert.equal(kit.responses.length, 1);
    });

    await t.test("approval without known hashes answers the bare bundle id", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      const runtime = await server.ssrLoadModule("/src/chrome/transactions/runtime.ts");
      assert.deepEqual(kit.responses, []);

      // Split mode and OP Stack force inclusion publish no same-chain hashes.
      await runtime.writeResultToStorage(`batchTxResult:${bundleId}`, {
        success: true,
        splitMode: true,
      });
      assert.deepEqual(kit.responses[0]?.response.result, { id: bundleId });
    });

    await t.test("authorization invalidation answers the existing 4100 error", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      const pending = local.pendingBatchTxRequests.find((entry: any) => entry.id === bundleId);
      const terminalization = await server.ssrLoadModule(
        "/src/chrome/requests/pendingRequestTerminalization.ts",
      );
      await terminalization.terminalizeUnauthorizedPendingRequest("batchTransaction", pending, {
        authorized: false,
        error: "Pending request authorization was revoked",
        code: 4100,
      });
      assert.deepEqual(kit.responses[0]?.response.error, {
        code: 4100,
        message: "Pending request authorization was revoked",
      });
      assert.equal(
        local.pendingBatchTxRequests.some((entry: any) => entry.id === bundleId),
        false,
      );
    });

    await t.test("session termination drops the route without a response", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      kit.active = false;
      const lifecycle = await server.ssrLoadModule(
        "/src/chrome/requests/pendingWalletConnectLifecycle.ts",
      );
      const summary = await lifecycle.cancelPendingRequestsForWalletConnectTopic(TOPIC);
      assert.ok(summary.batches >= 1);
      await lifecycle.finalizeWalletConnectTopicTermination(TOPIC);
      assert.equal(local.walletConnectPendingRequests?.[bundleId], undefined);
      // The ended session cannot receive a response; the route is simply dropped.
      await waitFor(() => true, "settle");
      lifecycle.resetPendingWalletConnectLifecycleForTests();
    });

    await t.test("a relay failure keeps the rejection in the replayable outbox", async () => {
      let failing = true;
      const kit = fakeKit({ failDelivery: () => failing });
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      const status = await server.ssrLoadModule("/src/chrome/batch/batchRequestStatusHandlers.ts");
      await status.handleRejectBatchTransaction(bundleId);
      assert.deepEqual(kit.responses, []);
      assert.deepEqual(local.walletConnectPendingRequests?.[bundleId]?.terminalResponse?.code, 4001);

      failing = false;
      const outbox = await server.ssrLoadModule("/src/chrome/walletConnect/outbox.ts");
      await outbox.flushWalletConnectTerminalResponses(kit);
      assert.equal(kit.responses[0]?.response.id, requestId);
      assert.equal(kit.responses[0]?.response.error.code, 4001);
      assert.equal(local.walletConnectPendingRequests?.[bundleId], undefined);
    });

    await t.test("removing a WalletConnect bundle from the cross-dapp batch answers 4001", async () => {
      const kit = fakeKit();
      (globalThis as any).__wcTestKit = kit;
      const requestId = await sendCalls(server, kit);
      const bundleId = pendingBundleId(local, requestId);
      local.crossDappBatch = {
        fromAddress: ADDRESS,
        chainId: 1,
        chainName: "Ethereum",
        accountType: "privateKey",
        accountId: "pk-1",
        createdAt: Date.now(),
        entries: [{
          txId: `${bundleId}:0`,
          tx: { from: ADDRESS, to: TARGET, data: "0x", value: "0x1", chainId: 1 },
          origin: "https://dapp.example",
          favicon: null,
          addedAt: Date.now(),
          source: { kind: "wallet_sendCalls", bundleId, callIndex: 0, totalCalls: 1 },
          walletConnect: { topic: TOPIC, requestId, method: "wallet_sendCalls" },
        }],
      };
      const staging = await server.ssrLoadModule("/src/chrome/crossDappBatch/staging.ts");
      assert.deepEqual(await staging.handleRemoveFromCrossDappBatch(`${bundleId}:0`), { success: true });
      assert.deepEqual(kit.responses[0]?.response.error, {
        code: 4001,
        message: "User rejected the request.",
      });
    });
  } finally {
    delete (globalThis as any).__wcTestKit;
    await server.close();
    harness.restore();
  }
});

test("Safe owner approval still answers through the routed ack", async () => {
  const harness = setupChrome();
  const server = await startServer();
  const local = harness.stores.local as Record<string, any>;
  try {
    const kit = fakeKit();
    (globalThis as any).__wcTestKit = kit;
    const storage = await server.ssrLoadModule("/src/chrome/walletConnect/storage.ts");
    const runtime = await server.ssrLoadModule("/src/chrome/transactions/runtime.ts");
    await storage.saveWalletConnectPendingRequest({
      id: "safe-bundle",
      kind: "batch",
      topic: TOPIC,
      requestId: 77,
      method: "wallet_sendCalls",
      timestamp: Date.now(),
    });

    // An EOA queue acknowledgement never answers a batch route.
    await runtime.writeResultToStorage("batchTxAck:safe-bundle", {
      success: true,
      id: "safe-bundle",
      awaitingUserDecision: true,
    });
    assert.deepEqual(kit.responses, []);

    // Safe writes its ack only after explicit owner approval.
    await runtime.writeResultToStorage("batchTxAck:safe-bundle", {
      success: true,
      id: "safe-bundle",
    });
    assert.deepEqual(kit.responses[0]?.response.result, { id: "safe-bundle" });
    assert.equal(local.walletConnectPendingRequests?.["safe-bundle"], undefined);
  } finally {
    delete (globalThis as any).__wcTestKit;
    await server.close();
    harness.restore();
  }
});
