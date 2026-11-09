// Pure parsing of a Sputnik FunctionCall proposal into the Standing Order operations it performs.
// Every action is reviewed, not just the first one: a proposal that funds a plan and, in a second
// action, transfers tokens somewhere else must never look like a harmless top-up.
import type { Finding, RecipientIn } from "./checks.ts";

export interface ProposalAction { method_name: string; args: string; deposit?: string; gas?: string }

export interface ParsedAction {
  index: number;
  method: string;
  /** Standing Order operation (create_plan, fund_plan, update_plan, ...) or "unrecognised". */
  kind: string;
  args: unknown;
  planId?: number;
  recipients?: RecipientIn[];
  fundAmount?: string;
  capPerRun?: string;
  interval?: number;
}

const DIRECT = new Set(["create_plan", "fund_plan", "update_plan", "pause_plan", "resume_plan", "cancel_plan", "sweep", "set_guardians"]);
const TOKEN_MOVING = new Set(["ft_transfer", "ft_transfer_call", "storage_withdraw", "near_withdraw", "mt_transfer", "mt_transfer_call", "nft_transfer", "nft_transfer_call"]);

/**
 * Classify every action of a FunctionCall proposal against the Standing Order contract and the plan
 * token. Returns one entry per action plus structural findings (unrecognised actions, transfers to
 * anyone but the contract, the wrong token, operations whose effect the payroll checks cannot see).
 */
export function parseProposalActions(input: { receiverId: string; actions: ProposalAction[]; contract: string; token: string }): { actions: ParsedAction[]; findings: Finding[] } {
  const { receiverId, contract, token } = input;
  const actions: ParsedAction[] = [];
  const findings: Finding[] = [];
  const block = (code: string, message: string) => findings.push({ level: "block", code, message });
  const warn = (code: string, message: string) => findings.push({ level: "warn", code, message });
  if (!input.actions?.length) block("no_actions", "The proposal contains no actions");

  (input.actions ?? []).forEach((action, index) => {
    const label = `action ${index + 1} (${receiverId}.${action.method_name})`;
    let a: any;
    try {
      a = JSON.parse(Buffer.from(action.args ?? "", "base64").toString() || "{}");
    } catch {
      actions.push({ index, method: action.method_name, kind: "unrecognised", args: null });
      block("unparseable_args", `${label}: arguments are not valid JSON, so the clerk cannot tell what it does`);
      return;
    }
    const parsed: ParsedAction = { index, method: action.method_name, kind: "unrecognised", args: a };
    actions.push(parsed);

    if (action.method_name === "ft_transfer_call") {
      if (receiverId !== token) {
        block("wrong_token", `${label}: transfers ${receiverId}, not the plan token ${token}`);
        if (a?.receiver_id !== contract) block("transfer_elsewhere", `${label}: sends tokens to ${a?.receiver_id ?? "?"}, not to ${contract}`);
        return;
      }
      if (a?.receiver_id !== contract) {
        block("transfer_elsewhere", `${label}: sends ${a?.amount ?? "?"} base units to ${a?.receiver_id ?? "?"}, not to ${contract}`);
        return;
      }
      let msg: any;
      try { msg = JSON.parse(a.msg); } catch { msg = null; }
      if (msg?.action === "create_plan" && msg.plan) {
        parsed.kind = "create_plan";
        parsed.fundAmount = a.amount;
        parsed.recipients = msg.plan.recipients;
        parsed.capPerRun = msg.plan.cap_per_run;
        parsed.interval = msg.plan.interval_seconds;
        if (msg.plan.asset?.Ft?.contract !== undefined && msg.plan.asset.Ft.contract !== token) block("wrong_token", `${label}: creates a plan in ${msg.plan.asset.Ft.contract} while funding it with ${token}`);
      } else if (msg?.action === "fund_plan" && msg.plan_id !== undefined) {
        parsed.kind = "fund_plan";
        parsed.fundAmount = a.amount;
        parsed.planId = msg.plan_id;
      } else {
        block("unrecognised", `${label}: msg ${JSON.stringify(a.msg)} is neither create_plan nor fund_plan`);
      }
      return;
    }

    if (TOKEN_MOVING.has(action.method_name)) {
      // Any other token movement (plain ft_transfer and friends) pays someone outside the plan.
      block("transfer_elsewhere", `${label}: moves ${a?.amount ?? "?"} to ${a?.receiver_id ?? "?"} outside Standing Order`);
      return;
    }

    if (receiverId === contract && DIRECT.has(action.method_name)) {
      parsed.kind = action.method_name;
      parsed.planId = a?.plan_id;
      switch (action.method_name) {
        case "create_plan":
          parsed.recipients = a?.plan?.recipients;
          parsed.capPerRun = a?.plan?.cap_per_run;
          parsed.interval = a?.plan?.interval_seconds;
          parsed.fundAmount = action.deposit;
          break;
        case "fund_plan":
          parsed.fundAmount = action.deposit;
          break;
        case "update_plan":
          parsed.recipients = a?.update?.recipients;
          parsed.capPerRun = a?.update?.cap_per_run;
          parsed.interval = a?.update?.interval_seconds;
          if (!parsed.recipients) warn("update_without_recipients", `${label}: changes plan #${parsed.planId} (${Object.keys(a?.update ?? {}).join(", ") || "nothing"}) without a recipients list; the payroll checks do not cover it`);
          break;
        case "sweep":
          warn("sweep", `${label}: withdraws ${a?.amount ?? "the whole unused balance"} from plan #${parsed.planId} back to the plan owner`);
          break;
        case "cancel_plan":
          warn("cancel", `${label}: cancels plan #${parsed.planId} and returns its balance to the plan owner; no further payroll runs`);
          break;
        case "set_guardians":
          warn("guardians", `${label}: sets the guardians who can pause plan #${parsed.planId} to ${JSON.stringify(a?.guardians ?? [])}`);
          break;
      }
      return;
    }

    block("unrecognised", `${label}: not a Standing Order operation the clerk recognises`);
  });

  return { actions, findings };
}
