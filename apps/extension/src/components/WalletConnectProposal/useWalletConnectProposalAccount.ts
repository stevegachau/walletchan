import { useCallback, useEffect, useState } from "react";
import type { Account } from "@/chrome/types";

/**
 * The wallet-wide active account, which is the account a WalletConnect
 * approval uses. Unlike the injected-site picker this never selects a per-tab
 * account: WalletConnect sessions are not bound to a browser tab.
 */
export function useWalletConnectProposalAccount(accounts: Account[]) {
  const [accountId, setAccountId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const active = (await chrome.runtime.sendMessage({
        type: "getActiveAccount",
      })) as Account | null;
      setAccountId(active?.id ?? null);
    } catch {
      // Keep the previous selection; the background may be waking up.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleMessage = (message: { type?: string }) => {
      if (message?.type === "accountsUpdated") void refresh();
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [refresh]);

  const selectAccount = useCallback(async (next: Account) => {
    const result = (await chrome.runtime.sendMessage({
      type: "setActiveAccount",
      accountId: next.id,
    })) as { success?: boolean; error?: string } | undefined;
    if (!result?.success) {
      throw new Error(result?.error || "Failed to select account");
    }
    setAccountId(next.id);
  }, []);

  const account =
    accounts.find((candidate) => candidate.id === accountId) ?? null;
  return { account, selectAccount };
}
