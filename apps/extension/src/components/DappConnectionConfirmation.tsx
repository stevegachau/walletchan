import { useEffect, useMemo, useState } from "react";
import { Button, Text, VStack } from "@chakra-ui/react";
import type { Account } from "@/chrome/types";
import type { PendingDappConnectionRequest } from "@/chrome/requests/dappPermissionStorage";
import DappConnectionAccountSelector from "@/components/DappConnectionAccountSelector";
import { ConfirmationScreen } from "@/components/ui";
import { googleFaviconUrl } from "@/constants/externalUrls";
import { useDappOriginFormatter } from "@/hooks/useDappOriginDisplay";
import DisplayModeMenu from "@/components/DisplayModeMenu";
import { playInteractionSound } from "@/sounds/soundManager";
import { contenthashHistoryLabel } from "@/components/DappConnection/contenthashHistoryModel";
import { useEnsContenthashLastUpdated } from "@/components/DappConnection/useEnsContenthashLastUpdated";
import { useDappConnectionReputation } from "@/components/DappConnection/useDappConnectionReputation";
import { DappConnectionReputationNotice } from "@/components/DappConnection/DappConnectionReputationNotice";
import { buildDappReputationPresentation } from "@/components/DappConnection/reputationPresentation";
import { ConnectionPermissionList } from "@/components/DappConnection/ConnectionPermissionList";
import { ConnectionRequestHeader } from "@/components/DappConnection/ConnectionRequestHeader";

interface DappConnectionConfirmationProps {
  request: PendingDappConnectionRequest;
  accounts: Account[];
  account: Account;
  sidePanelSupported: boolean;
  sidePanelMode: boolean;
  isFullscreenTab: boolean;
  onAccountSelect: (account: Account) => void | Promise<void>;
  onToggleSidePanel: () => void;
  onOpenFullscreen: () => void;
  onFinished: () => void;
}

export default function DappConnectionConfirmation({
  request,
  accounts,
  account,
  sidePanelSupported,
  sidePanelMode,
  isFullscreenTab,
  onAccountSelect,
  onToggleSidePanel,
  onOpenFullscreen,
  onFinished,
}: DappConnectionConfirmationProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const formatOrigin = useDappOriginFormatter();
  const displayOrigin = formatOrigin(request.origin);
  const contenthashHistory = useEnsContenthashLastUpdated(
    displayOrigin.contenthashEnsName,
    displayOrigin.isEnsIpfsGateway,
  );
  const contenthashLabel = contenthashHistoryLabel(contenthashHistory);
  const reputation = useDappConnectionReputation(request.id);
  const reputationPresentation =
    reputation.status === "ready"
      ? buildDappReputationPresentation(reputation.reputation)
      : null;
  const requiresRiskAcknowledgement =
    reputationPresentation?.requiresAcknowledgement === true;
  const reputationStatus =
    reputation.status === "ready" ? reputation.reputation.status : "loading";
  const canConnect =
    reputation.status === "ready" &&
    (!requiresRiskAcknowledgement || riskAcknowledged);
  useEffect(() => {
    setRiskAcknowledged(false);
  }, [request.id, reputationStatus]);
  const favicon = useMemo(
    () => request.favicon || googleFaviconUrl(request.hostname, 64),
    [request.favicon, request.hostname],
  );

  const finish = async (type: "confirmDappConnection" | "rejectDappConnection") => {
    if (type === "confirmDappConnection") {
      void playInteractionSound("dappConnectionConfirm");
      setIsConfirming(true);
    } else {
      setIsRejecting(true);
    }
    try {
      await chrome.runtime.sendMessage({ type, requestId: request.id });
      onFinished();
    } finally {
      setIsConfirming(false);
      setIsRejecting(false);
    }
  };

  return (
    <ConfirmationScreen
      title="Connect site"
      onBack={() => void finish("rejectDappConnection")}
      backLabel="Reject connection request"
      trailing={
        <DisplayModeMenu
          sidePanelSupported={sidePanelSupported}
          sidePanelMode={sidePanelMode}
          isFullscreenTab={isFullscreenTab}
          onToggleSidePanel={onToggleSidePanel}
          onOpenFullscreen={onOpenFullscreen}
        />
      }
      outcome={
        <ConnectionRequestHeader
          headingId="dapp-connection-site"
          eyebrow="Connection request"
          label={displayOrigin.label}
          iconSrc={displayOrigin.faviconSrc || favicon}
          iconFallbackSrc={displayOrigin.faviconFallbackSrc}
        >
          {contenthashLabel && (
            <Text
              as="span"
              role="status"
              aria-live="polite"
              maxW="full"
              px={2}
              py={1}
              borderWidth="1px"
              borderColor="border.subtle"
              borderRadius="full"
              bg="surface.raisedHover"
              color="fg.secondary"
              fontSize="xs"
              fontWeight="500"
              lineHeight="1.35"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {contenthashLabel}
            </Text>
          )}
        </ConnectionRequestHeader>
      }
      contextTitle="Connecting as"
      context={
        <VStack align="stretch" spacing={4}>
          <DappConnectionReputationNotice
            state={reputation}
            acknowledged={riskAcknowledged}
            onAcknowledgedChange={setRiskAcknowledged}
          />

          <DappConnectionAccountSelector
            accounts={accounts}
            account={account}
            onAccountSelect={onAccountSelect}
            chainId={request.chainId}
          />

          <ConnectionPermissionList accountType={account.type} />

        </VStack>
      }
      rejectAction={
        <Button
          variant="secondary"
          isLoading={isRejecting}
          isDisabled={isConfirming}
          onClick={() => void finish("rejectDappConnection")}
        >
          Cancel
        </Button>
      }
      confirmAction={
        <Button
          variant={requiresRiskAcknowledgement ? "danger" : "brand"}
          isLoading={isConfirming}
          isDisabled={isRejecting || !canConnect}
          onClick={() => void finish("confirmDappConnection")}
        >
          {reputation.status === "loading"
            ? "Checking site…"
            : requiresRiskAcknowledgement
              ? "Connect anyway"
              : "Connect"}
        </Button>
      }
    />
  );
}
