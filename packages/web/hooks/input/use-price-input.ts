import { Dec, DecUtils } from "@keplr-wallet/unit";
import { Currency } from "@osmosis-labs/types";
import { useCallback, useMemo, useState } from "react";

import { trimZerosFromEnd } from "~/utils/string";

/** Manages the input of a price with decimals for a base and quote currency.
 *  Includes utility functions for converting to and from decimals with currency decimals for given currencies. */
export function useAssetPairPriceInput(
  memoedBaseCurrency?: Currency,
  memoedQuoteCurrency?: Currency
) {
  const [decRaw, setDecRaw] = useState("0");

  const multiplicationQuoteOverBase = useMemo(
    () =>
      DecUtils.getTenExponentN(
        (memoedBaseCurrency?.coinDecimals ?? 0) -
          (memoedQuoteCurrency?.coinDecimals ?? 0)
      ),
    [memoedBaseCurrency?.coinDecimals, memoedQuoteCurrency?.coinDecimals]
  );

  const input = useCallback((value: string | Dec) => {
    if (value instanceof Dec) {
      setDecRaw(value.toString());
    } else if (value.startsWith(".")) {
      setDecRaw("0" + value);
    } else if (value === "") {
      setDecRaw("0");
    } else {
      setDecRaw(value);
    }
  }, []);

  const addCurrencyDecimals = useCallback(
    (price: Dec | string | number) => {
      price =
        typeof price === "string" || typeof price === "number"
          ? new Dec(price)
          : price;

      return price.mul(multiplicationQuoteOverBase);
    },
    [multiplicationQuoteOverBase]
  );

  const removeCurrencyDecimals = useCallback(
    (price: Dec | string | number) => {
      price =
        typeof price === "string" || typeof price === "number"
          ? new Dec(price)
          : price;

      return price.quo(multiplicationQuoteOverBase);
    },
    [multiplicationQuoteOverBase]
  );

  /** Price where decimal adjustment is removed and converted to base asset decimals.
   *  Intended for performing computation. */
  const toDec = useCallback(() => {
    if (decRaw.endsWith(".")) {
      return removeCurrencyDecimals(decRaw.slice(0, -1));
    }
    return removeCurrencyDecimals(decRaw);
  }, [decRaw, removeCurrencyDecimals]);

  /** Current price adjusted based on base and quote currency decimals. */
  const toDecWithCurrencyDecimals = useCallback(() => {
    return new Dec(decRaw);
  }, [decRaw]);

  /** Raw value, which may be terminated with a `'.'`. `0`s are trimmed.
   *  Includes currency decimals for display. */
  const toString = useCallback(() => {
    if (new Dec(decRaw).isZero()) return decRaw;
    return trimZerosFromEnd(decRaw);
  }, [decRaw]);

  return {
    input,
    multiplicationQuoteOverBase,
    toDec,
    toDecWithCurrencyDecimals,
    toString,
    addCurrencyDecimals,
    removeCurrencyDecimals,
  };
}
