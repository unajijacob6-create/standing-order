import { JsonRpcProvider } from "near-api-js";
import { CONTRACT, DAO, RPC_URL, TOKEN } from "./config";

export const provider = new JsonRpcProvider({ url: RPC_URL });

export async function view<T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as unknown as T;
}

export type Asset = "Near" | { Ft: { contract: string } };
export interface Recipient {
  account_id: string;
  amount: string;
}
export interface Plan {
  id: number;
  owner: string;
  title: string;
  asset: Asset;
  recipients: Recipient[];
  interval_seconds: number;
  next_run_at: number;
  end_at: number | null;
  cap_per_run: string;
  balance: string;
  status: "Active" | "Paused" | "Cancelled";
  runs_completed: number;
  run_cursor: number | null;
  payout_count: number;
  created_at: number;
  updated_at: number;
}
export interface Payout {
  plan_id: number;
  seq: number;
  run_index: number;
  recipient: string;
  amount: string;
  status: "Pending" | "Sent" | "Failed";
  timestamp: number;
  block_height: number;
}
export interface RouteRecord {
  deposit_address: string;
  destination_asset: string;
  destination_address: string;
  amount_out: string;
  min_amount_out: string;
  deadline: number;
  correlation_id: string;
}
export interface Destination {
  asset_id: string;
  address: string;
  updated_at: number;
}
export interface TokenMeta {
  symbol: string;
  decimals: number;
  icon?: string | null;
  name: string;
}
export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: any;
  status: string;
  vote_counts: Record<string, number[]>;
  votes: Record<string, string>;
  submission_time: string;
}

export const getConfig = () => view(CONTRACT, "get_config");
export const getPlans = () => view<Plan[]>(CONTRACT, "get_plans", { from_index: 0, limit: 100 });
export const getPlan = (plan_id: number) => view<Plan | null>(CONTRACT, "get_plan", { plan_id });
export const getPayouts = (plan_id: number, from_seq: number, limit: number) => view<Payout[]>(CONTRACT, "get_payouts", { plan_id, from_seq, limit });
/** Every payout record of a plan, oldest first, paged in chunks of 100 (the contract caps a single view at its own limit). */
export async function getAllPayouts(plan: Pick<Plan, "id" | "payout_count">, page = 100): Promise<Payout[]> {
  const out: Payout[] = [];
  for (let from = 0; from < plan.payout_count; from += page) {
    const rows = await getPayouts(plan.id, from, Math.min(page, plan.payout_count - from));
    out.push(...rows);
    if (rows.length === 0) break;
  }
  return out;
}
export const getRoute = (plan_id: number, seq: number) => view<RouteRecord | null>(CONTRACT, "get_route", { plan_id, seq });
export const getDestination = (account_id: string) => view<Destination | null>(CONTRACT, "get_destination", { account_id });
export const getPlanDestinations = (plan_id: number) => view<Array<[string, Destination]>>(CONTRACT, "get_plan_destinations", { plan_id });
export const getNow = () => view<number>(CONTRACT, "now_seconds");
export const getTokenMeta = () => view<TokenMeta>(TOKEN, "ft_metadata");
export const getTokenBalance = (account_id: string) => view<string>(TOKEN, "ft_balance_of", { account_id });

export async function getDaoProposals(limit = 30): Promise<Proposal[]> {
  const last = await view<number>(DAO, "get_last_proposal_id");
  const from = Math.max(0, last - limit);
  const proposals = await view<Proposal[]>(DAO, "get_proposals", { from_index: from, limit });
  return proposals.reverse();
}

export async function getDaoPolicy() {
  return view(DAO, "get_policy");
}

/** Every payout of a plan plus the 1Click route of each routed one (recipients with a registered destination). */
export async function getPlanLedger(plan: Pick<Plan, "id" | "payout_count">): Promise<{ payouts: Payout[]; routes: Map<number, RouteRecord> }> {
  const [payouts, dests] = await Promise.all([getAllPayouts(plan), getPlanDestinations(plan.id).catch(() => [] as Array<[string, Destination]>)]);
  const routed = new Set(dests.map(([a]) => a));
  const routes = new Map<number, RouteRecord>();
  await Promise.all(
    payouts
      .filter((p) => routed.has(p.recipient))
      .map(async (p) => {
        const r = await getRoute(plan.id, p.seq).catch(() => null);
        if (r) routes.set(p.seq, r);
      }),
  );
  return { payouts, routes };
}

export interface ProposalAction {
  kind: "manage" | "fund" | "storage" | "other";
  method: string;
  args?: any;
  receiver: string;
}
export interface ProposalInfo {
  actions: ProposalAction[];
  /** True when the proposal also does something that is not Standing Order (e.g. an ft_transfer to some account). */
  hasOther: boolean;
}

function decodeArgs(b64: string): any {
  try {
    return JSON.parse(atob(b64));
  } catch {
    return undefined; // non-JSON args
  }
}

/** Does this Sputnik proposal touch Standing Order (directly or via a token transfer into it)? Looks at every action. */
export function proposalTouchesStandingOrder(p: Proposal): ProposalInfo | null {
  const fc = p.kind?.FunctionCall;
  if (!fc || !Array.isArray(fc.actions) || fc.actions.length === 0) return null;
  const receiver: string = fc.receiver_id;
  const actions: ProposalAction[] = fc.actions.map((a: any): ProposalAction => {
    const method = String(a?.method_name ?? "");
    const args = typeof a?.args === "string" ? decodeArgs(a.args) : undefined;
    if (receiver === CONTRACT) return { kind: "manage", method, args, receiver };
    if (method === "ft_transfer_call" && args?.receiver_id === CONTRACT) {
      let msg: any = undefined;
      try {
        msg = JSON.parse(args.msg);
      } catch {
        /* ignore */
      }
      return { kind: "fund", method: msg?.action ?? "ft_transfer_call", args: { ...args, msg }, receiver };
    }
    // Registering the contract's storage on the token is part of funding it, not a payment to someone else.
    if (method === "storage_deposit" && args?.account_id === CONTRACT) return { kind: "storage", method, args, receiver };
    return { kind: "other", method, args, receiver };
  });
  if (!actions.some((a) => a.kind === "manage" || a.kind === "fund")) return null;
  return { actions, hasOther: actions.some((a) => a.kind === "other") };
}
