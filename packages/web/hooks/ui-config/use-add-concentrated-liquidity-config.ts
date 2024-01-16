import { CoinPretty, Dec, DecUtils, Int, RatePretty } from "@keplr-wallet/unit";
import {
  BigDec,
  calcAmount0,
  calcAmount1,
  maxSpotPrice,
  maxTick,
  minSpotPrice,
  minTick,
  priceToTick,
  roundPriceToNearestTick,
  roundToNearestDivisible,
} from "@osmosis-labs/math";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EventName } from "~/config";
import { useAmplitudeAnalytics } from "~/hooks/use-amplitude-analytics";
import type { Pool } from "~/server/queries/complex/pools";
import type { ConcentratedPoolRawResponse } from "~/server/queries/osmosis";
import { useStore } from "~/stores";
import { api } from "~/utils/trpc";

import { useAmountInput } from "../input/use-amount-input";
import { useAssetPairPriceInput } from "../input/use-price-input";
import { useCoinFiatValue } from "../queries/assets/use-coin-fiat-value";

/** Add concentrated liquidity.
 *
 *  Provides memoized callbacks for sending common messages associated with adding concentrated liquidity.
 */
export function useAddConcentratedLiquidityConfig(
  osmosisChainId: string,
  poolId: string
): {
  config: AddConcentratedLiquidityState;
  addLiquidity: (superfluidValidatorAddress?: string) => Promise<void>;
  increaseLiquidity: (positionId: string) => Promise<void>;
} {
  const { accountStore, queriesStore } = useStore();
  const osmosisQueries = queriesStore.get(osmosisChainId).osmosis!;
  const { logEvent } = useAmplitudeAnalytics();

  const account = accountStore.getWallet(osmosisChainId);
  const address = account?.address ?? "";

  const pool = api.edge.pools.getPool.useQuery({ poolId }).data;

  const config = useAddConcentratedLiquidityState(pool, address);

  const value0 = useCoinFiatValue(config?.baseDepositAmountIn.amount);
  const value1 = useCoinFiatValue(config?.quoteDepositAmountIn.amount);

  const addLiquidity = useCallback(
    (superfluidValidatorAddress?: string) => {
      return new Promise<void>(async (resolve, reject) => {
        try {
          if (
            !config.baseDepositAmountIn.amount ||
            !config.quoteDepositAmountIn.amount
          ) {
            reject("Invalid amount inputs");
            return;
          }

          const quoteCoin = {
            currency: config.quoteDepositAmountIn.amount.currency,
            amount: config.quoteDepositAmountIn.amount.toCoin().amount,
          };
          const baseCoin = {
            currency: config.baseDepositAmountIn.amount.currency,
            amount: config.baseDepositAmountIn.amount.toCoin().amount,
          };
          let quoteDepositCoin = undefined;
          let baseDepositCoin = undefined;
          if (config.baseDepositOnly) {
            baseDepositCoin = baseCoin;
          } else if (config.quoteDepositOnly) {
            quoteDepositCoin = quoteCoin;
          } else {
            quoteDepositCoin = quoteCoin;
            baseDepositCoin = baseCoin;
          }

          const totalValue = Number(
            value0?.toDec().add(value1?.toDec() ?? new Dec(0)) ?? 0
          );
          const baseEvent = {
            isSingleAsset:
              !Boolean(baseDepositCoin) || !Boolean(quoteDepositCoin),
            liquidityUSD: totalValue,
            volatilityType: config.currentStrategy ?? "",
            poolId,
            rangeHigh: Number(config.rangeWithCurrencyDecimals[1].toString()),
            rangeLow: Number(config.rangeWithCurrencyDecimals[0].toString()),
          };
          logEvent([
            EventName.ConcentratedLiquidity.addLiquidityStarted,
            baseEvent,
          ]);

          await account?.osmosis.sendCreateConcentratedLiquidityPositionMsg(
            poolId,
            config.tickRange[0],
            config.tickRange[1],
            superfluidValidatorAddress,
            baseDepositCoin,
            quoteDepositCoin,
            undefined,
            undefined,
            (tx) => {
              if (tx.code) reject(tx.rawLog);
              else {
                osmosisQueries.queryLiquiditiesPerTickRange
                  .getForPoolId(poolId)
                  .waitFreshResponse()
                  .then(() => resolve());

                logEvent([
                  EventName.ConcentratedLiquidity.addLiquidityCompleted,
                  baseEvent,
                ]);
              }
            }
          );
        } catch (e: any) {
          console.error(e);
          reject(e.message);
        }
      });
    },
    [
      poolId,
      account?.osmosis,
      value0,
      value1,
      osmosisQueries.queryLiquiditiesPerTickRange,
      config.baseDepositAmountIn.amount,
      config.quoteDepositAmountIn.amount,
      config.baseDepositOnly,
      config.quoteDepositOnly,
      config.tickRange,
      config.currentStrategy,
      config.rangeWithCurrencyDecimals,
      logEvent,
    ]
  );

  const increaseLiquidity = useCallback(
    (positionId: string) =>
      new Promise<void>(async (resolve, reject) => {
        if (
          !config.baseDepositAmountIn.amount ||
          !config.quoteDepositAmountIn.amount
        ) {
          reject("Invalid amount inputs");
          return;
        }

        const amount0 = config.quoteDepositOnly
          ? "0"
          : config.baseDepositAmountIn.amount?.toCoin().amount;
        const amount1 = config.baseDepositOnly
          ? "0"
          : config.quoteDepositAmountIn.amount?.toCoin().amount;

        const totalValue = Number(
          value0?.toDec().add(value1?.toDec() ?? new Dec(0)) ?? 0
        );
        const baseEvent = {
          isSingleAsset: amount0 === "0" || amount1 === "0",
          liquidityUSD: totalValue,
          positionId: positionId,
          volatilityType: config.currentStrategy ?? "",
          poolId,
          rangeHigh: Number(config.rangeWithCurrencyDecimals[1].toString()),
          rangeLow: Number(config.rangeWithCurrencyDecimals[0].toString()),
        };
        logEvent([
          EventName.ConcentratedLiquidity.addMoreLiquidityStarted,
          baseEvent,
        ]);

        try {
          await account?.osmosis.sendAddToConcentratedLiquidityPositionMsg(
            positionId,
            amount0,
            amount1,
            undefined,
            undefined,
            (tx) => {
              if (tx.code) reject(tx.rawLog);
              else {
                osmosisQueries.queryLiquiditiesPerTickRange
                  .getForPoolId(poolId)
                  .waitFreshResponse();

                logEvent([
                  EventName.ConcentratedLiquidity.addMoreLiquidityCompleted,
                  baseEvent,
                ]);

                resolve();
              }
            }
          );
        } catch (e: any) {
          console.error(e);
          reject(e.message);
        }
      }),
    [
      poolId,
      osmosisQueries.queryLiquiditiesPerTickRange,
      config.baseDepositAmountIn,
      config.quoteDepositAmountIn,
      config.baseDepositOnly,
      config.quoteDepositOnly,
      config.currentStrategy,
      config.rangeWithCurrencyDecimals,
      account?.osmosis,
      value0,
      value1,
      logEvent,
    ]
  );

  return { config, addLiquidity, increaseLiquidity };
}

export const MODERATE_STRATEGY_MULTIPLIER = 0.25;
export const AGGRESSIVE_STRATEGY_MULTIPLIER = 0.05;

export type AddConcentratedLiquidityState = ReturnType<
  typeof useAddConcentratedLiquidityState
>;
export function useAddConcentratedLiquidityState(
  pool?: Pool,
  userOsmoAddress?: string
) {
  const clPool = useMemo(() => {
    if (pool?.type !== "concentrated") {
      console.error(
        "useAddConcentratedLiquidity used with wrong pool type",
        pool?.id
      );
      return undefined;
    }

    return {
      ...pool,
      type: pool.type as "concentrated",
      raw: pool.raw as ConcentratedPoolRawResponse,
    };
  }, [pool]);

  const baseCurrency = clPool?.reserveCoins[0].currency;
  const quoteCurrency = clPool?.reserveCoins[1].currency;

  // queries
  const { data: historicalPriceData } =
    api.edge.assets.getAssetPairHistoricalPrice.useQuery(
      {
        poolId: clPool?.id ?? "",
        quoteCoinMinimalDenom: quoteCurrency?.coinMinimalDenom ?? "",
        baseCoinMinimalDenom: baseCurrency?.coinMinimalDenom ?? "",
        timeDuration: "7d",
      },
      {
        enabled:
          Boolean(clPool) && Boolean(baseCurrency) && Boolean(quoteCurrency),
      }
    );

  // state
  const baseAmountInput = useAmountInput(baseCurrency);
  const quoteAmountInput = useAmountInput(quoteCurrency);
  const minPriceInput = useAssetPairPriceInput(baseCurrency, quoteCurrency);
  const maxPriceInput = useAssetPairPriceInput(baseCurrency, quoteCurrency);
  const [modalView, setModalView] = useState<
    "overview" | "add_manual" | "add_managed"
  >("overview");
  const [fullRange, setFullRange] = useState(false);
  const [anchorAsset, setAnchorAsset] = useState<"base" | "quote">("base");
  const [isSuperfluidStakingEnabled, setElectSuperfluidStaking] =
    useState(false);

  // state derivations
  const shouldBeSuperfluidStaked = isSuperfluidStakingEnabled && fullRange;
  const calcLastWeekPriceDiff = useCallback(
    (multiplier: number) => {
      if (!historicalPriceData)
        return {
          lastWeekPriceDiffMin: new Dec(0),
          lastWeekPriceDiffMax: new Dec(0),
        };
      const { min, max } = historicalPriceData;

      // returns prices with decimals for display
      const minPrice7d = minPriceInput.removeCurrencyDecimals(min);
      const maxPrice7d = maxPriceInput.removeCurrencyDecimals(max);
      const priceDiff = maxPrice7d.sub(minPrice7d).mul(new Dec(multiplier));

      return {
        lastWeekPriceDiffMin: minPrice7d.sub(priceDiff),
        lastWeekPriceDiffMax: maxPrice7d.add(priceDiff),
      };
    },
    [historicalPriceData, minPriceInput, maxPriceInput]
  );

  const currentSqrtPrice = useMemo(() => {
    if (!clPool) return new BigDec(0);
    return new BigDec(clPool.raw.current_sqrt_price);
  }, [clPool]);
  const currentPrice = useMemo(() => {
    return currentSqrtPrice.mul(currentSqrtPrice).toDec();
  }, [currentSqrtPrice]);
  const currentPriceWithDecimals = useMemo(() => {
    return currentPrice.mul(minPriceInput.multiplicationQuoteOverBase);
  }, [currentPrice, minPriceInput.multiplicationQuoteOverBase]);

  const tickDivisor = useMemo(
    () => new Int(clPool?.raw.tick_spacing ?? 100),
    [clPool]
  );

  /** User-selected price range without currency decimals, rounded to nearest tick. Within +/-50x of current tick. */
  const range = useMemo(() => {
    const input0 = minPriceInput.toDec();
    const input1 = maxPriceInput.toDec();
    if (fullRange || !clPool) return [minSpotPrice, maxSpotPrice];
    const tickSpacing = Number(clPool.raw.tick_spacing);

    const inputMinPrice = roundPriceToNearestTick(input0, tickSpacing, true);
    const inputMaxPrice = roundPriceToNearestTick(input1, tickSpacing, true);
    const minPrice50x = currentPrice.quo(new Dec(50));
    const maxPrice50x = currentPrice.mul(new Dec(50));

    return [
      inputMinPrice.lt(minPrice50x) ? minPrice50x : inputMinPrice,
      inputMaxPrice.gt(maxPrice50x) ? maxPrice50x : inputMaxPrice,
    ];
  }, [minPriceInput, maxPriceInput, clPool, fullRange, currentPrice]);
  const rangeWithCurrencyDecimals: [Dec, Dec] = useMemo(() => {
    if (fullRange) {
      return [
        minPriceInput.addCurrencyDecimals(minSpotPrice),
        // for display, avoid using max spot price since the price chart would get flattened
        currentPriceWithDecimals.mul(new Dec(2)),
      ];
    }

    return [
      minPriceInput.toDecWithCurrencyDecimals(),
      maxPriceInput.toDecWithCurrencyDecimals(),
    ];
  }, [fullRange, minPriceInput, maxPriceInput, currentPriceWithDecimals]);
  const rangeRaw = useMemo(
    () => [minPriceInput.toString(), maxPriceInput.toString()],
    [minPriceInput, maxPriceInput]
  );
  const tickRange = useMemo(() => {
    if (fullRange || !tickDivisor) return [minTick, maxTick];
    try {
      // account for precision issues from price <> tick conversion
      const lowerTick = priceToTick(range[0]);
      const upperTick = priceToTick(range[1]);

      let lowerTickRounded = roundToNearestDivisible(lowerTick, tickDivisor);
      let upperTickRounded = roundToNearestDivisible(upperTick, tickDivisor);

      // If they rounded to the same value, pad both to respect the
      // user's desired range.
      if (lowerTickRounded.equals(upperTickRounded)) {
        lowerTickRounded = lowerTickRounded.sub(tickDivisor);
        upperTickRounded = upperTickRounded.add(tickDivisor);
      }

      return [
        lowerTickRounded.lt(minTick) ? minTick : lowerTickRounded,
        upperTickRounded.gt(maxTick) ? maxTick : upperTickRounded,
      ];
    } catch (e) {
      console.error(e);
      return [minTick, maxTick];
    }
  }, [fullRange, tickDivisor, range]);

  const baseDepositOnly = useMemo(() => {
    // can be 0 if no positions in pool
    if (currentPrice.isZero()) return false;

    const range0 = range[0];
    const range1 = range[1];
    if (typeof range0 === "string" || typeof range1 === "string") return false;

    return !fullRange && currentPrice.lt(range0) && currentPrice.lt(range1);
  }, [currentPrice, fullRange, range]);
  const quoteDepositOnly = useMemo(() => {
    // can be 0 if no positions in pool
    if (currentPrice.isZero()) return false;

    return !fullRange && currentPrice.gt(range[0]) && currentPrice.gt(range[1]);
  }, [currentPrice, fullRange, range]);

  // -- moderate strategy
  const moderatePriceRange = useMemo(() => {
    if (!clPool) return [new Dec(0.1), new Dec(100)];
    const tickSpacing = Number(clPool.raw.tick_spacing);

    const { lastWeekPriceDiffMin, lastWeekPriceDiffMax } =
      calcLastWeekPriceDiff(MODERATE_STRATEGY_MULTIPLIER);

    return [
      roundPriceToNearestTick(lastWeekPriceDiffMin, tickSpacing, true),
      roundPriceToNearestTick(lastWeekPriceDiffMax, tickSpacing, false),
    ];
  }, [clPool, calcLastWeekPriceDiff]);
  const moderateTickRange = useMemo(
    () => [
      roundToNearestDivisible(priceToTick(moderatePriceRange[0]), tickDivisor),
      roundToNearestDivisible(priceToTick(moderatePriceRange[1]), tickDivisor),
    ],
    [moderatePriceRange, tickDivisor]
  );

  // -- custom strategy
  const initialCustomPriceRange = useMemo(() => {
    if (!clPool) return [new Dec(0.1), new Dec(100)];
    const tickSpacing = Number(clPool.raw.tick_spacing);

    return [
      roundPriceToNearestTick(
        currentPrice.mul(new Dec(0.45)),
        tickSpacing,
        true
      ),
      roundPriceToNearestTick(
        currentPrice.mul(new Dec(1.55)),
        tickSpacing,
        false
      ),
    ];
  }, [clPool, currentPrice]);

  // -- aggressive strategy
  const aggressivePriceRange = useMemo(() => {
    if (!clPool) return [new Dec(0.1), new Dec(100)];
    const tickSpacing = Number(clPool.raw.tick_spacing);

    // query returns prices with decimals for display
    const { lastWeekPriceDiffMin, lastWeekPriceDiffMax } =
      calcLastWeekPriceDiff(AGGRESSIVE_STRATEGY_MULTIPLIER);

    return [
      roundPriceToNearestTick(lastWeekPriceDiffMin, tickSpacing, true),
      roundPriceToNearestTick(lastWeekPriceDiffMax, tickSpacing, false),
    ];
  }, [clPool, calcLastWeekPriceDiff]);
  const aggressiveTickRange = useMemo(
    () => [
      roundToNearestDivisible(
        priceToTick(aggressivePriceRange[0]),
        tickDivisor
      ),
      roundToNearestDivisible(
        priceToTick(aggressivePriceRange[1]),
        tickDivisor
      ),
    ],
    [aggressivePriceRange, tickDivisor]
  );

  const currentStrategy = useMemo(() => {
    const isRangePassive = fullRange;
    const isRangeAggressive =
      !isRangePassive &&
      tickRange[0].equals(aggressiveTickRange[0]) &&
      tickRange[1].equals(aggressiveTickRange[1]);
    const isRangeModerate =
      !isRangePassive &&
      tickRange[0].equals(moderateTickRange[0]) &&
      tickRange[1].equals(moderateTickRange[1]);

    if (isRangePassive) return "passive";
    if (isRangeModerate) return "moderate";
    if (isRangeAggressive) return "aggressive";
    return null;
  }, [fullRange, tickRange, aggressiveTickRange, moderateTickRange]);

  // deposit percentages
  const oneAmount1 = useMemo(
    () =>
      quoteCurrency
        ? new CoinPretty(
            quoteCurrency,
            new Int(1)
              .toDec()
              .mul(DecUtils.getTenExponentN(quoteCurrency.coinDecimals))
              .truncate()
          )
        : undefined,
    [quoteCurrency]
  );
  const ratioAmount0 = useMemo(
    () =>
      oneAmount1 && baseCurrency
        ? new CoinPretty(
            baseCurrency,
            calcAmount0(
              new Int(oneAmount1.toCoin().amount),
              tickRange[0],
              tickRange[1],
              currentSqrtPrice
            )
          )
        : undefined,
    [oneAmount1, tickRange, currentSqrtPrice, baseCurrency]
  );
  const amount1FiatValue = useCoinFiatValue(oneAmount1);
  const amount0FiatValue = useCoinFiatValue(ratioAmount0);
  const depositPercentages = useMemo(() => {
    if (!amount0FiatValue || !amount1FiatValue)
      return [new RatePretty(0), new RatePretty(0)];
    if (baseDepositOnly) return [new RatePretty(1), new RatePretty(0)];
    if (quoteDepositOnly) return [new RatePretty(0), new RatePretty(1)];

    const totalFiatValue = amount0FiatValue
      .toDec()
      .add(amount1FiatValue.toDec());
    if (totalFiatValue.isZero()) return [new RatePretty(0), new RatePretty(0)];

    return [
      new RatePretty(amount0FiatValue.toDec().quo(totalFiatValue)),
      new RatePretty(amount1FiatValue.toDec().quo(totalFiatValue)),
    ];
  }, [baseDepositOnly, quoteDepositOnly, amount1FiatValue, amount0FiatValue]);

  const error = useMemo(() => {
    if (!fullRange && range[0].gte(range[1])) {
      return new InvalidRangeError(
        "lower range must be less than upper range."
      );
    }

    if (quoteDepositOnly) {
      return quoteAmountInput.error;
    }

    if (baseDepositOnly) {
      return baseAmountInput.error;
    }

    return baseAmountInput.error || quoteAmountInput.error;
  }, [
    fullRange,
    range,
    quoteDepositOnly,
    baseDepositOnly,
    quoteAmountInput.error,
    baseAmountInput.error,
  ]);

  // actions
  const setMinRange = useCallback(
    (min: string) => {
      if (!clPool) return;

      setFullRange(false);
      minPriceInput.input(min);
    },
    [clPool, minPriceInput]
  );
  const setMaxRange = useCallback(
    (max: string) => {
      if (!clPool) return;

      setFullRange(false);
      maxPriceInput.input(max);
    },
    [clPool, maxPriceInput]
  );

  const setBaseDepositAmountMax = useCallback(() => {
    setAnchorAsset("base");
    quoteAmountInput.setFraction(null);
    baseAmountInput.setFraction(1);
  }, [quoteAmountInput, baseAmountInput]);
  const setQuoteDepositAmountMax = useCallback(() => {
    setAnchorAsset("quote");
    baseAmountInput.setFraction(null);
    quoteAmountInput.setFraction(1);
  }, [quoteAmountInput, baseAmountInput]);

  // effects

  // -- initialize range
  const initialized = useRef(false);
  useEffect(() => {
    if (
      clPool &&
      !initialized.current &&
      baseAmountInput.amount?.currency &&
      quoteAmountInput.amount?.currency
    ) {
      initialized.current = true;

      const multiplicationQuoteOverBase = DecUtils.getTenExponentN(
        (baseAmountInput.amount.currency.coinDecimals ?? 0) -
          (quoteAmountInput.amount.currency.coinDecimals ?? 0)
      );

      // Set the initial range to be the moderate range
      setMinRange(
        moderatePriceRange[0].mul(multiplicationQuoteOverBase).toString()
      );
      setMaxRange(
        moderatePriceRange[1].mul(multiplicationQuoteOverBase).toString()
      );
    }
  }, [
    clPool,
    setMinRange,
    setMaxRange,
    moderatePriceRange,
    baseAmountInput.amount?.currency,
    quoteAmountInput.amount?.currency,
  ]);

  const { data: userAssetsData } = api.edge.assets.getAssets.useQuery(
    {
      userOsmoAddress,
    },
    { enabled: Boolean(userOsmoAddress) }
  );
  // -- react to amount0 input
  useEffect(() => {
    const baseAmountRaw = baseAmountInput.amount?.toCoin().amount ?? "0";
    const amount0 = new Int(baseAmountRaw);
    const userAssets = userAssetsData?.items;

    if (
      anchorAsset !== "base" ||
      amount0.lte(new Int(0)) ||
      // special case: likely no positions created yet in pool
      currentSqrtPrice.isZero() ||
      !quoteCurrency ||
      !userAssets
    ) {
      return;
    }

    if (amount0.isZero()) quoteAmountInput.setAmount("0");

    const [lowerTick, upperTick] = tickRange;

    // calculate proportional amount of other amount
    const amount1 = calcAmount1(
      amount0,
      lowerTick,
      upperTick,
      currentSqrtPrice
    );
    // include decimals, as is displayed to user
    const quoteCoin = new CoinPretty(quoteCurrency, amount1);

    const quoteBalance = userAssets.find(
      (asset) =>
        asset.amount &&
        asset.amount?.currency.coinMinimalDenom ===
          quoteCurrency.coinMinimalDenom
    )?.amount;

    // set max: if quote coin higher than quote balance, set to quote balance
    if (
      baseAmountInput.fraction === 1 &&
      quoteBalance &&
      quoteCoin.toDec().gt(quoteBalance.toDec())
    ) {
      setQuoteDepositAmountMax();
    } else {
      quoteAmountInput.setAmount(
        quoteCoin.hideDenom(true).locale(false).trim(true).toString()
      );
    }
  }, [
    baseAmountInput,
    baseAmountInput.amount,
    baseAmountInput.fraction,
    quoteAmountInput,
    anchorAsset,
    tickRange,
    userAssetsData,
    currentSqrtPrice,
    quoteCurrency,
    setQuoteDepositAmountMax,
  ]);

  // -- react to amount1 input
  useEffect(() => {
    const quoteAmountRaw = quoteAmountInput.amount?.toCoin().amount ?? "0";
    const amount1 = new Int(quoteAmountRaw);
    const userAssets = userAssetsData?.items;

    if (
      anchorAsset !== "quote" ||
      amount1.lte(new Int(0)) ||
      !userAssets ||
      // special case: likely no positions created yet in pool
      currentSqrtPrice.isZero() ||
      !baseCurrency
    )
      return;

    if (amount1.isZero()) baseAmountInput.setAmount("0");

    const [lowerTick, upperTick] = tickRange;

    // calculate proportional amount of other amount
    const amount0 = calcAmount0(
      amount1,
      lowerTick,
      upperTick,
      currentSqrtPrice
    );
    // include decimals, as is displayed to user
    const baseCoin = new CoinPretty(baseCurrency, amount0);

    const baseBalance = userAssets.find(
      (asset) =>
        asset.amount &&
        asset.amount?.currency.coinMinimalDenom ===
          baseCurrency.coinMinimalDenom
    )?.amount;

    // set max: if base coin higher than base balance, set to base balance
    if (
      quoteAmountInput.fraction === 1 &&
      baseBalance &&
      baseCoin.toDec().gt(baseBalance.toDec())
    ) {
      setBaseDepositAmountMax();
    } else {
      baseAmountInput.setAmount(
        baseCoin.hideDenom(true).locale(false).trim(true).toString()
      );
    }
  }, [
    anchorAsset,
    baseAmountInput,
    baseCurrency,
    currentSqrtPrice,
    quoteAmountInput.amount,
    quoteAmountInput.fraction,
    tickRange,
    userAssetsData,
    setBaseDepositAmountMax,
  ]);

  return {
    modalView,
    setModalView,
    shouldBeSuperfluidStaked,
    setElectSuperfluidStaking,
    anchorAsset,
    setAnchorAsset,
    fullRange,
    setFullRange,
    setMinRange,
    setMaxRange,
    rangeWithCurrencyDecimals,
    rangeRaw,
    tickRange,
    baseDepositAmountIn: baseAmountInput,
    setBaseDepositAmountMax,
    baseDepositOnly,
    quoteDepositAmountIn: quoteAmountInput,
    setQuoteDepositAmountMax,
    quoteDepositOnly,
    currentPrice,
    currentPriceWithDecimals,
    moderatePriceRange,
    aggressivePriceRange,
    initialCustomPriceRange,
    currentStrategy,
    depositPercentages,
    error,
  };
}

export class InvalidRangeError extends Error {
  constructor(m: string) {
    super(m);
    Object.setPrototypeOf(this, InvalidRangeError.prototype);
  }
}
