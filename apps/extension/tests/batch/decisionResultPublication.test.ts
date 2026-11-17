// Every batch decision publishes batchTxResult, which answers a deferred
// WalletConnect wallet_sendCalls. Same-chain broadcasts publish their hashes
// for CAIP-345; cross-chain force-inclusion deposits never do.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative: string) =>
  readFile(new URL(`../../src/chrome/${relative}`, import.meta.url), "utf8");

function batchResultWrites(source: string): string[] {
  return [...source.matchAll(/writeResultToStorage\(`batchTxResult:\$\{[^}]+\}`,\s*\{([\s\S]*?)\}\)/g)]
    .map((match) => match[1]);
}

test("local and Bankr broadcasts publish chain id and same-chain hashes", async () => {
  for (const file of [
    "batch/batchAtomic7702Execution.ts",
    "batch/batchSingleExecution.ts",
    "batch/batchSequentialExecution.ts",
    "batch/batchBankrProcessing.ts",
  ]) {
    const successes = batchResultWrites(await read(file)).filter((body) =>
      /success:\s*true/.test(body),
    );
    assert.ok(successes.length > 0, `${file} publishes a success decision`);
    for (const body of successes) {
      assert.match(body, /chainId/, `${file} publishes its chain id`);
      assert.match(body, /transactionHashes/, `${file} publishes its hashes`);
    }
  }
});

test("force inclusion L1 deposits never claim CAIP-345 hashes on the L2 chain", async () => {
  for (const file of [
    "forceInclusion/batchLocalReceipts.ts",
    "forceInclusion/batchBankr.ts",
    "forceInclusion/splitBatchSequencer.ts",
  ]) {
    for (const body of batchResultWrites(await read(file))) {
      assert.doesNotMatch(body, /transactionHashes/, file);
    }
  }
});

test("user rejection and authorization terminalization publish explicit codes", async () => {
  const [status, terminalization, staging, lifecycle, feePayment] = await Promise.all([
    read("batch/batchRequestStatusHandlers.ts"),
    read("requests/pendingRequestTerminalization.ts"),
    read("crossDappBatch/staging.ts"),
    read("crossDappBatch/lifecycle.ts"),
    read("feePayment/batchExecution.ts"),
  ]);
  assert.match(batchResultWrites(status).join("\n"), /code:\s*4001/);
  assert.match(terminalization, /`batchTxResult:\$\{pending\.id\}`[\s\S]*?code:\s*failure\.code/);
  // Remove-one and reject-all both answer user rejection.
  assert.equal(
    batchResultWrites(staging).filter((body) => /code:\s*4001/.test(body)).length,
    2,
  );
  assert.match(batchResultWrites(lifecycle).join("\n"), /\bcode\b/);
  // Fee-token batches answer once the bundler accepts the user operation.
  assert.ok(
    batchResultWrites(feePayment).some((body) => /userOperationSubmitted:\s*true/.test(body)),
  );
});

test("the EOA intake ack is a queue acknowledgement, not a decision", async () => {
  const intake = await read("batch/batchRequestIntake.ts");
  assert.match(
    intake,
    /writeResultToStorage\(`batchTxAck:\$\{bundleId\}`,\s*\{\s*success:\s*true,\s*id:\s*bundleId,\s*awaitingUserDecision:\s*true,?\s*\}\)/,
  );
});
