/**
 * Known coin+chain codes for the crypto gateways, and the guard that rejects a
 * typo at startup instead of at every checkout.
 *
 * These codes are opaque provider strings: they never enter the ledger, never
 * appear in `CurrencyCode`, and are not interchangeable between providers.
 * NowPayments names a coin and its chain in one token (`usdtbsc`), Cryptomus
 * splits them into a coin (`USDT`) plus a network (`bsc`). Both are pinned in
 * config and copied verbatim into the provider's checkout request.
 *
 * WHY A GUARD EXISTS AT ALL
 *
 * An unrecognised code is accepted by the provider's API only at checkout time,
 * as a per-request rejection. paykit surfaces that as a 502 telling the caller to
 * retry with the same idempotency key — advice that can never succeed, because
 * the cause is static configuration rather than a transient fault. Each attempt
 * also leaves a payment row parked awaiting reconciliation. So a one-character
 * mistake reads as an intermittent provider outage and quietly accrues
 * reconciliation work. Refusing to boot is the only point where the mistake is
 * still cheap and unambiguous.
 *
 * WHY THE GUARD IS NOT A CLOSED ENUM
 *
 * Both providers list far more coin+chain combinations than paykit can enumerate,
 * and they add more without notice. A closed allow-list would therefore reject
 * valid production configuration — turning this guard into the very outage it is
 * meant to prevent, and with no way out but a paykit release. The sets below are
 * the codes paykit has seen documented; anything else is refused with a message
 * naming both the known set and the override that accepts it.
 *
 * Matching is case-insensitive because both providers accept their codes in any
 * case, so rejecting `USDTBSC` would be paykit inventing a constraint the
 * provider does not have.
 */

/**
 * NowPayments `pay_currency` values (coin and chain fused into one token).
 *
 * Note the naming is by chain SUFFIX, not by token standard: BEP20 is `usdtbsc`,
 * NOT `usdtbep20`. `usdterc20` and `usdttrc20` are genuine exceptions that do
 * exist — which is exactly why `usdtbep20` looks plausible and is wrong.
 */
export const NOWPAYMENTS_PAY_CURRENCIES = [
  "usdtbsc",
  "usdttrc20",
  "usdterc20",
  "usdtmatic",
  "usdtarb",
  "usdtop",
  "usdtsol",
  "usdtton",
  "usdtcelo",
  "usdcmatic",
  "usdcbsc",
  "usdcsol",
] as const;

/** Cryptomus `network` values — the chain only; the coin travels separately. */
export const CRYPTOMUS_NETWORKS = [
  "bsc",
  "tron",
  "eth",
  "polygon",
  "arbitrum",
  "avalanche",
  "sol",
  "ton",
] as const;

/** Cryptomus `to_currency` values — the coin only; the chain travels separately. */
export const CRYPTOMUS_CURRENCIES = ["USDT", "USDC", "BTC", "ETH", "BNB", "TRX", "SOL"] as const;

const NOWPAYMENTS_SET = new Set<string>(NOWPAYMENTS_PAY_CURRENCIES);
const CRYPTOMUS_NETWORK_SET = new Set<string>(CRYPTOMUS_NETWORKS);
const CRYPTOMUS_CURRENCY_SET = new Set<string>(CRYPTOMUS_CURRENCIES);

export function isKnownNowpaymentsPayCurrency(value: string): boolean {
  return NOWPAYMENTS_SET.has(value.trim().toLowerCase());
}

export function isKnownCryptomusNetwork(value: string): boolean {
  return CRYPTOMUS_NETWORK_SET.has(value.trim().toLowerCase());
}

export function isKnownCryptomusCurrency(value: string): boolean {
  return CRYPTOMUS_CURRENCY_SET.has(value.trim().toUpperCase());
}

/** One unrecognised chain/coin code, described well enough to act on. */
export interface UnknownChainCode {
  /** Env var / config field the value came from. */
  readonly field: string;
  readonly value: string;
  /** The codes paykit recognises for this field. */
  readonly known: readonly string[];
}

export interface CheckChainCodesInput {
  readonly nowpaymentsPayCurrency?: string | undefined;
  readonly cryptomusNetwork?: string | undefined;
  readonly cryptomusToCurrency?: string | undefined;
}

/**
 * Collect every unrecognised code. Returns all of them rather than the first, so
 * an operator fixing several env vars needs one boot cycle instead of three.
 *
 * An empty or whitespace-only value is not reported: callers already treat that
 * as "unset" and let the customer choose on the provider's page.
 */
export function findUnknownChainCodes(input: CheckChainCodesInput): readonly UnknownChainCode[] {
  const unknown: UnknownChainCode[] = [];

  const np = input.nowpaymentsPayCurrency?.trim();
  if (np !== undefined && np !== "" && !isKnownNowpaymentsPayCurrency(np)) {
    unknown.push({
      field: "NOWPAYMENTS_PAY_CURRENCY",
      value: np,
      known: NOWPAYMENTS_PAY_CURRENCIES,
    });
  }

  const network = input.cryptomusNetwork?.trim();
  if (network !== undefined && network !== "" && !isKnownCryptomusNetwork(network)) {
    unknown.push({ field: "CRYPTOMUS_NETWORK", value: network, known: CRYPTOMUS_NETWORKS });
  }

  const coin = input.cryptomusToCurrency?.trim();
  if (coin !== undefined && coin !== "" && !isKnownCryptomusCurrency(coin)) {
    unknown.push({ field: "CRYPTOMUS_TO_CURRENCY", value: coin, known: CRYPTOMUS_CURRENCIES });
  }

  return unknown;
}

/**
 * The startup message for unrecognised codes.
 *
 * It quotes the offending value and lists the known set: a chain code is not a
 * secret, and a message that withheld them would leave the operator with the
 * same guessing game that made the misconfiguration expensive. The override is
 * named here too, so a genuinely newer code is not a dead end.
 */
export function describeUnknownChainCodes(
  unknown: readonly UnknownChainCode[],
  overrideVar: string,
): string {
  const lines = unknown.map(
    (u) => `  ${u.field}=${JSON.stringify(u.value)} — known values: ${u.known.join(", ")}`,
  );
  return [
    "Unrecognised crypto coin/chain code(s):",
    ...lines,
    `If the provider genuinely supports this code, set ${overrideVar}=true to accept it (it will be passed through unchecked).`,
  ].join("\n");
}
