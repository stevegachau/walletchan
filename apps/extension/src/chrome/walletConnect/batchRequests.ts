import {
  handleWalletGetCapabilities,
  handleWalletGetCallsStatus,
  handleWalletSendCalls,
  handleWalletShowCallsStatus,
} from "../batchTxHandlers";
import type { WalletSendCallsParams } from "../erc5792Types";
import {
  getSessionAccounts,
  getSessionMetadata,
  isAddress,
  parseWalletChainId,
} from "./sessionPolicy";
import { resolveSessionAccount } from "./sessionAccountPolicy";
import {
  rejectSessionRequest,
  respondSessionRequest,
  type WalletKitLike,
} from "./protocol";
import {
  getWalletConnectPendingRequest,
  withWalletConnectPendingRoute,
} from "./storage";
import { walletSendCallsTerminalResponse } from "./batchResponse";

export async function handleWalletConnectGetCapabilities(
  kit: WalletKitLike,
  args: any,
  params: any[],
  chainId: number,
): Promise<void> {
  const first = params[0];
  const address =
    isAddress(first)
      ? first
      : typeof first === "object" && isAddress(first?.address)
        ? first.address
        : typeof first === "object" && isAddress(first?.account)
          ? first.account
          : getSessionAccounts(kit.getActiveSessions()?.[args.topic], chainId)[0];
  const chainIds = Array.isArray(params[1])
    ? params[1]
    : typeof first === "object" && Array.isArray(first?.chainIds)
      ? first.chainIds
      : undefined;

  if (!isAddress(address)) {
    throw new Error("No authorized account for this session");
  }
  const account = await resolveSessionAccount(
    kit.getActiveSessions()?.[args.topic],
    chainId,
    address,
  );

  await respondSessionRequest(
    kit,
    args,
    await handleWalletGetCapabilities(address, chainIds, account),
  );
}

export async function handleWalletConnectSendCalls(
  kit: WalletKitLike,
  args: any,
  params: any[],
  chainId: number,
  remoteClaimId?: string,
): Promise<void> {
  const request = (params[0] || params) as WalletSendCallsParams;
  const requestChainId = parseWalletChainId(request?.chainId);
  if (!requestChainId) {
    throw new Error("Invalid batch chainId");
  }
  if (requestChainId !== chainId) {
    throw new Error("Batch chainId does not match session chain");
  }
  if (request.from && !isAddress(request.from)) {
    throw new Error("Invalid from address");
  }
  const account = await resolveSessionAccount(
    kit.getActiveSessions()?.[args.topic],
    chainId,
    request.from || null,
  );

  const bundleId = crypto.randomUUID();
  const peer = getSessionMetadata(kit.getActiveSessions()?.[args.topic]);
  const peerOrigin = peer.url || peer.name;

  const intake = () => handleWalletSendCalls(
    request,
    bundleId,
    peerOrigin,
    peer.icon,
    undefined,
    peerOrigin,
    undefined,
    undefined,
    account,
    {
      topic: args.topic,
      requestId: args.id,
      method: "wallet_sendCalls",
    },
  );

  // Every wallet_sendCalls owns a durable route so the JSON-RPC response is
  // deferred until the user decides (EOA: batchTxResult; Safe: owner-approved
  // batchTxAck), mirroring eth_sendTransaction/personal_sign.
  await withWalletConnectPendingRoute({
    id: bundleId,
    kind: "batch",
    topic: args.topic,
    requestId: args.id,
    method: "wallet_sendCalls",
    timestamp: Date.now(),
  }, intake, remoteClaimId);

  await settleWalletConnectBatchIntake(kit, args, bundleId, account.type === "safe");
}

/**
 * Intake failures are answered through the routed result bridge as soon as
 * their ack is written. This only covers a bridge that could not commit the
 * failure, or an intake that wrote no ack at all; a queued EOA batch keeps its
 * route open for the user's decision.
 */
async function settleWalletConnectBatchIntake(
  kit: WalletKitLike,
  args: any,
  bundleId: string,
  isSafe: boolean,
): Promise<void> {
  const ackKey = `batchTxAck:${bundleId}`;
  const storedAck = await chrome.storage.local.get(ackKey);
  const ack = storedAck[ackKey]?.result as Record<string, unknown> | undefined;
  if (!ack && isSafe) return; // The Safe ack is written on owner approval.
  if (!isSafe) await chrome.storage.local.remove(ackKey).catch(() => undefined);

  const terminal = ack
    ? walletSendCallsTerminalResponse("ack", bundleId, ack)
    : {
        kind: "error" as const,
        code: -32000,
        message: "Failed to persist batch acknowledgement",
      };
  if (!terminal) return;
  const route = await getWalletConnectPendingRequest(bundleId);
  if (!route || route.terminalResponse) return;
  if (terminal.kind === "result") {
    await respondSessionRequest(kit, args, terminal.value);
  } else {
    await rejectSessionRequest(kit, args, terminal.code, terminal.message);
  }
}

export async function handleWalletConnectGetCallsStatus(
  kit: WalletKitLike,
  args: any,
  params: any[],
): Promise<void> {
  const bundleId = getBundleIdParam(params);
  if (!bundleId) {
    throw new Error("Missing bundle ID");
  }
  const peer = getSessionMetadata(kit.getActiveSessions()?.[args.topic]);
  const result = await handleWalletGetCallsStatus(bundleId, peer.url || peer.name);
  if ("error" in result) {
    await rejectSessionRequest(kit, args, result.code, result.error);
    return;
  }
  await respondSessionRequest(kit, args, result);
}

export async function handleWalletConnectShowCallsStatus(
  kit: WalletKitLike,
  args: any,
  params: any[],
): Promise<void> {
  const bundleId = getBundleIdParam(params);
  if (!bundleId) {
    throw new Error("Missing bundle ID");
  }
  const peer = getSessionMetadata(kit.getActiveSessions()?.[args.topic]);
  await handleWalletShowCallsStatus(bundleId, peer.url || peer.name);
  await respondSessionRequest(kit, args, null);
}

function getBundleIdParam(params: any[]): string | null {
  const first = params[0];
  if (typeof first === "string" && first.length > 0) return first;
  if (first && typeof first === "object" && typeof first.id === "string") {
    return first.id;
  }
  return null;
}
