// Export every payout recorded on the live contract as an accountant-friendly ledger.
//
//   npm run ledger                      CSV to stdout
//   npm run ledger -- --out ledger.csv  CSV to a file
//   npm run ledger -- --json            JSON array instead of CSV
//   npm run ledger -- --owner <account> only plans owned by this account (default: all plans)
//
// Needs no keys and no funds: only view calls to the testnet RPC (NODE_USE_ENV_PROXY=1 behind a proxy).
// Fields come from PayoutRecord / RouteRecord in contract/src/types.rs.
import fs from "node:fs";
import { cfg, view } from "./lib/near.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
if (outIdx >= 0 && !outFile) { console.error("--out needs a file name"); process.exit(2); }
const ownerIdx = args.indexOf("--owner");
const ownerFilter = ownerIdx >= 0 ? args[ownerIdx + 1] : null;
if (ownerIdx >= 0 && (!ownerFilter || ownerFilter.startsWith("--"))) { console.error("--owner needs an account id"); process.exit(2); }

const PAGE = 100;
const CONCURRENCY = 8;

interface Row {
  date: string; plan_id: number; plan_title: string; seq: number; run_index: number; recipient: string;
  amount: string; amount_base_units: string; token_symbol: string; token_contract: string; status: string;
  route: string; route_destination_asset: string; route_destination_address: string; route_deposit_address: string;
  route_amount_out_base_units: string; route_correlation_id: string; source_dao: string; block_height: number;
  note: string;
}

const formatAmount = (base: string, decimals: number) => {
  const u = 10n ** BigInt(decimals);
  const v = BigInt(base);
  const frac = (v % u).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / u}${frac ? "." + frac : ""}`;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const allPlans = await view<any[]>(cfg.contract, "get_plans", { from_index: 0, limit: 500 });
const plans = ownerFilter ? allPlans.filter((p) => p.owner === ownerFilter) : allPlans;
const metaCache = new Map<string, { symbol: string; decimals: number; note: string }>();
/** Token metadata comes from whatever contract a plan names, so treat it as untrusted. */
async function tokenMeta(asset: any): Promise<{ symbol: string; decimals: number; contract: string; note: string }> {
  if (typeof asset !== "object" || !asset.Ft) return { symbol: "NEAR", decimals: 24, contract: "near", note: "" };
  const contract = String(asset.Ft.contract);
  if (!metaCache.has(contract)) {
    const m: any = await view<any>(contract, "ft_metadata").catch(() => null);
    const symbol = typeof m?.symbol === "string" ? m.symbol : contract;
    const validDecimals = Number.isInteger(m?.decimals) && m.decimals >= 0 && m.decimals <= 36;
    const note = !m ? "ft_metadata unavailable; amount shown in base units" : validDecimals ? "" : `invalid token decimals ${JSON.stringify(m.decimals)}; amount shown in base units`;
    metaCache.set(contract, { symbol, decimals: validDecimals ? m.decimals : 0, note });
  }
  return { ...metaCache.get(contract)!, contract };
}

const ROUTE_ERROR = Symbol("route lookup failed");
const rows: Row[] = [];
let skippedPlans = 0;
for (const p of plans) {
  // One hostile or broken plan (odd token, failing view) must not stop the export.
  try {
    const meta = await tokenMeta(p.asset);
    const payouts: any[] = [];
    for (let from = 0; from < p.payout_count; from += PAGE) {
      payouts.push(...(await view<any[]>(cfg.contract, "get_payouts", { plan_id: p.id, from_seq: from, limit: PAGE })));
    }
    const routes = await mapLimit(payouts, CONCURRENCY, (o) => view<any | null>(cfg.contract, "get_route", { plan_id: p.id, seq: o.seq }).catch(() => ROUTE_ERROR));
    const planRows: Row[] = payouts.map((o, i) => {
      const lookup = routes[i];
      const failed = lookup === ROUTE_ERROR;
      const r: any = failed ? null : lookup;
      const notes = [meta.note, failed ? "get_route failed; route unknown" : ""].filter(Boolean);
      return {
        date: new Date(o.timestamp * 1000).toISOString(),
        plan_id: p.id,
        plan_title: String(p.title ?? ""),
        seq: o.seq,
        run_index: o.run_index,
        recipient: o.recipient,
        amount: formatAmount(o.amount, meta.decimals),
        amount_base_units: o.amount,
        token_symbol: meta.symbol,
        token_contract: meta.contract,
        status: o.status,
        route: failed ? "unknown" : r ? `${r.destination_asset} → ${r.destination_address}` : "near",
        route_destination_asset: r?.destination_asset ?? "",
        route_destination_address: r?.destination_address ?? "",
        route_deposit_address: r?.deposit_address ?? "",
        // amount_out is denominated in the destination asset, whose decimals we do not know here.
        route_amount_out_base_units: r?.amount_out ?? "",
        route_correlation_id: r?.correlation_id ?? "",
        source_dao: p.owner,
        block_height: o.block_height,
        note: notes.join("; "),
      };
    });
    rows.push(...planRows);
  } catch (e) {
    skippedPlans += 1;
    console.error(`ledger: warning: skipped plan #${p?.id} (${String(e).slice(0, 200)})`);
  }
}
rows.sort((a, b) => a.date.localeCompare(b.date) || a.plan_id - b.plan_id || a.seq - b.seq);

// Spreadsheet apps execute cells that start with = + - @ (or tab / CR); neutralise them with a quote.
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const columns = ["date", "plan_id", "plan_title", "seq", "run_index", "recipient", "amount", "token_symbol", "token_contract", "status", "route", "route_destination_asset", "route_destination_address", "route_deposit_address", "route_amount_out_base_units", "route_correlation_id", "source_dao", "amount_base_units", "block_height", "note"] as const;
const text = asJson
  ? JSON.stringify(rows, null, 2) + "\n"
  : [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

if (outFile) {
  fs.writeFileSync(outFile, text);
  console.error(`ledger: ${rows.length} payouts across ${plans.length - skippedPlans} plans${ownerFilter ? ` owned by ${ownerFilter}` : ""} on ${cfg.contract} written to ${outFile}${skippedPlans ? ` (${skippedPlans} plan(s) skipped, see warnings)` : ""}`);
} else {
  process.stdout.write(text);
}
