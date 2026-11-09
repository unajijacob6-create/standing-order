//! Standing Order: recurring payroll and scheduled payouts for Sputnik DAO treasuries on NEAR.
//!
//! A treasury (normally a Sputnik DAO) creates and funds a plan once. Afterwards anyone, usually a
//! keeper holding a function-call key limited to `run_due`, can trigger the next scheduled run.
//! Only the plan owner can pause, resume, update, cancel or sweep.

mod events;
pub mod routes;
pub mod types;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub use types::*;

/// Gas budgeted for one native NEAR payout (transfer + callback).
const GAS_PER_NEAR_PAYOUT: Gas = Gas::from_tgas(10);
/// Gas budgeted for one fungible-token payout (ft_transfer + callback).
const GAS_PER_FT_PAYOUT: Gas = Gas::from_tgas(40);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(5);
/// Extra gas budgeted per payout when signed 1Click quotes must be verified.
const GAS_ROUTE_VERIFY: Gas = Gas::from_tgas(15);
/// Gas kept back after the last payout of a call for bookkeeping.
const GAS_RESERVE: Gas = Gas::from_tgas(20);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Longest allowed interval (10 years); keeps schedule arithmetic far from overflow.
const MAX_INTERVAL_SECONDS: u64 = 10 * 365 * 24 * 3600;
/// Smallest storage_deposit accepted (the NEP-145 convention of 0.00125 NEAR).
const MIN_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Plans,
    PlansByOwner,
    Payouts,
    StorageCredits,
    Destinations,
    Routes,
    Guardians,
    UsedDepositAddresses,
}

/// State layout before the token allowlist and quote-replay guard (v0.3). Used by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV3 {
    owner_id: AccountId,
    plans: IterableMap<u64, Plan>,
    plans_by_owner: LookupMap<AccountId, Vec<u64>>,
    payouts: LookupMap<(u64, u32), PayoutRecord>,
    storage_credits: LookupMap<AccountId, u128>,
    next_plan_id: u64,
    sponsor_storage: bool,
    min_interval_seconds: u64,
    max_recipients: u32,
    destinations: LookupMap<AccountId, Destination>,
    routes: LookupMap<(u64, u32), RouteRecord>,
    oneclick_public_key: [u8; 32],
    guardians: LookupMap<u64, Vec<AccountId>>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    plans: IterableMap<u64, Plan>,
    plans_by_owner: LookupMap<AccountId, Vec<u64>>,
    /// (plan_id, seq) -> record
    payouts: LookupMap<(u64, u32), PayoutRecord>,
    /// NEAR prepaid for storage by an account (used when plans arrive via ft_transfer_call).
    storage_credits: LookupMap<AccountId, u128>,
    next_plan_id: u64,
    /// When true the contract pays storage for plans created through `ft_on_transfer`
    /// if the sender has no credits. Handy for demos; turn off in production.
    sponsor_storage: bool,
    min_interval_seconds: u64,
    max_recipients: u32,
    /// Recipient-registered cross-chain payout destinations.
    destinations: LookupMap<AccountId, Destination>,
    /// (plan_id, seq) -> verified 1Click route used for that payout.
    routes: LookupMap<(u64, u32), RouteRecord>,
    /// Key that signs 1Click quotes. Owner-updatable in case 1Click rotates it.
    oneclick_public_key: [u8; 32],
    /// Accounts the plan owner (the DAO) lets pause a plan without a vote: an emergency kill
    /// switch. Only the owner can resume, update, cancel or sweep.
    guardians: LookupMap<u64, Vec<AccountId>>,
    /// Token contracts that may fund plans. `None` accepts any token (local testing only); the
    /// live deployments set it, because any account can call `ft_on_transfer` and claim to be a token.
    allowed_tokens: Option<Vec<AccountId>>,
    /// 1Click deposit addresses already paid, so one signed quote can never be used twice.
    used_deposit_addresses: LookupSet<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, sponsor_storage: bool, min_interval_seconds: Option<u64>, allowed_tokens: Option<Vec<AccountId>>) -> Self {
        Self {
            owner_id,
            plans: IterableMap::new(StorageKey::Plans),
            plans_by_owner: LookupMap::new(StorageKey::PlansByOwner),
            payouts: LookupMap::new(StorageKey::Payouts),
            storage_credits: LookupMap::new(StorageKey::StorageCredits),
            next_plan_id: 1,
            sponsor_storage,
            min_interval_seconds: min_interval_seconds.unwrap_or(60),
            max_recipients: 100,
            destinations: LookupMap::new(StorageKey::Destinations),
            routes: LookupMap::new(StorageKey::Routes),
            oneclick_public_key: routes::decode_public_key(routes::ONE_CLICK_MANAGER_PUB_KEY).expect("key"),
            guardians: LookupMap::new(StorageKey::Guardians),
            allowed_tokens,
            used_deposit_addresses: LookupSet::new(StorageKey::UsedDepositAddresses),
        }
    }

    /// Upgrade state from v0.1 (no cross-chain routes). Only the contract account can call it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV3 = env::state_read().expect("no previous state");
        // Allow exactly the tokens existing plans already use, so nothing live breaks.
        let mut tokens: Vec<AccountId> = Vec::new();
        for (_, plan) in old.plans.iter() {
            if let Asset::Ft { contract } = &plan.asset {
                if !tokens.contains(contract) {
                    tokens.push(contract.clone());
                }
            }
        }
        Self {
            owner_id: old.owner_id,
            plans: old.plans,
            plans_by_owner: old.plans_by_owner,
            payouts: old.payouts,
            storage_credits: old.storage_credits,
            next_plan_id: old.next_plan_id,
            sponsor_storage: old.sponsor_storage,
            min_interval_seconds: old.min_interval_seconds,
            max_recipients: old.max_recipients,
            destinations: old.destinations,
            routes: old.routes,
            oneclick_public_key: old.oneclick_public_key,
            guardians: old.guardians,
            allowed_tokens: Some(tokens),
            used_deposit_addresses: LookupSet::new(StorageKey::UsedDepositAddresses),
        }
    }

    // ───────────────────────────── plan lifecycle ─────────────────────────────

    /// Create a plan owned by the caller. The attached deposit pays for storage; for native NEAR
    /// plans the remainder becomes the plan balance, for token plans it is refunded.
    #[payable]
    pub fn create_plan(&mut self, plan: PlanInput) -> u64 {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();
        let (plan_id, asset) = self.insert_plan(owner.clone(), plan, 0);
        let storage_cost = self.storage_cost_since(before);
        require!(
            deposit >= storage_cost,
            format!("Attach at least {} yoctoNEAR for storage", storage_cost)
        );
        let rest = deposit - storage_cost;
        if rest > 0 {
            match asset {
                Asset::Near => {
                    let plan = self.plans.get_mut(&plan_id).expect("plan");
                    plan.balance = U128(rest);
                    events::plan_funded(plan_id, &owner, rest, rest);
                }
                Asset::Ft { .. } => {
                    Promise::new(owner).transfer(NearToken::from_yoctonear(rest)).detach();
                }
            }
        }
        plan_id
    }

    /// Add native NEAR to a native-asset plan.
    #[payable]
    pub fn fund_plan(&mut self, plan_id: u64) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach the amount to add");
        let from = env::predecessor_account_id();
        let plan = self.plans.get_mut(&plan_id).expect("Plan not found");
        require!(plan.asset == Asset::Near, "Plan is not funded in NEAR; use ft_transfer_call");
        require!(plan.status != PlanStatus::Cancelled, "Plan is cancelled");
        plan.balance = U128(plan.balance.0.checked_add(amount).expect("overflow"));
        plan.updated_at = Self::now();
        let balance = plan.balance.0;
        events::plan_funded(plan_id, &from, amount, balance);
    }

    /// Execute the next due run (or continue a run in progress). Permissionless.
    /// Call with up to 300 TGas; large recipient lists are paid over several calls.
    ///
    /// `routes` optionally carries signed 1Click quotes for recipients who registered a
    /// cross-chain destination. Each quote is verified against the 1Click key and bound to the
    /// recipient's registered asset/address, the plan token and the exact payout amount, with the
    /// recipient's own account as the refund target. Only then is the payout sent to the quote's
    /// deposit address instead of the recipient's NEAR account.
    pub fn run_due(&mut self, plan_id: u64, routes: Option<Vec<QuotedRoute>>) -> RunOutcome {
        let now = Self::now();
        let mut plan = self.plans.get(&plan_id).expect("Plan not found").clone();
        let routes = routes.unwrap_or_default();

        match plan.status {
            PlanStatus::Paused => return RunOutcome::Paused,
            PlanStatus::Cancelled => return RunOutcome::Cancelled,
            PlanStatus::Active => {}
        }

        let total = plan.total_per_run();
        if plan.run_cursor.is_none() {
            if plan.is_ended() {
                return RunOutcome::Ended;
            }
            if now < plan.next_run_at {
                return RunOutcome::NotDue { next_run_at: plan.next_run_at };
            }
            require!(total <= plan.cap_per_run.0, "Run total exceeds cap_per_run");
            if plan.balance.0 < total {
                events::plan_underfunded(plan_id, total, plan.balance.0);
                return RunOutcome::Underfunded { needed: U128(total), balance: plan.balance };
            }
            plan.run_cursor = Some(0);
        }

        let mut gas_per_payout = match plan.asset {
            Asset::Near => GAS_PER_NEAR_PAYOUT,
            Asset::Ft { .. } => GAS_PER_FT_PAYOUT,
        };
        if !routes.is_empty() {
            gas_per_payout = Gas::from_gas(gas_per_payout.as_gas() + GAS_ROUTE_VERIFY.as_gas());
        }
        let storage_before = env::storage_usage();
        let run_index = plan.runs_completed;
        let len = plan.recipients.len() as u32;
        let mut cursor = plan.run_cursor.unwrap_or(0);
        let mut sent = 0u32;

        while cursor < len {
            let remaining_gas = env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas());
            if remaining_gas < gas_per_payout.as_gas() + GAS_RESERVE.as_gas() {
                require!(sent > 0, "Not enough gas to pay a single recipient; attach more gas");
                break;
            }
            let recipient = plan.recipients[cursor as usize].clone();
            let amount = recipient.amount.0;
            // Cross-chain: pay the verified 1Click deposit address instead of the NEAR account.
            let route = routes
                .iter()
                .find(|r| r.recipient == recipient.account_id)
                .map(|r| self.verify_route(&plan, &recipient, &r.quote, now));
            let pay_to = route.as_ref().map(|r| r.deposit_address.clone()).unwrap_or_else(|| recipient.account_id.clone());
            // Debit first; a failed transfer re-credits in the callback.
            plan.balance = U128(plan.balance.0.checked_sub(amount).expect("balance underflow"));
            let seq = plan.payout_count;
            plan.payout_count += 1;
            if let Some(r) = &route {
                require!(self.used_deposit_addresses.insert(r.deposit_address.clone()), "Route deposit address was already used; fetch a fresh quote");
                self.routes.insert((plan_id, seq), r.clone());
                events::payout_routed(plan_id, seq, &recipient.account_id, &r.deposit_address, &r.destination_asset, &r.destination_address, r.amount_out.0);
            }
            self.payouts.insert(
                (plan_id, seq),
                PayoutRecord {
                    plan_id,
                    seq,
                    run_index,
                    recipient: recipient.account_id.clone(),
                    amount: U128(amount),
                    status: PayoutStatus::Pending,
                    timestamp: now,
                    block_height: env::block_height(),
                },
            );
            events::payout_dispatched(plan_id, seq, run_index, &recipient.account_id, amount);
            self.dispatch_transfer(&plan.asset, &pay_to, amount, plan_id, seq);
            cursor += 1;
            sent += 1;
        }

        let completed = cursor >= len;
        if completed {
            plan.run_cursor = None;
            plan.runs_completed += 1;
            plan.next_run_at = plan.next_run_at.checked_add(plan.interval_seconds).expect("schedule overflow");
            events::run_completed(plan_id, run_index, total, plan.next_run_at, plan.balance.0);
        } else {
            plan.run_cursor = Some(cursor);
        }
        plan.updated_at = now;
        let owner = plan.owner.clone();
        self.plans.insert(plan_id, plan);
        // Payout and route records are paid for by the plan owner's storage credits (or sponsored),
        // never silently out of the contract balance that holds NEAR plans' funds.
        self.routes.flush();
        let cost = self.storage_cost_since(storage_before);
        self.charge_storage(&owner, cost);

        RunOutcome::Sent { run_index, sent, remaining: len - cursor, completed }
    }

    /// Callback after each payout transfer.
    #[private]
    pub fn on_payout(
        &mut self,
        plan_id: u64,
        seq: u32,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let record = self.payouts.get_mut(&(plan_id, seq)).expect("payout record");
        if result.is_ok() {
            record.status = PayoutStatus::Sent;
            events::payout_sent(plan_id, seq, &record.recipient, amount.0);
        } else {
            record.status = PayoutStatus::Failed;
            let recipient = record.recipient.clone();
            let plan = self.plans.get_mut(&plan_id).expect("plan");
            plan.balance = U128(plan.balance.0.checked_add(amount.0).expect("overflow"));
            events::payout_failed(plan_id, seq, &recipient, amount.0);
        }
    }

    /// Pause a plan. The owner can always pause; so can any guardian the owner named
    /// (`set_guardians` or `guardians` in the plan input), which gives a single council member an
    /// emergency stop without waiting for a vote. Resuming needs the owner.
    pub fn pause_plan(&mut self, plan_id: u64) {
        let by = env::predecessor_account_id();
        let is_guardian = self.guardians.get(&plan_id).map(|g| g.contains(&by)).unwrap_or(false);
        let plan = self.plans.get_mut(&plan_id).expect("Plan not found");
        require!(plan.owner == by || is_guardian, "Only the plan owner or a guardian can pause");
        require!(plan.status == PlanStatus::Active, "Plan is not active");
        plan.status = PlanStatus::Paused;
        plan.updated_at = Self::now();
        events::plan_status("plan_paused", plan_id, &by);
    }

    /// Resume a paused plan. By default missed periods are paid as back pay, one per `run_due`
    /// call; pass `skip_missed: true` to forget them and continue from the next scheduled slot.
    pub fn resume_plan(&mut self, plan_id: u64, skip_missed: Option<bool>) {
        let by = env::predecessor_account_id();
        let now = Self::now();
        let plan = self.owned_plan_mut(&plan_id);
        require!(plan.status == PlanStatus::Paused, "Plan is not paused");
        plan.status = PlanStatus::Active;
        if skip_missed.unwrap_or(false) && now >= plan.next_run_at {
            let periods = (now - plan.next_run_at) / plan.interval_seconds + 1;
            let target = periods
                .checked_mul(plan.interval_seconds)
                .and_then(|d| plan.next_run_at.checked_add(d))
                .expect("schedule overflow");
            // If a run was interrupted by the pause, finishing it adds one interval, so aim one short.
            plan.next_run_at = if plan.run_cursor.is_some() { target - plan.interval_seconds } else { target };
        }
        plan.updated_at = now;
        events::plan_status("plan_resumed", plan_id, &by);
    }

    // ───────────────────────────── cross-chain destinations ─────────────────────────────

    /// A recipient declares where cross-chain payouts should land. `asset_id` is a NEAR Intents
    /// asset id (see https://1click.chaindefuser.com/v0/tokens), `address` the recipient's
    /// address on that chain. Attach a little NEAR for storage; the excess is refunded.
    #[payable]
    pub fn register_destination(&mut self, asset_id: String, address: String) {
        let who = env::predecessor_account_id();
        require!(asset_id.starts_with("nep141:") && asset_id.len() <= 128, "asset_id must be a NEAR Intents asset id");
        require!(!address.is_empty() && address.len() <= 128, "address required");
        let deposit = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();
        self.destinations.insert(who.clone(), Destination { asset_id: asset_id.clone(), address: address.clone(), updated_at: Self::now() });
        self.destinations.flush();
        let cost = env::storage_byte_cost().as_yoctonear() * env::storage_usage().saturating_sub(before) as u128;
        require!(deposit >= cost, format!("Attach at least {} yoctoNEAR for storage", cost));
        if deposit > cost {
            Promise::new(who.clone()).transfer(NearToken::from_yoctonear(deposit - cost)).detach();
        }
        events::destination_set(&who, &asset_id, &address);
    }

    /// Go back to being paid on NEAR.
    pub fn clear_destination(&mut self) {
        let who = env::predecessor_account_id();
        self.destinations.remove(&who);
        events::destination_cleared(&who);
    }

    /// Owner only: name the accounts that may pause this plan without a vote (at most 10).
    /// An empty list removes all guardians.
    pub fn set_guardians(&mut self, plan_id: u64, guardians: Vec<AccountId>) {
        let by = env::predecessor_account_id();
        self.owned_plan_mut(&plan_id);
        Self::validate_guardians(&guardians);
        let before = env::storage_usage();
        if guardians.is_empty() {
            self.guardians.remove(&plan_id);
        } else {
            self.guardians.insert(plan_id, guardians.clone());
        }
        let cost = self.storage_cost_since(before);
        self.charge_storage(&by, cost);
        events::guardians_set(plan_id, &by, &guardians);
    }

    pub fn get_guardians(&self, plan_id: u64) -> Vec<AccountId> {
        self.guardians.get(&plan_id).cloned().unwrap_or_default()
    }

    pub fn get_destination(&self, account_id: AccountId) -> Option<Destination> {
        self.destinations.get(&account_id).cloned()
    }

    /// Recipients of a plan who have a cross-chain destination, with it. The keeper quotes these.
    pub fn get_plan_destinations(&self, plan_id: u64) -> Vec<(AccountId, Destination)> {
        let Some(plan) = self.plans.get(&plan_id) else { return vec![] };
        plan.recipients
            .iter()
            .filter_map(|r| self.destinations.get(&r.account_id).map(|d| (r.account_id.clone(), d.clone())))
            .collect()
    }

    pub fn get_route(&self, plan_id: u64, seq: u32) -> Option<RouteRecord> {
        self.routes.get(&(plan_id, seq)).cloned()
    }

    /// Update recipients, cap, interval, title or end date. Not allowed mid-run.
    /// Attach a deposit covering any storage growth; the remainder is refunded.
    #[payable]
    pub fn update_plan(&mut self, plan_id: u64, update: PlanUpdate) {
        let by = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();
        let min_interval = self.min_interval_seconds;
        let max_recipients = self.max_recipients;
        {
            let plan = self.owned_plan_mut(&plan_id);
            require!(plan.status != PlanStatus::Cancelled, "Plan is cancelled");
            Self::abort_run_if_paused(plan_id, plan);
            require!(plan.run_cursor.is_none(), "Cannot update a plan mid-run");
            if let Some(title) = update.title {
                require!(title.len() <= 120, "Title too long");
                plan.title = title;
            }
            if let Some(recipients) = update.recipients {
                Self::validate_recipients(&recipients, max_recipients);
                plan.recipients = recipients;
            }
            if let Some(cap) = update.cap_per_run {
                plan.cap_per_run = cap;
            }
            if let Some(interval) = update.interval_seconds {
                require!(interval >= min_interval, "interval_seconds below minimum");
                require!(interval <= MAX_INTERVAL_SECONDS, "interval_seconds above maximum");
                plan.interval_seconds = interval;
            }
            if update.clear_end_at.unwrap_or(false) {
                plan.end_at = None;
            } else if let Some(end) = update.end_at {
                plan.end_at = Some(end);
            }
            require!(plan.total_per_run() <= plan.cap_per_run.0, "Recipients total exceeds cap_per_run");
            plan.updated_at = Self::now();
        }
        let cost = self.storage_cost_since(before);
        require!(deposit >= cost, format!("Attach at least {} yoctoNEAR for storage", cost));
        if deposit > cost {
            Promise::new(by.clone()).transfer(NearToken::from_yoctonear(deposit - cost)).detach();
        }
        events::plan_status("plan_updated", plan_id, &by);
    }

    /// Stop the plan for good and return any remaining balance to the owner.
    pub fn cancel_plan(&mut self, plan_id: u64) -> Option<Promise> {
        let by = env::predecessor_account_id();
        {
            let plan = self.owned_plan_mut(&plan_id);
            require!(plan.status != PlanStatus::Cancelled, "Plan is already cancelled");
            Self::abort_run_if_paused(plan_id, plan);
            require!(plan.run_cursor.is_none(), "Cannot cancel a plan mid-run");
            plan.status = PlanStatus::Cancelled;
            plan.updated_at = Self::now();
        }
        events::plan_status("plan_cancelled", plan_id, &by);
        self.sweep_internal(plan_id, None)
    }

    /// Return funds to the owner without cancelling (e.g. a quarter-end true-up).
    pub fn sweep(&mut self, plan_id: u64, amount: Option<U128>) -> Option<Promise> {
        {
            let plan = self.owned_plan_mut(&plan_id);
            Self::abort_run_if_paused(plan_id, plan);
            require!(plan.run_cursor.is_none(), "Cannot sweep a plan mid-run");
        }
        self.sweep_internal(plan_id, amount.map(|a| a.0))
    }

    /// Callback for token sweeps: re-credit on failure.
    #[private]
    pub fn on_sweep(&mut self, plan_id: u64, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            let plan = self.plans.get_mut(&plan_id).expect("plan");
            plan.balance = U128(plan.balance.0.checked_add(amount.0).expect("overflow"));
            let balance = plan.balance.0;
            events::sweep_failed(plan_id, amount.0, balance);
        }
    }

    // ───────────────────────────── NEP-141 receiver ─────────────────────────────

    /// Receive fungible tokens from `ft_transfer_call` (this is what a Sputnik DAO `Transfer`
    /// proposal with a `msg` does). `msg` is JSON:
    /// `{"action":"fund_plan","plan_id":1}` or `{"action":"create_plan","plan":{...PlanInput}}`.
    /// Storage for a new plan is paid from the sender's storage credits, or sponsored when enabled.
    /// Any failure panics, which makes the token contract refund the full amount to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(amount.0 > 0, "Amount must be positive");
        let parsed: FtMessage = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| {
            env::panic_str("msg must be {\"action\":\"fund_plan\",\"plan_id\":N} or {\"action\":\"create_plan\",\"plan\":{...}}")
        });
        match parsed {
            FtMessage::FundPlan { plan_id } => {
                let plan = self.plans.get_mut(&plan_id).expect("Plan not found");
                require!(plan.asset == Asset::Ft { contract: token }, "Token does not match the plan asset");
                require!(plan.status != PlanStatus::Cancelled, "Plan is cancelled");
                plan.balance = U128(plan.balance.0.checked_add(amount.0).expect("overflow"));
                plan.updated_at = Self::now();
                let balance = plan.balance.0;
                events::plan_funded(plan_id, &sender_id, amount.0, balance);
            }
            FtMessage::CreatePlan { plan } => {
                require!(plan.asset == Asset::Ft { contract: token }, "plan.asset must be the token being transferred");
                let before = env::storage_usage();
                let (plan_id, _) = self.insert_plan(sender_id.clone(), plan, amount.0);
                let cost = self.storage_cost_since(before);
                self.charge_storage(&sender_id, cost);
                events::plan_funded(plan_id, &sender_id, amount.0, amount.0);
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    // ───────────────────────────── storage credits ─────────────────────────────

    /// Prepay storage for plans created through `ft_transfer_call`.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_STORAGE_DEPOSIT, format!("Attach at least {} yoctoNEAR", MIN_STORAGE_DEPOSIT));
        let current = self.storage_credits.get(&account).copied().unwrap_or(0);
        let updated = current + amount;
        self.storage_credits.insert(account.clone(), updated);
        events::storage_credited(&account, amount, updated);
        U128(updated)
    }

    pub fn storage_credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credits.get(&account_id).copied().unwrap_or(0))
    }

    // ───────────────────────────── admin ─────────────────────────────

    pub fn set_config(&mut self, sponsor_storage: Option<bool>, min_interval_seconds: Option<u64>, max_recipients: Option<u32>, oneclick_public_key: Option<String>, allowed_tokens: Option<Vec<AccountId>>) {
        let by = env::predecessor_account_id();
        require!(by == self.owner_id, "Only the contract owner");
        let old = self.config_snapshot();
        if let Some(pk) = oneclick_public_key {
            self.oneclick_public_key = routes::decode_public_key(&pk).unwrap_or_else(|| env::panic_str("oneclick_public_key must be ed25519:<base58>"));
        }
        if let Some(v) = sponsor_storage {
            self.sponsor_storage = v;
        }
        if let Some(v) = min_interval_seconds {
            self.min_interval_seconds = v;
        }
        if let Some(v) = max_recipients {
            self.max_recipients = v;
        }
        if let Some(v) = allowed_tokens {
            self.allowed_tokens = Some(v);
        }
        events::config_updated(&by, &old, &self.config_snapshot());
    }

    fn config_snapshot(&self) -> events::ConfigSnapshot {
        events::ConfigSnapshot {
            oneclick_public_key: routes::encode_public_key(&self.oneclick_public_key),
            sponsor_storage: self.sponsor_storage,
            min_interval_seconds: self.min_interval_seconds,
            max_recipients: self.max_recipients,
            allowed_tokens: self.allowed_tokens.clone(),
        }
    }

    // ───────────────────────────── views ─────────────────────────────

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            sponsor_storage: self.sponsor_storage,
            min_interval_seconds: self.min_interval_seconds,
            max_recipients: self.max_recipients,
            plan_count: self.next_plan_id - 1,
            oneclick_public_key: routes::encode_public_key(&self.oneclick_public_key),
            allowed_tokens: self.allowed_tokens.clone(),
        }
    }

    pub fn get_plan(&self, plan_id: u64) -> Option<Plan> {
        self.plans.get(&plan_id).cloned()
    }

    pub fn get_plans(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Plan> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50) as usize;
        self.plans.iter().skip(from).take(limit).map(|(_, p)| p.clone()).collect()
    }

    pub fn get_plans_by_owner(&self, owner: AccountId) -> Vec<Plan> {
        self.plans_by_owner
            .get(&owner)
            .map(|ids| ids.iter().filter_map(|id| self.plans.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    /// Plans a keeper should call `run_due` on right now.
    pub fn get_due_plans(&self, limit: Option<u64>) -> Vec<u64> {
        let now = Self::now();
        self.plans
            .iter()
            .filter(|(_, p)| p.is_due(now))
            .map(|(id, _)| *id)
            .take(limit.unwrap_or(50) as usize)
            .collect()
    }

    /// Plans that are past their run time but cannot pay a full run; they need a top-up.
    pub fn get_underfunded_plans(&self, limit: Option<u64>) -> Vec<u64> {
        let now = Self::now();
        self.plans
            .iter()
            .filter(|(_, p)| p.is_underfunded(now))
            .map(|(id, _)| *id)
            .take(limit.unwrap_or(50) as usize)
            .collect()
    }

    pub fn is_due(&self, plan_id: u64) -> bool {
        self.plans.get(&plan_id).map(|p| p.is_due(Self::now())).unwrap_or(false)
    }

    pub fn get_payouts(&self, plan_id: u64, from_seq: Option<u32>, limit: Option<u32>) -> Vec<PayoutRecord> {
        let Some(plan) = self.plans.get(&plan_id) else { return vec![] };
        let from = from_seq.unwrap_or(0);
        let to = plan.payout_count.min(from.saturating_add(limit.unwrap_or(50)));
        (from..to).filter_map(|seq| self.payouts.get(&(plan_id, seq)).cloned()).collect()
    }

    pub fn now_seconds(&self) -> u64 {
        Self::now()
    }
}

// ───────────────────────────── internals ─────────────────────────────

impl Contract {
    fn now() -> u64 {
        env::block_timestamp_ms() / 1000
    }

    /// `near_sdk::store` collections write lazily; flush so `storage_usage` reflects the change.
    fn storage_cost_since(&mut self, before: u64) -> u128 {
        self.plans.flush();
        self.plans_by_owner.flush();
        self.payouts.flush();
        self.guardians.flush();
        let after = env::storage_usage();
        let used = after.saturating_sub(before);
        env::storage_byte_cost().as_yoctonear() * used as u128
    }

    /// Pay `cost` yoctoNEAR of storage from `payer`'s credits, or sponsor it when allowed.
    fn charge_storage(&mut self, payer: &AccountId, cost: u128) {
        if cost == 0 {
            return;
        }
        let credits = self.storage_credits.get(payer).copied().unwrap_or(0);
        if credits >= cost {
            self.storage_credits.insert(payer.clone(), credits - cost);
        } else if self.sponsor_storage {
            log!("Storage of {} yoctoNEAR for {} sponsored by the contract", cost, payer);
        } else {
            env::panic_str(&format!(
                "Insufficient storage credits: need {} yoctoNEAR, have {}. Call storage_deposit first.",
                cost, credits
            ));
        }
    }

    fn owned_plan_mut(&mut self, plan_id: &u64) -> &mut Plan {
        let caller = env::predecessor_account_id();
        let plan = self.plans.get_mut(plan_id).expect("Plan not found");
        require!(plan.owner == caller, "Only the plan owner can do this");
        plan
    }

    /// A plan paused in the middle of a split run would otherwise be stuck: the owner could not
    /// cancel, sweep or update it without first resuming (and paying the rest of the run). When the
    /// owner acts on such a plan, the unpaid remainder of that run is dropped, the period counts as
    /// done (recipients already paid are not paid twice), and a `run_aborted` event records it.
    fn abort_run_if_paused(plan_id: u64, plan: &mut Plan) {
        if plan.status != PlanStatus::Paused {
            return;
        }
        let Some(cursor) = plan.run_cursor else { return };
        let len = plan.recipients.len() as u32;
        let run_index = plan.runs_completed;
        plan.run_cursor = None;
        plan.runs_completed += 1;
        plan.next_run_at = plan.next_run_at.checked_add(plan.interval_seconds).expect("schedule overflow");
        events::run_aborted(plan_id, run_index, cursor, len - cursor);
    }

    fn validate_guardians(guardians: &[AccountId]) {
        require!(guardians.len() <= 10, "At most 10 guardians");
        for (i, g) in guardians.iter().enumerate() {
            require!(!guardians[..i].contains(g), "Duplicate guardian");
        }
    }

    fn validate_recipients(recipients: &[Recipient], max_recipients: u32) {
        require!(!recipients.is_empty(), "At least one recipient is required");
        require!(recipients.len() as u32 <= max_recipients, "Too many recipients");
        for (i, r) in recipients.iter().enumerate() {
            require!(r.amount.0 > 0, "Recipient amount must be positive");
            require!(!recipients[..i].iter().any(|o| o.account_id == r.account_id), "Duplicate recipient");
        }
    }

    /// Inserts a plan and returns (id, asset). `balance` is the initial balance in base units.
    pub(crate) fn insert_plan(&mut self, owner: AccountId, input: PlanInput, balance: u128) -> (u64, Asset) {
        Self::validate_recipients(&input.recipients, self.max_recipients);
        require!(
            input.interval_seconds >= self.min_interval_seconds,
            format!("interval_seconds must be at least {}", self.min_interval_seconds)
        );
        require!(input.interval_seconds <= MAX_INTERVAL_SECONDS, "interval_seconds above maximum");
        require!(input.title.len() <= 120, "Title too long");
        if let (Asset::Ft { contract }, Some(allowed)) = (&input.asset, &self.allowed_tokens) {
            require!(allowed.contains(contract), "Token is not on this contract's allowlist");
        }
        let now = Self::now();
        let next_run_at = input.start_at.unwrap_or(now);
        // At most one period of back pay at creation; a start date years in the past would
        // otherwise make thousands of periods due at once.
        require!(next_run_at.saturating_add(input.interval_seconds) >= now, "start_at is more than one interval in the past");
        if let Some(end) = input.end_at {
            require!(end >= next_run_at, "end_at is before the first run");
        }
        let plan_id = self.next_plan_id;
        self.next_plan_id += 1;
        let mut plan = Plan {
            id: plan_id,
            owner: owner.clone(),
            title: input.title,
            asset: input.asset.clone(),
            recipients: input.recipients,
            interval_seconds: input.interval_seconds,
            next_run_at,
            end_at: input.end_at,
            cap_per_run: U128(0),
            balance: U128(balance),
            status: PlanStatus::Active,
            runs_completed: 0,
            run_cursor: None,
            payout_count: 0,
            created_at: now,
            updated_at: now,
        };
        let total = plan.total_per_run();
        plan.cap_per_run = input.cap_per_run.unwrap_or(U128(total));
        require!(total <= plan.cap_per_run.0, "Recipients total exceeds cap_per_run");
        self.plans.insert(plan_id, plan);
        if let Some(guardians) = input.guardians.filter(|g| !g.is_empty()) {
            Self::validate_guardians(&guardians);
            self.guardians.insert(plan_id, guardians);
        }
        let mut ids = self.plans_by_owner.get(&owner).cloned().unwrap_or_default();
        ids.push(plan_id);
        self.plans_by_owner.insert(owner.clone(), ids);
        events::plan_created(plan_id, &owner, total, input.interval_seconds, next_run_at);
        (plan_id, input.asset)
    }

    /// Verify a 1Click quote and bind it to this plan, recipient and amount. Panics with the
    /// reason on any mismatch so a buggy or malicious keeper cannot redirect funds.
    fn verify_route(&self, plan: &Plan, recipient: &Recipient, quote_json: &str, now: u64) -> RouteRecord {
        let Asset::Ft { contract } = &plan.asset else {
            env::panic_str("Cross-chain routes are only supported for token plans");
        };
        let dest = self
            .destinations
            .get(&recipient.account_id)
            .unwrap_or_else(|| env::panic_str(&format!("{} has no registered destination", recipient.account_id)));
        let q = routes::verify_quote(quote_json, &self.oneclick_public_key).unwrap_or_else(|e| env::panic_str(&format!("Route for {}: {}", recipient.account_id, e)));
        require!(q.origin_asset == format!("nep141:{}", contract), "Route origin asset does not match the plan token");
        require!(q.amount_in == recipient.amount.0, "Route amount does not match the recipient's payout");
        require!(q.destination_asset == dest.asset_id, "Route destination asset differs from the recipient's registration");
        // EVM (0x) addresses are compared case-insensitively; everything else (e.g. Solana base58) exactly.
        require!(routes::destination_address_matches(&dest.address, &q.recipient), "Route recipient address differs from the recipient's registration");
        require!(q.refund_to == recipient.account_id.as_str(), "Route refund target must be the recipient's NEAR account");
        require!(q.deadline_seconds > now + 60, "Route deposit address expires too soon");
        RouteRecord {
            deposit_address: q.deposit_address,
            destination_asset: q.destination_asset,
            destination_address: q.recipient,
            amount_out: U128(q.amount_out),
            min_amount_out: U128(q.min_amount_out),
            deadline: q.deadline_seconds,
            correlation_id: q.correlation_id,
        }
    }

    fn dispatch_transfer(&self, asset: &Asset, to: &AccountId, amount: u128, plan_id: u64, seq: u32) {
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_ON_PAYOUT)
            .on_payout(plan_id, seq, U128(amount));
        match asset {
            Asset::Near => Promise::new(to.clone())
                .transfer(NearToken::from_yoctonear(amount))
                .then(callback)
                .detach(),
            Asset::Ft { contract } => ext_ft::ext(contract.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(to.clone(), U128(amount), Some(format!("standing-order plan {} payout {}", plan_id, seq)))
                .then(callback)
                .detach(),
        }
    }

    fn sweep_internal(&mut self, plan_id: u64, amount: Option<u128>) -> Option<Promise> {
        let plan = self.plans.get_mut(&plan_id).expect("Plan not found");
        let amount = amount.unwrap_or(plan.balance.0);
        if amount == 0 {
            return None;
        }
        require!(amount <= plan.balance.0, "Sweep amount exceeds balance");
        plan.balance = U128(plan.balance.0 - amount);
        plan.updated_at = Self::now();
        let owner = plan.owner.clone();
        let asset = plan.asset.clone();
        let balance = plan.balance.0;
        events::plan_swept(plan_id, &owner, amount, balance);
        let promise = match asset {
            Asset::Near => Promise::new(owner).transfer(NearToken::from_yoctonear(amount)),
            Asset::Ft { contract } => ext_ft::ext(contract)
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(owner, U128(amount), Some(format!("standing-order plan {} sweep", plan_id)))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_PAYOUT)
                        .on_sweep(plan_id, U128(amount)),
                ),
        };
        Some(promise)
    }
}

#[cfg(test)]
mod tests;
