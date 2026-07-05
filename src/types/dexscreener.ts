import { z } from "zod";

/**
 * Zod schemas that validate the shape of DexScreener API responses.
 * DexScreener does not publish a formal OpenAPI spec, and fields are
 * frequently optional/missing depending on the chain and pair, so every
 * numeric/string field here is treated as optional unless it's essentially
 * always present (pair/base/quote token identity fields).
 */

const TokenInfoSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
  symbol: z.string().optional(),
});

const TxnsWindowSchema = z.object({
  buys: z.number().optional(),
  sells: z.number().optional(),
});

const TxnsSchema = z.object({
  m5: TxnsWindowSchema.optional(),
  h1: TxnsWindowSchema.optional(),
  h6: TxnsWindowSchema.optional(),
  h24: TxnsWindowSchema.optional(),
});

const VolumeSchema = z.object({
  m5: z.number().optional(),
  h1: z.number().optional(),
  h6: z.number().optional(),
  h24: z.number().optional(),
});

const PriceChangeSchema = z.object({
  m5: z.number().optional(),
  h1: z.number().optional(),
  h6: z.number().optional(),
  h24: z.number().optional(),
});

const LiquiditySchema = z.object({
  usd: z.number().optional(),
  base: z.number().optional(),
  quote: z.number().optional(),
});

export const DexPairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  url: z.string().optional(),
  pairAddress: z.string(),
  baseToken: TokenInfoSchema,
  quoteToken: TokenInfoSchema.optional(),
  priceUsd: z.string().optional(),
  priceNative: z.string().optional(),
  txns: TxnsSchema.optional(),
  volume: VolumeSchema.optional(),
  priceChange: PriceChangeSchema.optional(),
  liquidity: LiquiditySchema.optional(),
  fdv: z.number().optional(),
  marketCap: z.number().optional(),
  pairCreatedAt: z.number().optional(),
});

export type DexPair = z.infer<typeof DexPairSchema>;

export const DexTokensResponseSchema = z.object({
  schemaVersion: z.string().optional(),
  pairs: z.array(DexPairSchema).nullable().optional(),
});

export type DexTokensResponse = z.infer<typeof DexTokensResponseSchema>;
