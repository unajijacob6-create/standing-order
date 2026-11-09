import { useEffect, useRef, useState } from "react";
import { ShowMore } from "./Expand";
import type { Destination, Payout, Plan, RouteRecord } from "../near";
import { getPayouts, getPlanDestinations, getPlanLedger, getRoute, view } from "../near";
import { download, formatInterval, formatTime, shortAccount, sum, toCsv } from "../format";
import { CONTRACT, EXPLORER, destinationLabel } from "../config";
import { assetInfo, csvAmount, formatAsset, type MetaMap } from "../assets";
import { usePollTick } from "./LiveFeed";

const HISTORY_ROWS = 40;

// Rendered with key={plan.id} by App, so switching plans starts from empty state; the request counter below also drops
// any response that arrives after a newer request was made.
const COLLAPSED_ROWS = 5;

export function PlanDetail({ plan, metas, keeperRuns }: { plan: Plan; metas: MetaMap; keeperRuns: Array<{ plan_id: number; outcome: any; tx: string }> }) {
  const info = assetInfo(plan.asset, metas);
  const fmt = (amount: string | bigint) => formatAsset(amount, info);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [payouts, setPayouts] = useState<Payout[] | null>(null);
  const [routes, setRoutes] = useState<Record<number, RouteRecord>>({});
  const [dests, setDests] = useState<Record<string, Destination>>({});
  const [guardians, setGuardians] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [destErr, setDestErr] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    let cancelled = false;
    view<string[]>(CONTRACT, "get_guardians", { plan_id: plan.id }).then((g) => { if (!cancelled) setGuardians(g ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [plan.id]);

  // Re-read while a record is still Pending (its on_payout callback has not landed yet) or after a failed read.
  const tick = usePollTick(loadErr !== null || destErr || (payouts ?? []).some((p) => p.status === "Pending"));

  useEffect(() => {
    const id = ++reqId.current;
    const live = () => id === reqId.current;
    (async () => {
      let list: Payout[];
      try {
        const from = Math.max(0, plan.payout_count - HISTORY_ROWS);
        list = await getPayouts(plan.id, from, HISTORY_ROWS);
      } catch (e) {
        if (live()) setLoadErr(String((e as any)?.message ?? e).slice(0, 120));
        return;
      }
      if (!live()) return;
      setLoadErr(null);
      setPayouts(list.slice().reverse());
      // Destinations only decorate the history; a failure here must not hide it.
      let d: Array<[string, Destination]> | null = null;
      try {
        d = await getPlanDestinations(plan.id);
      } catch {
        /* keep the previous destinations, retry on the next tick */
      }
      if (!live()) return;
      setDestErr(d === null);
      if (d === null) return;
      setDests(Object.fromEntries(d));
      const routedRecipients = new Set(d.map(([a]) => a));
      const routed: Record<number, RouteRecord> = {};
      await Promise.all(
        list
          .filter((p) => routedRecipients.has(p.recipient))
          .map(async (p) => {
            const r = await getRoute(plan.id, p.seq).catch(() => null);
            if (r) routed[p.seq] = r;
          }),
      );
      if (live()) setRoutes(routed);
    })();
    return () => {
      reqId.current++;
    };
  }, [plan.id, plan.payout_count, tick]);

  const rows = payouts ?? [];
  const txFor = (runIndex: number) => keeperRuns.find((r) => r.plan_id === plan.id && r.outcome?.Sent?.run_index === runIndex)?.tx;
  const perRun = sum(plan.recipients.map((r) => r.amount));

  // Every payout of the plan, not only the rows shown.
  const exportCsv = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      const { payouts: all, routes: allRoutes } = await getPlanLedger(plan);
      const csvRows = all.map((p) => {
        const r = allRoutes.get(p.seq);
        const tx = txFor(p.run_index);
        return {
          plan_id: p.plan_id,
          seq: p.seq,
          run: p.run_index,
          recipient: p.recipient,
          amount: csvAmount(p.amount, info),
          token_symbol: info.decimals === null ? "" : info.symbol,
          token_contract: info.contract,
          amount_base_units: p.amount,
          status: p.status,
          paid_at_utc: new Date(p.timestamp * 1000).toISOString(),
          block_height: p.block_height,
          routed_to: r ? `${destinationLabel(r.destination_asset)} ${r.destination_address}` : "",
          deposit_address: r?.deposit_address ?? "",
          tx: tx ? `${EXPLORER}/txns/${tx}` : "",
        };
      });
      if (csvRows.length === 0) throw new Error("no payouts to export yet");
      download(`standing-order-plan-${plan.id}-payouts.csv`, toCsv(csvRows));
    } catch (e) {
      setExportErr(String((e as any)?.message ?? e).slice(0, 120));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="card detail">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>{plan.title}</h2>
          <div className="tiny mono">plan #{plan.id} · {formatInterval(plan.interval_seconds)} · created {formatTime(plan.created_at)}</div>
        </div>
        <button className="btn ghost sm" onClick={exportCsv} disabled={exporting || plan.payout_count === 0} title={`All ${plan.payout_count} payouts of this plan as CSV`}>{exporting ? "Building CSV…" : "Export CSV"}</button>
      </div>
      {exportErr && <div className="tiny err-text">Export failed: {exportErr}</div>}

      <div className="kv">
        <div><span className="k">Treasury (owner)</span><span className="v">{plan.owner}</span></div>
        <div><span className="k">Asset</span><span className="v">{info.contract === "near" ? "NEAR" : info.decimals === null ? `${info.contract} (no token metadata)` : `${info.symbol} · ${info.contract}`}</span></div>
        <div><span className="k">Balance</span><span className="v">{fmt(plan.balance)}</span></div>
        <div><span className="k">Cap per run</span><span className="v">{fmt(plan.cap_per_run)} (run total {fmt(perRun)})</span></div>
        <div><span className="k">Next run</span><span className="v">{formatTime(plan.next_run_at)}</span></div>
        <div><span className="k">Ends</span><span className="v">{plan.end_at ? formatTime(plan.end_at) : "open-ended"}</span></div>
      </div>

      <div>
        <h3>Recipients</h3>
        <div className="table-wrap">
        <table>
          <thead><tr><th>Account</th><th>Paid where</th><th className="num">Per run</th></tr></thead>
          <tbody>
            {plan.recipients.map((r) => (
              <tr key={r.account_id}>
                <td className="mono">{r.account_id}</td>
                <td>{dests[r.account_id] ? <span className="chip blue" title={dests[r.account_id].address}>{destinationLabel(dests[r.account_id].asset_id)} · {shortAccount(dests[r.account_id].address, 14)}</span> : <span className="muted">NEAR account</span>}</td>
                <td className="num">{fmt(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div>
        <h3>Payout history{plan.payout_count > HISTORY_ROWS ? <span className="tiny muted"> · latest {HISTORY_ROWS} of {plan.payout_count}, Export CSV has all</span> : null}</h3>
        {loadErr && <div className="tiny err-text" style={{ marginBottom: 8 }}>Couldn't read payout history from RPC ({loadErr}). Retrying…</div>}
        {destErr && payouts !== null && <div className="tiny muted" style={{ marginBottom: 8 }}>Cross-chain destinations unavailable right now; retrying.</div>}
        {payouts === null ? (
          <div className="empty">{loadErr ? "Payout history unavailable for now." : "Loading payout history…"}</div>
        ) : rows.length === 0 ? (
          <div className="empty">No payouts yet. The first run is due {formatTime(plan.next_run_at)}.</div>
        ) : (
          <div className="table-wrap">
          <table className="payouts">
            <thead><tr><th>Run</th><th>Recipient</th><th className="num">Amount</th><th>Status</th><th>When</th><th>Proof</th></tr></thead>
            <tbody>
              {(historyOpen ? rows : rows.slice(0, COLLAPSED_ROWS)).map((p) => {
                const route = routes[p.seq];
                const tx = txFor(p.run_index);
                return (
                  <tr key={p.seq}>
                    <td className="mono">{p.run_index}</td>
                    <td className="mono">
                      {shortAccount(p.recipient)}
                      {route && <div className="tiny">→ {destinationLabel(route.destination_asset)} {shortAccount(route.destination_address, 12)}</div>}
                    </td>
                    <td className="num">{fmt(p.amount)}</td>
                    <td><span className={`chip ${p.status === "Sent" ? "active" : p.status === "Failed" ? "failed" : "neutral"}`}>{p.status}</span></td>
                    <td className="muted nowrap">{formatTime(p.timestamp)}</td>
                    <td className="tiny nowrap">
                      {tx ? <a href={`${EXPLORER}/txns/${tx}`} target="_blank" rel="noreferrer">tx ↗</a> : <a href={`${EXPLORER}/blocks/${p.block_height}`} target="_blank" rel="noreferrer">block {p.block_height} ↗</a>}
                      {route && <div><a href={`${EXPLORER}/address/${route.deposit_address}`} target="_blank" rel="noreferrer">deposit addr ↗</a></div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        {payouts !== null && <ShowMore total={rows.length} shown={COLLAPSED_ROWS} expanded={historyOpen} onToggle={() => setHistoryOpen(!historyOpen)} noun="loaded payouts" />}
      </div>

      <div className="note">
        Managed by the treasury, not by this page: the DAO files <b>pause</b>, <b>resume</b>, <b>top up</b>, <b>update</b> or <b>cancel</b> as proposals
        (Trezu templates in <code>trezu-templates/</code>). Anyone can trigger a due run; the keeper does it automatically.
        {guardians.length > 0 ? (
          <> Emergency stop: {guardians.map((g, i) => <span key={g}>{i > 0 ? ", " : ""}<code>{g}</code></span>)} can <b>pause</b> this plan alone, without a vote; resuming still needs the DAO.</>
        ) : (
          <> No guardian named: only a DAO vote can pause this plan.</>
        )}
      </div>
    </div>
  );
}
