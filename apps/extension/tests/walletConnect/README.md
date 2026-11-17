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
- `csp.test.ts` proves WalletConnect Pay remains fail-closed and that the
  background bundle uses the extension-owned CSP-safe shim.

The trusted-UI session router remains in `../background/` because that test
audits Chrome message transport rather than the WalletConnect protocol itself.
