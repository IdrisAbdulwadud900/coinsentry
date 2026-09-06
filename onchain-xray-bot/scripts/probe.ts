/**
 * Diagnostic: dumps the raw reconstructed trade stream for a Solana mint so
 * price outliers and parsing artifacts can be inspected directly.
 *
 *   npm run probe -- <mint>
 */
import { lookupToken } from '../src/data/dexscreener.js';
import { getToken as getJupToken } from '../src/data/jupiter.js';
import { HeliusClient } from '../src/data/helius.js';
import { parseSolanaHistory } from '../src/data/solanaParse.js';
import { NativePriceOracle } from '../src/data/nativePrice.js';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: npm run probe -- <mint>');
  process.exit(1);
}

const helius = HeliusClient.fromConfig();
if (!helius) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

const ds = await lookupToken(mint);
const jup = await getJupToken(mint);
const totalSupply = jup?.totalSupply ?? 0;
const oracle = await NativePriceOracle.create('solana', Math.floor(Date.now() / 1000) - 86400);

console.log(`mint        ${mint}`);
console.log(`symbol      ${jup?.symbol ?? '?'}`);
console.log(`totalSupply ${totalSupply.toLocaleString()}`);
console.log(`mcap (jup)  $${(jup?.mcap ?? 0).toLocaleString()}`);
console.log(`mcap (ds)   $${(ds?.best.mcap ?? 0).toLocaleString()}`);
console.log(`SOL price   $${oracle.at(Math.floor(Date.now() / 1000)).toFixed(2)}`);

const sigs = await helius.listSignatures(mint, 25_000);
console.log(`signatures  ${sigs.length}`);

const txs = await helius.hydrate(sigs.map((s) => s.signature));
console.log(`hydrated    ${txs.length}`);

const parsed = parseSolanaHistory(txs, {
  mint,
  decimals: jup?.decimals ?? 6,
  totalSupply,
  solPriceAt: (ts) => oracle.at(ts),
});

const trades = parsed.trades;
console.log(`trades      ${trades.length}`);
console.log(`transfers   ${parsed.supplyTransfers.length}`);
console.log(`pools       ${parsed.poolAccounts.size}`);

const mcaps = trades.map((t) => t.mcap).sort((a, b) => a - b);
const q = (p: number) => mcaps[Math.floor((mcaps.length - 1) * p)] ?? 0;
console.log('\n--- mcap distribution ---');
for (const p of [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
  console.log(`  p${String(p * 100).padStart(3)}  $${q(p).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
}

console.log('\n--- 8 highest-mcap trades ---');
for (const t of [...trades].sort((a, b) => b.mcap - a.mcap).slice(0, 8)) {
  console.log(
    `  $${t.mcap.toExponential(3).padStart(11)}  ${t.side.padEnd(4)}  tok=${t.tokenAmount.toExponential(3)}  usd=$${t.usd.toFixed(4)}  ${t.tx.slice(0, 20)}`,
  );
}

console.log('\n--- 8 lowest-mcap trades ---');
for (const t of [...trades].sort((a, b) => a.mcap - b.mcap).slice(0, 8)) {
  console.log(
    `  $${t.mcap.toExponential(3).padStart(11)}  ${t.side.padEnd(4)}  tok=${t.tokenAmount.toExponential(3)}  usd=$${t.usd.toFixed(4)}  ${t.tx.slice(0, 20)}`,
  );
}
