import { Box } from "@chakra-ui/react";
import { Suspense } from "react";
import LoadingFallback from "@/app/LoadingFallback";
import { WalletConnectProposalConfirmation } from "@/app/lazyScreens";
import type { WalletConnectProposalConfirmationProps } from "@/components/WalletConnectProposal/WalletConnectProposalConfirmation";

/** Shared App frame and lazy boundary for the WalletConnect connection review. */
export default function WalletConnectProposalRoute(
  props: WalletConnectProposalConfirmationProps,
) {
  return (
    <Box bg="bg.base" h="100%" display="flex" flexDirection="column">
      <Box
        maxW={props.isFullscreenTab ? "480px" : "100%"}
        mx="auto"
        w="100%"
        h="100%"
        display="flex"
        flexDirection="column"
      >
        <Suspense fallback={<LoadingFallback />}>
          <WalletConnectProposalConfirmation {...props} />
        </Suspense>
      </Box>
    </Box>
  );
}
