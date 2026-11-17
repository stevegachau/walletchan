# Batch tests

`architecture.test.ts` freezes the extracted ERC-5792 module boundaries,
facade identities, encoding bytes, origin scoping, durable queue compensation,
credential authorization, and sequential ambiguity policy. Atomic delegate
reauthorization and non-expiring private-key/seed/Bankr confirmation coverage
are colocated here as well. Broader shared
transport/lifecycle tests remain at `tests/` until their owning production
domains move.

`decisionResultPublication.test.ts` freezes which executors publish
`batchTxResult` decisions with same-chain `chainId`/`transactionHashes` (local
single/atomic/sequential and Bankr), that force-inclusion L1 deposits never do,
and that rejection/terminalization writes carry explicit codes; these records
answer deferred WalletConnect `wallet_sendCalls` requests.

The security runner discovers this directory recursively.
