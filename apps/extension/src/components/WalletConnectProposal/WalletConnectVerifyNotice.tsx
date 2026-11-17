import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Checkbox,
  Text,
  VStack,
} from "@chakra-ui/react";
import type { WalletConnectVerifyPresentation } from "./proposalPresentation";

/** Compact pill under the app name summarizing the Verify verdict. */
export function WalletConnectVerifyBadge({
  presentation,
}: {
  presentation: WalletConnectVerifyPresentation;
}) {
  return (
    <Badge
      data-testid="walletconnect-verify-badge"
      variant={presentation.tone}
      px={2.5}
      py={1}
      borderRadius="full"
      fontSize="xs"
      lineHeight="1.35"
      textTransform="none"
    >
      {presentation.badgeLabel}
    </Badge>
  );
}

/**
 * Explains a non-verified verdict. Scam and domain-mismatch verdicts are
 * rendered as errors and require an explicit acknowledgement before Connect;
 * Reject always stays available.
 */
export function WalletConnectVerifyNotice({
  presentation,
  acknowledged,
  onAcknowledgedChange,
}: {
  presentation: WalletConnectVerifyPresentation;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}) {
  if (presentation.kind === "verified") return null;
  return (
    <VStack align="stretch" spacing={2.5}>
      <Alert
        status={presentation.tone}
        alignItems="start"
        borderWidth={presentation.tone === "error" ? "2px" : undefined}
        borderRadius="md"
        role="alert"
      >
        <AlertIcon mt={0.5} />
        <VStack align="start" spacing={0.5}>
          <AlertTitle fontSize="sm">{presentation.title}</AlertTitle>
          <AlertDescription fontSize="xs" lineHeight="1.45">
            {presentation.description}
          </AlertDescription>
        </VStack>
      </Alert>
      {presentation.requiresAcknowledgement && (
        <Checkbox
          isChecked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          alignItems="start"
        >
          <Text color="fg.primary" fontSize="xs" lineHeight="1.45">
            I understand this app may be malicious and want to connect anyway.
          </Text>
        </Checkbox>
      )}
    </VStack>
  );
}
