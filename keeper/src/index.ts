// Standing Order keeper.
//
// Every POLL_SECONDS it asks the contract which plans are due and calls `run_due` on each,
// repeating while a large run is split across calls. It signs with a function-call access key that
// can only call `run_due` on the contract, so a compromised keeper can trigger payroll early by at
// most one polling interval, and can never redirect funds or change a plan.
//
// Config (keeper/.env or environment): NEAR_NETWORK, NEAR_RPC_URL, SO_CONTRACT, KEEPER_ACCOUNT,
// KEEPER_KEY (ed25519:...), POLL_SECONDS (default 15), KEEPER_HTTP_PORT (optional status endpoint).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { quoteRoute, swapStatus, type Destination, type Mode, type Route, type RouteLog } from "./routes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(here, "..", ".env"));

const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const RPC_URL = process.env.NEAR_RPC_URL ?? (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const CONTRACT = must("SO_CONTRACT");
const KEEPER_ACCOUNT = must("KEEPER_ACCOUNT");
// Secrets pasted into CI often carry a trailing newline or quotes; a key is a single base58 token.
const KEEPER_KEY = must("KEEPER_KEY").trim().replace(/^["']|["']$/g, "") as KeyPairString;
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 15);
const ONCE = process.argv.includes("--once");
const LOG_FILE = process.env.KEEPER_LOG ?? path.join(here, "..", "data", "runs.jsonl");
const CROSSCHAIN: Mode = parseMode(process.env.CROSSCHAIN, NETWORK === "mainnet" ? "live" : "dry");
const TGAS_300 = 300n * 10n ** 12n;
const MAX_CATCHUP = Number(process.env.MAX_CATCHUP ?? 3);

const provider = new JsonRpcProvider({ url: RPC_URL });
const keeper = new Account(KEEPER_ACCOUNT, provider, KEEPER_KEY);

type Outcome = "Paused" | "Cancelled" | "Ended" | { NotDue: { next_run_at: number } } | { Underfunded: { needed: string; balance: string } } | { Sent: { run_index: number; sent: number; remaining: number; completed: boolean } };

const state = {
  startedAt: new Date().toISOString(),
  ticks: 0,
  runs: 0,
  payoutsSent: 0,
  lastTick: null as string | null,
  lastError: null as string | null,
  crosschain: CROSSCHAIN,
  recent: [] as Array<Record<string, unknown>>,
  /** Routed payouts we are still tracking on 1Click, by deposit address. */
  swaps: {} as Record<string, { plan_id: number; recipient: string; status: string; updatedAt: string; details?: unknown }>,
};

async function tick(): Promise<void> {
  state.ticks += 1;
  state.lastTick = new Date().toISOString();
  const due = (await provider.callFunction<number[]>({ contractId: CONTRACT, method: "get_due_plans", args: { limit: 20 } })) ?? [];
  if (due.length === 0) {
    log("idle", { due: 0 });
    return;
  }
  // Each plan is isolated: one plan that keeps failing (for example a route the contract rejects
  // because the recipient changed their destination after we quoted) must not block the others.
  const failed: Array<{ plan_id: number; error: string }> = [];
  for (const planId of due) {
    try {
      await runPlan(planId);
    } catch (e) {
      const error = String(e).slice(0, 300);
      failed.push({ plan_id: planId, error });
      log("plan_error", { plan_id: planId, error });
    }
  }
  // Surface the failure so the status endpoint shows it and `--once` exits non-zero.
  if (failed.length) throw new Error(`${failed.length} of ${due.length} due plan(s) failed: ${failed.map((f) => `#${f.plan_id}: ${f.error}`).join("; ")}`);
}

async function runPlan(planId: number): Promise<void> {
  // A run with many recipients is paid over several calls; keep going until it completes.
  // After a completed run, keep going while the plan is still due (catch up at most
  // MAX_CATCHUP periods per tick, which absorbs delayed scheduled runs such as GitHub cron).
  let completedRuns = 0;
  let routesDisabled = false;
  for (let i = 0; i < 20; i++) {
    // Fresh quotes for every call: a signed quote and its deposit address belong to one payout,
    // so catch-up runs must never reuse them.
    let { routes, routeLogs } = routesDisabled ? { routes: [] as Route[], routeLogs: [] as RouteLog[] } : await buildRoutes(planId);
    let res: any;
    let outcome: Outcome;
    try {
      res = await keeper.callFunctionRaw({ contractId: CONTRACT, methodName: "run_due", args: { plan_id: planId, routes: routes.length ? routes : null }, gas: TGAS_300 });
      outcome = decode<Outcome>(res);
    } catch (e) {
      if (!routes.length) throw e;
      // The contract rejected the call that carried routes; pay this plan on NEAR instead.
      log("retried_without_routes", { plan_id: planId, error: String(e).slice(0, 300) });
      routesDisabled = true;
      routes = [];
      routeLogs = [];
      res = await keeper.callFunctionRaw({ contractId: CONTRACT, methodName: "run_due", args: { plan_id: planId, routes: null }, gas: TGAS_300 });
      outcome = decode<Outcome>(res);
    }
    const entry = { at: new Date().toISOString(), plan_id: planId, outcome, tx: res.transaction.hash, routes: routeLogs.length ? routeLogs : undefined };
    if (typeof outcome === "object" && "Sent" in outcome) {
      // Only a Sent outcome means the contract dispatched the routed transfers.
      for (const r of routeLogs) {
        if (r.ok && r.mode === "live" && r.depositAddress) {
          state.swaps[r.depositAddress] = { plan_id: planId, recipient: r.recipient, status: "SUBMITTED", updatedAt: new Date().toISOString() };
        }
      }
      record(entry);
      // Counts transfers the contract dispatched in this call, not confirmed deliveries;
      // delivery is confirmed by the on_payout callback (see get_payouts).
      state.payoutsSent += outcome.Sent.sent;
      if (outcome.Sent.completed) state.runs += 1;
      log("sent", { ...entry, dispatched: true });
      if (outcome.Sent.completed) {
        completedRuns += 1;
        const stillDue = await provider.callFunction<boolean>({ contractId: CONTRACT, method: "is_due", args: { plan_id: planId } });
        if (!stillDue || completedRuns >= MAX_CATCHUP) break;
      }
      continue;
    }
    record(entry);
    log("skipped", entry);
    break;
  }
}

/** For every recipient of the plan with a registered destination, obtain a signed 1Click quote. */
async function buildRoutes(planId: number): Promise<{ routes: Route[]; routeLogs: RouteLog[] }> {
  const routes: Route[] = [];
  const routeLogs: RouteLog[] = [];
  if (CROSSCHAIN === "off") return { routes, routeLogs };
  const plan: any = await provider.callFunction({ contractId: CONTRACT, method: "get_plan", args: { plan_id: planId } });
  const token = plan?.asset?.Ft?.contract;
  if (!token) return { routes, routeLogs }; // native NEAR plans are paid on NEAR
  const dests = (await provider.callFunction<Array<[string, Destination]>>({ contractId: CONTRACT, method: "get_plan_destinations", args: { plan_id: planId } })) ?? [];
  for (const [recipient, dest] of dests) {
    const amount = plan.recipients.find((r: any) => r.account_id === recipient)?.amount;
    if (!amount) continue;
    const { route, info } = await quoteRoute(CROSSCHAIN, token, recipient, amount, dest, log);
    routeLogs.push(info);
    if (route) routes.push(route);
  }
  return { routes, routeLogs };
}

/** Follow routed payouts until 1Click reports a final status. */
async function trackSwaps(): Promise<void> {
  for (const [addr, s] of Object.entries(state.swaps)) {
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) continue;
    try {
      const r = await swapStatus(addr);
      if (r && r.status !== s.status) {
        s.status = r.status;
        s.updatedAt = new Date().toISOString();
        s.details = r.details;
        const entry = { at: s.updatedAt, event: "swap", deposit_address: addr, plan_id: s.plan_id, recipient: s.recipient, status: r.status, destinationTx: r.details?.destinationChainTxHashes };
        record(entry);
        log("swap status", entry);
      }
    } catch (e) {
      log("swap status error", { addr, error: String(e).slice(0, 200) });
    }
  }
}

async function main(): Promise<void> {
  log("keeper starting", { network: NETWORK, rpc: RPC_URL, contract: CONTRACT, account: KEEPER_ACCOUNT, pollSeconds: POLL_SECONDS, once: ONCE, crosschain: CROSSCHAIN });
  await assertKeyIsRestricted();
  if (process.env.KEEPER_HTTP_PORT) startStatusServer(Number(process.env.KEEPER_HTTP_PORT));
  let backoff = POLL_SECONDS;
  for (;;) {
    try {
      await tick();
      await trackSwaps();
      state.lastError = null;
      backoff = POLL_SECONDS;
    } catch (e) {
      state.lastError = String(e).slice(0, 300);
      log("error", { error: state.lastError, retryInSeconds: backoff });
      backoff = Math.min(backoff * 2, 300);
      if (ONCE) {
        // A failed one-shot tick (CI keeper) must fail the job, not exit green.
        process.exitCode = 1;
        break;
      }
    }
    if (ONCE) break;
    await sleep(backoff * 1000);
  }
}

/** Refuse to run with anything broader than a function-call key for `run_due` on the contract. */
async function assertKeyIsRestricted(): Promise<void> {
  const pk = keeper.getSigner()!.getPublicKey();
  const key = await provider.viewAccessKey({ accountId: KEEPER_ACCOUNT, publicKey: (await pk).toString() });
  const perm: any = key.permission;
  if (perm === "FullAccess") throw new Error("Refusing to run with a full-access key. Create a function-call key with scripts/keeper-key.ts");
  const fc = perm.FunctionCall;
  if (fc.receiver_id !== CONTRACT || !(fc.method_names ?? []).every((m: string) => m === "run_due") || (fc.method_names ?? []).length === 0) {
    throw new Error(`Keeper key must be limited to ${CONTRACT}:run_due, got ${JSON.stringify(fc)}`);
  }
  log("key verified", { receiver: fc.receiver_id, methods: fc.method_names, allowance_near: fc.allowance ? Number(BigInt(fc.allowance) / 10n ** 18n) / 1e6 : "unlimited" });
}

function startStatusServer(port: number): void {
  http
    .createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("access-control-allow-origin", "*");
      res.end(JSON.stringify({ ok: state.lastError === null, contract: CONTRACT, account: KEEPER_ACCOUNT, ...state }, null, 2));
    })
    .listen(port, () => log("status endpoint", { url: `http://localhost:${port}/` }));
}

function decode<T>(res: any): T {
  const v = res.status?.SuccessValue;
  if (v === undefined) throw new Error(`run_due failed: ${JSON.stringify(res.status)}`);
  return JSON.parse(Buffer.from(v, "base64").toString() || "null") as T;
}

function record(entry: Record<string, unknown>): void {
  state.recent.unshift(entry);
  state.recent = state.recent.slice(0, 50);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never stop the keeper */
  }
}

function log(event: string, detail?: unknown): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...(detail && typeof detail === "object" ? detail : { detail }) }));
}

function parseMode(raw: string | undefined, fallback: Mode): Mode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "off" || v === "dry" || v === "live") return v;
  throw new Error(`Invalid CROSSCHAIN=${JSON.stringify(raw)}: expected one of off, dry, live (or unset for the network default)`);
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (see keeper/.env or scripts/keeper-key.ts)`);
  return v;
}

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  log("fatal", { error: String(e) });
  process.exit(1);
});
