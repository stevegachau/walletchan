# WalletConnect tests

This directory freezes the remote-session boundary:

- `architecture.test.ts` enforces the single source folder, 400-line ceiling,
  dependency direction, and direct background composition.
- `accountPolicy.test.ts` covers private-key, seed-phrase, Ledger, Safe,
  impersonator, and Bankr admission plus account-specific WalletConnect methods.
- `requestSecurity.test.ts` covers bounded request validation, CAIP chain/method
  routing, terminal responses, pending-route locking, and queue limits.
- `reset.test.ts` covers replacement-wallet namespace compatibility and ordered
  SDK/session/pairing teardown.
- `proposalApproval.test.ts` covers explicit session-proposal review: no
  auto-approval on arrival, Connect with the active/selected account and the
  unchanged namespace policy, account-change fail-closed, view-only rejection,
  Reject (5000 "User rejected"), expiry, first-action-wins races through the
  router claim, queue bounds/replays, Verify sanitization, and reset clearing.
- `proposalAccess.test.ts` drives the real background message pipeline to
  prove pages, subframes, ENS documents, and other extensions cannot list,
  approve, or reject proposals.
- `batchDeferredResponse.test.ts` drives the real request router, batch
  intake, and result bridge (WalletKit replaced by a fake) to prove
  `wallet_sendCalls` sends no early reply, answers `{ id }` with CAIP-345 hashes
  only after approval, 4001 on reject (including cross-dapp removal), 4100 on
  authorization invalidation, nothing on session termination, replays from the
  outbox after a relay failure, and keeps Safe owner-approval answers.
- `sessionCapabilities.test.ts` proves session approval `scopedProperties`
  carry exactly the standard `atomic` status of the `wallet_getCapabilities`
  answer for approved chains (no legacy keys) and that
  a failing, slow, or empty probe omits them without failing the approval.
- `csp.test.ts` proves WalletConnect Pay remains fail-closed and that the
  background bundle uses the extension-owned CSP-safe shim.

The trusted-UI session router remains in `../background/` because that test
audits Chrome message transport rather than the WalletConnect protocol itself.
