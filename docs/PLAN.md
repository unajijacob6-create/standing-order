# Standing Order — build plan

Recurring payroll and scheduled payouts for Sputnik DAO treasuries on NEAR. The DAO votes once;
code pays on schedule, within caps, until the council pauses it. Recipients choose the token and
chain they are paid on; cross-chain legs settle through NEAR Intents. Plugs into Trezu through
custom proposal templates without changing Trezu.

Deadline: 2026-11-14 23:59 UTC. Each phase ends with its own tests passing before the next starts.

**Status (2026-11-08):** Phases 0–8 built and tested; live on testnet (`docs/TESTNET.md`); repo public at
github.com/unajijacob6-create/standing-order. Outstanding: the Phase 5 exit test (one mainnet routed payout,
`docs/MAINNET.md`, needs mainnet funds), the X post and the submission.

Dropped: the Phase 1 `wasm < 300 KB` target (the release wasm is ~409 KB with `opt-level = "z"`, `lto` and a single
codegen unit already; the target was replaced by measuring gas and storage costs per run) and `scripts/crosschain-demo.ts` (the keeper's
`CROSSCHAIN=live` mode plus `scripts/register-destination.ts` cover the same path; see `docs/MAINNET.md`).

## Phase map

| # | Phase | Deliverable | Exit test (must pass) | Reference repos |
|---|---|---|---|---|
| 0 | Scaffold | repo layout, toolchain, this plan | `cargo build --target wasm32-unknown-unknown --release` produces a wasm | — |
| 1 | Core contract | `contract/` Rust near-sdk 5: plans, schedule math, native NEAR payouts in batches with callbacks, pause/resume/cancel/sweep, update recipients, views, NEP-297 events, storage accounting | unit tests: schedule, cap, idempotency, permissions, catch-up; ~~wasm < 300 KB~~ (dropped) | Trezu `contracts/bulk-payment` (MIT) for gas metering + callback patterns; near-sdk-rs examples |
| 1b | Sandbox tests | `contract/tests/` near-workspaces | deploy → create+fund → run pays → second run NotDue → pause blocks → sweep returns funds → transfer to missing account re-credits balance | near-workspaces-rs |
| 2 | Fungible tokens | `ft_on_transfer` msg `{create_plan|fund_plan}`, `ft_transfer` payouts + callbacks, recipient storage check, storage credits + sponsored storage | sandbox tests with a test NEP-141 token: fund via `ft_transfer_call`, payouts land, unregistered recipient fails safely and re-credits | near-sdk-rs FT example, Trezu `ft_on_transfer` |
| 3 | Sputnik DAO on testnet | testnet accounts, DAO on `sputnik-v2.testnet`, contract deployed, `scripts/` to propose + approve `Transfer{msg}` and `FunctionCall` (pause/resume/top-up/sweep) | real testnet loop: DAO vote → plan funded with testnet USDC → `run_due` pays → pause via DAO vote | near-daos/sputnik-dao-contract README + `proposals.rs` |
| 4 | Keeper | `keeper/` TypeScript worker with a function-call key limited to `run_due`; polls `get_due_plans`; retries; writes history JSON from NEP-297 events | keeper runs unattended for 30 min on testnet with a 120-s plan, no missed runs, no double pays | near-api-js 7.4 |
| 5 | Cross-chain leg | `register_destination`; keeper quotes 1Click, contract pays the quote's deposit address for opted-in recipients; status polling; ~~`scripts/crosschain-demo.ts`~~ (dropped; keeper `CROSSCHAIN=live` on mainnet with $2–5) | **built; exit test (one mainnet routed payout) outstanding.** one real NEAR-USDC → Base-USDC payout reaches `SUCCESS`; dry-run mode works without funds (done); threat model written (done) | `@defuse-protocol/one-click-sdk-typescript`, docs.near-intents.org |
| 6 | Trezu integration | `trezu-templates/*.json` manifests; Trezu `nt-fe` run locally against the testnet DAO | proposal filed from Trezu's template form reaches the contract; screenshots in docs | NEAR-DevHub/trezu `docs/trezu-custom-proposal-template/SKILL.md` |
| 7 | Web UI (second to last) | `web/` modern dashboard in NEAR palette/font: plans, countdown, history with explorer links, CSV export, destination registration, wallet login | Playwright smoke test; judge can watch a payout land | `@hot-labs/near-connect`, NEAR brand assets (verify palette first) |
| 8 | Ship | README with "do X, see Y", `npm run demo`, fresh-clone test, reuse disclosure, video, X post draft, submission payload | a clean machine follows the README end to end; submission returns 201 | HACKATHON.md |

Stretch (only if Phase 7 finishes early): attested "payroll clerk" on NEAR AI Cloud that drafts plan changes from contributor invoices.

## Contract design (Phase 1–2)

```
Asset        = Near | Ft { contract }
Recipient    = { account_id, amount }               # amount in base units
Plan         = { id, owner, title, asset, recipients[], interval_seconds,
                 next_run_at, end_at?, cap_per_run, balance, paused,
                 runs_completed, run_cursor?, payout_count, created_at, updated_at }
PayoutRecord = { plan_id, run_index, recipient, amount, status: Sent|Failed, timestamp, block_height }
```

Rules
- Only `plan.owner` (the DAO) can pause, resume, update recipients, cancel or sweep.
- `run_due(plan_id)` is permissionless. It pays one period per completed run and advances
  `next_run_at += interval` (schedule stays aligned; missed periods are caught up one call at a time).
- A run never pays partially: if `balance < sum(recipients)` the call returns `Underfunded` and emits an event.
- `sum(recipients) <= cap_per_run` is enforced on create/update and on every run.
- Payouts are sent in batches limited by remaining gas (native ~5 TGas each, FT ~35 TGas each);
  a run in progress keeps a cursor and continues on the next call.
- Balance is debited when a payout is sent; a failed transfer callback re-credits it and marks the record `Failed`.
- Storage for new plans is paid by the attached deposit on direct calls, or by the caller's
  storage credits / the sponsored pool when created through `ft_on_transfer`.

Events (NEP-297, standard `standing_order`, version `1.0.0`): `plan_created`, `plan_funded`,
`payout_sent`, `payout_failed`, `run_completed`, `plan_underfunded`, `plan_paused`,
`plan_resumed`, `plan_updated`, `plan_cancelled`, `plan_swept`.

## Testing policy
- Unit tests in `contract/src` for pure logic (schedule math, caps, permissions) using `near-sdk` unit-testing.
- Sandbox tests in `contract/tests` for every cross-contract path (native transfer, FT transfer, callbacks).
- Each later phase adds a script that reproduces its exit test against testnet, and the README lists the same steps as "do X, see Y".
