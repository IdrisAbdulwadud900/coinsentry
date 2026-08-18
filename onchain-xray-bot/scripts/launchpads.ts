/**
 * Measures the opening market cap of each launchpad, so the registry in
 * `src/data/launchpads.ts` can be extended with verified numbers instead of
 * guesses.
 *
 *   npm run launchpads -- [samples]
 *
 * Method: Jupiter's recent feed returns tokens seconds after their pool is
 * created. Sampling it repeatedly and keeping only launches that are still
 * untouched (very young, at most a couple of trades) gives the curve's opening
 * price directly. Values are reported in SOL, because that is what the curve
 * fixes — the dollar figure moves with the SOL price.
 *
 * Reading the output: a launchpad whose launches agree to a fraction of a
 * percent has a fixed curve and belongs in the registry. One whose launches
 * disagree by multiples is creator-configured, and must NOT be given a
 * constant — mark it `configurable` instead.
 */
import { fetchJson } from '../src/util/http.js';
import { getToken } from '../src/data/jupiter.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BATCHES = Number(process.argv[2] ?? 20);
const GAP_MS = 5_000;

interface RecentToken {
  id: string;
  symbol?: string;
  launchpad?: string;
  mcap?: number;
  totalSupply?: number;
  firstPool?: { createdAt?: string };
  stats5m?: { numBuys?: number; numSells?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const solToken = await getToken(SOL_MINT);
const solPrice = solToken?.usdPrice ?? 0;
if (solPrice <= 0) {
  console.error('Could not resolve the SOL price; aborting.');
  process.exit(1);
}
console.log(`SOL = $${solPrice.toFixed(2)}`);
console.log(`sampling ${BATCHES} batches, ${GAP_MS / 1000}s apart…\n`);

const seen = new Map<string, RecentToken>();
for (let i = 0; i < BATCHES; i++) {
  try {
    const batch = await fetchJson<RecentToken[]>('https://lite-api.jup.ag/tokens/v2/recent', {
      retries: 1,
      timeoutMs: 15_000,
    });
    for (const t of batch) seen.set(t.id, t);
  } catch {
    // A dropped sample only costs coverage, never correctness.
  }
  process.stdout.write(`\r  batch ${i + 1}/${BATCHES} — ${seen.size} unique tokens`);
  if (i < BATCHES - 1) await sleep(GAP_MS);
}
console.log('\n');

const now = Date.now() / 1000;
const byLaunchpad = new Map<string, number[]>();

for (const t of seen.values()) {
  const created = t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) / 1000 : 0;
  const mcap = t.mcap ?? 0;
  const trades = (t.stats5m?.numBuys ?? 0) + (t.stats5m?.numSells ?? 0);
  // Only launches still sitting on the opening tick.
  if (!created || mcap <= 0 || now - created > 300 || trades > 2) continue;
  const key = t.launchpad ?? 'UNKNOWN';
  const arr = byLaunchpad.get(key) ?? [];
  arr.push(mcap / solPrice);
  byLaunchpad.set(key, arr);
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(
  `${'launchpad'.padEnd(22)} ${'n'.padStart(3)} ${'min FDV(SOL)'.padStart(13)} ` +
    `${'median'.padStart(10)} ${'max'.padStart(10)} ${'at floor'.padStart(9)}  verdict`,
);

const ranked = [...byLaunchpad.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [lp, values] of ranked) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);

  /*
   * The minimum IS the floor — a bonding curve only moves up from its opening
   * tick, so a sample above the minimum is a launch that already took a buy,
   * not evidence of a different curve. Comparing max to min therefore measures
   * how much these coins traded, not whether they share a floor, and would
   * label pump.fun "configurable" purely because one sampled coin ran 2x.
   *
   * What actually distinguishes a fixed curve is how many launches sit exactly
   * ON the minimum. A fixed curve stamps every launch at the same opening
   * price, so untouched ones pile up there. A creator-configured curve has no
   * common opening price, so they scatter and the minimum is arbitrary.
   */
  const atFloor = values.filter((v) => v <= lo * 1.03).length;
  const clustered = atFloor / values.length;
  const spread = lo > 0 ? hi / lo : Infinity;

  const verdict =
    values.length < 4
      ? 'too few samples'
      : clustered >= 0.4
        ? `FIXED → register ${lo.toFixed(3)} SOL`
        : spread > 3
          ? 'CONFIGURABLE → do not register a constant'
          : 'inconclusive, sample more';

  console.log(
    `${lp.slice(0, 22).padEnd(22)} ${String(values.length).padStart(3)} ` +
      `${lo.toFixed(3).padStart(13)} ${median(values).toFixed(2).padStart(10)} ` +
      `${hi.toFixed(2).padStart(10)} ${`${atFloor}/${values.length}`.padStart(9)}  ${verdict}`,
  );
}

if (ranked.length === 0) {
  console.log('\nNo untouched launches captured — try more batches.');
}
