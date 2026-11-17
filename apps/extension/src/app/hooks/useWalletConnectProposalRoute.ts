import { useCallback, useState } from "react";
import type { AppView } from "@/components/ScreenTransition";
import type { PendingWalletConnectProposal } from "@/types/walletConnect";

type SendMessageWithRetry = <T>(message: {
  type: string;
  [key: string]: unknown;
}) => Promise<T | null>;

/**
 * App-owned selection of the WalletConnect session proposal under review.
 * Live arrivals use `open`; startup and post-unlock routing use `openNewest`,
 * which loads the durable pending list from the background.
 */
export function useWalletConnectProposalRoute(
  sendMessageWithRetry: SendMessageWithRetry,
  setView: (view: AppView) => void,
) {
  const [proposal, setProposal] =
    useState<PendingWalletConnectProposal | null>(null);

  const open = useCallback(
    (next: PendingWalletConnectProposal) => {
      setProposal(next);
      setView("walletConnectProposalConfirm");
    },
    [setView],
  );

  const openNewest = useCallback(async (): Promise<boolean> => {
    const response = await sendMessageWithRetry<{
      success?: boolean;
      proposals?: PendingWalletConnectProposal[];
    }>({ type: "walletConnectGetPendingProposals" });
    const proposals = Array.isArray(response?.proposals) ? response.proposals : [];
    const newest = proposals[proposals.length - 1];
    if (!newest) return false;
    open(newest);
    return true;
  }, [open, sendMessageWithRetry]);

  const finish = useCallback(() => setProposal(null), []);

  return { proposal, open, openNewest, finish };
}
