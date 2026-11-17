/**
 * Pure presentation model for the WalletConnect connection review: Verify
 * verdict copy/tone, display hostnames, requested-network summary, and
 * account eligibility. No React, Chakra, Chrome, storage, or network code.
 */

import { isDirectSigningAccountType } from "@/chrome/accounts/accountTypePolicy";
import type { AccountType } from "@/chrome/types";
import type { WalletConnectProposalVerification } from "@/types/walletConnect";

export type WalletConnectVerifyKind = "verified" | "unverified" | "mismatch" | "scam";

export interface WalletConnectVerifyPresentation {
  kind: WalletConnectVerifyKind;
  tone: "success" | "warning" | "error";
  badgeLabel: string;
  title: string;
  description: string;
  /** Scam and domain-mismatch verdicts need an explicit acknowledgement. */
  requiresAcknowledgement: boolean;
}

/** Hostname of an http(s) URL, or null when it is missing/unparseable. */
export function displayHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export function buildWalletConnectVerifyPresentation(
  verification: WalletConnectProposalVerification,
  claimedUrl: string,
): WalletConnectVerifyPresentation {
  const claimedHost = displayHostname(claimedUrl);
  const originHost = displayHostname(verification.origin);
  if (verification.isScam) {
    return {
      kind: "scam",
      tone: "error",
      badgeLabel: "Known scam",
      title: "Known malicious app",
      description: `WalletConnect Verify flagged ${originHost || claimedHost || "this app"} as a scam. Connecting can lead to requests that drain your funds. Reject unless you are certain.`,
      requiresAcknowledgement: true,
    };
  }
  if (verification.validation === "INVALID") {
    return {
      kind: "mismatch",
      tone: "error",
      badgeLabel: "Domain mismatch",
      title: "Domain doesn't match",
      description: `This app says it is ${claimedHost || "a different site"}, but the request came from ${originHost || "another domain"}. It may be impersonating a trusted app.`,
      requiresAcknowledgement: true,
    };
  }
  if (verification.validation === "VALID") {
    return {
      kind: "verified",
      tone: "success",
      badgeLabel: "Verified",
      title: "Verified domain",
      description: `WalletConnect Verify confirmed this request came from ${originHost || claimedHost || "the app's domain"}.`,
      requiresAcknowledgement: false,
    };
  }
  return {
    kind: "unverified",
    tone: "warning",
    badgeLabel: "Unverified",
    title: "Domain not verified",
    description: claimedHost
      ? `WalletConnect couldn't verify that this request came from ${claimedHost}. Only connect if you started it there yourself.`
      : "WalletConnect couldn't verify where this request came from. Only connect if you started it yourself.",
    requiresAcknowledgement: false,
  };
}

export interface RequestedNetworkItem {
  chainId: number;
  name: string;
  required: boolean;
}

export interface RequestedNetworkSummary {
  items: RequestedNetworkItem[];
  hiddenCount: number;
}

/**
 * Required networks first, then optional ones, capped at `maxItems`.
 * `resolveName` returns null for chains WalletChan does not know.
 */
export function summarizeRequestedNetworks(
  requiredChainIds: readonly number[],
  optionalChainIds: readonly number[],
  resolveName: (chainId: number) => string | null,
  maxItems = 6,
): RequestedNetworkSummary {
  const items: RequestedNetworkItem[] = [];
  const seen = new Set<number>();
  for (const [chainIds, required] of [
    [requiredChainIds, true],
    [optionalChainIds, false],
  ] as const) {
    for (const chainId of chainIds) {
      if (seen.has(chainId)) continue;
      seen.add(chainId);
      items.push({
        chainId,
        name: resolveName(chainId) || `Chain ${chainId}`,
        required,
      });
    }
  }
  return {
    items: items.slice(0, maxItems),
    hiddenCount: Math.max(0, items.length - maxItems),
  };
}

/**
 * Mirrors the background `isSessionAccount` policy (direct signers and Safes);
 * view-only accounts can never approve a WalletConnect session.
 */
export function canConnectWalletConnectAccountType(type: AccountType): boolean {
  return isDirectSigningAccountType(type) || type === "safe";
}
