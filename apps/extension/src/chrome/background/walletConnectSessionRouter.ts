/**
 * Focused trusted-UI transport for WalletConnect listing, pairing, disconnect,
 * active-chain selection, and the explicit Connect/Reject decision on pending
 * session proposals. SDK lifecycle and teardown stay in the injected
 * WalletConnect handlers so this module has no relay SDK import side effects.
 */

import type * as PendingRequestResolutionModule from "../requests/pendingRequestResolution";

export const BACKGROUND_WALLETCONNECT_SESSION_MESSAGE_TYPES = [
  "walletConnectGetSessions",
  "walletConnectPair",
  "walletConnectDisconnectSession",
  "walletConnectSwitchChain",
  "walletConnectGetPendingProposals",
  "walletConnectApproveProposal",
  "walletConnectRejectProposal",
] as const;

export type BackgroundWalletConnectSessionRouteResult =
  | { handled: false }
  | { handled: true; keepChannelOpen: boolean };

type Dependencies = {
  handleWalletConnectGetSessions: () => Promise<any>;
  handleWalletConnectPair: (uri: string) => Promise<any>;
  handleWalletConnectDisconnectSession: (topic: string) => Promise<any>;
  handleWalletConnectSwitchChain: (chainName: string) => Promise<any>;
  handleWalletConnectGetPendingProposals: () => Promise<any>;
  handleWalletConnectApproveProposal: (
    proposalId: unknown,
    accountId: unknown,
  ) => Promise<any>;
  handleWalletConnectRejectProposal: (proposalId: unknown) => Promise<any>;
  runPendingRequestResolution: typeof PendingRequestResolutionModule.runPendingRequestResolution;
  pendingResolutionConflict: (action: any) => any;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const HANDLED_ASYNC: BackgroundWalletConnectSessionRouteResult = {
  handled: true,
  keepChannelOpen: true,
};

export function createBackgroundWalletConnectSessionMessageRouter(
  dependencies: Dependencies,
): (
  message: any,
  sendResponse: (response?: any) => void,
) => BackgroundWalletConnectSessionRouteResult {
  return (message, sendResponse) => {
    let result: Promise<any>;
    switch (message?.type) {
      case "walletConnectGetSessions":
        result = dependencies.handleWalletConnectGetSessions();
        break;
      case "walletConnectPair":
        result = dependencies.handleWalletConnectPair(message.uri || "");
        break;
      case "walletConnectDisconnectSession":
        result = dependencies.handleWalletConnectDisconnectSession(
          message.topic || "",
        );
        break;
      case "walletConnectSwitchChain":
        result = dependencies.handleWalletConnectSwitchChain(
          message.chainName || "",
        );
        break;
      case "walletConnectGetPendingProposals":
        result = dependencies.handleWalletConnectGetPendingProposals();
        break;
      case "walletConnectApproveProposal":
      case "walletConnectRejectProposal": {
        const approving = message.type === "walletConnectApproveProposal";
        result = dependencies
          .runPendingRequestResolution({
            family: "sessionProposal",
            requestId: String(message.proposalId),
            action: approving ? "confirm" : "reject",
            resolve: () =>
              approving
                ? dependencies.handleWalletConnectApproveProposal(
                    message.proposalId,
                    message.accountId,
                  )
                : dependencies.handleWalletConnectRejectProposal(
                    message.proposalId,
                  ),
            conflictResult: dependencies.pendingResolutionConflict,
          })
          .catch((error) => ({
            success: false,
            error: errorMessage(
              error,
              approving
                ? "Failed to approve connection request"
                : "Failed to reject connection request",
            ),
          }));
        break;
      }
      default:
        return { handled: false };
    }
    result.then(sendResponse);
    return HANDLED_ASYNC;
  };
}
