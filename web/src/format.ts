import type { TokenMeta } from "./near";

export function formatUnits(amount: string | bigint, decimals: number, maxFrac = 2): string {
  const v = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const wholeStr = whole.toLocaleString("en-US");
  if (maxFrac === 0 || frac === 0n) return wholeStr;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

/** Plain decimal (no thousands grouping, full precision, trailing zeros trimmed) for CSV / machine readers. */
export function formatDecimal(amount: string | bigint, decimals: number): string {
  const v = BigInt(amount);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function formatAmount(amount: string | bigint, meta: TokenMeta | null, isNear: boolean): string {
  if (isNear) return `${formatUnits(amount, 24, 3)} NEAR`;
  if (!meta) return String(amount);
  return `${formatUnits(amount, meta.decimals)} ${meta.symbol}`;
}

export function sum(amounts: Array<string | bigint>): bigint {
  return amounts.reduce<bigint>((a, b) => a + BigInt(b), 0n);
}

export function formatInterval(seconds: number): string {
  if (seconds % 2_592_000 === 0) return seconds === 2_592_000 ? "every 30 days" : `every ${seconds / 2_592_000} × 30 days`;
  if (seconds % 604_800 === 0) return seconds === 604_800 ? "weekly" : `every ${seconds / 604_800} weeks`;
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "daily" : `every ${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hourly" : `every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "every minute" : `every ${seconds / 60} minutes`;
  return `every ${seconds} s`;
}

export function formatCountdown(targetSeconds: number, nowMs: number): { text: string; due: boolean } {
  const diff = Math.floor(targetSeconds - nowMs / 1000);
  if (diff <= 0) return { text: "due now", due: true };
  const d = Math.floor(diff / 86_400);
  const h = Math.floor((diff % 86_400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (d > 0) return { text: `${d}d ${h}h`, due: false };
  if (h > 0) return { text: `${h}h ${String(m).padStart(2, "0")}m`, due: false };
  return { text: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, due: false };
}

export function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function shortAccount(id: string, keep = 22): string {
  if (id.length <= keep) return id;
  return `${id.slice(0, 10)}…${id.slice(-8)}`;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (plan titles and account names are chosen by whoever
 * created the plan) is neutralised with a leading single quote; cells with quotes, commas or line breaks are quoted.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function download(filename: string, content: string, type = "text/csv") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
