# WalletConnect connection review UI

Explicit Connect/Reject screen for a pending WalletConnect session proposal
(`walletConnectPendingProposals`). The background never auto-approves; it
records the proposal and broadcasts `newPendingWalletConnectProposalRequest`.

- `WalletConnectProposalConfirmation.tsx` is the lazy-loaded composition root
  (`app/lazyScreens.ts`, routed by `app/screens/WalletConnectProposalRoute.tsx`).
  It reuses the injected-site pieces from `../DappConnection/`
  (`ConnectionRequestHeader`, `ConnectionPermissionList`) and
  `../DappConnectionAccountSelector.tsx` instead of duplicating them.
- `proposalPresentation.ts` is the pure model: WalletConnect Verify verdict
  copy/tone (verified, unverified, domain mismatch, known scam), display
  hostnames, requested-network summary, and account eligibility that mirrors
  the background `isSessionAccount` policy.
- `WalletConnectVerifyNotice.tsx` renders the Verify badge and the warning or
  error notice. Scam and domain-mismatch verdicts require an explicit
  acknowledgement and turn Connect into a danger "Connect anyway" action;
  Reject is always available.
- `useWalletConnectProposalAccount.ts` reads and changes the wallet-wide
  active account (`getActiveAccount` / `setActiveAccount`). WalletConnect
  sessions are not tab-scoped, so the per-tab account path is never used.
- `useWalletConnectProposalDecision.ts` sends `walletConnectApproveProposal`
  (with the displayed `accountId`) or `walletConnectRejectProposal`, and turns
  a proposal removed elsewhere (other surface, expiry) into a terminal state.

The background (`src/chrome/walletConnect/proposalDecisions.ts`) owns every
effect and is first-action-wins; this folder only presents its answers.
Tests: `tests/ui/walletConnectProposalPresentation.test.ts` and
`tests/walletConnect/proposal*.test.ts`.
