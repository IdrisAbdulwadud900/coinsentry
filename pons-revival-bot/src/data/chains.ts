/**
 * Chains this bot can track. The `id` is DexScreener's own chainId slug, which is also
 * what's stored in `tokens.chain` and used to build every DexScreener URL.
 *
 * `hasOnChainIntegrations` marks the one chain (Robinhood) where this bot has real
 * contract-level integrations — Pons factory launch discovery, graduation status,
 * early-buy ("bundle") concentration via getLogs, deployer-wallet status, and Blockscout
 * holder balances. Those features are specific to Pons contracts and the Robinhood RPC;
 * on every other chain the corresponding alert lines are simply omitted rather than
 * faked, and discovery comes from DexScreener's cross-chain feeds instead.
 */
export interface ChainInfo {
  id: string;
  label: string;
  emoji: string;
  hasOnChainIntegrations: boolean;
}

export const CHAINS: Record<string, ChainInfo> = {
  robinhood: { id: "robinhood", label: "Robinhood", emoji: "🇺🇸", hasOnChainIntegrations: true },
  solana: { id: "solana", label: "Solana", emoji: "◎", hasOnChainIntegrations: false },
  bsc: { id: "bsc", label: "BSC", emoji: "🟡", hasOnChainIntegrations: false },
  ethereum: { id: "ethereum", label: "Ethereum", emoji: "Ξ", hasOnChainIntegrations: false },
  hyperevm: { id: "hyperevm", label: "HyperEVM", emoji: "🟢", hasOnChainIntegrations: false },
};

/** The chain every pre-existing token row belongs to (this bot started Robinhood-only). */
export const DEFAULT_CHAIN = "robinhood";

export function chainInfo(chainId: string): ChainInfo | undefined {
  return CHAINS[chainId];
}

/** "◎ Solana" — used as the chain badge on alerts. Unknown chains fall back to the raw id. */
export function chainBadge(chainId: string): string {
  const info = CHAINS[chainId];
  return info ? `${info.emoji} ${info.label}` : chainId;
}

/** True when this bot has contract-level integrations for the chain (Robinhood only). */
export function hasOnChainIntegrations(chainId: string): boolean {
  return CHAINS[chainId]?.hasOnChainIntegrations ?? false;
}

// Any 0x-prefixed hex string is treated as EVM. Deliberately not length-pinned to 40:
// this must also normalize the shorter fixture-style addresses used in tests exactly the
// way real ones are normalized. Safe against false positives because base58 — which
// Solana addresses use — has no '0' in its alphabet, so a Solana address can never
// begin with "0x".
const EVM_ADDRESS = /^0x[0-9a-fA-F]*$/;

/**
 * Canonical storage/lookup form of a token or pair address.
 *
 * EVM addresses are case-insensitive, and this bot has always stored them lowercased —
 * that must not change. Solana addresses are base58 and **case-sensitive**, so
 * lowercasing one produces a different, invalid address (breaking DexScreener lookups
 * and every explorer link). Keying off the address shape rather than the chain keeps
 * every existing repo call site correct without threading a chain argument through.
 */
export function normalizeAddress(address: string): string {
  return EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
}
