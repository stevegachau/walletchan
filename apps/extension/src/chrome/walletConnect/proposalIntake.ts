/**
 * Session proposal intake. Never approves: records a sanitized, display-only
 * pending proposal and surfaces the review screen. Approval happens only in
 * `proposalDecisions.ts` after the user explicitly chooses Connect.
 */

import type {
  PendingWalletConnectProposal,
  WalletConnectVerifyValidation,
} from "@/types/walletConnect";
import { openExtensionPopup } from "../txHandlers";
import { getSessionMetadata, sanitizeWalletConnectMetadataUrl } from "./sessionPolicy";
import { getProposalNamespaceSummary } from "./proposal";
import {
  DEFAULT_WALLETCONNECT_PROPOSAL_TTL_MS,
  MAX_WALLETCONNECT_PROPOSAL_TTL_MS,
  savePendingWalletConnectProposal,
} from "./proposalStorage";

export const NEW_PENDING_WALLETCONNECT_PROPOSAL_MESSAGE =
  "newPendingWalletConnectProposalRequest";
const MAX_PAIRING_TOPIC_CHARS = 512;
const VERIFY_VALIDATIONS = new Set<WalletConnectVerifyValidation>([
  "VALID",
  "INVALID",
  "UNKNOWN",
]);

function proposalExpiresAt(params: any, now: number): number {
  const seconds = Number(params?.expiryTimestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return now + DEFAULT_WALLETCONNECT_PROPOSAL_TTL_MS;
  }
  return Math.min(seconds * 1000, now + MAX_WALLETCONNECT_PROPOSAL_TTL_MS);
}

/** Sanitized, bounded, non-secret record of a raw `session_proposal` event. */
export function buildPendingWalletConnectProposal(
  proposal: any,
  now = Date.now(),
): PendingWalletConnectProposal | null {
  const id = proposal?.id;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const params = proposal?.params;
  const metadata = getSessionMetadata({
    peer: { metadata: params?.proposer?.metadata },
  });
  const verified = proposal?.verifyContext?.verified;
  const validation = VERIFY_VALIDATIONS.has(verified?.validation)
    ? (verified.validation as WalletConnectVerifyValidation)
    : "UNKNOWN";
  const pairingTopic =
    typeof params?.pairingTopic === "string" &&
    params.pairingTopic.length <= MAX_PAIRING_TOPIC_CHARS
      ? params.pairingTopic
      : "";
  let summary: ReturnType<typeof getProposalNamespaceSummary>;
  try {
    summary = getProposalNamespaceSummary(params);
  } catch {
    summary = { requiredChainIds: [], optionalChainIds: [], methods: [] };
  }
  return {
    id,
    pairingTopic,
    name: metadata.name,
    url: metadata.url,
    ...(metadata.description ? { description: metadata.description } : {}),
    icons: metadata.icons,
    ...summary,
    verification: {
      validation,
      origin: sanitizeWalletConnectMetadataUrl(verified?.origin),
      isScam: verified?.isScam === true,
    },
    createdAt: now,
    expiresAt: proposalExpiresAt(params, now),
  };
}

/**
 * Records the proposal and surfaces the review screen. Nothing is approved
 * here; malformed or over-capacity proposals are rejected fail-closed.
 */
export async function handleWalletConnectSessionProposal(
  kit: any,
  proposal: any,
): Promise<void> {
  const record = buildPendingWalletConnectProposal(proposal);
  if (!record) return;
  const saved = await savePendingWalletConnectProposal(record).catch(
    () => ({ saved: false, reason: "capacity" }) as const,
  );
  if (!saved.saved && saved.reason !== "duplicate") {
    await kit
      .rejectSession({
        id: record.id,
        reason: {
          code: 5000,
          message:
            saved.reason === "expired"
              ? "Connection request expired"
              : "Too many pending WalletConnect connection requests",
        },
      })
      .catch(() => undefined);
    return;
  }

  chrome.runtime
    .sendMessage({
      type: NEW_PENDING_WALLETCONNECT_PROPOSAL_MESSAGE,
      proposal: record,
    })
    .catch(() => {});
  await openExtensionPopup().catch((error) => {
    console.warn(
      "[WalletConnect] Failed to open connection review",
      error,
    );
  });
}
