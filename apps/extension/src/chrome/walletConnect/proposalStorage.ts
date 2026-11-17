/**
 * Durable, bounded queue of WalletConnect session proposals awaiting an
 * explicit user decision.
 *
 * Records are display-only public metadata (proposer name/url/icons, chain
 * and method summary, Verify verdict). They never authorize anything: the
 * approval path re-reads the authoritative proposal from the WalletKit store.
 * Removal is atomic under the storage lock so the first decision wins.
 */

import type {
  PendingWalletConnectProposal,
  WalletConnectVerifyValidation,
} from "@/types/walletConnect";
import { withStorageLock } from "../storageLock";

export const WALLETCONNECT_PENDING_PROPOSALS_KEY = "walletConnectPendingProposals";
const STORAGE_LOCK_KEY = `local:${WALLETCONNECT_PENDING_PROPOSALS_KEY}`;

export const MAX_PENDING_WALLETCONNECT_PROPOSALS = 10;
export const DEFAULT_WALLETCONNECT_PROPOSAL_TTL_MS = 5 * 60 * 1000;
export const MAX_WALLETCONNECT_PROPOSAL_TTL_MS = 15 * 60 * 1000;
export const MAX_WALLETCONNECT_PROPOSAL_CHAIN_IDS = 100;
export const MAX_WALLETCONNECT_PROPOSAL_METHODS = 100;
const MAX_TOPIC_CHARS = 512;
const MAX_NAME_CHARS = 200;
const MAX_URL_CHARS = 2_048;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_ICONS = 5;
const MAX_METHOD_CHARS = 128;
const VERIFY_VALIDATIONS: readonly WalletConnectVerifyValidation[] = [
  "VALID",
  "INVALID",
  "UNKNOWN",
];

export type SavePendingWalletConnectProposalResult =
  | { saved: true }
  | { saved: false; reason: "duplicate" | "capacity" | "expired" };

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

function isChainIdList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_WALLETCONNECT_PROPOSAL_CHAIN_IDS &&
    value.every((chainId) => Number.isSafeInteger(chainId) && chainId > 0)
  );
}

export function isPendingWalletConnectProposal(
  value: unknown,
): value is PendingWalletConnectProposal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingWalletConnectProposal>;
  const verification = candidate.verification;
  return (
    Number.isSafeInteger(candidate.id) &&
    (candidate.id as number) > 0 &&
    isBoundedString(candidate.pairingTopic, MAX_TOPIC_CHARS) &&
    isBoundedString(candidate.name, MAX_NAME_CHARS) &&
    candidate.name.length > 0 &&
    isBoundedString(candidate.url, MAX_URL_CHARS) &&
    (candidate.description === undefined ||
      isBoundedString(candidate.description, MAX_DESCRIPTION_CHARS)) &&
    Array.isArray(candidate.icons) &&
    candidate.icons.length <= MAX_ICONS &&
    candidate.icons.every((icon) => isBoundedString(icon, MAX_URL_CHARS)) &&
    isChainIdList(candidate.requiredChainIds) &&
    isChainIdList(candidate.optionalChainIds) &&
    Array.isArray(candidate.methods) &&
    candidate.methods.length <= MAX_WALLETCONNECT_PROPOSAL_METHODS &&
    candidate.methods.every((method) => isBoundedString(method, MAX_METHOD_CHARS)) &&
    !!verification &&
    typeof verification === "object" &&
    VERIFY_VALIDATIONS.includes(verification.validation) &&
    isBoundedString(verification.origin, MAX_URL_CHARS) &&
    typeof verification.isScam === "boolean" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  );
}

async function readStoredProposals(): Promise<PendingWalletConnectProposal[]> {
  const stored = await chrome.storage.local.get(
    WALLETCONNECT_PENDING_PROPOSALS_KEY,
  );
  const value = stored[WALLETCONNECT_PENDING_PROPOSALS_KEY];
  // Malformed records fail closed: they are dropped, never shown or approved.
  return Array.isArray(value)
    ? value.filter(isPendingWalletConnectProposal)
    : [];
}

async function writeStoredProposals(
  proposals: PendingWalletConnectProposal[],
): Promise<void> {
  if (proposals.length === 0) {
    await chrome.storage.local.remove(WALLETCONNECT_PENDING_PROPOSALS_KEY);
    return;
  }
  await chrome.storage.local.set({
    [WALLETCONNECT_PENDING_PROPOSALS_KEY]: proposals,
  });
}

function isLive(proposal: PendingWalletConnectProposal, now: number): boolean {
  return proposal.expiresAt > now;
}

/** Live proposals, oldest first. Expired or malformed entries are pruned. */
export async function getPendingWalletConnectProposals(
  now = Date.now(),
): Promise<PendingWalletConnectProposal[]> {
  const stored = await chrome.storage.local.get(
    WALLETCONNECT_PENDING_PROPOSALS_KEY,
  );
  const raw = stored[WALLETCONNECT_PENDING_PROPOSALS_KEY];
  if (raw === undefined) return [];
  const valid = Array.isArray(raw) ? raw.filter(isPendingWalletConnectProposal) : [];
  const live = valid.filter((proposal) => isLive(proposal, now));
  if (!Array.isArray(raw) || live.length !== raw.length) {
    await withStorageLock(STORAGE_LOCK_KEY, async () => {
      const latest = await readStoredProposals();
      await writeStoredProposals(latest.filter((proposal) => isLive(proposal, now)));
    });
  }
  return live.sort((a, b) => a.createdAt - b.createdAt);
}

/** Returns the stored record for `id`, including an expired one. */
export async function findPendingWalletConnectProposal(
  id: number,
): Promise<PendingWalletConnectProposal | null> {
  return (await readStoredProposals()).find((proposal) => proposal.id === id) ?? null;
}

export async function savePendingWalletConnectProposal(
  proposal: PendingWalletConnectProposal,
  now = Date.now(),
): Promise<SavePendingWalletConnectProposalResult> {
  if (!isPendingWalletConnectProposal(proposal)) {
    throw new Error("Invalid WalletConnect proposal record");
  }
  if (!isLive(proposal, now)) return { saved: false, reason: "expired" };
  return withStorageLock(STORAGE_LOCK_KEY, async () => {
    const live = (await readStoredProposals()).filter((entry) => isLive(entry, now));
    if (live.some((entry) => entry.id === proposal.id)) {
      await writeStoredProposals(live);
      return { saved: false, reason: "duplicate" } as const;
    }
    if (live.length >= MAX_PENDING_WALLETCONNECT_PROPOSALS) {
      await writeStoredProposals(live);
      return { saved: false, reason: "capacity" } as const;
    }
    await writeStoredProposals([...live, proposal]);
    return { saved: true } as const;
  });
}

/**
 * Atomically removes and returns the record for `id` (expired or not). Only
 * the first caller receives it, which makes Connect/Reject first-action-wins
 * across surfaces and service-worker instances sharing storage.
 */
export async function takePendingWalletConnectProposal(
  id: number,
): Promise<PendingWalletConnectProposal | null> {
  return withStorageLock(STORAGE_LOCK_KEY, async () => {
    const stored = await readStoredProposals();
    const taken = stored.find((proposal) => proposal.id === id) ?? null;
    if (taken) {
      await writeStoredProposals(stored.filter((proposal) => proposal.id !== id));
    }
    return taken;
  });
}

export async function clearPendingWalletConnectProposals(): Promise<void> {
  await withStorageLock(STORAGE_LOCK_KEY, async () => {
    await chrome.storage.local.remove(WALLETCONNECT_PENDING_PROPOSALS_KEY);
  });
}
