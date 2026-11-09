// Standing Order payroll clerk: private, attested pre-vote review for treasury payroll.
//
//   npm run clerk -- review <proposal_id>            explain + check a pending Sputnik proposal
//   npm run clerk -- draft <folder> [--plan N] [--file]
//                                                    read contributor documents, propose a plan
//                                                    update (or a new plan), optionally file it
//
// Salary documents never leave the machine except to a NEAR-operated TEE model; every model call
// returns a receipt (attestation nonce, request/response hashes, TEE signature) that the dashboard
// and anyone else can re-verify. Deterministic checks run regardless of what the model says.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cfg, view, TGAS, provider } from "../../scripts/lib/near.ts";
import { proposeFunctionCall, vote as voteOn, proposal as getProposal } from "../../scripts/lib/dao.ts";
import { loadDocuments } from "./documents.ts";
import { checkProposal, verdict, type Finding, type RecipientIn } from "./checks.ts";
import { parseProposalActions } from "./actions.ts";
import { verifiedCompletion, extractJson, DEFAULT_MODEL, type Receipt } from "./nearai.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REVIEWS = path.join(here, "..", "reviews");
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const meta: any = await view(cfg.token, "ft_metadata");
const units = 10n ** BigInt(meta.decimals);
const plans: any[] = await view(cfg.contract, "get_plans", { from_index: 0, limit: 100 });
const knownAccounts = Array.from(new Set(plans.flatMap((p) => p.recipients.map((r: any) => r.account_id))));
const human = (v: string | bigint) => `${(Number(BigInt(v) * 100n / units) / 100).toLocaleString()} ${meta.symbol}`;

/** On-chain facts the model cannot know: does the account exist, and can it receive this token? */
async function onchainFindings(recipients: RecipientIn[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const r of recipients) {
    let exists = true;
    try { await provider.viewAccount({ accountId: r.account_id }); } catch { exists = false; }
    if (!exists) { out.push({ level: "block", code: "no_account", message: `${r.account_id} does not exist on ${process.env.NEAR_NETWORK ?? "testnet"}; the payout would fail and be re-credited`, recipient: r.account_id }); continue; }
    const bal = await view<any>(cfg.token, "storage_balance_of", { account_id: r.account_id }).catch(() => null);
    if (!bal) out.push({ level: "warn", code: "not_registered", message: `${r.account_id} is not registered on the ${meta.symbol} contract; register storage (0.00125 NEAR) or the transfer fails`, recipient: r.account_id });
  }
  return out;
}


// ───────────────────────── review a pending proposal ─────────────────────────
async function review(id: number) {
  const p = await getProposal(id);
  const fc = p.kind?.FunctionCall;
  if (!fc) throw new Error(`proposal #${id} is not a FunctionCall proposal`);
  // Review every action, not only the first: extra actions (e.g. an ft_transfer to a third party)
  // must be visible and blocking.
  const parsed = parseProposalActions({ receiverId: fc.receiver_id, actions: fc.actions ?? [], contract: cfg.contract, token: cfg.token });
  const findings: Finding[] = [...parsed.findings];
  for (const act of parsed.actions) {
    if (act.kind === "unrecognised") continue;
    const current = act.planId !== undefined ? plans.find((x) => x.id === act.planId) : undefined;
    if (act.recipients) {
      findings.push(...checkProposal({ recipients: act.recipients, decimals: meta.decimals, symbol: meta.symbol, capPerRun: act.capPerRun ?? current?.cap_per_run, intervalSeconds: act.interval, previous: current?.recipients, knownAccounts, fundAmount: act.fundAmount, balance: current?.balance }));
      findings.push(...(await onchainFindings(act.recipients)));
    } else if (act.kind === "fund_plan" && current) {
      findings.push(...checkProposal({ recipients: current.recipients, decimals: meta.decimals, symbol: meta.symbol, fundAmount: (BigInt(act.fundAmount ?? "0") + BigInt(current.balance)).toString(), previous: current.recipients }));
    } else if (act.planId !== undefined && !current) {
      findings.push({ level: "warn", code: "unknown_plan", message: `action ${act.index + 1} (${act.method}) targets plan #${act.planId}, which the clerk could not find` });
    }
  }
  // Summary fields keep the single-action shape the dashboard reads; `actions` lists all of them.
  const primary = parsed.actions.find((x) => x.kind !== "unrecognised") ?? parsed.actions[0];
  const kind = parsed.actions.map((x) => x.kind).join("+");
  const planId = primary?.planId;
  const fundAmount = primary?.fundAmount;
  const current = planId !== undefined ? plans.find((x) => x.id === planId) : undefined;
  const facts = {
    proposal_id: id, status: p.status, proposer: p.proposer, kind, method: primary?.method, receiver: fc.receiver_id,
    actions: parsed.actions.map((x) => ({ index: x.index, method: x.method, kind: x.kind, args: x.args })),
    plan_now: current ? { id: current.id, title: current.title, status: current.status, interval_seconds: current.interval_seconds, balance: human(current.balance), recipients: current.recipients.map((r: any) => ({ account_id: r.account_id, amount: human(r.amount) })) } : null,
    token: { symbol: meta.symbol, decimals: meta.decimals },
    deterministic_findings: findings,
  };
  const { content, receipt } = await verifiedCompletion({
    system: SYSTEM_REVIEW,
    user: `Review this Sputnik DAO proposal for the Standing Order payroll contract and write the council brief.\n\n${JSON.stringify(facts, null, 1)}`,
    maxTokens: 1200,
  });
  const brief = safeBrief(content);
  const out = { type: "review", proposal_id: id, dao: cfg.dao, contract: cfg.contract, verdict: verdict(findings), findings, facts: { kind, method: primary?.method, plan_id: planId, fund_amount: fundAmount, actions: parsed.actions.map((x) => ({ method: x.method, kind: x.kind, plan_id: x.planId, fund_amount: x.fundAmount })) }, brief, model: receipt.model, receipt, at: new Date().toISOString() };
  save(`proposal-${id}.json`, out);
  print(out);
}

// ───────────────────────── draft from contributor documents ─────────────────────────
async function draft(folder: string, planId: number | undefined, file: boolean, autoVote: boolean) {
  const docs = await loadDocuments(folder);
  if (docs.length === 0) throw new Error(`no documents in ${folder}`);
  const current = planId !== undefined ? plans.find((x) => x.id === planId) : undefined;
  const user = [
    `Token: ${meta.symbol} with ${meta.decimals} decimals (1 ${meta.symbol} = ${units} base units).`,
    current ? `Current plan #${current.id} "${current.title}" pays every ${current.interval_seconds}s: ${current.recipients.map((r: any) => `${r.account_id}=${human(r.amount)}`).join(", ")}.` : "There is no current plan; propose a new one.",
    `Known contributor accounts: ${knownAccounts.join(", ") || "(none)"}.`,
    "Documents:",
    ...docs.map((d) => `--- ${d.name} ---\n${d.text.slice(0, 6000)}`),
  ].join("\n\n");
  const { content, receipt } = await verifiedCompletion({ system: SYSTEM_DRAFT, user, maxTokens: 1200 });
  const extracted = extractJson<{ recipients: Array<{ account_id: string; amount_human: number; source: string; note?: string }>; period?: string; summary?: string }>(content);
  const recipients: RecipientIn[] = extracted.recipients.map((r) => ({ account_id: String(r.account_id).trim().toLowerCase(), amount: toBase(r.amount_human) }));
  const findings = checkProposal({ recipients, decimals: meta.decimals, symbol: meta.symbol, previous: current?.recipients, knownAccounts, capPerRun: recipients.reduce((s, r) => (s + BigInt(r.amount)), 0n).toString() });
  findings.push(...(await onchainFindings(recipients)));
  const total = recipients.reduce((s, r) => s + BigInt(r.amount), 0n);
  const runs = Number(opt("--runs") ?? 3);
  const proposalArgs = current
    ? { receiver_id: cfg.contract, method: "update_plan", args: { plan_id: current.id, update: { recipients, cap_per_run: total.toString() } }, deposit: "10000000000000000000000" }
    : { receiver_id: cfg.token, method: "ft_transfer_call", args: { receiver_id: cfg.contract, amount: (total * BigInt(runs)).toString(), msg: JSON.stringify({ action: "create_plan", plan: { title: opt("--title") ?? `Payroll ${extracted.period ?? ""}`.trim(), asset: { Ft: { contract: cfg.token } }, recipients, interval_seconds: Number(opt("--interval") ?? 2592000), cap_per_run: total.toString() } }) }, deposit: "1" };
  const out: any = { type: "draft", dao: cfg.dao, contract: cfg.contract, plan_id: current?.id ?? null, period: extracted.period ?? null, documents: docs.map((d) => d.name), verdict: verdict(findings), findings, recipients: recipients.map((r, i) => ({ ...r, human: human(r.amount), source: extracted.recipients[i]?.source, note: extracted.recipients[i]?.note })), total_per_run: human(total), summary: extracted.summary ?? "", proposal: proposalArgs, model: receipt.model, receipt, at: new Date().toISOString() };
  out.review_hash = sha256(JSON.stringify({ recipients, findings, receipt: { request_hash: receipt.request_hash, response_hash: receipt.response_hash } }));
  if (file) {
    if (out.verdict === "block") throw new Error("refusing to file: blocking findings present (fix the documents or the plan first)");
    const description = `Standing Order: ${current ? `update plan #${current.id}` : "start recurring payroll"} from ${docs.length} contributor document(s); clerk verdict ${out.verdict}; drafted by ${receipt.model} in a TEE, receipt ${receipt.verified ? "verified" : "UNVERIFIED"} [clerk:${out.review_hash}]`;
    const id = await proposeFunctionCall(cfg.council[0], proposalArgs.receiver_id, [{ method_name: proposalArgs.method, args: proposalArgs.args, deposit: proposalArgs.deposit, gas: TGAS(100).toString() }], description);
    out.proposal_id = id;
    if (autoVote) {
      let p = await getProposal(id);
      for (const m of cfg.council) { if (p.status !== "InProgress") break; p = await voteOn(m, id); }
      out.proposal_status = p.status;
    }
    save(`proposal-${id}.json`, out);
  }
  save(`draft-${Date.now()}.json`, out);
  print(out);
}

// ───────────────────────── helpers ─────────────────────────
const SYSTEM_REVIEW = `You are the payroll clerk for a DAO treasury. You write a short, factual brief for council members who are about to vote on a payroll proposal. Use only the facts given. Never invent accounts or amounts. Output JSON only: {"headline": string (<= 120 chars, what the proposal does in plain words), "what_changes": string[] (each <= 160 chars), "risks": string[] (restate every deterministic finding with level block or warn in plain words, then add at most 2 observations of your own, each marked "(model)"), "questions_for_proposer": string[] (<= 3), "recommend": "approve" | "ask" | "reject"}. If any deterministic finding has level "block", recommend must be "reject". If any has level "warn", recommend must be "ask" or "reject".`;
const SYSTEM_DRAFT = `You are the payroll clerk for a DAO treasury. Extract the payroll a treasury should pay this period from contributor documents. Output JSON only: {"period": string, "recipients": [{"account_id": string (a NEAR account id exactly as written in the document; if the document gives none, use "" ), "amount_human": number (the amount due this period in whole tokens, e.g. 120 for 120 USDC), "source": string (file name), "note": string (<= 120 chars: what the document says, including any change versus last period)}], "summary": string (<= 300 chars)}. One entry per contributor. Do not merge or split invoices. Do not include anyone without a document. Do not convert to base units.`;

function toBase(humanAmount: number): string {
  const [w, f = ""] = String(humanAmount).split(".");
  const frac = (f + "0".repeat(meta.decimals)).slice(0, meta.decimals);
  return (BigInt(w || "0") * units + BigInt(frac || "0")).toString();
}
function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }
function safeBrief(content: string) {
  try { return extractJson(content); } catch { return { headline: content.slice(0, 200), what_changes: [], risks: [], questions_for_proposer: [], recommend: "ask", parse_error: true }; }
}
function save(name: string, data: unknown) {
  fs.mkdirSync(REVIEWS, { recursive: true });
  fs.writeFileSync(path.join(REVIEWS, name), JSON.stringify(data, null, 2));
  // index for the dashboard
  const files = fs.readdirSync(REVIEWS).filter((f) => f.startsWith("proposal-") && f.endsWith(".json")).sort();
  const index = files.map((f) => { const j = JSON.parse(fs.readFileSync(path.join(REVIEWS, f), "utf8")); return { file: f, proposal_id: j.proposal_id, type: j.type, verdict: j.verdict, recommend: j.brief?.recommend, headline: j.brief?.headline ?? j.summary, verified: j.receipt?.verified, model: j.model, at: j.at }; });
  fs.writeFileSync(path.join(REVIEWS, "index.json"), JSON.stringify(index, null, 2));
}
function print(out: any) {
  console.log(`\n${out.type === "review" ? `Proposal #${out.proposal_id}` : "Draft"} · verdict ${out.verdict.toUpperCase()} · model ${out.model} · receipt ${out.receipt.verified ? `VERIFIED (${out.receipt.signed_by})` : "unverified"}`);
  if (out.brief) { console.log(`  ${out.brief.headline}`); for (const r of out.brief.risks ?? []) console.log(`  ! ${r}`); console.log(`  → recommend: ${out.brief.recommend}`); }
  if (out.recipients) for (const r of out.recipients) console.log(`  ${r.account_id}: ${r.human}  (${r.source}) ${r.note ?? ""}`);
  for (const f of out.findings) console.log(`  [${f.level}] ${f.message}`);
  for (const c of out.receipt.checks) console.log(`  ✓ ${c}`);
  if (out.proposal_id && out.type === "draft") console.log(`  filed as proposal #${out.proposal_id}${out.proposal_status ? ` (${out.proposal_status})` : ""}`);
  console.log(`  saved under clerk/reviews/`);
}

// Dispatch last so the prompt constants above are initialised.
if (cmd === "review") await review(Number(args[1]));
else if (cmd === "draft") await draft(args[1], opt("--plan") ? Number(opt("--plan")) : undefined, flag("--file"), flag("--vote"));
else { console.error("usage: clerk review <proposal_id> | clerk draft <folder> [--plan N] [--file] [--vote]"); process.exit(1); }
