import { useEffect, useRef, useState } from "react";
import type { Payout, Plan } from "../near";
import { getPayouts, getPlanLedger } from "../near";
import { EXPLORER, destinationLabel } from "../config";
import { download, shortAccount, toCsv } from "../format";
import { assetInfo, csvAmount, formatAsset, isConfiguredToken, type MetaMap } from "../assets";

export interface FeedItem extends Payout {
  planTitle: string;
  plan: Plan;
}

/** Payout callbacks land a few seconds after run_due wrote the record as Pending, without changing payout_count. */
export const PENDING_POLL_MS = 6000;

/** A counter that ticks every `ms` while `active` (used to re-read records still marked Pending, or to retry after an error). */
export function usePollTick(active: boolean, ms = PENDING_POLL_MS): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return active ? tick : 0;
}

/** Latest payouts across all plans, newest first, read straight from the contract. */
export function useRecentPayouts(plans: Plan[], perPlan = 8): FeedItem[] {
  const [items, setItems] = useState<FeedItem[]>([]);
  const hasPending = items.some((i) => i.status === "Pending");
  const tick = usePollTick(hasPending);
  const key = plans.map((p) => `${p.id}:${p.payout_count}`).join(",") + `|${tick}`;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lists = await Promise.all(
        plans
          .filter((p) => p.payout_count > 0)
          .map(async (p) => {
            const rows = await getPayouts(p.id, Math.max(0, p.payout_count - perPlan), perPlan).catch(() => [] as Payout[]);
            return rows.map((r) => ({ ...r, planTitle: p.title, plan: p }));
          }),
      );
      if (!cancelled) setItems(lists.flat().sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq).slice(0, 12));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return items;
}

/**
 * Sum of the payouts that actually went out (status Sent) across the plans in the configured token. Payout records are
 * cached per plan and only new or still-Pending records are re-read, so after the first load this costs one small view
 * per plan that ran. `total` is null until the first full read succeeds.
 */
export function usePaidOut(plans: Plan[]): { total: bigint | null; sent: number } {
  const cache = useRef(new Map<number, Map<number, Payout>>());
  const [result, setResult] = useState<{ total: bigint | null; sent: number; pending: boolean; failed: boolean }>({ total: null, sent: 0, pending: false, failed: false });
  const tokenPlans = plans.filter(isConfiguredToken);
  const tick = usePollTick(result.pending || result.failed, result.failed ? 10_000 : PENDING_POLL_MS);
  const key = tokenPlans.map((p) => `${p.id}:${p.payout_count}`).join(",") + `|${tick}`;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let failed = false;
      await Promise.all(
        tokenPlans.map(async (p) => {
          const rows = cache.current.get(p.id) ?? new Map<number, Payout>();
          let from = 0;
          while (rows.has(from) && rows.get(from)!.status !== "Pending") from++;
          try {
            while (from < p.payout_count) {
              const page = await getPayouts(p.id, from, Math.min(100, p.payout_count - from));
              if (page.length === 0) break;
              for (const r of page) rows.set(r.seq, r);
              from += page.length;
            }
            cache.current.set(p.id, rows);
          } catch {
            failed = true;
          }
        }),
      );
      if (cancelled) return;
      let total = 0n;
      let sent = 0;
      let pending = false;
      for (const p of tokenPlans) {
        for (const r of cache.current.get(p.id)?.values() ?? []) {
          if (r.status === "Sent") {
            total += BigInt(r.amount);
            sent++;
          } else if (r.status === "Pending") pending = true;
        }
      }
      setResult((prev) => ({ total: failed && prev.total === null ? null : total, sent, pending, failed }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { total: result.total, sent: result.sent };
}

export function ago(seconds: number, nowMs: number): string {
  const d = Math.max(0, Math.floor(nowMs / 1000 - seconds));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86_400)} d ago`;
}

/**
 * Full ledger, every payout of every plan, oldest first, one row per transfer, with the token spelled out and the
 * cross-chain destination when the recipient was paid through NEAR Intents. Amounts are plain decimals (no grouping).
 */
export async function buildLedgerCsv(plans: Plan[], metas: MetaMap): Promise<{ csv: string; rows: number }> {
  const perPlan = await Promise.all(
    plans
      .filter((p) => p.payout_count > 0)
      .map(async (plan) => {
        const info = assetInfo(plan.asset, metas);
        const { payouts, routes } = await getPlanLedger(plan);
        return payouts.map((p) => {
          const r = routes.get(p.seq);
          return {
            date: new Date(p.timestamp * 1000).toISOString(),
            plan_id: p.plan_id,
            plan_title: plan.title,
            seq: p.seq,
            recipient: p.recipient,
            amount: csvAmount(p.amount, info),
            amount_base_units: p.amount,
            token_symbol: info.decimals === null ? "" : info.symbol,
            token_contract: info.contract,
            outcome: p.status.toLowerCase(),
            route: r ? `${destinationLabel(r.destination_asset)} ${r.destination_address}` : "near",
            block_height: p.block_height,
            block_url: `${EXPLORER}/blocks/${p.block_height}`,
            _ts: p.timestamp,
          };
        });
      }),
  );
  const all = perPlan.flat().sort((a, b) => a._ts - b._ts || a.plan_id - b.plan_id || a.seq - b.seq);
  const rows = all.map(({ _ts, ...r }) => r);
  return { csv: toCsv(rows), rows: rows.length };
}

export function LiveFeed({ items, metas, nowMs, plans, paidOut }: { items: FeedItem[]; metas: MetaMap; nowMs: number; plans: Plan[]; paidOut: string | null }) {
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const payoutCount = plans.reduce((a, p) => a + p.payout_count, 0);

  const exportCsv = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      const { csv, rows } = await buildLedgerCsv(plans, metas);
      if (rows === 0) throw new Error("no payouts to export yet");
      download(`standing-order-ledger-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    } catch (e) {
      setExportErr(String((e as any)?.message ?? e).slice(0, 120));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="card pad">
      <div className="section-head">
        <h2>Live payouts</h2>
        <span className="pill ok"><span className="dot" />on-chain</span>
      </div>
      <div className="ledger-bar">
        <span className="tiny mono">
          {payoutCount > 0 ? `${payoutCount} payout${payoutCount === 1 ? "" : "s"}${paidOut ? ` · ${paidOut} sent` : ""}` : "no payouts recorded yet"}
        </span>
        <button className="btn ghost sm" onClick={exportCsv} disabled={exporting || payoutCount === 0} title="Every payout of every plan as CSV: date, plan, recipient, amount, token, outcome, destination">
          {exporting ? "Building CSV…" : "Download CSV"}
        </button>
      </div>
      {exportErr && <div className="tiny err-text" style={{ marginBottom: 8 }}>Export failed: {exportErr}</div>}
      {items.length === 0 ? (
        <div className="empty">Waiting for the first payout…</div>
      ) : (
        <ul className="feed">
          {items.map((it) => (
            <li key={`${it.plan_id}-${it.seq}`} className={nowMs / 1000 - it.timestamp < 90 ? "fresh" : ""}>
              <span className={`feed-dot ${it.status === "Failed" ? "bad" : ""}`} />
              <div className="feed-body">
                <div>
                  <b className="mono">{shortAccount(it.recipient, 40)}</b> received <b className="mono nowrap">{formatAsset(it.amount, assetInfo(it.plan.asset, metas))}</b>
                </div>
                <div className="tiny">
                  {it.planTitle} · run {it.run_index} · {it.status === "Failed" ? "failed, re-credited" : it.status.toLowerCase()} ·{" "}
                  <a href={`${EXPLORER}/blocks/${it.block_height}`} target="_blank" rel="noreferrer">block ↗</a>
                </div>
              </div>
              <span className="tiny feed-ago">{ago(it.timestamp, nowMs)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
