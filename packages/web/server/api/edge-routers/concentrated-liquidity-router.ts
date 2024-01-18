import { CoinPretty, Dec, DecUtils, Int } from "@keplr-wallet/unit";
import { maxTick, minTick, tickToSqrtPrice } from "@osmosis-labs/math";
import cachified, { CacheEntry } from "cachified";
import { LRUCache } from "lru-cache";
import { z } from "zod";

import { DEFAULT_LRU_OPTIONS } from "~/config/cache";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { getAsset } from "~/server/queries/complex/assets";
import { UserOsmoAddressSchema } from "~/server/queries/complex/parameter-types";
import { getPools } from "~/server/queries/complex/pools";
import { queryPositionPerformance } from "~/server/queries/imperator";
import { ConcentratedPoolRawResponse } from "~/server/queries/osmosis";
import {
  queryCLPositions,
  queryCLUnbondingPositions,
} from "~/server/queries/osmosis/concentratedliquidity";
import {
  queryDelegatedClPositions,
  queryUndelegatingClPositions,
} from "~/server/queries/osmosis/superfluid";
import { sort } from "~/utils/sort";

export const concentratedLiquidityRouter = createTRPCRouter({
  getUserPositions: publicProcedure
    .input(
      z
        .object({
          sortDirection: z.enum(["asc", "desc"]).default("desc"),
        })
        .merge(UserOsmoAddressSchema.required())
    )
    .query(async ({ input: { userOsmoAddress, sortDirection } }) => {
      const { positions: rawPositions } = await queryCLPositions({
        bech32Address: userOsmoAddress,
      });

      // TODO: sort by joinTime
      console.time("normalizePositions");
      const result = await normalizePositions({
        positions: rawPositions,
        userOsmoAddress,
      });
      console.timeEnd("normalizePositions");
      return sort(result, "joinTime", sortDirection);
    }),

  getPositionPerformance: publicProcedure
    .input(
      z.object({
        positionId: z.string(),
      })
    )
    .query(async ({ input: { positionId } }) => {
      const performance = await queryPositionPerformance({
        positionId,
      });

      return {
        principalAssets: await mapRawAssetsToCoinPretty({
          rawAssets: performance.principal.assets,
        }),
        totalEarned: getTotalEarned({
          totalIncentivesRewards: performance.total_incentives_rewards,
          totalSpreadRewards: performance.total_spread_rewards,
        }),
      };
    }),
});

type LiquidityPosition = Awaited<
  ReturnType<typeof queryCLPositions>
>["positions"][number];
type PositionPerformance = Awaited<ReturnType<typeof queryPositionPerformance>>;

type PositionStatus =
  | "inRange"
  | "nearBounds"
  | "outOfRange"
  | "fullRange"
  | "unbonding"
  | "superfluidStaked"
  | "superfluidUnstaking";

function getPositionStatus({
  lowerPrice,
  upperPrice,
  currentPrice,
  isFullRange,
  isSuperfluid,
  isSuperfluidUnstaking,
  isUnbonding,
}: {
  lowerPrice: Dec;
  upperPrice: Dec;
  currentPrice: Dec;
  isFullRange: boolean;
  isSuperfluid: boolean;
  isSuperfluidUnstaking: boolean;
  isUnbonding: boolean;
}): PositionStatus {
  const inRange = lowerPrice.lt(currentPrice) && upperPrice.gt(currentPrice);
  const diff = new Dec(
    Math.min(
      Number(currentPrice.sub(lowerPrice).toString()),
      Number(upperPrice.sub(currentPrice).toString())
    )
  );
  const rangeDiff = upperPrice.sub(lowerPrice);
  const diffPercentage =
    currentPrice.isZero() || rangeDiff.isZero()
      ? new Dec(0)
      : diff.quo(rangeDiff).mul(new Dec(100));

  let status: PositionStatus;

  if (isFullRange) {
    status = "fullRange";
  } else if (isUnbonding) {
    status = "unbonding";
  } else if (isSuperfluid) {
    status = "superfluidStaked";
  } else if (isSuperfluidUnstaking) {
    status = "superfluidUnstaking";
  } else if (inRange) {
    status = diffPercentage.lte(new Dec(15)) ? "nearBounds" : "inRange";
  } else {
    status = "outOfRange";
  }

  return status;
}

async function getPositionAsset({
  amount,
  denom,
}: LiquidityPosition["asset0"] & LiquidityPosition["asset1"]) {
  const asset = await getAsset({
    anyDenom: denom,
  });

  if (!amount || !denom) return undefined;
  if (!asset) throw new Error("Asset not found " + denom);

  return new CoinPretty(asset, amount);
}

function getPriceFromSqrtPrice({
  sqrtPrice,
  baseAsset,
  quoteAsset,
}: {
  baseAsset: CoinPretty;
  quoteAsset: CoinPretty;
  sqrtPrice: Dec;
}) {
  const multiplicationQuoteOverBase = DecUtils.getTenExponentN(
    baseAsset.currency.coinDecimals - quoteAsset.currency.coinDecimals
  );
  const price = sqrtPrice.mul(sqrtPrice).mul(multiplicationQuoteOverBase);
  return price;
}

function getClTickPrice({
  tick,
  baseAsset,
  quoteAsset,
}: {
  tick: Int;
  baseAsset: CoinPretty;
  quoteAsset: CoinPretty;
}) {
  const sqrtPrice = tickToSqrtPrice(tick);
  return getPriceFromSqrtPrice({
    baseAsset,
    quoteAsset,
    sqrtPrice,
  });
}

function isPositionFullRange({
  lowerTick,
  upperTick,
}: {
  lowerTick: Int;
  upperTick: Int;
}): boolean {
  if (lowerTick?.equals(minTick) && upperTick?.equals(maxTick)) {
    return true;
  }

  return false;
}

async function mapRawAssetsToCoinPretty({
  rawAssets,
}: {
  rawAssets?: {
    amount: string | number;
    denom: string;
  }[];
}) {
  if (!rawAssets) return [];
  const result = await Promise.all(
    rawAssets.map(async ({ amount, denom }) => {
      const asset = await getAsset({
        anyDenom: denom,
      });

      if (!asset) return undefined;
      const coin = new CoinPretty(asset, amount);
      return coin;
    })
  );
  return result.filter((p): p is NonNullable<typeof p> => !!p);
}

async function getTotalClaimableRewards({
  rawClaimableIncentiveRewards,
  rawClaimableSpreadRewards,
}: {
  rawClaimableSpreadRewards: LiquidityPosition["claimable_spread_rewards"];
  rawClaimableIncentiveRewards: LiquidityPosition["claimable_incentives"];
}) {
  const [claimableIncentiveRewards, claimableSpreadRewards] = await Promise.all(
    [
      mapRawAssetsToCoinPretty({
        rawAssets: rawClaimableIncentiveRewards,
      }),
      mapRawAssetsToCoinPretty({
        rawAssets: rawClaimableSpreadRewards,
      }),
    ]
  );

  return Array.from(
    [...claimableSpreadRewards, ...claimableIncentiveRewards]
      .reduce<Map<string, CoinPretty>>((sumByDenoms, coin) => {
        const current = sumByDenoms.get(coin.currency.coinMinimalDenom);
        if (current) {
          sumByDenoms.set(coin.currency.coinMinimalDenom, current.add(coin));
        } else {
          sumByDenoms.set(coin.currency.coinMinimalDenom, coin);
        }
        return sumByDenoms;
      }, new Map())
      .values()
  );
}

async function getTotalEarned({
  totalSpreadRewards,
  totalIncentivesRewards,
}: {
  totalSpreadRewards: PositionPerformance["total_spread_rewards"];
  totalIncentivesRewards: PositionPerformance["total_incentives_rewards"];
}) {
  const [spreadRewards, incentivesRewards] = await Promise.all([
    mapRawAssetsToCoinPretty({
      rawAssets: totalSpreadRewards,
    }),
    mapRawAssetsToCoinPretty({
      rawAssets: totalIncentivesRewards,
    }),
  ]);

  const earnedCoinDenomMap = new Map<string, CoinPretty>();
  [...spreadRewards, ...incentivesRewards].forEach((coin) => {
    const existingCoin = earnedCoinDenomMap.get(coin.currency.coinMinimalDenom);
    if (existingCoin) {
      earnedCoinDenomMap.set(
        coin.currency.coinMinimalDenom,
        existingCoin.add(coin)
      );
    } else {
      earnedCoinDenomMap.set(coin.currency.coinMinimalDenom, coin);
    }
  });
  return Array.from(earnedCoinDenomMap.values());
}

const clCache = new LRUCache<string, CacheEntry>(DEFAULT_LRU_OPTIONS);
async function getUserUnbondingPositions({
  userOsmoAddress,
}: {
  userOsmoAddress: string;
}) {
  return cachified({
    cache: clCache,
    key: `${userOsmoAddress}-cl-unbonding-info`,
    getFreshValue: async () => {
      const { positions_with_period_lock } = await queryCLUnbondingPositions({
        bech32Address: userOsmoAddress,
      });
      return positions_with_period_lock;
    },
    ttl: 5 * 1000, // 5 seconds
  });
}

async function getUserDelegatedClPositions({
  userOsmoAddress,
}: {
  userOsmoAddress: string;
}) {
  return cachified({
    cache: clCache,
    key: `${userOsmoAddress}-cl-delegated-positions`,
    getFreshValue: async () => {
      const { cl_pool_user_position_records } = await queryDelegatedClPositions(
        {
          bech32Address: userOsmoAddress,
        }
      );
      return cl_pool_user_position_records;
    },
    ttl: 5 * 1000, // 5 seconds
  });
}

async function getUserUndelegatingClPositions({
  userOsmoAddress,
}: {
  userOsmoAddress: string;
}) {
  return cachified({
    cache: clCache,
    key: `${userOsmoAddress}-cl-undelegating-positions`,
    getFreshValue: async () => {
      const { cl_pool_user_position_records } =
        await queryUndelegatingClPositions({
          bech32Address: userOsmoAddress,
        });
      return cl_pool_user_position_records;
    },
    ttl: 5 * 1000, // 5 seconds
  });
}

async function normalizePositions({
  positions,
  userOsmoAddress,
}: {
  positions: LiquidityPosition[];
  userOsmoAddress: string;
}) {
  try {
    const poolIds = positions.map(({ position: { pool_id } }) => pool_id);
    const pools = await getPools({ poolIds: poolIds });

    const normalizedPositions = await Promise.all(
      positions.map(
        async ({
          asset0,
          asset1,
          position,
          claimable_incentives,
          claimable_spread_rewards,
        }) => {
          const [baseAsset, quoteAsset] = await Promise.all([
            getPositionAsset(asset0),
            getPositionAsset(asset1),
          ]);

          if (!baseAsset || !quoteAsset) {
            console.info(
              `Error finding assets for position ${position.position_id}`
            );
            return undefined;
          }

          const lowerTick = new Int(position.lower_tick);
          const upperTick = new Int(position.upper_tick);
          const priceRangePromise = Promise.all([
            getClTickPrice({
              tick: lowerTick,
              baseAsset,
              quoteAsset,
            }),
            getClTickPrice({
              tick: upperTick,
              baseAsset,
              quoteAsset,
            }),
          ]);
          const unclaimedRewardsPromise = getTotalClaimableRewards({
            rawClaimableIncentiveRewards: claimable_incentives,
            rawClaimableSpreadRewards: claimable_spread_rewards,
          });
          const userUnbondingPositionsPromise = getUserUnbondingPositions({
            userOsmoAddress,
          });
          const delegatedPositionsPromise = getUserDelegatedClPositions({
            userOsmoAddress,
          });
          const undelegatingPositionsPromise = getUserUndelegatingClPositions({
            userOsmoAddress,
          });
          const stakeCurrencyPromise = getAsset({ anyDenom: "OSMO" });

          const [
            priceRange,
            unclaimedRewards,
            userUnbondingPositions,
            delegatedPositions,
            undelegatingPositions,
            stakeCurrency,
          ] = await Promise.all([
            priceRangePromise,
            unclaimedRewardsPromise,
            userUnbondingPositionsPromise,
            delegatedPositionsPromise,
            undelegatingPositionsPromise,
            stakeCurrencyPromise,
          ]);

          const pool = pools.find((pool) => pool.id === position.pool_id);

          if (!pool) {
            console.error(`Pool (${position.pool_id}) not found`);
            return undefined;
          }

          if (pool.type !== "concentrated") {
            throw new Error("Pool type is not concentrated");
          }

          const liquidity = new Dec(position.liquidity);
          const currentAssets = [baseAsset, quoteAsset];
          const isUnbonding = userUnbondingPositions.some(
            ({ position: unbondingPosition }) =>
              unbondingPosition.position_id === position.position_id
          );

          const rawDelegatedSuperfluidPosition = delegatedPositions.find(
            (delegatedPosition) =>
              delegatedPosition.position_id === position.position_id
          );
          const rawUndelegatingSuperfluidPosition = undelegatingPositions.find(
            (undelegatingPosition) =>
              undelegatingPosition.position_id === position.position_id
          );
          const isSuperfluid = !!rawDelegatedSuperfluidPosition;
          const isSuperfluidUnstaking = !!rawUndelegatingSuperfluidPosition;

          if (!stakeCurrency)
            throw new Error(`Stake currency (OSMO) not found`);

          const delegatedSuperfluidPosition = isSuperfluid
            ? {
                positionId: rawDelegatedSuperfluidPosition.position_id,
                validatorAddress:
                  rawDelegatedSuperfluidPosition.validator_address,
                lockId: rawDelegatedSuperfluidPosition.lock_id,
                equivalentStakedAmount: new CoinPretty(
                  stakeCurrency,
                  rawDelegatedSuperfluidPosition.equivalent_staked_amount.amount
                ),
              }
            : undefined;

          const undelegatingSuperfluidPosition = isSuperfluidUnstaking
            ? {
                positionId: rawUndelegatingSuperfluidPosition.position_id,
                validatorAddress:
                  rawUndelegatingSuperfluidPosition.validator_address,
                lockId: rawUndelegatingSuperfluidPosition.lock_id,
                equivalentStakedAmount: new CoinPretty(
                  stakeCurrency,
                  rawUndelegatingSuperfluidPosition.equivalent_staked_amount.amount
                ),
                endTime: new Date(
                  rawUndelegatingSuperfluidPosition.synthetic_lock.end_time
                ),
              }
            : undefined;

          const status = getPositionStatus({
            currentPrice: getPriceFromSqrtPrice({
              sqrtPrice: new Dec(
                (pool.raw as ConcentratedPoolRawResponse).current_sqrt_price
              ),
              baseAsset,
              quoteAsset,
            }),
            isFullRange: isPositionFullRange({ lowerTick, upperTick }),
            isSuperfluid,
            isSuperfluidUnstaking,
            isUnbonding,
            lowerPrice: priceRange[0],
            upperPrice: priceRange[1],
          });
          const joinTime = new Date(position.join_time);

          let superfluidData: Record<any, any> | undefined = undefined;
          if (isSuperfluid && delegatedSuperfluidPosition) {
            superfluidData = {
              // validatorName,
              // validatorImgSrc,
              equivalentStakedAmount:
                delegatedSuperfluidPosition.equivalentStakedAmount,
              // validatorCommission,
              // superfluidApr,
              // stakeDuration,
            };
          } else if (isSuperfluidUnstaking && undelegatingSuperfluidPosition) {
            superfluidData = {
              // validatorName,
              // validatorImgSrc,
              equivalentStakedAmount:
                undelegatingSuperfluidPosition.equivalentStakedAmount,
              // validatorCommission,
              // superfluidApr,
              // stakeDuration,
            };
          }

          return {
            id: position.position_id,
            poolId: position.pool_id,
            status,
            priceRange,
            liquidity,
            currentAssets,
            unclaimedRewards,
            joinTime,
            ...(superfluidData ? { superfluidData } : undefined),
          };
        }
      )
    );

    return normalizedPositions.filter((p): p is NonNullable<typeof p> => !!p);
  } catch (e) {
    console.error(e);
    throw e;
  }
}