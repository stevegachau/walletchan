/**
 * Trusted wallet-UI decisions on pending WalletConnect session proposals.
 *
 * Connecting exposes only public addresses, so neither decision needs an
 * unlocked session. Both are first-action-wins: the router installs an
 * in-process claim and the pending record is removed atomically before any
 * relay effect, so a double click, a second surface, or a late expiry can
 * never approve and reject (or approve twice) the same proposal.
 *
 * The WalletKit client and broadcasts are injected by the background
 * composition root so this module stays free of SDK import side effects.
 */

import type {
  PendingWalletConnectProposal,
  WalletConnectProposalDecisionResult,
  WalletConnectProposalRejection,
} from "@/types/walletConnect";
import { getActiveAccount } from "../accountStorage";
import {
  findPendingWalletConnectProposal,
  getPendingWalletConnectProposals,
  takePendingWalletConnectProposal,
} from "./proposalStorage";
import { approveWalletConnectProposalForAccount } from "./sessionProposal";

export const WALLETCONNECT_PROPOSAL_USER_REJECTED_MESSAGE =
  "walletConnectProposalUserRejected";
const USER_REJECTED_REASON = { code: 5000, message: "User rejected" };

const NOT_FOUND: WalletConnectProposalDecisionResult = {
  success: false,
  code: "notFound",
  error: "This connection request is no longer pending.",
};
const EXPIRED: WalletConnectProposalDecisionResult = {
  success: false,
  code: "expired",
  error: "This connection request expired. Ask the app for a new WalletConnect link.",
};

export interface WalletConnectProposalDecisionDependencies {
  ensureWalletKit: () => Promise<any>;
  onSessionsChanged: () => Promise<void>;
  onProposalRejected: (rejection: WalletConnectProposalRejection) => void;
}

export function parseWalletConnectProposalId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

async function rejectAtRelay(
  dependencies: WalletConnectProposalDecisionDependencies,
  id: number,
  reason = USER_REJECTED_REASON,
) {
  try {
    const kit = await dependencies.ensureWalletKit();
    await kit.rejectSession({ id, reason });
  } catch (error) {
    // The SDK has already dropped expired proposals; nothing remains to answer.
    console.warn("[WalletConnect] Proposal rejection was not delivered", error);
  }
}

/** WalletKit returns `proposal.getAll()` (an array) despite its Record typing. */
function findSdkProposal(kit: any, id: number): any | null {
  const pending: unknown = kit.getPendingSessionProposals?.();
  const list = Array.isArray(pending) ? pending : Object.values(pending ?? {});
  return list.find((proposal: any) => proposal?.id === id) ?? null;
}

async function getPendingProposals(): Promise<{
  success: true;
  proposals: PendingWalletConnectProposal[];
}> {
  return { success: true, proposals: await getPendingWalletConnectProposals() };
}

async function approveProposal(
  dependencies: WalletConnectProposalDecisionDependencies,
  rawProposalId: unknown,
  expectedAccountId?: unknown,
): Promise<WalletConnectProposalDecisionResult> {
  const id = parseWalletConnectProposalId(rawProposalId);
  if (id === null) {
    return { success: false, code: "invalid", error: "Invalid connection request" };
  }
  const pending = await findPendingWalletConnectProposal(id);
  if (!pending) return NOT_FOUND;
  if (pending.expiresAt <= Date.now()) {
    if (await takePendingWalletConnectProposal(id)) {
      await rejectAtRelay(dependencies, id, { code: 5000, message: "Connection request expired" });
    }
    return EXPIRED;
  }

  // Re-read the account at decision time; the UI names the account it showed
  // so a selection changed elsewhere cannot silently expose another address.
  const account = await getActiveAccount();
  if (
    typeof expectedAccountId === "string" &&
    account?.id !== expectedAccountId
  ) {
    return {
      success: false,
      code: "accountChanged",
      error: "The selected account changed. Review the account and try again.",
    };
  }

  const kit = await dependencies.ensureWalletKit();
  if (!(await takePendingWalletConnectProposal(id))) return NOT_FOUND;
  const params = findSdkProposal(kit, id);
  if (!params) return EXPIRED;
  return approveWalletConnectProposalForAccount(
    kit,
    { id, params },
    account,
    dependencies.onSessionsChanged,
    dependencies.onProposalRejected,
  );
}

async function rejectProposal(
  dependencies: WalletConnectProposalDecisionDependencies,
  rawProposalId: unknown,
): Promise<WalletConnectProposalDecisionResult> {
  const id = parseWalletConnectProposalId(rawProposalId);
  if (id === null) {
    return { success: false, code: "invalid", error: "Invalid connection request" };
  }
  const taken = await takePendingWalletConnectProposal(id);
  if (!taken) return NOT_FOUND;
  await rejectAtRelay(dependencies, id);
  chrome.runtime
    .sendMessage({
      type: WALLETCONNECT_PROPOSAL_USER_REJECTED_MESSAGE,
      proposalId: id,
      name: taken.name,
      url: taken.url,
    })
    .catch(() => {});
  return { success: true };
}

export function createWalletConnectProposalDecisionHandlers(
  dependencies: WalletConnectProposalDecisionDependencies,
) {
  return {
    handleWalletConnectGetPendingProposals: getPendingProposals,
    handleWalletConnectApproveProposal: (
      proposalId: unknown,
      expectedAccountId?: unknown,
    ) => approveProposal(dependencies, proposalId, expectedAccountId),
    handleWalletConnectRejectProposal: (proposalId: unknown) =>
      rejectProposal(dependencies, proposalId),
  };
}
