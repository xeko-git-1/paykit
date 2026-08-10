/**
 * Coin/chain allow-list tests.
 *
 * The guard's whole value is catching a plausible-looking typo at startup, so the
 * cases below lean on the codes that are easy to get wrong rather than on obvious
 * garbage.
 */
import { describe, expect, it } from "vitest";
import {
  CRYPTOMUS_CURRENCIES,
  CRYPTOMUS_NETWORKS,
  NOWPAYMENTS_PAY_CURRENCIES,
  describeUnknownChainCodes,
  findUnknownChainCodes,
  isKnownCryptomusCurrency,
  isKnownCryptomusNetwork,
  isKnownNowpaymentsPayCurrency,
} from "../src/index.js";

describe("known-code recognition", () => {
  it("accepts every documented NowPayments pay currency", () => {
    for (const code of NOWPAYMENTS_PAY_CURRENCIES) {
      expect(isKnownNowpaymentsPayCurrency(code)).toBe(true);
    }
  });

  it("accepts every documented Cryptomus network and coin", () => {
    for (const network of CRYPTOMUS_NETWORKS) {
      expect(isKnownCryptomusNetwork(network)).toBe(true);
    }
    for (const coin of CRYPTOMUS_CURRENCIES) {
      expect(isKnownCryptomusCurrency(coin)).toBe(true);
    }
  });

  it("matches case-insensitively, since the providers do", () => {
    expect(isKnownNowpaymentsPayCurrency("USDTBSC")).toBe(true);
    expect(isKnownNowpaymentsPayCurrency("UsdtBsc")).toBe(true);
    expect(isKnownCryptomusNetwork("BSC")).toBe(true);
    expect(isKnownCryptomusCurrency("usdt")).toBe(true);
  });

  it("tolerates surrounding whitespace from a copy-pasted env value", () => {
    expect(isKnownNowpaymentsPayCurrency("  usdtbsc  ")).toBe(true);
    expect(isKnownCryptomusNetwork(" tron ")).toBe(true);
  });
});

describe("typo rejection", () => {
  it("rejects the token-standard spelling of a chain NowPayments names by suffix", () => {
    // BEP20 is 'usdtbsc'. 'usdtbep20' is plausible precisely because
    // 'usdterc20' and 'usdttrc20' are real, which is what makes it a trap.
    expect(isKnownNowpaymentsPayCurrency("usdtbep20")).toBe(false);
    expect(isKnownNowpaymentsPayCurrency("bep20")).toBe(false);
  });

  it("rejects a chain name used where a coin+chain token belongs", () => {
    expect(isKnownNowpaymentsPayCurrency("bsc")).toBe(false);
  });

  it("rejects a coin+chain token used where a bare chain belongs", () => {
    expect(isKnownCryptomusNetwork("usdtbsc")).toBe(false);
    expect(isKnownCryptomusNetwork("bep20")).toBe(false);
  });
});

describe("findUnknownChainCodes", () => {
  it("reports nothing when every field is unset", () => {
    expect(findUnknownChainCodes({})).toHaveLength(0);
  });

  it("treats an empty or whitespace-only value as unset, not as a typo", () => {
    const unknown = findUnknownChainCodes({
      nowpaymentsPayCurrency: "",
      cryptomusNetwork: "   ",
      cryptomusToCurrency: undefined,
    });
    expect(unknown).toHaveLength(0);
  });

  it("names the offending field and carries its known set", () => {
    const unknown = findUnknownChainCodes({ nowpaymentsPayCurrency: "usdtbep20" });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.field).toBe("NOWPAYMENTS_PAY_CURRENCY");
    expect(unknown[0]?.value).toBe("usdtbep20");
    expect(unknown[0]?.known).toContain("usdtbsc");
  });

  it("collects every bad field at once so one boot cycle fixes them all", () => {
    const unknown = findUnknownChainCodes({
      nowpaymentsPayCurrency: "bep20",
      cryptomusNetwork: "binance-smart-chain",
      cryptomusToCurrency: "TETHER",
    });
    expect(unknown.map((u) => u.field)).toEqual([
      "NOWPAYMENTS_PAY_CURRENCY",
      "CRYPTOMUS_NETWORK",
      "CRYPTOMUS_TO_CURRENCY",
    ]);
  });
});

describe("describeUnknownChainCodes", () => {
  it("quotes the bad value, lists the known set, and names the override", () => {
    const message = describeUnknownChainCodes(
      findUnknownChainCodes({ nowpaymentsPayCurrency: "usdtbep20" }),
      "PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES",
    );
    expect(message).toContain("NOWPAYMENTS_PAY_CURRENCY");
    expect(message).toContain("usdtbep20");
    expect(message).toContain("usdtbsc");
    expect(message).toContain("PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES");
  });
});
