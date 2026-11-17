/*
 * Test-only dependencies resolved from the monorepo's existing install, so
 * the harness needs no extra `pnpm install`:
 *   - ethers (apps/extension dependency) for signature recovery
 *   - @walletconnect/sign-client (already in the pnpm store as a transitive
 *     dependency of the extension's WalletKit) to act as the dApp.
 */
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

export function ethers() {
  const require = createRequire(path.join(repoRoot, "apps/extension/package.json"));
  return require("ethers");
}

export function signClientModule() {
  const store = path.join(repoRoot, "node_modules/.pnpm");
  const candidates = readdirSync(store)
    .filter((name) => name.startsWith("@walletconnect+sign-client@"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (candidates.length === 0) throw new Error("@walletconnect/sign-client not found in the pnpm store");
  const pkgDir = path.join(store, candidates[0], "node_modules/@walletconnect/sign-client");
  const require = createRequire(path.join(pkgDir, "package.json"));
  return require(pkgDir);
}
