/**
 * ERC-5792 capability advertisement for WalletConnect session approval.
 *
 * The per-chain values come from the exact `wallet_getCapabilities` handler
 * the session will later answer with, so the two can never disagree. The
 * probe is best effort: a failure or a slow RPC omits the advertisement and
 * never blocks or fails the approval.
 */

import { handleWalletGetCapabilities } from "../batchTxHandlers";
import type { Account } from "../types";

// Optional extra: never hold a connection back for long (speed first); a dApp
// without it simply asks wallet_getCapabilities later.
export const SESSION_CAPABILITY_PROBE_TIMEOUT_MS = 800;

type CapabilityProbe = typeof handleWalletGetCapabilities;
export type WalletConnectScopedProperties = Record<
  string,
  { atomic: { status: "supported" | "ready" } }
>;

/** Approved `eip155:<id>` chains, whether keyed `eip155` or `eip155:<id>`. */
export function approvedEip155ChainIds(namespaces: unknown): number[] {
  if (!namespaces || typeof namespaces !== "object") return [];
  const chainIds = new Set<number>();
  for (const [key, namespace] of Object.entries(namespaces)) {
    if (key !== "eip155" && !key.startsWith("eip155:")) continue;
    const chains = (namespace as { chains?: unknown })?.chains;
    const candidates = Array.isArray(chains)
      ? chains
      : key.startsWith("eip155:")
        ? [key]
        : [];
    for (const chain of candidates) {
      if (typeof chain !== "string") continue;
      const [prefix, reference] = chain.split(":");
      const chainId = Number(reference);
      if (prefix === "eip155" && Number.isSafeInteger(chainId) && chainId > 0) {
        chainIds.add(chainId);
      }
    }
  }
  return [...chainIds];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `{ "eip155:<id>": { atomic: { status } } }` for approved chains whose
 * wallet_getCapabilities entry reports `atomic.status` "supported" or "ready"
 * (WalletConnect's documented scopedProperties shape); `undefined` when
 * nothing should be advertised.
 */
export async function buildWalletConnectScopedProperties(
  account: Account,
  namespaces: unknown,
  probe: CapabilityProbe = handleWalletGetCapabilities,
  timeoutMs = SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
): Promise<WalletConnectScopedProperties | undefined> {
  const chainIds = approvedEip155ChainIds(namespaces);
  if (chainIds.length === 0) return undefined;
  try {
    const capabilities = await withTimeout(
      probe(
        account.address,
        chainIds.map((chainId) => `0x${chainId.toString(16)}` as `0x${string}`),
        account,
      ),
      timeoutMs,
    );
    if (!capabilities || typeof capabilities !== "object") return undefined;
    const scoped: WalletConnectScopedProperties = {};
    for (const chainId of chainIds) {
      const status = capabilities[`0x${chainId.toString(16)}`]?.atomic?.status;
      // Only the standard EIP-5792 `atomic` capability, in WalletConnect's
      // documented CAIP-25 shape; legacy/non-standard keys are not advertised.
      if (status === "supported" || status === "ready") {
        scoped[`eip155:${chainId}`] = { atomic: { status } };
      }
    }
    return Object.keys(scoped).length > 0 ? scoped : undefined;
  } catch {
    return undefined;
  }
}
