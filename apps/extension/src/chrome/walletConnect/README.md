# WalletConnect audit domain

All implementations and callers use this folder directly; there is no root
compatibility family. Review implementation in this order:

1. `requestValidation.ts`, `sessionPolicy.ts` — bounded request, CAIP, method,
   account, and metadata policy without SDK ownership. `signatureMethodPolicy.ts`
   rejects deprecated signature methods before pending-request preparation.
2. `storage.ts`, `protocol.ts`, `outbox.ts` — durable remote-request claims,
   first terminal responses, and replay/removal ordering.
3. `pendingRequests.ts`, `batchRequests.ts`, `rpcRequests.ts` — transaction,
   signature, ERC-5792, and safe RPC method adapters. Every `wallet_sendCalls`
   opens a durable `batch` route keyed by its wallet-generated bundle id, so
   the JSON-RPC answer is deferred until the user decides. `batchResponse.ts`
   is the pure (storage-type-only) mapping from `batchTxAck`/`batchTxResult`
   records to that answer: the EOA intake ack (`awaitingUserDecision: true`)
   never answers; the first `batchTxResult` answers `{ id }` plus WalletConnect
   `capabilities.caip345` when the executor published same-chain `chainId` +
   `transactionHashes`, or an error (`4001 "User rejected the request."` for
   user rejection). Safe batches still answer on the owner-approved ack.
4. `requestRouter.ts` — claimed session-request dispatch after validation and
   method approval.
5. `proposal.ts`, `proposalIntake.ts`, `proposalStorage.ts`,
   `proposalDecisions.ts`, `sessionProposal.ts`, `chainState.ts` — proposal intake, the explicit
   user decision, namespace approval, rejection metadata, and active-chain
   synchronization. A `session_proposal` is never auto-approved:
   `proposalIntake.ts` records a sanitized, display-only entry in the bounded
   `walletConnectPendingProposals` queue (`proposalStorage.ts`: ≤10 live
   entries, expiry from `params.expiryTimestamp` capped at 15 minutes, atomic
   first-wins removal), broadcasts `newPendingWalletConnectProposalRequest`,
   and opens the request surface. `proposalDecisions.ts` handles the trusted-UI
   `walletConnectGetPendingProposals` / `walletConnectApproveProposal` /
   `walletConnectRejectProposal` routes. It is built by
   `createWalletConnectProposalDecisionHandlers` so `sessionCommands.ts` injects
   `ensureWalletKit` and the broadcasts (no SDK import side effects). Connect
   re-reads the active account, requires `isSessionAccount`, removes the record,
   re-reads the authoritative proposal from the WalletKit store, then runs
   `approveWalletConnectProposalForAccount` (the unchanged Safe-eligibility and
   `buildApprovedNamespaces` policy). `sessionCapabilities.ts` then derives
   WalletKit `scopedProperties` (`{ "eip155:<id>": { atomic: { status } } }`,
   WalletConnect's documented shape, "supported"/"ready" chains only) from the
   same `handleWalletGetCapabilities`
   via the `../batchTxHandlers` facade; it is bounded to 3 seconds and any
   failure omits it without affecting the approval. Reject answers 5000 "User rejected" and
   broadcasts `walletConnectProposalUserRejected`. Dependency direction:
   `client.ts` → `proposalIntake.ts` → `proposalStorage.ts`;
   `proposalDecisions.ts` → `sessionProposal.ts`/`proposalStorage.ts` (never
   `client.ts`); `sessionCommands.ts` binds the decisions to the client as
   `walletConnectProposalCommands`. The SDK `proposal_expire` listener and WalletConnect reset
   clear pending records.
6. `keepalive.ts`, `reset.ts` — relay liveness and replacement-wallet SDK
   namespace teardown. Hosts that freeze the worker (the Android app in
   `apps/android`) dispatch `walletchan:relay-nudge` on the worker global when
   they resume; keepalive then fetches queued relay messages immediately.
7. `client.ts`, `sessionCommands.ts`, `resultBridge.ts` — SDK lifecycle,
   trusted-UI commands, and durable result delivery composition.
   `resultBridge.ts` commits the terminal response to the outbox before
   acquiring WalletKit. `resultMapping.ts` is its pure key/record → JSON-RPC
   mapping: only batch prefixes can answer a batch route, and batch prefixes
   never answer a transaction/signature/permission route. In the
   Android app (`__WALLETCHAN_PLATFORM__ === "android"`) the WalletKit
   metadata advertises `redirect.native: "walletchan://"`; the extension
   advertises no redirect.
8. `payUnavailable.ts` — CSP-safe fail-closed alias for optional Pay support.

Storage key names, namespace rotation, SDK listener generation checks, and
terminal-response persistence are compatibility boundaries. Folder moves must
not alter them.

Unresolved transaction, signature, ERC-5792 batch, and ERC-7715 permission routes are durable
until the user decides or the WalletConnect session is explicitly terminated.
Only pre-prompt intake claims and already-terminal response routes have bounded
retention so abandoned transport metadata cannot consume capacity forever.
