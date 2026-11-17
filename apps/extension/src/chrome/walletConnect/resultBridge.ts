/** Bridges durable injected-request results back to their WalletConnect route. */

import {
  getWalletConnectPendingRequest,
  saveWalletConnectTerminalResponse,
} from "./storage";
import {
  rejectSessionRequest as rejectRoutedSessionRequest,
  respondSessionRequest as respondRoutedSessionRequest,
} from "./protocol";
import { ensureWalletKit } from "./client";
import {
  parseWalletConnectResultKey,
  walletConnectTerminalResponseFor,
} from "./resultMapping";

export async function completeWalletConnectRequestIfNeeded(
  key: string,
  result: Record<string, unknown>,
): Promise<void> {
  const parsed = parseWalletConnectResultKey(key);
  if (!parsed) return;

  const pending = await getWalletConnectPendingRequest(parsed.id);
  if (!pending) return;
  const terminal = walletConnectTerminalResponseFor(parsed.family, pending, result);
  if (!terminal) return;

  try {
    // Commit the first terminal response before SDK acquisition so a failed
    // WalletKit init still leaves a replayable outbox entry.
    await saveWalletConnectTerminalResponse(
      pending.topic,
      pending.requestId,
      terminal,
    );
    const kit = await ensureWalletKit();
    const args = { topic: pending.topic, id: pending.requestId };
    if (terminal.kind === "result") {
      await respondRoutedSessionRequest(kit, args, terminal.value);
    } else {
      await rejectRoutedSessionRequest(kit, args, terminal.code, terminal.message);
    }
  } catch (error) {
    console.warn(
      "[WalletConnect] Response delivery deferred; terminal outbox retained",
      error,
    );
  }
}
