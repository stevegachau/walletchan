/**
 * Pure mapping from durable ERC-5792 batch results to the deferred
 * WalletConnect `wallet_sendCalls` JSON-RPC response.
 *
 * `batchTxAck:{bundleId}` is the intake acknowledgement. For EOA batches it
 * only means "queued for review" (`awaitingUserDecision: true`) and must not
 * answer the remote request. Safe batches write their ack only after explicit
 * owner approval, so a success ack without that marker is a decision.
 * `batchTxResult:{bundleId}` is the user's decision / execution acceptance.
 */

import { MAX_BATCH_CALLS } from "../provider/limits";
import type { WalletConnectTerminalResponseInput } from "./storage";

export const WALLETCONNECT_USER_REJECTED_CODE = 4001;
export const WALLETCONNECT_USER_REJECTED_MESSAGE = "User rejected the request.";

export type WalletConnectBatchResultSource = "ack" | "decision";

export interface WalletSendCallsResponse {
  id: string;
  capabilities?: {
    caip345: { caip2: string; transactionHashes: string[] };
  };
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function knownTransactionHashes(result: Record<string, unknown>): string[] {
  const hashes = result.transactionHashes;
  if (!Array.isArray(hashes) || hashes.length > MAX_BATCH_CALLS) return [];
  const unique: string[] = [];
  for (const hash of hashes) {
    if (typeof hash !== "string" || !TX_HASH_PATTERN.test(hash)) return [];
    if (!unique.includes(hash)) unique.push(hash);
  }
  return unique;
}

/**
 * `{ id }` plus WalletConnect's CAIP-345 capability only when the writer
 * explicitly published same-chain transaction hashes. Writers whose hashes
 * live on another chain (OP Stack force inclusion L1 deposits) omit them.
 */
export function buildWalletSendCallsResponse(
  bundleId: string,
  result: Record<string, unknown>,
): WalletSendCallsResponse {
  const chainId = result.chainId;
  const transactionHashes = knownTransactionHashes(result);
  if (
    typeof chainId !== "number" ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    transactionHashes.length === 0
  ) {
    return { id: bundleId };
  }
  return {
    id: bundleId,
    capabilities: {
      caip345: { caip2: `eip155:${chainId}`, transactionHashes },
    },
  };
}

export function walletSendCallsError(
  result: Record<string, unknown>,
): { code: number; message: string } {
  const error =
    typeof result.error === "string" && result.error
      ? result.error
      : "Request failed";
  const code =
    typeof result.code === "number" && Number.isSafeInteger(result.code)
      ? result.code
      : /reject|cancel/i.test(error)
        ? WALLETCONNECT_USER_REJECTED_CODE
        : -32000;
  return {
    code,
    message:
      code === WALLETCONNECT_USER_REJECTED_CODE
        ? WALLETCONNECT_USER_REJECTED_MESSAGE
        : error,
  };
}

/**
 * Returns the terminal response for a batch route, or `null` when the write
 * is not a user decision and the remote request must stay open.
 */
export function walletSendCallsTerminalResponse(
  source: WalletConnectBatchResultSource,
  bundleId: string,
  result: Record<string, unknown>,
): WalletConnectTerminalResponseInput | null {
  if (result.success === true) {
    if (source === "ack") {
      if (result.awaitingUserDecision === true) return null;
      if (result.id !== bundleId) {
        return { kind: "error", code: -32000, message: "Request failed" };
      }
    }
    return {
      kind: "result",
      value: buildWalletSendCallsResponse(bundleId, result),
    };
  }
  return { kind: "error", ...walletSendCallsError(result) };
}
