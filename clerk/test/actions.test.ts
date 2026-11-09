import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposalActions, type ProposalAction } from "../src/actions.ts";
import { verdict } from "../src/checks.ts";

const contract = "standing-order.testnet";
const token = "usdc.fakes.testnet";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const act = (method_name: string, args: unknown, deposit = "1"): ProposalAction => ({ method_name, args: b64(args), deposit, gas: "100000000000000" });
const fund = act("ft_transfer_call", { receiver_id: contract, amount: "1000000", msg: JSON.stringify({ action: "fund_plan", plan_id: 0 }) });
const codes = (f: { code: string }[]) => f.map((x) => x.code).sort();

test("a single fund_plan top-up is recognised without findings", () => {
  const r = parseProposalActions({ receiverId: token, actions: [fund], contract, token });
  assert.deepEqual(r.findings, []);
  assert.equal(r.actions[0].kind, "fund_plan");
  assert.equal(r.actions[0].planId, 0);
  assert.equal(r.actions[0].fundAmount, "1000000");
});

test("fund_plan plus an ft_transfer to an attacker blocks", () => {
  const r = parseProposalActions({ receiverId: token, actions: [fund, act("ft_transfer", { receiver_id: "attacker.testnet", amount: "999000000" })], contract, token });
  assert.equal(verdict(r.findings), "block");
  assert.ok(codes(r.findings).includes("transfer_elsewhere"));
  assert.deepEqual(r.actions.map((x) => x.kind), ["fund_plan", "unrecognised"]);
});

test("ft_transfer_call on another token blocks", () => {
  const r = parseProposalActions({ receiverId: "wrap.testnet", actions: [act("ft_transfer_call", { receiver_id: contract, amount: "5", msg: JSON.stringify({ action: "fund_plan", plan_id: 0 }) })], contract, token });
  assert.equal(verdict(r.findings), "block");
  assert.ok(codes(r.findings).includes("wrong_token"));
});

test("ft_transfer_call to someone other than the contract blocks", () => {
  const r = parseProposalActions({ receiverId: token, actions: [act("ft_transfer_call", { receiver_id: "evil.testnet", amount: "5", msg: JSON.stringify({ action: "fund_plan", plan_id: 0 }) })], contract, token });
  assert.equal(verdict(r.findings), "block");
  assert.deepEqual(codes(r.findings), ["transfer_elsewhere"]);
});

test("unrecognised actions block, including a second call on the contract", () => {
  const r = parseProposalActions({ receiverId: contract, actions: [act("pause_plan", { plan_id: 1 }), act("set_owner", { owner: "x.testnet" })], contract, token });
  assert.equal(verdict(r.findings), "block");
  assert.deepEqual(codes(r.findings), ["unrecognised"]);
  const other = parseProposalActions({ receiverId: "random.testnet", actions: [act("do_thing", {})], contract, token });
  assert.equal(verdict(other.findings), "block");
});

test("update_plan without recipients, sweep and cancel are never silently ok", () => {
  for (const a of [act("update_plan", { plan_id: 1, update: { title: "x" } }), act("sweep", { plan_id: 1 }), act("cancel_plan", { plan_id: 1 })]) {
    const r = parseProposalActions({ receiverId: contract, actions: [a], contract, token });
    assert.equal(verdict(r.findings), "warn", a.method_name);
  }
});

test("update_plan with recipients and create_plan via ft_transfer_call are parsed", () => {
  const recipients = [{ account_id: "a.testnet", amount: "100" }];
  const up = parseProposalActions({ receiverId: contract, actions: [act("update_plan", { plan_id: 2, update: { recipients, cap_per_run: "100" } })], contract, token });
  assert.deepEqual(up.findings, []);
  assert.deepEqual(up.actions[0].recipients, recipients);
  const create = parseProposalActions({ receiverId: token, actions: [act("ft_transfer_call", { receiver_id: contract, amount: "300", msg: JSON.stringify({ action: "create_plan", plan: { title: "t", asset: { Ft: { contract: token } }, recipients, interval_seconds: 60, cap_per_run: "100" } }) })], contract, token });
  assert.deepEqual(create.findings, []);
  assert.equal(create.actions[0].kind, "create_plan");
  assert.equal(create.actions[0].capPerRun, "100");
});

test("unparseable args block", () => {
  const r = parseProposalActions({ receiverId: contract, actions: [{ method_name: "fund_plan", args: Buffer.from("{not json").toString("base64") }], contract, token });
  assert.equal(verdict(r.findings), "block");
});
