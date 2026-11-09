use super::*;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, NearToken};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn ctx(predecessor: AccountId, deposit: u128, ts_seconds: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0))
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_seconds * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn dao() -> AccountId {
    accounts(1)
}

fn recipient(i: usize) -> AccountId {
    format!("r{}.test.near", i).parse().unwrap()
}

fn input(interval: u64, amounts: &[u128]) -> PlanInput {
    PlanInput {
        title: "Core team payroll".into(),
        asset: Asset::Near,
        recipients: amounts
            .iter()
            .enumerate()
            .map(|(i, a)| Recipient { account_id: recipient(i), amount: U128(*a) })
            .collect(),
        interval_seconds: interval,
        start_at: None,
        end_at: None,
        cap_per_run: None,
        guardians: None,
    }
}

fn new_contract() -> Contract {
    testing_env!(ctx(accounts(0), 0, 1_000).build());
    Contract::new(accounts(0), true, Some(60), None)
}

#[test]
fn create_native_plan_funds_from_deposit() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 5 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR, 2 * NEAR]));
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.owner, dao());
    assert_eq!(plan.next_run_at, 1_000, "first run is due immediately by default");
    assert_eq!(plan.cap_per_run.0, 3 * NEAR, "cap defaults to the recipients total");
    // The mocked VM does not meter storage, so the whole deposit becomes balance here;
    // real storage charging is covered by the sandbox tests.
    assert!(plan.balance.0 <= 5 * NEAR && plan.balance.0 > 4 * NEAR, "deposit minus storage becomes balance");
    assert!(get_logs().iter().any(|l| l.contains("plan_created")));
    assert_eq!(c.get_plans_by_owner(dao()).len(), 1);
    assert_eq!(c.get_config().plan_count, 1);
}

#[test]
#[should_panic(expected = "interval_seconds must be at least")]
fn create_plan_rejects_short_interval() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), NEAR, 1_000).build());
    c.create_plan(input(5, &[NEAR]));
}

#[test]
#[should_panic(expected = "Recipients total exceeds cap_per_run")]
fn create_plan_rejects_total_above_cap() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), NEAR, 1_000).build());
    let mut i = input(3600, &[NEAR, NEAR]);
    i.cap_per_run = Some(U128(NEAR));
    c.create_plan(i);
}

#[test]
fn run_due_pays_once_per_period_and_advances_schedule() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR, 2 * NEAR]));
    let before = c.get_plan(id).unwrap().balance.0;

    testing_env!(ctx(accounts(5), 0, 1_000).build()); // anyone can trigger
    let out = c.run_due(id, None);
    assert_eq!(out, RunOutcome::Sent { run_index: 0, sent: 2, remaining: 0, completed: true });
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.balance.0, before - 3 * NEAR);
    assert_eq!(plan.next_run_at, 4_600);
    assert_eq!(plan.runs_completed, 1);
    assert_eq!(plan.payout_count, 2);
    let payouts = c.get_payouts(id, None, None);
    assert_eq!(payouts.len(), 2);
    assert_eq!(payouts[1].recipient, recipient(1));
    assert_eq!(payouts[1].status, PayoutStatus::Pending);

    // Same period again: nothing happens.
    assert_eq!(c.run_due(id, None), RunOutcome::NotDue { next_run_at: 4_600 });
    assert_eq!(c.get_plan(id).unwrap().balance.0, before - 3 * NEAR);
    assert!(!c.is_due(id));

    // Two periods later: catch-up pays one period per call, schedule stays aligned.
    testing_env!(ctx(accounts(5), 0, 9_000).build());
    assert!(c.is_due(id));
    assert_eq!(c.get_due_plans(None), vec![id]);
    assert!(matches!(c.run_due(id, None), RunOutcome::Sent { run_index: 1, completed: true, .. }));
    assert_eq!(c.get_plan(id).unwrap().next_run_at, 8_200);
    assert!(matches!(c.run_due(id, None), RunOutcome::Sent { run_index: 2, completed: true, .. }));
    assert_eq!(c.get_plan(id).unwrap().next_run_at, 11_800);
    assert_eq!(c.run_due(id, None), RunOutcome::NotDue { next_run_at: 11_800 });
}

#[test]
fn run_due_refuses_partial_runs_when_underfunded() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 2 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR, 2 * NEAR]));
    testing_env!(ctx(accounts(5), 0, 1_000).build());
    let out = c.run_due(id, None);
    assert!(matches!(out, RunOutcome::Underfunded { needed, .. } if needed.0 == 3 * NEAR));
    assert!(!c.is_due(id), "underfunded plans are not due, so keepers stop polling them");
    assert!(c.get_due_plans(None).is_empty());
    assert_eq!(c.get_underfunded_plans(None), vec![id]);
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.runs_completed, 0);
    assert_eq!(plan.payout_count, 0);
    assert!(get_logs().iter().any(|l| l.contains("plan_underfunded")));

    // Top up and it pays.
    testing_env!(ctx(dao(), 2 * NEAR, 1_000).build());
    c.fund_plan(id);
    assert!(c.get_underfunded_plans(None).is_empty());
    assert_eq!(c.get_due_plans(None), vec![id]);
    testing_env!(ctx(accounts(5), 0, 1_000).build());
    assert!(matches!(c.run_due(id, None), RunOutcome::Sent { completed: true, .. }));
}

#[test]
fn failed_payout_recredits_balance() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    testing_env!(ctx(accounts(5), 0, 1_000).build());
    c.run_due(id, None);
    let after_send = c.get_plan(id).unwrap().balance.0;

    // Callback runs as the contract itself.
    testing_env!(ctx(accounts(0), 0, 1_001).build());
    c.on_payout(id, 0, U128(NEAR), Err(PromiseError::Failed));
    assert_eq!(c.get_plan(id).unwrap().balance.0, after_send + NEAR);
    assert_eq!(c.get_payouts(id, None, None)[0].status, PayoutStatus::Failed);
    assert!(get_logs().iter().any(|l| l.contains("payout_failed")));
}

#[test]
fn successful_payout_marks_sent() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    testing_env!(ctx(accounts(5), 0, 1_000).build());
    c.run_due(id, None);
    testing_env!(ctx(accounts(0), 0, 1_001).build());
    c.on_payout(id, 0, U128(NEAR), Ok(()));
    assert_eq!(c.get_payouts(id, None, None)[0].status, PayoutStatus::Sent);
}

#[test]
fn pause_blocks_runs_and_resume_restores() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    c.pause_plan(id);
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Paused);
    assert!(c.get_due_plans(None).is_empty());
    testing_env!(ctx(accounts(5), 0, 5_000).build());
    assert_eq!(c.run_due(id, None), RunOutcome::Paused);
    testing_env!(ctx(dao(), 0, 5_000).build());
    c.resume_plan(id, None);
    testing_env!(ctx(accounts(5), 0, 5_000).build());
    assert!(matches!(c.run_due(id, None), RunOutcome::Sent { .. }));
}

#[test]
#[should_panic(expected = "Only the plan owner or a guardian can pause")]
fn only_owner_can_pause() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    testing_env!(ctx(accounts(5), 0, 1_000).build());
    c.pause_plan(id);
}

#[test]
fn cancel_sweeps_balance_and_stops_runs() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    let promise = c.cancel_plan(id);
    assert!(promise.is_some(), "a transfer back to the owner is scheduled");
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.status, PlanStatus::Cancelled);
    assert_eq!(plan.balance.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("plan_swept")));
    testing_env!(ctx(accounts(5), 0, 9_000).build());
    assert_eq!(c.run_due(id, None), RunOutcome::Cancelled);
}

#[test]
fn partial_sweep_keeps_plan_active() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    let before = c.get_plan(id).unwrap().balance.0;
    c.sweep(id, Some(U128(NEAR)));
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.balance.0, before - NEAR);
    assert_eq!(plan.status, PlanStatus::Active);
}

#[test]
#[should_panic(expected = "Sweep amount exceeds balance")]
fn sweep_cannot_exceed_balance() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 2 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    c.sweep(id, Some(U128(5 * NEAR)));
}

#[test]
fn end_date_stops_runs_after_last_period() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let mut i = input(3600, &[NEAR]);
    i.start_at = Some(1_000);
    i.end_at = Some(4_600); // exactly two runs: t=1000 and t=4600
    let id = c.create_plan(i);
    testing_env!(ctx(accounts(5), 0, 20_000).build());
    assert!(matches!(c.run_due(id, None), RunOutcome::Sent { run_index: 0, .. }));
    assert!(matches!(c.run_due(id, None), RunOutcome::Sent { run_index: 1, .. }));
    assert_eq!(c.run_due(id, None), RunOutcome::Ended);
    assert!(c.get_due_plans(None).is_empty());
}

#[test]
fn update_plan_changes_recipients_and_enforces_cap() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    testing_env!(ctx(dao(), NEAR, 1_000).build());
    c.update_plan(
        id,
        PlanUpdate {
            recipients: Some(vec![
                Recipient { account_id: recipient(0), amount: U128(NEAR) },
                Recipient { account_id: recipient(1), amount: U128(NEAR / 2) },
            ]),
            cap_per_run: Some(U128(2 * NEAR)),
            interval_seconds: Some(7200),
            end_at: Some(100_000),
            ..Default::default()
        },
    );
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.recipients.len(), 2);
    assert_eq!(plan.interval_seconds, 7200);
    assert_eq!(plan.end_at, Some(100_000));
    assert_eq!(plan.total_per_run(), NEAR + NEAR / 2);
}

#[test]
#[should_panic(expected = "Recipients total exceeds cap_per_run")]
fn update_plan_rejects_recipients_over_cap() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    testing_env!(ctx(dao(), NEAR, 1_000).build());
    c.update_plan(
        id,
        PlanUpdate {
            recipients: Some(vec![Recipient { account_id: recipient(0), amount: U128(3 * NEAR) }]),
            ..Default::default()
        },
    );
}

#[test]
fn large_runs_continue_across_calls_when_gas_is_short() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 100 * NEAR, 1_000).build());
    let amounts = vec![NEAR / 10; 40];
    let id = c.create_plan(input(3600, &amounts));
    // Give only enough gas for a handful of payouts per call.
    let mut b = ctx(accounts(5), 0, 1_000);
    b.prepaid_gas(Gas::from_tgas(80));
    testing_env!(b.build());
    let first = c.run_due(id, None);
    let RunOutcome::Sent { sent, remaining, completed, run_index } = first else { panic!("expected Sent") };
    assert_eq!(run_index, 0);
    assert!(sent > 0 && !completed && remaining == 40 - sent, "run should be split: {:?}", first);
    assert!(c.get_plan(id).unwrap().run_cursor.is_some());
    assert!(c.is_due(id), "mid-run plans stay due");

    let mut total_sent = sent;
    let mut guard = 0;
    while c.get_plan(id).unwrap().run_cursor.is_some() {
        let mut b = ctx(accounts(5), 0, 1_000);
        b.prepaid_gas(Gas::from_tgas(80));
        testing_env!(b.build());
        if let RunOutcome::Sent { sent, .. } = c.run_due(id, None) {
            total_sent += sent;
        }
        guard += 1;
        assert!(guard < 50, "run never completed");
    }
    assert_eq!(total_sent, 40);
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.runs_completed, 1);
    assert_eq!(plan.payout_count, 40);
    assert_eq!(plan.next_run_at, 4_600);
}

#[test]
#[should_panic(expected = "Cannot update a plan mid-run")]
fn cannot_update_mid_run() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 100 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &vec![NEAR / 10; 40]));
    let mut b = ctx(accounts(5), 0, 1_000);
    b.prepaid_gas(Gas::from_tgas(80));
    testing_env!(b.build());
    c.run_due(id, None);
    testing_env!(ctx(dao(), NEAR, 1_000).build());
    c.update_plan(id, PlanUpdate { title: Some("x".into()), ..Default::default() });
}

/// Parse the NEP-297 `EVENT_JSON:` logs emitted so far and return the `data[0]` of those named `event`.
fn events_named(event: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).expect("event log is JSON"))
        .filter(|v| v["event"] == event && v["standard"] == "standing_order")
        .map(|v| v["data"][0].clone())
        .collect()
}

#[test]
fn storage_deposit_tracks_credits() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), NEAR, 1_000).build());
    assert_eq!(c.storage_deposit(None).0, NEAR);
    assert_eq!(c.storage_credit_of(dao()).0, NEAR);
    let ev = events_named("storage_credited");
    assert_eq!(ev.len(), 1, "{:?}", get_logs());
    assert_eq!(ev[0]["account"], dao().to_string());
    assert_eq!(ev[0]["amount"], NEAR.to_string());
    assert_eq!(ev[0]["credit"], NEAR.to_string());

    // Topping up another account reports that account and its cumulative credit.
    testing_env!(ctx(dao(), NEAR / 2, 1_000).build());
    assert_eq!(c.storage_deposit(Some(accounts(2))).0, NEAR / 2);
    testing_env!(ctx(dao(), NEAR / 2, 1_000).build());
    assert_eq!(c.storage_deposit(Some(accounts(2))).0, NEAR);
    let ev = events_named("storage_credited");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["account"], accounts(2).to_string());
    assert_eq!(ev[0]["amount"], (NEAR / 2).to_string());
    assert_eq!(ev[0]["credit"], NEAR.to_string());
}

#[test]
fn only_contract_owner_sets_config() {
    let mut c = new_contract();
    testing_env!(ctx(accounts(0), 0, 1_000).build());
    let old_key = c.get_config().oneclick_public_key;
    let new_key = routes::encode_public_key(&[1u8; 32]);
    c.set_config(Some(false), Some(10), Some(5), Some(new_key.clone()), None);
    let cfg = c.get_config();
    assert!(!cfg.sponsor_storage);
    assert_eq!(cfg.min_interval_seconds, 10);
    assert_eq!(cfg.max_recipients, 5);
    assert_eq!(cfg.oneclick_public_key, new_key);

    let ev = events_named("config_updated");
    assert_eq!(ev.len(), 1, "{:?}", get_logs());
    let ev = &ev[0];
    assert_eq!(ev["by"], accounts(0).to_string());
    assert_eq!(ev["old"]["oneclick_public_key"], old_key);
    assert_eq!(ev["old"]["sponsor_storage"], true);
    assert_eq!(ev["old"]["min_interval_seconds"], 60);
    assert_eq!(ev["old"]["max_recipients"], 100);
    assert_eq!(ev["new"]["oneclick_public_key"], new_key);
    assert_eq!(ev["new"]["sponsor_storage"], false);
    assert_eq!(ev["new"]["min_interval_seconds"], 10);
    assert_eq!(ev["new"]["max_recipients"], 5);
}

#[test]
#[should_panic(expected = "Only the contract owner")]
fn non_owner_cannot_set_config() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 0, 1_000).build());
    c.set_config(Some(false), None, None, None, None);
}

#[test]
fn resume_can_skip_missed_periods() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    c.pause_plan(id);
    // Three periods later: resume with skip_missed → next run is the next aligned slot, no back pay.
    testing_env!(ctx(dao(), 0, 1_000 + 3 * 3600 + 100).build());
    c.resume_plan(id, Some(true));
    let plan = c.get_plan(id).unwrap();
    assert_eq!(plan.next_run_at, 1_000 + 4 * 3600);
    assert!(!c.is_due(id));

    // Default resume keeps back pay.
    let mut c = new_contract();
    testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    c.pause_plan(id);
    testing_env!(ctx(dao(), 0, 1_000 + 3 * 3600 + 100).build());
    c.resume_plan(id, None);
    assert_eq!(c.get_plan(id).unwrap().next_run_at, 1_000);
    assert!(c.is_due(id));
}

#[test]
fn register_destination_requires_intents_asset_id() {
    let mut c = new_contract();
    testing_env!(ctx(accounts(2), NEAR / 10, 1_000).build());
    c.register_destination("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".into(), "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".into());
    let d = c.get_destination(accounts(2)).unwrap();
    assert_eq!(d.address, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    c.clear_destination();
    assert!(c.get_destination(accounts(2)).is_none());
}

#[test]
#[should_panic(expected = "asset_id must be a NEAR Intents asset id")]
fn register_destination_rejects_bad_asset() {
    let mut c = new_contract();
    testing_env!(ctx(accounts(2), NEAR / 10, 1_000).build());
    c.register_destination("base-usdc".into(), "0xabc".into());
}

// ───────────────────────────── cross-chain routes ─────────────────────────────

mod routed {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::serde_json::{json, Value};
    use std::collections::BTreeMap;

    const USD: u128 = 1_000_000;
    const BASE_USDC: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    const BASE_ADDR: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const SOL_USDC: &str = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
    const SOL_ADDR: &str = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

    fn token() -> AccountId {
        accounts(3)
    }

    /// A quote response shaped and signed like 1Click's, signed by `signer` (same canonical
    /// form as `tests/routed_payouts.rs`).
    fn signed_quote(signer: &SigningKey, origin_asset: &str, destination_asset: &str, amount: u128, recipient: &str, refund_to: &str) -> String {
        let request = json!({
            "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 100,
            "originAsset": origin_asset, "depositType": "ORIGIN_CHAIN", "destinationAsset": destination_asset,
            "amount": amount.to_string(), "refundTo": refund_to, "refundType": "ORIGIN_CHAIN",
            "recipient": recipient, "recipientType": "DESTINATION_CHAIN", "deadline": "2026-11-09T06:00:00.000Z",
            "confidentiality": "public", "quoteWaitingTimeMs": 0, "insured": false,
        });
        let amount_out = amount - amount / 1000;
        let quote = json!({
            "amountIn": amount.to_string(), "amountInFormatted": "x", "amountInUsd": "x", "minAmountIn": amount.to_string(),
            "amountOut": amount_out.to_string(), "amountOutFormatted": "x", "amountOutUsd": "x", "minAmountOut": (amount_out - 1000).to_string(),
            "timeEstimate": 22, "refundFee": "4528", "withdrawFee": "2400",
            "deadline": "2026-11-12T06:00:00.000Z", "timeWhenInactive": "2026-11-12T06:00:00.000Z",
            "depositAddress": "702bb1cdf6e6d1f80776679b6e0f2745226efd76cda7563fe0f45ee1d1929d87"
        });
        let timestamp = "2026-11-08T20:25:36.811Z";
        let mut m: BTreeMap<&str, Value> = BTreeMap::new();
        for k in ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"] {
            m.insert(k, request[k].clone());
        }
        for k in ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut", "depositAddress", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"] {
            m.insert(k, quote[k].clone());
        }
        m.insert("timestamp", Value::String(timestamp.into()));
        let canonical = format!("{{{}}}", m.iter().map(|(k, v)| format!("{}:{}", near_sdk::serde_json::to_string(k).unwrap(), near_sdk::serde_json::to_string(v).unwrap())).collect::<Vec<_>>().join(","));
        let message = bs58::encode(env::sha256(canonical.as_bytes())).into_string();
        let signature = format!("ed25519:{}", bs58::encode(signer.sign(message.as_bytes()).to_bytes()).into_string());
        json!({"quote": quote, "quoteRequest": request, "signature": signature, "timestamp": timestamp, "correlationId": "unit"}).to_string()
    }

    /// Contract with a test 1Click key, one token plan paying r0 and r1 100 USD each, and
    /// r0 registered for Base USDC, r1 for Solana USDC.
    fn setup() -> (Contract, SigningKey, Plan) {
        let mut c = new_contract();
        let signer = SigningKey::generate(&mut rand::rngs::OsRng);
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        c.set_config(None, None, None, Some(format!("ed25519:{}", bs58::encode(signer.verifying_key().to_bytes()).into_string())), None);
        testing_env!(ctx(recipient(0), NEAR / 10, 1_000).build());
        c.register_destination(BASE_USDC.into(), BASE_ADDR.into());
        testing_env!(ctx(recipient(1), NEAR / 10, 1_000).build());
        c.register_destination(SOL_USDC.into(), SOL_ADDR.into());
        let mut plan_input = input(3600, &[100 * USD, 100 * USD]);
        plan_input.asset = Asset::Ft { contract: token() };
        let msg = near_sdk::serde_json::to_string(&FtMessage::CreatePlan { plan: plan_input }).unwrap();
        testing_env!(ctx(token(), 0, 1_000).build());
        let _ = c.ft_on_transfer(dao(), U128(300 * USD), msg);
        let plan = c.get_plan(1).unwrap();
        assert_eq!(plan.asset, Asset::Ft { contract: token() });
        (c, signer, plan)
    }

    fn origin() -> String {
        format!("nep141:{}", token())
    }

    #[test]
    fn evm_destination_matches_regardless_of_case() {
        let (c, signer, plan) = setup();
        let r0 = &plan.recipients[0];
        for addr in [BASE_ADDR.to_string(), BASE_ADDR.to_lowercase(), format!("0x{}", BASE_ADDR[2..].to_uppercase())] {
            let quote = signed_quote(&signer, &origin(), BASE_USDC, 100 * USD, &addr, r0.account_id.as_str());
            let route = c.verify_route(&plan, r0, &quote, 1_000);
            assert_eq!(route.destination_address, addr);
            assert_eq!(route.destination_asset, BASE_USDC);
        }
    }

    #[test]
    fn solana_destination_matches_exactly() {
        let (c, signer, plan) = setup();
        let r1 = &plan.recipients[1];
        let quote = signed_quote(&signer, &origin(), SOL_USDC, 100 * USD, SOL_ADDR, r1.account_id.as_str());
        let route = c.verify_route(&plan, r1, &quote, 1_000);
        assert_eq!(route.destination_address, SOL_ADDR);
        assert_eq!(route.destination_asset, SOL_USDC);
    }

    #[test]
    #[should_panic(expected = "Route recipient address differs from the recipient's registration")]
    fn solana_destination_with_different_case_is_refused() {
        let (c, signer, plan) = setup();
        let r1 = &plan.recipients[1];
        let quote = signed_quote(&signer, &origin(), SOL_USDC, 100 * USD, &SOL_ADDR.to_lowercase(), r1.account_id.as_str());
        c.verify_route(&plan, r1, &quote, 1_000);
    }

    #[test]
    #[should_panic(expected = "Route recipient address differs from the recipient's registration")]
    fn evm_destination_for_other_address_is_refused() {
        let (c, signer, plan) = setup();
        let r0 = &plan.recipients[0];
        let quote = signed_quote(&signer, &origin(), BASE_USDC, 100 * USD, "0x1111111111111111111111111111111111111111", r0.account_id.as_str());
        c.verify_route(&plan, r0, &quote, 1_000);
    }

    #[test]
    #[should_panic(expected = "quoteRequest.swapType must be EXACT_INPUT")]
    fn exact_output_quotes_are_refused() {
        let (c, signer, plan) = setup();
        let r0 = &plan.recipients[0];
        let quote = signed_quote(&signer, &origin(), BASE_USDC, 100 * USD, BASE_ADDR, r0.account_id.as_str())
            .replace("\"swapType\":\"EXACT_INPUT\"", "\"swapType\":\"EXACT_OUTPUT\"");
        c.verify_route(&plan, r0, &quote, 1_000);
    }
}

#[test]
fn guardian_can_pause_but_not_resume() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 5 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    let guardian: AccountId = "council1.test.near".parse().unwrap();
    c.set_guardians(id, vec![guardian.clone()]);
    assert_eq!(c.get_guardians(id), vec![guardian.clone()]);
    assert!(get_logs().iter().any(|l| l.contains("guardians_set")));

    testing_env!(ctx(guardian.clone(), 0, 1_001).build());
    c.pause_plan(id);
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Paused);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("plan_paused") && l.contains("council1.test.near")));

    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resume_plan(id, None)));
    assert!(res.is_err(), "a guardian must not be able to resume");

    testing_env!(ctx(dao(), 0, 1_002).build());
    c.resume_plan(id, Some(true));
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Active);
    c.set_guardians(id, vec![]);
    assert!(c.get_guardians(id).is_empty());
}

#[test]
#[should_panic(expected = "Only the plan owner or a guardian can pause")]
fn stranger_cannot_pause() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 5 * NEAR, 1_000).build());
    let id = c.create_plan(input(3600, &[NEAR]));
    testing_env!(ctx(recipient(0), 0, 1_001).build());
    c.pause_plan(id);
}

#[test]
fn guardians_can_come_with_the_plan_input() {
    let mut c = new_contract();
    testing_env!(ctx(dao(), 5 * NEAR, 1_000).build());
    let mut inp = input(3600, &[NEAR]);
    let g: AccountId = "council2.test.near".parse().unwrap();
    inp.guardians = Some(vec![g.clone()]);
    let id = c.create_plan(inp);
    assert_eq!(c.get_guardians(id), vec![g]);
}

// ───────────── regression tests for the Nov 9 review findings ─────────────
mod review_fixes {
    use super::*;
    use near_sdk::PromiseError;

    fn signed_route(signer: &ed25519_dalek::SigningKey, origin_asset: &str, amount: u128, refund_to: &str, deposit: &str) -> String {
        use ed25519_dalek::Signer;
        use near_sdk::serde_json::json;
        let request = json!({"dry": false, "swapType": "EXACT_INPUT", "slippageTolerance": 100, "originAsset": origin_asset, "depositType": "ORIGIN_CHAIN",
            "destinationAsset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "amount": amount.to_string(), "refundTo": refund_to,
            "refundType": "ORIGIN_CHAIN", "recipient": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "recipientType": "DESTINATION_CHAIN", "deadline": "2026-11-09T06:00:00.000Z"});
        let quote = json!({"amountIn": amount.to_string(), "amountOut": amount.to_string(), "minAmountOut": amount.to_string(),
            "deadline": "2026-11-12T06:00:00.000Z", "depositAddress": deposit});
        let ts = "2026-11-08T20:25:36.811Z";
        let msg = crate::routes::signed_message(&request, &quote, ts).unwrap();
        let sig = format!("ed25519:{}", bs58::encode(signer.sign(msg.as_bytes()).to_bytes()).into_string());
        json!({"quote": quote, "quoteRequest": request, "signature": sig, "timestamp": ts}).to_string()
    }

    fn panics<F: FnOnce()>(f: F) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    #[test]
    fn allowlist_blocks_fake_token_plans_and_protects_credits() {
        let mut c = new_contract();
        let usdc: AccountId = "usdc.test.near".parse().unwrap();
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        c.set_config(Some(false), None, None, None, Some(vec![usdc.clone()]));
        assert_eq!(c.get_config().allowed_tokens, Some(vec![usdc.clone()]));
        testing_env!(ctx(dao(), NEAR, 1_000).build());
        c.storage_deposit(None);
        let before = c.storage_credit_of(dao()).0;
        let evil: AccountId = "evil.test.near".parse().unwrap();
        let mut p = input(3600, &[1]);
        p.asset = Asset::Ft { contract: evil.clone() };
        let msg = near_sdk::serde_json::to_string(&FtMessage::CreatePlan { plan: p.clone() }).unwrap();
        testing_env!(ctx(evil.clone(), 0, 1_000).build());
        assert!(panics(|| { let _ = c.ft_on_transfer(dao(), U128(1), msg.clone()); }), "fake token must be refused");
        // Same for a zero-balance token plan created directly and then "funded" by the fake token.
        testing_env!(ctx(evil.clone(), NEAR, 1_000).build());
        assert!(panics(|| { c.create_plan(p.clone()); }));
        assert_eq!(c.storage_credit_of(dao()).0, before);
        assert!(c.get_plans_by_owner(dao()).is_empty());
    }

    #[test]
    #[should_panic(expected = "Attach at least")]
    fn storage_deposit_requires_a_minimum() {
        let mut c = new_contract();
        testing_env!(ctx(accounts(5), 0, 1_000).build());
        c.storage_deposit(Some("victim.test.near".parse().unwrap()));
    }

    #[test]
    fn payout_storage_is_charged_to_the_plan_owner() {
        // No credits and no sponsorship: the run is refused instead of eating contract balance.
        let mut c = new_contract();
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        c.set_config(Some(false), None, None, None, None);
        testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
        let id = c.create_plan(input(3600, &[NEAR, NEAR]));
        testing_env!(ctx(accounts(5), 0, 1_000).build());
        assert!(panics(|| { c.run_due(id, None); }), "run without storage credits must be refused");
    }

    #[test]
    fn payout_storage_comes_out_of_the_owner_credits() {
        let mut c = new_contract();
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        c.set_config(Some(false), None, None, None, None);
        testing_env!(ctx(dao(), 10 * NEAR, 1_000).build());
        let id = c.create_plan(input(3600, &[NEAR, NEAR]));
        testing_env!(ctx(dao(), NEAR / 10, 1_000).build());
        c.storage_deposit(None);
        let before = c.storage_credit_of(dao()).0;
        testing_env!(ctx(accounts(5), 0, 1_000).build());
        assert!(matches!(c.run_due(id, None), RunOutcome::Sent { completed: true, .. }));
        let after = c.storage_credit_of(dao()).0;
        assert!(after < before, "payout records must be paid from the owner's credits ({} -> {})", before, after);
    }

    #[test]
    fn creation_back_pay_is_limited_to_one_interval() {
        let mut c = new_contract();
        let mut p = input(60, &[1]);
        p.start_at = Some(0);
        testing_env!(ctx(dao(), NEAR, 1_000_000).build());
        assert!(panics(|| { c.create_plan(p.clone()); }));
        p.start_at = Some(1_000_000 - 30); // within one interval: fine
        c.create_plan(p);
    }

    #[test]
    fn owner_can_cancel_a_plan_paused_mid_run_and_skip_lands_on_the_next_slot() {
        // Part 1: cancel while paused mid-run is allowed and records the aborted run.
        let mut c = new_contract();
        testing_env!(ctx(dao(), 100 * NEAR, 1_000).build());
        let id = c.create_plan(input(3600, &vec![NEAR / 10; 40]));
        let mut b = ctx(accounts(5), 0, 1_000);
        b.prepaid_gas(Gas::from_tgas(80));
        testing_env!(b.build());
        c.run_due(id, None);
        assert!(c.get_plan(id).unwrap().run_cursor.is_some());
        testing_env!(ctx(dao(), 0, 1_100).build());
        c.pause_plan(id);
        c.cancel_plan(id);
        assert!(get_logs().iter().any(|l| l.contains("run_aborted")));
        let p = c.get_plan(id).unwrap();
        assert_eq!(p.status, PlanStatus::Cancelled);
        assert!(p.run_cursor.is_none());

        // Part 2: resume with skip_missed after a mid-run pause keeps the schedule aligned.
        let mut c = new_contract();
        testing_env!(ctx(dao(), 100 * NEAR, 1_000).build());
        let id = c.create_plan(input(3600, &vec![NEAR / 10; 40]));
        let mut b = ctx(accounts(5), 0, 1_000);
        b.prepaid_gas(Gas::from_tgas(80));
        testing_env!(b.build());
        c.run_due(id, None);
        testing_env!(ctx(dao(), 0, 1_100).build());
        c.pause_plan(id);
        testing_env!(ctx(dao(), 0, 8_210).build());
        c.resume_plan(id, Some(true));
        while c.get_plan(id).unwrap().run_cursor.is_some() {
            testing_env!(ctx(accounts(5), 0, 8_210).build());
            c.run_due(id, None);
        }
        assert_eq!(c.get_plan(id).unwrap().next_run_at, 11_800, "next payday is the next aligned slot");
    }

    #[test]
    fn a_signed_quote_cannot_be_replayed_and_duplicate_recipients_are_refused() {
        let mut c = new_contract();
        let signer = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        c.set_config(None, None, None, Some(format!("ed25519:{}", bs58::encode(signer.verifying_key().to_bytes()).into_string())), None);
        let r0 = recipient(0);
        testing_env!(ctx(r0.clone(), NEAR / 10, 1_000).build());
        c.register_destination("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".into(), "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".into());
        let token: AccountId = accounts(3);

        let mut dup = input(3600, &[100]);
        dup.recipients.push(Recipient { account_id: r0.clone(), amount: U128(100) });
        dup.asset = Asset::Ft { contract: token.clone() };
        testing_env!(ctx(token.clone(), 0, 1_000).build());
        let dup_msg = near_sdk::serde_json::to_string(&FtMessage::CreatePlan { plan: dup }).unwrap();
        assert!(panics(|| { let _ = c.ft_on_transfer(dao(), U128(1000), dup_msg.clone()); }), "duplicate recipient must be refused");

        let mut p = input(3600, &[100]);
        p.asset = Asset::Ft { contract: token.clone() };
        testing_env!(ctx(token.clone(), 0, 1_000).build());
        let _ = c.ft_on_transfer(dao(), U128(1000), near_sdk::serde_json::to_string(&FtMessage::CreatePlan { plan: p }).unwrap());
        let q = signed_route(&signer, &format!("nep141:{}", token), 100, r0.as_str(), "702bb1cdf6e6d1f80776679b6e0f2745226efd76cda7563fe0f45ee1d1929d87");
        let routes = vec![QuotedRoute { recipient: r0.clone(), quote: q }];
        testing_env!(ctx(accounts(5), 0, 1_000).build());
        c.run_due(1, Some(routes.clone()));
        testing_env!(ctx(accounts(5), 0, 4_600).build());
        assert!(panics(|| { c.run_due(1, Some(routes.clone())); }), "the same deposit address must not be paid twice");
        // A fresh quote (new deposit address) works.
        let q2 = signed_route(&signer, &format!("nep141:{}", token), 100, r0.as_str(), "0b0f1ee3d1e0c0ffee0000000000000000000000000000000000000000000001");
        testing_env!(ctx(accounts(5), 0, 4_600).build());
        assert!(matches!(c.run_due(1, Some(vec![QuotedRoute { recipient: r0.clone(), quote: q2 }])), RunOutcome::Sent { .. }));
    }

    #[test]
    fn oversized_intervals_are_refused() {
        let mut c = new_contract();
        testing_env!(ctx(dao(), 100 * NEAR, 1_000).build());
        assert!(panics(|| { c.create_plan(input(u64::MAX - 10, &[NEAR])); }));
        let id = c.create_plan(input(3600, &[NEAR]));
        assert!(panics(|| c.update_plan(id, PlanUpdate { interval_seconds: Some(u64::MAX), ..Default::default() })));
    }

    #[test]
    fn guardian_storage_is_included_in_the_creation_charge() {
        let mut c = new_contract();
        let mut inp = input(3600, &[NEAR]);
        inp.guardians = Some((0..10).map(|i| format!("{}{}.test.near", "g".repeat(50), i).parse().unwrap()).collect());
        testing_env!(ctx(dao(), 5 * NEAR, 1_000).build());
        let s0 = env::storage_usage();
        let id = c.create_plan(inp);
        let charged = 5 * NEAR - c.get_plan(id).unwrap().balance.0;
        c.guardians.flush();
        let written = env::storage_usage() - s0;
        assert_eq!(charged / env::storage_byte_cost().as_yoctonear(), written as u128, "every byte written is charged");
    }

    #[test]
    fn failed_sweep_emits_an_event() {
        let mut c = new_contract();
        let token: AccountId = accounts(3);
        let mut p = input(3600, &[100]);
        p.asset = Asset::Ft { contract: token.clone() };
        testing_env!(ctx(token.clone(), 0, 1_000).build());
        let _ = c.ft_on_transfer(dao(), U128(1000), near_sdk::serde_json::to_string(&FtMessage::CreatePlan { plan: p }).unwrap());
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        c.on_sweep(1, U128(400), Err(PromiseError::Failed));
        assert!(get_logs().iter().any(|l| l.contains("sweep_failed")));
    }
}
