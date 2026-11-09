//! NEP-297 events: `EVENT_JSON:{"standard":"standing_order","version":"1.0.0","event":...,"data":[...]}`
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

const STANDARD: &str = "standing_order";
const VERSION: &str = "1.0.0";

fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

pub fn plan_created(plan_id: u64, owner: &AccountId, total_per_run: u128, interval_seconds: u64, next_run_at: u64) {
    emit(
        "plan_created",
        json!({
            "plan_id": plan_id,
            "owner": owner,
            "total_per_run": total_per_run.to_string(),
            "interval_seconds": interval_seconds,
            "next_run_at": next_run_at,
        }),
    );
}

pub fn plan_funded(plan_id: u64, from: &AccountId, amount: u128, balance: u128) {
    emit(
        "plan_funded",
        json!({"plan_id": plan_id, "from": from, "amount": amount.to_string(), "balance": balance.to_string()}),
    );
}

pub fn payout_dispatched(plan_id: u64, seq: u32, run_index: u32, recipient: &AccountId, amount: u128) {
    emit(
        "payout_dispatched",
        json!({"plan_id": plan_id, "seq": seq, "run_index": run_index, "recipient": recipient, "amount": amount.to_string()}),
    );
}

pub fn payout_sent(plan_id: u64, seq: u32, recipient: &AccountId, amount: u128) {
    emit(
        "payout_sent",
        json!({"plan_id": plan_id, "seq": seq, "recipient": recipient, "amount": amount.to_string()}),
    );
}

pub fn payout_failed(plan_id: u64, seq: u32, recipient: &AccountId, amount: u128) {
    emit(
        "payout_failed",
        json!({"plan_id": plan_id, "seq": seq, "recipient": recipient, "amount": amount.to_string()}),
    );
}

pub fn run_completed(plan_id: u64, run_index: u32, total: u128, next_run_at: u64, balance: u128) {
    emit(
        "run_completed",
        json!({
            "plan_id": plan_id,
            "run_index": run_index,
            "total": total.to_string(),
            "next_run_at": next_run_at,
            "balance": balance.to_string(),
        }),
    );
}

pub fn plan_underfunded(plan_id: u64, needed: u128, balance: u128) {
    emit(
        "plan_underfunded",
        json!({"plan_id": plan_id, "needed": needed.to_string(), "balance": balance.to_string()}),
    );
}

pub fn plan_status(event: &str, plan_id: u64, by: &AccountId) {
    emit(event, json!({"plan_id": plan_id, "by": by}));
}

pub fn guardians_set(plan_id: u64, by: &AccountId, guardians: &[AccountId]) {
    emit("guardians_set", json!({"plan_id": plan_id, "by": by, "guardians": guardians}));
}

pub fn sweep_failed(plan_id: u64, amount: u128, balance: u128) {
    emit("sweep_failed", json!({"plan_id": plan_id, "amount": amount.to_string(), "balance": balance.to_string()}));
}

pub fn run_aborted(plan_id: u64, run_index: u32, paid: u32, unpaid: u32) {
    emit("run_aborted", json!({"plan_id": plan_id, "run_index": run_index, "paid": paid, "unpaid": unpaid}));
}

pub fn plan_swept(plan_id: u64, to: &AccountId, amount: u128, balance: u128) {
    emit(
        "plan_swept",
        json!({"plan_id": plan_id, "to": to, "amount": amount.to_string(), "balance": balance.to_string()}),
    );
}

pub fn payout_routed(plan_id: u64, seq: u32, recipient: &AccountId, deposit_address: &AccountId, destination_asset: &str, destination_address: &str, amount_out: u128) {
    emit(
        "payout_routed",
        json!({
            "plan_id": plan_id,
            "seq": seq,
            "recipient": recipient,
            "deposit_address": deposit_address,
            "destination_asset": destination_asset,
            "destination_address": destination_address,
            "amount_out": amount_out.to_string(),
        }),
    );
}

pub fn destination_set(account: &AccountId, asset_id: &str, address: &str) {
    emit("destination_set", json!({"account": account, "asset_id": asset_id, "address": address}));
}

pub fn destination_cleared(account: &AccountId) {
    emit("destination_cleared", json!({"account": account}));
}

/// The admin-tunable part of the contract config, as it appears in `config_updated`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigSnapshot {
    pub oneclick_public_key: String,
    pub sponsor_storage: bool,
    pub min_interval_seconds: u64,
    pub max_recipients: u32,
    pub allowed_tokens: Option<Vec<AccountId>>,
}

impl ConfigSnapshot {
    fn to_json(&self) -> Value {
        json!({
            "oneclick_public_key": self.oneclick_public_key,
            "allowed_tokens": self.allowed_tokens,
            "sponsor_storage": self.sponsor_storage,
            "min_interval_seconds": self.min_interval_seconds,
            "max_recipients": self.max_recipients,
        })
    }
}

pub fn config_updated(by: &AccountId, old: &ConfigSnapshot, new: &ConfigSnapshot) {
    emit("config_updated", json!({"by": by, "old": old.to_json(), "new": new.to_json()}));
}

pub fn storage_credited(account: &AccountId, amount: u128, credit: u128) {
    emit(
        "storage_credited",
        json!({"account": account, "amount": amount.to_string(), "credit": credit.to_string()}),
    );
}
