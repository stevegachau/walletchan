/** Namespace approval policy; runs only after an explicit Connect (`proposalDecisions.ts`). */

import { buildApprovedNamespaces } from "@walletconnect/utils";
import { getStoredNetworksInfo, getVisibleChains } from "@/lib/chains";
import type { WalletConnectProposalDecisionResult, WalletConnectProposalRejection } from "@/types/walletConnect";
import type { Account } from "../types";
import { WALLETCONNECT_SUPPORTED_EVENTS } from "./sessionPolicy";
import { getWalletConnectMethodsForAccount, isSessionAccount } from "./sessionAccountPolicy";
import { getSafeAccountRecord } from "../safe/accountRepository";
import { buildWalletConnectScopedProperties } from "./sessionCapabilities";
import { requireSafeFeature } from "../safe/featurePolicy";
import {
  buildProposalRejection,
  hasApprovedNamespaces,
  normalizeWalletConnectProposal,
  type WalletConnectSupportedNamespaces,
} from "./proposal";

/** Approves `proposal` for `account` or rejects it; the caller claimed the user's decision. */
export async function approveWalletConnectProposalForAccount(
  kit: any,
  proposal: any,
  account: Account | null,
  onSessionsChanged: () => Promise<void>,
  onProposalRejected: (rejection: WalletConnectProposalRejection) => void,
): Promise<WalletConnectProposalDecisionResult> {
  if (!isSessionAccount(account)) {
    const reason = { code: 4001, message: "No signing account is active" };
    await kit.rejectSession({ id: proposal.id, reason }).catch(() => undefined);
    return { success: false, code: "rejected", error: reason.message };
  }

  try {
    const networksInfo = await getStoredNetworksInfo();
    const visibleChains = getVisibleChains(networksInfo, account.type);
    let eligibleChains = visibleChains;
    if (account.type === "safe") {
      requireSafeFeature("walletConnect");
      const record = await getSafeAccountRecord(account.id);
      eligibleChains = visibleChains.filter((chain) => {
        const snapshot = record?.chains[String(chain.chainId)];
        return !!snapshot && ["approve", "quorumAvailable", "readyToExecute"].includes(snapshot.capability);
      });
    }
    const chains = eligibleChains.map((chain) => `eip155:${chain.chainId}`);
    const accounts = chains.map((chain) => `${chain}:${account.address}`);
    const supportedNamespaces: WalletConnectSupportedNamespaces = {
      eip155: {
        chains,
        accounts,
        methods: getWalletConnectMethodsForAccount(account),
        events: WALLETCONNECT_SUPPORTED_EVENTS,
      },
    };
    const namespaces = buildApprovedNamespaces({
      proposal: normalizeWalletConnectProposal(
        proposal.params,
        supportedNamespaces,
      ),
      supportedNamespaces,
    });
    if (!hasApprovedNamespaces(namespaces)) {
      throw new Error(
        "No supported WalletConnect chains or methods matched this dapp",
      );
    }

    // Advertise the same atomic capability wallet_getCapabilities returns;
    // best effort, so a failed or slow probe only omits it.
    const scopedProperties = await buildWalletConnectScopedProperties(
      account,
      namespaces,
    );
    await kit.approveSession({
      id: proposal.id,
      namespaces,
      ...(scopedProperties ? { scopedProperties } : {}),
    });
    void onSessionsChanged();
    return { success: true };
  } catch (error) {
    const rejection = await buildProposalRejection(
      proposal,
      account.type,
      error,
    );
    onProposalRejected(rejection);
    await kit
      .rejectSession({ id: proposal.id, reason: { code: 5000, message: rejection.error } })
      .catch(() => undefined);
    return { success: false, code: "rejected", error: rejection.error, rejection };
  }
}
