import type { Proposal, ProposalAction, ProposalInfo } from "../near";
import { proposalTouchesStandingOrder } from "../near";
import { DAO, EXPLORER } from "../config";
import { ClerkBadge, type ReviewIndexItem } from "./ClerkPanel";

function actionLabel(info: ProposalAction): string {
  if (info.kind === "other") return `${info.method || "call"}${typeof info.args?.receiver_id === "string" ? ` to ${info.args.receiver_id}` : ""} on ${info.receiver}`;
  if (info.kind === "storage") return "Register storage";
  switch (info.method) {
    case "create_plan": return `Start recurring payroll: ${info.args?.msg?.plan?.title ?? ""}`;
    case "fund_plan": return `Top up plan #${info.args?.msg?.plan_id ?? info.args?.plan_id}`;
    case "pause_plan": return `Pause plan #${info.args?.plan_id}`;
    case "resume_plan": return `Resume plan #${info.args?.plan_id}${info.args?.skip_missed ? " (skip missed)" : ""}`;
    case "cancel_plan": return `Cancel plan #${info.args?.plan_id} and return funds`;
    case "update_plan": return `Update plan #${info.args?.plan_id}`;
    case "set_guardians": {
      const g: unknown[] = Array.isArray(info.args?.guardians) ? info.args.guardians : [];
      return g.length === 0 ? `Remove all guardians of plan #${info.args?.plan_id}` : `Set guardians of plan #${info.args?.plan_id}: ${g.join(", ")}`;
    }
    case "sweep": return `Return ${info.args?.amount ? "part of the " : ""}unused funds of plan #${info.args?.plan_id}`;
    case "set_config": return "Change contract settings";
    default: return info.method || info.kind;
  }
}

/** All actions of the proposal in order, e.g. "Pause plan #3 → Update plan #3 → Resume plan #3". */
function label(info: ProposalInfo): string {
  return info.actions.map(actionLabel).join(" → ");
}

function otherTitle(info: ProposalInfo): string {
  return "This proposal also runs actions that are not Standing Order: " + info.actions.filter((a) => a.kind === "other").map((a) => `${a.method} on ${a.receiver}${a.args?.receiver_id ? ` (to ${a.args.receiver_id}${a.args.amount ? `, amount ${a.args.amount}` : ""})` : ""}`).join("; ");
}

function summary(desc: string): string {
  const m = desc.match(/Summary: (.*)$/);
  return m ? m[1] : desc.length > 140 ? desc.slice(0, 140) + "…" : desc;
}

export function Requests({ proposals, reviews = [] }: { proposals: Proposal[]; reviews?: ReviewIndexItem[] }) {
  const ours = proposals.map((p) => ({ p, info: proposalTouchesStandingOrder(p) })).filter((x) => x.info);
  return (
    <div className="card pad">
      <div className="section-head">
        <h2>Treasury requests</h2>
        <a className="tiny" href={`${EXPLORER}/address/${DAO}`} target="_blank" rel="noreferrer">{DAO} ↗</a>
      </div>
      {ours.length === 0 ? (
        <div className="empty">No Standing Order proposals on this DAO yet.</div>
      ) : (
        ours.map(({ p, info }) => (
          <div className="req" key={p.id}>
            <div className="id">#{p.id}</div>
            <div>
              <div className="what">{label(info!)}</div>
              <div className="desc">{summary(p.description)}</div>
              <div className="tiny mono">by {p.proposer} · {Object.keys(p.votes ?? {}).length} vote{Object.keys(p.votes ?? {}).length === 1 ? "" : "s"}{p.description.includes("[trezu-tmpl:") ? " · via Trezu template" : ""}{p.description.includes("[clerk:") ? " · drafted by the clerk" : ""}</div>
            </div>
            <span className="row status" style={{ gap: 6, justifyContent: "flex-end" }}>
              {info!.hasOther && <span className="chip failed" title={otherTitle(info!)}>includes other actions</span>}
              <ClerkBadge review={reviews.find((r) => r.proposal_id === p.id)} />
              <span className={`chip ${p.status === "Approved" ? "active" : p.status === "InProgress" ? "blue" : "neutral"}`}>{p.status === "InProgress" ? "Voting" : p.status}</span>
            </span>
          </div>
        ))
      )}
    </div>
  );
}
