/**
 * Parses user-entered numeric shorthand into a plain number.
 * Accepts things like: "5k", "250K", "1.2m", "1.2M", "0.0045", "10,000", "$5k".
 * Returns null if the input can't be parsed into a finite positive-or-zero number.
 */
export function parseShorthandNumber(input: string): number | null {
  if (typeof input !== "string") return null;

  const cleaned = input
    .trim()
    .replace(/^\$/, "")
    .replace(/,/g, "")
    .toLowerCase();

  if (cleaned.length === 0) return null;

  const match = /^([+-]?\d+(?:\.\d+)?)([kmb])?$/.exec(cleaned);
  if (!match) return null;

  const rawNumber = match[1];
  const suffix = match[2];
  if (!rawNumber) return null;

  const base = Number(rawNumber);
  if (!Number.isFinite(base)) return null;

  const multipliers: Record<string, number> = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
  };

  const multiplier = suffix ? multipliers[suffix] ?? 1 : 1;
  const result = base * multiplier;

  if (!Number.isFinite(result)) return null;

  return result;
}

/** Formats a number back into a compact human-readable string, e.g. 5000 -> "$5.00K". */
export function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;

  // Sub-$1 tokens need more precision (meme coins can be $0.00000001).
  return `${sign}$${abs.toPrecision(3)}`;
}

/** Formats a percent change with a sign and fixed precision, e.g. 4.567 -> "+4.6%". */
export function formatPercent(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "" : "±";
  return `${sign}${value.toFixed(digits)}%`;
}
