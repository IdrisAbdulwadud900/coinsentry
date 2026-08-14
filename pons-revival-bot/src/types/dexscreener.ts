import { z } from "zod";

/**
 * DexScreener pair response schema, scoped to the fields this bot uses.
 * All numeric/optional fields are treated as optional since the API is
 * undocumented and fields can be missing for thin/new pairs.
 */
const TxnWindowSchema = z.object({
  buys: z.number().optional(),
  sells: z.number().optional(),
});

export const DexPairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  pairAddress: z.string(),
  url: z.string().optional(),
  baseToken: z.object({
    address: z.string(),
    name: z.string().optional(),
    symbol: z.string().optional(),
  }),
  quoteToken: z
    .object({
      address: z.string(),
      name: z.string().optional(),
      symbol: z.string().optional(),
    })
    .optional(),
  priceUsd: z.string().optional(),
  marketCap: z.number().optional(),
  fdv: z.number().optional(),
  liquidity: z
    .object({
      usd: z.number().optional(),
    })
    .optional(),
  volume: z
    .object({
      m5: z.number().optional(),
      h1: z.number().optional(),
      h6: z.number().optional(),
      h24: z.number().optional(),
    })
    .optional(),
  txns: z
    .object({
      m5: TxnWindowSchema.optional(),
      h1: TxnWindowSchema.optional(),
      h6: TxnWindowSchema.optional(),
      h24: TxnWindowSchema.optional(),
    })
    .optional(),
  pairCreatedAt: z.number().optional(),
  info: z
    .object({
      imageUrl: z.string().optional(),
      websites: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional(),
      socials: z.array(z.object({ url: z.string(), type: z.string().optional() })).optional(),
    })
    .optional(),
});

export type DexPair = z.infer<typeof DexPairSchema>;

export const DexPairArraySchema = DexPairSchema.array();
