# Testnet deployment (live)

| Role | Account |
|---|---|
| Standing Order contract | `standing-order.testnet` |
| Sputnik DAO (treasury) | `payroll-demo.sputnik-v2.testnet` (factory `sputnik-v2.testnet`, council of 2, threshold 1/2 → both must vote) |
| Council | `council1.standing-order.testnet`, `council2.standing-order.testnet` |
| Recipients | `dev1.standing-order.testnet`, `dev2.standing-order.testnet`, `design.standing-order.testnet` |
| Keeper | `keeper.standing-order.testnet` (function-call key limited to `run_due`, see Phase 4) |
| Token | `usdc.fakes.testnet` (USDC.e test token with public `mint`) |

## First live loop (2026-11-08)

| Step | Transaction |
|---|---|
| Proposal #0: fund plan with 1,200 USDC.e via `ft_transfer_call` → `create_plan` | https://testnet.nearblocks.io/txns/5iHCNcWkzetkziAPKG3ymJq8kn8g5Kb15mcnFPJ6LLGZ |
| council2 approves → proposal executes, Plan #1 created | https://testnet.nearblocks.io/txns/8ym6jz9FzATsRYJ2bdx8emjQLKjHJPVNWVupeshhfdvU |
| Keeper `run_due(1)` → run 0 pays 100 / 80 / 60 USDC.e | https://testnet.nearblocks.io/txns/8h41ZhNLjaUz5XPMV2sW26gWjcrHgbCavAAL9teJyPgm |
| Proposal #1 `pause_plan` approved | https://testnet.nearblocks.io/txns/9CjsSsMf5Nj5DzTA6rh4626s8u55YTxaex8JxkFjTfdQ |
| Keeper `run_due(1)` → `Paused`, nothing moves | https://testnet.nearblocks.io/txns/9rZnKYxUGFQRRC8dNaN8p4znv8tHDa2hWYG5UkMEHomY |
| Proposal #2 `resume_plan` approved | https://testnet.nearblocks.io/txns/CgF3eURnih2sYaxxZGDCStuWXbFEhWFe1fXpkRthT5VX |
| Keeper `run_due(1)` → run 1 pays again | https://testnet.nearblocks.io/txns/5R6ovaZTDdnEnBQe6VK9mcDrpW4pJE3FGfVW8axFJbcT |

## Gotchas learned

- A Sputnik `Transfer` proposal with `msg` attaches only 10 TGas to `ft_transfer_call`
  (`GAS_FOR_FT_TRANSFER` in `sputnikdao2/src/types.rs`). Standard NEP-141 contracts require more than
  30 TGas for `ft_transfer_call`, so that path fails. Fund plans with a `FunctionCall` proposal on the
  token contract (`ft_transfer_call`, 1 yoctoNEAR, 100 TGas) instead. This is also the shape Trezu's
  custom proposal templates produce.
- `near-sdk` 5.30 only emits host calls such as `env::panic_str` when built with `--cfg near`
  (see `contract/.cargo/config.toml`); without it every panic is an opaque `unreachable` trap.
- `near_sdk::store` collections write lazily: flush before measuring `storage_usage`.
- The keeper must hold enough NEAR to prepay 300 TGas per call (about 0.03 NEAR actually burnt, the rest refunded).
- Node 22's `fetch` ignores `HTTPS_PROXY`; set `NODE_USE_ENV_PROXY=1` behind a proxy.

## Trezu template proof (2026-11-08)

| Step | Transaction |
|---|---|
| Proposal #5 filed with the `FunctionCall` kind + description compiled by Trezu's own template engine from `trezu-templates/testnet/so-create-plan.json` | https://testnet.nearblocks.io/txns/2x8osuRn1DUyag1pkBqCkeh4EjPkiCLWM6RGq3qSDGpn |
| council2 approves → Plan #2 "Design retainer (filed from a Trezu template)" created with 300 USDC.e | https://testnet.nearblocks.io/txns/86WDFZKDHqov25uZvJnebcXHyiVN1TSdV96fPGxJ9JmE |

## Later additions (2026-11-08)

- Proposal #6: top up plan #1 with 1,200 USDC.e (approved). Proposal #7: new plan #3 "Core team retainer, every 10 minutes",
  24 runs × 270 USDC.e (approved): https://testnet.nearblocks.io/txns/CUg1stp4yNrPHunuskDZWkbwAZA6f9jkwqjG2gQn2QFU
- `dev1.standing-order.testnet` registered a destination (USDC on Base). On testnet the keeper logs
  `route unavailable, paying on NEAR` because 1Click rejects the testnet token (`tokenIn is not valid`), and pays on NEAR.
- Contract redeployed with `--migrate` (v0.1 → routes); plan history preserved.
- Proposals #8–#13 (2026-11-08, ~22:03 UTC, all approved by the 2-of-2 council): #8 `pause_plan` plan #1,
  #9 `resume_plan` plan #1 with `skip_missed: true` (missed periods dropped, schedule re-aligned to now), #10 `pause_plan`
  plan #2, #11 `resume_plan` plan #2 with `skip_missed: true`, #12 top-up plan #1 with 7,200 USDC.e and #13 top-up
  plan #2 with 3,000 USDC.e (both `ft_transfer_call` → `fund_plan`). Plans #1 and #2 had run dry and showed
  "Needs top-up" on the dashboard (and `underfunded, needs top-up` in `npm run status`) until the top-ups landed.

## Run the keeper

The keeper signs with a function-call access key that can only call `run_due` on the contract. Create the key once
(it is written to `keeper/.env`, gitignored, see `keeper/.env.example`), then start the loop:

```bash
export NODE_USE_ENV_PROXY=1            # only needed behind a proxy
npm run keeper:key                      # adds the run_due-only key to keeper.standing-order.testnet, writes keeper/.env
CROSSCHAIN=dry KEEPER_HTTP_PORT=8787 npm run keeper
# one tick instead of a loop (pays if due, otherwise prints {"event":"idle"}):
npm run keeper:once
```

What the log lines mean (one JSON object per line):

- `{"event":"key verified","receiver":"standing-order.testnet","methods":["run_due"],"allowance_near":2}`: the keeper
  looked up its own access key on-chain and confirmed it is a function-call key limited to `run_due` on the contract.
  It refuses to start with a full-access key or a key for another receiver/method.
- `{"event":"route unavailable, paying on NEAR","recipient":"dev1.standing-order.testnet","error":"tokenIn is not valid"}`:
  the recipient registered a cross-chain destination, but 1Click has no testnet and rejects `usdc.fakes.testnet`, so the
  keeper submits the run without a route and the contract pays the recipient on NEAR. On mainnet with `CROSSCHAIN=live`
  the same line only appears when a quote genuinely fails, and the fallback is identical: pay on NEAR, never skip.
- `{"event":"idle","due":0}`: nothing due this tick. `{"event":"sent",...,"outcome":{"Sent":{...}}}`: a run was paid;
  `{"event":"skipped",...,"outcome":"Paused"|{"NotDue":...}|{"Underfunded":...}}`: the contract declined.

With `KEEPER_HTTP_PORT` set, `GET http://localhost:8787/` returns the live status (ticks, runs, recent outcomes); point the
dashboard at it with `VITE_KEEPER_URL=http://localhost:8787/`. Without `VITE_KEEPER_URL` the dashboard hides the keeper pill.
- 2026-11-08 22:19 UTC: redeployed (route shape checks, address case rule, config/storage events; stripped 409,678-byte wasm, sha256 c61d7081…). State layout unchanged, no migration.

## 2026-11-09: schedules realigned for judging

- The in-container keeper stopped when its worker restarted (~22:28 UTC Nov 8), so payouts paused for ~2.5 h. Lesson: the
  keeper now also runs on GitHub Actions (`.github/workflows/keeper.yml`) with its own `run_due`-only key.
- Nov 9: GitHub's 5-minute cron fired only every 10–70 minutes, so a payday was 48 minutes late. Each keeper run now
  polls every 30 s for ~55 minutes and dispatches the next run itself; cron only restarts the chain if it breaks.
- Proposals #14–#16 (one per plan: pause → `update_plan` interval → `resume_plan` with `skip_missed`) realigned plan #1 to
  30 min, plan #2 to hourly, plan #3 to 10 min, with no back pay. Proposals #17–#19 topped the plans up to last past Nov 25.
- Proposals #20–#21 (retitle plan #1) were marked Approved by Sputnik although the inner `update_plan` panicked: the longer
  title needs a storage deposit and none was attached. Proposal #22 attached 0.01 NEAR and succeeded. Sputnik's Approved
  status does not prove the inner call succeeded; check the effect (`npm run status`).

## 2026-11-09: guardians (emergency pause without a vote) and keeper lockdown

Contract redeployed with `migrate` (state v2 → v3 adds the `guardians` map; all plans, payouts and
destinations carried over unchanged, `get_plans` still returns the same four plans).

| Step | Proof |
|---|---|
| DAO names `council1.standing-order.testnet` guardian of plan #1 | proposal **#24**, Approved (2 votes); `get_guardians {"plan_id":1}` → `["council1.standing-order.testnet"]` |
| The guardian pauses plan #1 alone, no proposal | `council1` called `pause_plan {"plan_id":1}` directly at 02:38:14 UTC; `get_plan(1).status` → `Paused`; event `plan_paused` with `"by":"council1.standing-order.testnet"` |
| Resuming needs the full vote | proposal **#25** `resume_plan {"plan_id":1,"skip_missed":true}`, Approved (2 votes); status back to `Active` |
| A non-guardian cannot pause | unit test `stranger_cannot_pause`; sandbox test `native_plans` step 4 (keeper's `pause_plan` fails with `Only the plan owner`) |

Trezu template for this call: `trezu-templates/testnet/so-set-guardians.json` (seven templates now compile with Trezu's engine).

Keeper accounts after lockdown (`npm run keeper:lockdown`, then every FullAccess key deleted; `npm run judge` check 3 lists them):

| Account | Keys | Note |
|---|---|---|
| `keeper.standing-order.testnet` | 3 × FunctionCall `standing-order.testnet::run_due` (allowances 1.5 / 1.88 / 0.25 NEAR), no FullAccess key | original keeper; the GitHub Actions `KEEPER_KEY` secret is one of these keys |
| `keeper2.standing-order.testnet` | 1 × FunctionCall `standing-order.testnet::run_due` (allowance 100 NEAR), no FullAccess key; balance 14 NEAR | reference keeper from 02:42 UTC; enough gas for the judging window at ~0.003 NEAR per run |

Lesson: `near-api-js` gives a function-call key a 0.25 NEAR allowance when none is passed, and once the
FullAccess key is gone no new key can be added, which is why `keeper2` exists. The allowance only caps
gas for `run_due`; neither account can do anything else.

## 2026-11-09 (04:23 UTC): security fixes from the code review, contract v4

A three-part review (contract, off-chain code, dashboard) found real bugs; each contract finding was proven with a
failing test first, then fixed, and each fix has a regression test (`contract/src/tests.rs`, module `review_fixes`).
Contract redeployed with `migrate` (state v3 → v4); all four plans, payouts, destinations and guardians carried over,
and `get_config().allowed_tokens` became `["usdc.fakes.testnet"]` automatically. The next payday (plan #3, run 32,
tx `6dzy138HufWWpoXjFdfXk3dYMpxhfqQSeXpheBhGTXEE`) settled `Sent` for all three recipients on the new code.

| Finding | Fix |
|---|---|
| Anyone could call `ft_on_transfer` posing as a token, create plans in a victim's name and spend the victim's storage credits; a fake token whose transfers always fail let a plan grow storage forever | Token allowlist (`allowed_tokens`), payout/route records charged to the plan owner's credits, `storage_deposit` minimum 0.00125 NEAR, creation back pay limited to one interval |
| A guardian pause in the middle of a split run left the DAO unable to cancel/sweep/update, and `skip_missed` then skipped one extra period | Owner actions abort the interrupted run (`run_aborted` event); `skip_missed` lands on the next aligned slot |
| One signed 1Click quote could be submitted for several payouts (same deposit address); duplicate recipients allowed | Each deposit address can be paid once; duplicate recipients refused |
| Huge `interval_seconds` could overflow and brick a split run | Interval capped at 10 years, checked arithmetic |
| Guardians written at plan creation were not charged for storage; failed token sweeps re-credited without an event | Guardians included in the storage charge; `sweep_failed` event |

Off-chain fixes in the same change: the GitHub Actions keeper now fails (exit 1) when a tick fails instead of
staying green; an invalid `CROSSCHAIN` value stops the keeper at startup; one failing plan no longer blocks the
others (retries once without routes); catch-up runs fetch a fresh quote each time; the clerk reviews every action
in a proposal (a harmless first action can no longer hide an `ft_transfer` to an attacker); `judge` checks only the
DAO's plans and fails on failed/stuck payouts, and check 6 fails if the receipt signer is missing from today's
attestation report; ledger CSV cells are protected against spreadsheet formulas. Dashboard fixes are listed in the
commit message.
