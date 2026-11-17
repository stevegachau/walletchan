import type { ReactNode } from "react";
import { Box, Flex, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import type { AccountType } from "@/chrome/types";

const permissionIconProps = {
  boxSize: "18px",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function AddressPermissionIcon() {
  return (
    <Icon {...permissionIconProps} aria-hidden="true">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function RequestPermissionIcon() {
  return (
    <Icon {...permissionIconProps} aria-hidden="true">
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </Icon>
  );
}

function PrivatePermissionIcon() {
  return (
    <Icon {...permissionIconProps} aria-hidden="true">
      <circle cx="12" cy="16" r="1" />
      <rect x="3" y="10" width="18" height="12" rx="2" />
      <path d="M7 10V7a5 5 0 0 1 10 0v3" />
    </Icon>
  );
}

function PermissionRow({
  icon,
  children,
  fontSize = "sm",
}: {
  icon: ReactNode;
  children: ReactNode;
  fontSize?: "xs" | "sm";
}) {
  return (
    <HStack align="center" spacing={2.5} minH="28px">
      <Flex
        boxSize="24px"
        align="center"
        justify="center"
        flexShrink={0}
        color="accent.secondary"
      >
        {icon}
      </Flex>
      <Text color="fg.secondary" fontSize={fontSize} lineHeight="1.45">
        {children}
      </Text>
    </HStack>
  );
}

/**
 * What a connection grants, shared by injected-site and WalletConnect
 * connection reviews. `subject` only changes the heading noun.
 */
export function ConnectionPermissionList({
  accountType,
  subject = "site",
}: {
  accountType: AccountType;
  subject?: "site" | "app";
}) {
  const isSafe = accountType === "safe";
  return (
    <VStack
      as="section"
      aria-label={subject === "app" ? "App permissions" : "Site permissions"}
      align="stretch"
      spacing={3}
      px={1}
    >
      <Text color="fg.primary" fontSize="sm" fontWeight="600">
        {subject === "app" ? "This app can" : "This site can"}
      </Text>
      <PermissionRow icon={<AddressPermissionIcon />}>
        See this account address
      </PermissionRow>
      <PermissionRow icon={<RequestPermissionIcon />}>
        {isSafe
          ? "Request Safe transaction proposals (message signing is unavailable)"
          : "Request transactions and signatures"}
      </PermissionRow>
      <Box pt={3}>
        <PermissionRow icon={<PrivatePermissionIcon />} fontSize="xs">
          {isSafe
            ? "Owner keys stay private. Proposals and execution are separate approvals."
            : "Keys stay private. You approve every request."}
        </PermissionRow>
      </Box>
    </VStack>
  );
}
