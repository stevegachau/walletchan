export interface WalletConnectSessionSummary {
  topic: string;
  name: string;
  url: string;
  description?: string;
  icons: string[];
  chains: number[];
  accounts: string[];
  expiry?: number;
}

export interface WalletConnectSessionsResponse {
  success: boolean;
  sessions: WalletConnectSessionSummary[];
  activeChainId?: number | null;
  error?: string;
  missingProjectId?: boolean;
}

export interface WalletConnectRequestedChain {
  chainId: number;
  name?: string;
  rpcUrl?: string;
  explorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

export interface WalletConnectProposalRejection {
  id: number;
  name: string;
  url: string;
  icon: string | null;
  error: string;
  requestedChains: WalletConnectRequestedChain[];
  requestedChainIds: number[];
  unavailableChainIds: number[];
  unconfiguredChains: WalletConnectRequestedChain[];
  requestedMethods: string[];
}

export interface WalletConnectAddChainContext {
  dappName?: string;
}

export interface WalletConnectRetryNotice {
  dappName?: string;
  chainName: string;
  chainId: number;
}

/** WalletConnect Verify API verdict for the proposer's claimed domain. */
export type WalletConnectVerifyValidation = "VALID" | "INVALID" | "UNKNOWN";

export interface WalletConnectProposalVerification {
  validation: WalletConnectVerifyValidation;
  /** Attested origin (sanitized http/https URL) or "" when absent. */
  origin: string;
  isScam: boolean;
}

/**
 * Display-only, non-secret summary of a WalletConnect session proposal that
 * is waiting for the user's Connect/Reject decision. The authoritative
 * namespaces stay in the WalletKit SDK store and are re-read on approval.
 */
export interface PendingWalletConnectProposal {
  id: number;
  pairingTopic: string;
  name: string;
  url: string;
  description?: string;
  icons: string[];
  requiredChainIds: number[];
  optionalChainIds: number[];
  methods: string[];
  verification: WalletConnectProposalVerification;
  createdAt: number;
  expiresAt: number;
}

export type WalletConnectProposalDecisionResult =
  | { success: true }
  | {
      success: false;
      error: string;
      code?: "invalid" | "notFound" | "expired" | "accountChanged" | "rejected";
      rejection?: WalletConnectProposalRejection;
    };
