import { useEffect, useState } from "react";
import { TOKEN } from "./config";
import { formatDecimal, formatUnits } from "./format";
import { view, type Asset, type Plan, type TokenMeta } from "./near";

/** How to print an amount of one plan asset. `decimals === null` means the metadata is unknown: print raw base units. */
export interface AssetInfo {
  contract: string; // "near" for native NEAR
  symbol: string;
  decimals: number | null;
}

export type MetaMap = Record<string, TokenMeta | null>; // contract → metadata (null = lookup failed)

export const ftContract = (a: Asset): string | null => (a === "Near" ? null : a?.Ft?.contract ?? null);
/** Is this plan denominated in the token the dashboard is configured for? Only those count in the headline stats. */
export const isConfiguredToken = (p: Pick<Plan, "asset">) => ftContract(p.asset) === TOKEN;

export function assetInfo(a: Asset, metas: MetaMap): AssetInfo {
  const c = ftContract(a);
  if (c === null) return { contract: "near", symbol: "NEAR", decimals: 24 };
  const m = metas[c];
  return m && Number.isInteger(m.decimals) ? { contract: c, symbol: m.symbol, decimals: m.decimals } : { contract: c, symbol: c, decimals: null };
}

/** Display string, e.g. "1,250 USDC", "3.5 NEAR" or, when ft_metadata is unavailable, "1250000 base units of foo.testnet". */
export function formatAsset(amount: string | bigint, info: AssetInfo): string {
  if (info.decimals === null) return `${BigInt(amount).toString()} base units of ${info.contract}`;
  return `${formatUnits(amount, info.decimals, info.contract === "near" ? 3 : 2)} ${info.symbol}`;
}

/** Plain decimal for CSV (raw base units when decimals are unknown). */
export function csvAmount(amount: string | bigint, info: AssetInfo): string {
  return info.decimals === null ? BigInt(amount).toString() : formatDecimal(amount, info.decimals);
}

// One in-flight / resolved lookup per token contract for the lifetime of the page. A failed lookup is dropped from the
// cache so a later render retries it.
const cache = new Map<string, Promise<TokenMeta | null>>();
const resolved: MetaMap = {};
export function getFtMeta(contract: string): Promise<TokenMeta | null> {
  let p = cache.get(contract);
  if (!p) {
    p = view<TokenMeta>(contract, "ft_metadata")
      .then((m) => {
        if (!m || typeof m.symbol !== "string" || !Number.isInteger(m.decimals)) throw new Error("bad metadata");
        resolved[contract] = m;
        return m;
      })
      .catch(() => {
        cache.delete(contract);
        resolved[contract] = resolved[contract] ?? null;
        return resolved[contract];
      });
    cache.set(contract, p);
  }
  return p;
}

/** ft_metadata for every FT contract used by `plans`, seeded with the configured token's metadata when known. */
export function useTokenMetas(plans: Plan[], seed: TokenMeta | null): MetaMap {
  const [metas, setMetas] = useState<MetaMap>(() => ({ ...resolved }));
  const contracts = [...new Set(plans.map((p) => ftContract(p.asset)).filter((c): c is string => c !== null))].sort();
  const key = contracts.join(",");
  useEffect(() => {
    if (seed) resolved[TOKEN] = seed;
    let cancelled = false;
    Promise.all(contracts.map((c) => (resolved[c] ? Promise.resolve(resolved[c]) : getFtMeta(c)))).then(() => {
      if (!cancelled) setMetas({ ...resolved });
    });
    return () => {
      cancelled = true;
    };
    // `plans` is a new array on every 10 s poll: re-running on it retries failed lookups (successful ones are cached).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, seed, plans]);
  return metas;
}
