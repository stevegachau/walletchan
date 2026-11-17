import { useCallback, useEffect, useRef, useState } from "react";
import { WALLETCONNECT_PENDING_PROPOSALS_KEY } from "@/chrome/walletConnect/proposalStorage";
import type {
  PendingWalletConnectProposal,
  WalletConnectProposalDecisionResult,
} from "@/types/walletConnect";

type Decision = "approve" | "reject";

/**
 * Connect/Reject lifecycle for one pending proposal. The background is
 * first-action-wins; this hook only reflects its answer. A proposal removed
 * by another surface or by expiry (while this screen is idle) becomes a
 * terminal "already handled" state with a single Close action.
 */
export function useWalletConnectProposalDecision(
  proposal: PendingWalletConnectProposal,
  onFinished: () => void,
) {
  const [inFlight, setInFlight] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTerminal, setIsTerminal] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    setError(null);
    setIsTerminal(false);
    const handleChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      const change = changes[WALLETCONNECT_PENDING_PROPOSALS_KEY];
      if (areaName !== "local" || !change || inFlightRef.current) return;
      const next: unknown = change.newValue;
      const stillPending =
        Array.isArray(next) &&
        next.some((entry) => (entry as { id?: unknown })?.id === proposal.id);
      if (!stillPending) {
        setIsTerminal(true);
        setError("This connection request was already handled or has expired.");
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, [proposal.id]);

  const decide = useCallback(
    async (decision: Decision, accountId?: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setInFlight(decision);
      setError(null);
      try {
        const result = (await chrome.runtime.sendMessage(
          decision === "approve"
            ? { type: "walletConnectApproveProposal", proposalId: proposal.id, accountId }
            : { type: "walletConnectRejectProposal", proposalId: proposal.id },
        )) as WalletConnectProposalDecisionResult | undefined;
        if (result?.success) {
          onFinished();
          return;
        }
        // Rejecting something that is already gone still leaves nothing to do.
        if (decision === "reject" && result?.code === "notFound") {
          onFinished();
          return;
        }
        setError(result?.error || "WalletConnect could not complete this request.");
        // An account change is recoverable; anything else consumed the request.
        if (result?.code !== "accountChanged") setIsTerminal(true);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "WalletConnect could not complete this request.",
        );
      } finally {
        inFlightRef.current = false;
        setInFlight(null);
      }
    },
    [onFinished, proposal.id],
  );

  return { inFlight, error, isTerminal, decide };
}
