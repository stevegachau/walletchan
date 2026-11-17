import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Button,
  HStack,
  Text,
  VStack,
  Wrap,
  WrapItem,
} from "@chakra-ui/react";
import type { Account } from "@/chrome/types";
import type { PendingWalletConnectProposal } from "@/types/walletConnect";
import ChainIcon from "@/components/ChainIcon";
import DappConnectionAccountSelector from "@/components/DappConnectionAccountSelector";
import DisplayModeMenu from "@/components/DisplayModeMenu";
import { ConnectionPermissionList } from "@/components/DappConnection/ConnectionPermissionList";
import { ConnectionRequestHeader } from "@/components/DappConnection/ConnectionRequestHeader";
import { ConfirmationScreen } from "@/components/ui";
import { googleFaviconUrl } from "@/constants/externalUrls";
import { useNetworks } from "@/contexts/NetworksContext";
import { getResolvedChainById } from "@/lib/chains";
import { playInteractionSound } from "@/sounds/soundManager";
import {
  buildWalletConnectVerifyPresentation,
  canConnectWalletConnectAccountType,
  displayHostname,
  summarizeRequestedNetworks,
} from "./proposalPresentation";
import { useWalletConnectProposalAccount } from "./useWalletConnectProposalAccount";
import { useWalletConnectProposalDecision } from "./useWalletConnectProposalDecision";
import {
  WalletConnectVerifyBadge,
  WalletConnectVerifyNotice,
} from "./WalletConnectVerifyNotice";

export interface WalletConnectProposalConfirmationProps {
  proposal: PendingWalletConnectProposal;
  accounts: Account[];
  sidePanelSupported: boolean;
  sidePanelMode: boolean;
  isFullscreenTab: boolean;
  onToggleSidePanel: () => void;
  onOpenFullscreen: () => void;
  onFinished: () => void;
}

export default function WalletConnectProposalConfirmation({
  proposal,
  accounts,
  sidePanelSupported,
  sidePanelMode,
  isFullscreenTab,
  onToggleSidePanel,
  onOpenFullscreen,
  onFinished,
}: WalletConnectProposalConfirmationProps) {
  const { networksInfo } = useNetworks();
  const { account, selectAccount } = useWalletConnectProposalAccount(accounts);
  const { inFlight, error, isTerminal, decide } =
    useWalletConnectProposalDecision(proposal, onFinished);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  useEffect(() => setRiskAcknowledged(false), [proposal.id]);

  const verify = useMemo(
    () => buildWalletConnectVerifyPresentation(proposal.verification, proposal.url),
    [proposal.verification, proposal.url],
  );
  const hostname = displayHostname(proposal.url);
  const networks = useMemo(
    () =>
      summarizeRequestedNetworks(
        proposal.requiredChainIds,
        proposal.optionalChainIds,
        (chainId) => getResolvedChainById(chainId, networksInfo)?.name ?? null,
      ),
    [networksInfo, proposal.optionalChainIds, proposal.requiredChainIds],
  );
  const accountEligible =
    !!account && canConnectWalletConnectAccountType(account.type);
  const canConnect =
    !isTerminal &&
    accountEligible &&
    (!verify.requiresAcknowledgement || riskAcknowledged);

  const reject = useCallback(() => void decide("reject"), [decide]);
  const connect = useCallback(() => {
    if (!account) return;
    void playInteractionSound("dappConnectionConfirm");
    void decide("approve", account.id);
  }, [account, decide]);

  return (
    <ConfirmationScreen
      title="Connect app"
      onBack={isTerminal ? onFinished : reject}
      isBackDisabled={inFlight !== null}
      backLabel={isTerminal ? "Close connection request" : "Reject connection request"}
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
          headingId="walletconnect-proposal-app"
          eyebrow="WalletConnect request"
          label={proposal.name}
          iconSrc={proposal.icons[0] || null}
          iconFallbackSrc={hostname ? googleFaviconUrl(hostname, 64) : null}
        >
          {hostname && (
            <Text
              color="fg.secondary"
              fontSize="sm"
              maxW="full"
              overflowWrap="anywhere"
            >
              {hostname}
            </Text>
          )}
          <HStack pt={1} justify="center">
            <WalletConnectVerifyBadge presentation={verify} />
          </HStack>
        </ConnectionRequestHeader>
      }
      contextTitle="Connecting as"
      context={
        <VStack align="stretch" spacing={4}>
          {error && (
            <Alert status="error" alignItems="start" borderRadius="md">
              <AlertIcon mt={0.5} />
              <AlertDescription fontSize="sm" lineHeight="1.45">
                {error}
              </AlertDescription>
            </Alert>
          )}
          <WalletConnectVerifyNotice
            presentation={verify}
            acknowledged={riskAcknowledged}
            onAcknowledgedChange={setRiskAcknowledged}
          />
          {account && (
            <DappConnectionAccountSelector
              accounts={accounts}
              account={account}
              onAccountSelect={selectAccount}
              pickerDescription="Choose the account this app can see"
            />
          )}
          {account && !accountEligible && (
            <Text color="status.error.emphasis" fontSize="sm" px={1}>
              View-only accounts can’t connect apps. Choose another account.
            </Text>
          )}
          {networks.items.length > 0 && (
            <VStack as="section" aria-label="Requested networks" align="stretch" spacing={2} px={1}>
              <Text color="fg.primary" fontSize="sm" fontWeight="600">
                Requested networks
              </Text>
              <Wrap spacing={2}>
                {networks.items.map((item) => (
                  <WrapItem key={item.chainId}>
                    <HStack
                      spacing={1.5}
                      px={2}
                      py={1}
                      borderWidth="1px"
                      borderColor="border.subtle"
                      borderRadius="full"
                      bg="surface.raised"
                    >
                      <ChainIcon chainId={item.chainId} chainName={item.name} size="16px" />
                      <Text color="fg.primary" fontSize="xs" fontWeight="600">
                        {item.name}
                      </Text>
                      {item.required && (
                        <Text color="fg.secondary" fontSize="xs">
                          required
                        </Text>
                      )}
                    </HStack>
                  </WrapItem>
                ))}
                {networks.hiddenCount > 0 && (
                  <WrapItem alignSelf="center">
                    <Text color="fg.secondary" fontSize="xs">
                      +{networks.hiddenCount} more
                    </Text>
                  </WrapItem>
                )}
              </Wrap>
            </VStack>
          )}
          {account && (
            <ConnectionPermissionList accountType={account.type} subject="app" />
          )}
        </VStack>
      }
      rejectAction={
        isTerminal ? undefined : (
          <Button
            variant="secondary"
            isLoading={inFlight === "reject"}
            isDisabled={inFlight !== null}
            onClick={reject}
          >
            Reject
          </Button>
        )
      }
      confirmAction={
        isTerminal ? (
          <Button variant="secondary" onClick={onFinished}>
            Close
          </Button>
        ) : (
          <Button
            variant={verify.requiresAcknowledgement ? "danger" : "brand"}
            isLoading={inFlight === "approve"}
            isDisabled={inFlight !== null || !canConnect}
            onClick={connect}
          >
            {verify.requiresAcknowledgement ? "Connect anyway" : "Connect"}
          </Button>
        )
      }
    />
  );
}
