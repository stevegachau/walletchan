import type { ReactNode } from "react";
import { Heading, Text, VStack } from "@chakra-ui/react";
import DappSiteIcon from "@/components/DappSiteIcon";

/**
 * Requesting-identity outcome block for connection reviews: icon, eyebrow,
 * and the requester's name as the section heading. `children` renders below
 * the heading (provenance pills, verification badges).
 */
export function ConnectionRequestHeader({
  headingId,
  eyebrow,
  label,
  iconSrc,
  iconFallbackSrc,
  children,
}: {
  headingId: string;
  eyebrow: string;
  label: string;
  iconSrc?: string | null;
  iconFallbackSrc?: string | null;
  children?: ReactNode;
}) {
  return (
    <VStack
      as="section"
      aria-labelledby={headingId}
      align="center"
      spacing={3}
      px={2}
      pt={2}
      textAlign="center"
    >
      <DappSiteIcon
        src={iconSrc}
        fallbackSrc={iconFallbackSrc}
        label={label}
        size="64px"
        imageSize="44px"
      />
      <VStack align="center" spacing={1} minW={0} w="full">
        <Text color="fg.secondary" fontSize="xs" fontWeight="600">
          {eyebrow}
        </Text>
        <Heading
          as="h2"
          id={headingId}
          color="fg.primary"
          fontSize="2xl"
          lineHeight="1.2"
          maxW="full"
          overflowWrap="anywhere"
        >
          {label}
        </Heading>
        {children}
      </VStack>
    </VStack>
  );
}
