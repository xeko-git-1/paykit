/**
 * Host clock drift check — Binance Pay rejects any request whose
 * BinancePay-Timestamp is more than ~1 second from its own clock (error
 * 400003), so this must pass before any Binance verification run.
 *
 * Compares local time against Binance's public time endpoint. The measured
 * offset includes network latency, so half the round-trip is subtracted as the
 * usual NTP-style estimate.
 */
const ENDPOINT = "https://api.binance.com/api/v3/time";
const MAX_SAFE_DRIFT_MS = 500;

async function main(): Promise<void> {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT);
  const t1 = Date.now();
  if (!res.ok) throw new Error(`time endpoint returned HTTP ${res.status}`);
  const { serverTime } = (await res.json()) as { serverTime: number };

  const roundTrip = t1 - t0;
  const estimatedDrift = serverTime + roundTrip / 2 - t1;

  console.log(`round-trip:      ${roundTrip} ms`);
  console.log(`estimated drift: ${Math.round(estimatedDrift)} ms (local vs Binance)`);

  if (Math.abs(estimatedDrift) > MAX_SAFE_DRIFT_MS) {
    console.error(
      `\nDRIFT TOO LARGE for Binance Pay's ~1s window. Sync the clock first:\n` +
        `  macOS: sudo sntp -sS time.apple.com\n` +
        `  Linux: sudo chronyc makestep   (or: sudo ntpdate pool.ntp.org)`,
    );
    process.exit(1);
  }
  console.log("\nOK — within Binance Pay's timestamp tolerance.");
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
