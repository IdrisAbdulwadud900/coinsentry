const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Returns the trimmed address if the text looks like a plausible contract address, else null. */
export function extractAddress(text: string): string | null {
  const trimmed = text.trim();
  if (EVM_ADDRESS.test(trimmed)) return trimmed;
  if (SOLANA_ADDRESS.test(trimmed)) return trimmed;
  return null;
}
