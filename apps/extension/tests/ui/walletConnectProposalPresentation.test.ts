import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalletConnectVerifyPresentation,
  canConnectWalletConnectAccountType,
  displayHostname,
  summarizeRequestedNetworks,
} from "../../src/components/WalletConnectProposal/proposalPresentation";

const URL = "https://app.example.com";

test("Verify verdicts map to distinct, escalating presentations", () => {
  const verified = buildWalletConnectVerifyPresentation(
    { validation: "VALID", origin: URL, isScam: false },
    URL,
  );
  assert.equal(verified.kind, "verified");
  assert.equal(verified.tone, "success");
  assert.equal(verified.requiresAcknowledgement, false);

  const unknown = buildWalletConnectVerifyPresentation(
    { validation: "UNKNOWN", origin: "", isScam: false },
    URL,
  );
  assert.equal(unknown.kind, "unverified");
  assert.equal(unknown.tone, "warning");
  assert.match(unknown.description, /app\.example\.com/);
  assert.equal(unknown.requiresAcknowledgement, false);

  const mismatch = buildWalletConnectVerifyPresentation(
    { validation: "INVALID", origin: "https://evil.example", isScam: false },
    URL,
  );
  assert.equal(mismatch.kind, "mismatch");
  assert.equal(mismatch.tone, "error");
  assert.match(mismatch.description, /app\.example\.com.*evil\.example/);
  assert.equal(mismatch.requiresAcknowledgement, true);

  // A scam flag wins over any validation result.
  const scam = buildWalletConnectVerifyPresentation(
    { validation: "VALID", origin: "https://evil.example", isScam: true },
    URL,
  );
  assert.equal(scam.kind, "scam");
  assert.equal(scam.tone, "error");
  assert.equal(scam.requiresAcknowledgement, true);
});

test("hostnames only come from http(s) URLs", () => {
  assert.equal(displayHostname("https://app.example.com/path"), "app.example.com");
  assert.equal(displayHostname("javascript:alert(1)"), null);
  assert.equal(displayHostname(""), null);
  assert.equal(displayHostname("not a url"), null);
});

test("requested networks list required first, dedupe, and cap", () => {
  const names: Record<number, string> = { 1: "Ethereum", 8453: "Base" };
  const summary = summarizeRequestedNetworks(
    [8453],
    [1, 8453, 10, 11, 12, 13, 14, 15],
    (chainId) => names[chainId] ?? null,
    4,
  );
  assert.deepEqual(summary.items, [
    { chainId: 8453, name: "Base", required: true },
    { chainId: 1, name: "Ethereum", required: false },
    { chainId: 10, name: "Chain 10", required: false },
    { chainId: 11, name: "Chain 11", required: false },
  ]);
  assert.equal(summary.hiddenCount, 4);
});

test("account eligibility mirrors the WalletConnect session policy", () => {
  for (const type of ["privateKey", "seedPhrase", "ledger", "trezor", "bankr", "safe"] as const) {
    assert.equal(canConnectWalletConnectAccountType(type), true, type);
  }
  assert.equal(canConnectWalletConnectAccountType("impersonator"), false);
});
