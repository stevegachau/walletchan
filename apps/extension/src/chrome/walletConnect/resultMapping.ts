/**
 * Pure mapping from a durable result key/record to the terminal JSON-RPC
 * response of the WalletConnect route it answers. No storage or SDK effects.
 */

import type {
  WalletConnectPendingRequest,
  WalletConnectTerminalResponseInput,
} from "./storage";
import { walletSendCallsTerminalResponse } from "./batchResponse";

const RESULT_PREFIXES = [
  ["txResult:", "transaction"],
  ["sigResult:", "signature"],
  ["erc7715PermissionResult:", "permission"],
  ["batchTxAck:", "batchAck"],
  ["batchTxResult:", "batchDecision"],
] as const;

export type WalletConnectResultFamily = (typeof RESULT_PREFIXES)[number][1];

export function parseWalletConnectResultKey(
  key: string,
): { id: string; family: WalletConnectResultFamily } | null {
  for (const [prefix, family] of RESULT_PREFIXES) {
    if (key.startsWith(prefix)) {
      const id = key.slice(prefix.length);
      return id ? { id, family } : null;
    }
  }
  return null;
}

function singleRequestTerminalResponse(
  pending: WalletConnectPendingRequest,
  result: Record<string, unknown>,
): WalletConnectTerminalResponseInput {
  const payload =
    pending.kind === "transaction"
      ? result.txHash
      : pending.kind === "signature"
        ? result.signature
        : result.result;
  if (
    result.success === true &&
    (typeof payload === "string" || Array.isArray(payload))
  ) {
    return { kind: "result", value: payload };
  }
  const error =
    typeof result.error === "string" ? result.error : "Request failed";
  return {
    kind: "error",
    code: /reject|cancel/i.test(error) ? 4001 : -32000,
    message: error.slice(0, 1_000),
  };
}

/**
 * `null` means the write must not answer this route: a batch route is
 * answered only by its own ack/decision keys (and never by an EOA queue ack),
 * and batch keys never answer a transaction/signature/permission route.
 */
export function walletConnectTerminalResponseFor(
  family: WalletConnectResultFamily,
  pending: WalletConnectPendingRequest,
  result: Record<string, unknown>,
): WalletConnectTerminalResponseInput | null {
  const batchFamily = family === "batchAck" || family === "batchDecision";
  if (pending.kind === "batch") {
    if (!batchFamily) return null;
    const terminal = walletSendCallsTerminalResponse(
      family === "batchAck" ? "ack" : "decision",
      pending.id,
      result,
    );
    return terminal?.kind === "error"
      ? { ...terminal, message: terminal.message.slice(0, 1_000) }
      : terminal;
  }
  return batchFamily ? null : singleRequestTerminalResponse(pending, result);
}
