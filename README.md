# Standing Order

![tests](https://github.com/unajijacob6-create/standing-order/actions/workflows/test.yml/badge.svg)

**Vote once, pay every period on NEAR. Recipients can choose USDC on Base, Arbitrum or Solana through NEAR Intents, and the contract checks 1Click's signature before it pays a route.**

**Live dashboard:** https://unajijacob6-create.github.io/standing-order/ (reads the testnet contract directly; payouts land every 10 minutes; CSV export of every payout on the page)

A Sputnik DAO funds and authorises a payroll plan in a single vote. From then on the Standing Order
contract pays every contributor on schedule, within the caps the council set, until the council
pauses or cancels it. A keeper that holds a key able to call only `run_due` triggers each period.
Contributors choose where they get paid: on NEAR, or on Base, Arbitrum, Ethereum or Solana through
NEAR Intents, and the contract verifies 1Click's own signature on every cross-chain route before it
pays a deposit address. A **private payroll clerk** on NEAR AI Cloud drafts proposals from contributor
invoices and briefs the council before each vote, inside a TEE and with a signed, re-verifiable receipt.
It plugs into Trezu through custom proposal templates, compiled and filed
with Trezu's own template engine; no Trezu code is modified.

Built at NEAR HACKATHON (Nov 2026). Tracks: `social` (Social Money), `realworld` (Real-World Money), `business` (Autonomous Business), `privacy` (Privacy & Private AI).

**Live numbers** (testnet, read from the contract on 2026-11-09 02:45 UTC; `npm run judge` re-reads them):
4 active plans · 74 paydays run · 207 payouts · 17,035 USDC.e paid · 26 DAO proposals (25 approved, 1 rejected; one filed through Trezu's template engine, one drafted by the clerk, two for the guardian demo) · keeper polling every 30 s from GitHub Actions · 78 tests in CI (53 contract unit, 9 sandbox, 16 clerk), each fix from the Nov 9 security review covered by a regression test.

![Dashboard](docs/screenshots/desktop.png)

Video: [docs/demo.mp4](docs/demo.mp4) (75 s screen capture of the live testnet dashboard).

## The problem

DAO and startup treasuries pay the same people every month, yet on NEAR every payment is a fresh
proposal that humans must file, vote on and sign. Trezu and NEAR Business offer single and bulk
payments, vesting and CSV export, but nothing recurring; Trezu's custom templates make the *form*
reusable while the filing and the vote still happen every cycle. Arbitrum's DAO paid 12 multisig
signers $1,500–$2,500 a month each to run its payments and in May 2025 proposed winding the
service down, calling its signing threshold "inherently slow and inefficient". Sources and figures:
[docs/PROBLEM.md](docs/PROBLEM.md).

## What Standing Order does

| Before | After |
|---|---|
| 12 payroll proposals a year per contributor group, each needing N signatures | 1 proposal per funding horizon; payday needs no signatures |
| Signer coordination on payday; late or missed pay | Code pays on schedule; missed periods are back-paid or skipped, the council decides |
| Everyone paid on NEAR in one token | Each recipient registers a destination chain/asset; delivery via NEAR Intents |
| Trust the ops person who holds the keys | The keeper key can only call `run_due`; it cannot move funds anywhere but to the plan's recipients |
| Cross-chain routing means trusting a backend | The contract verifies 1Click's ed25519 signature on the quote and binds it to the recipient's registration, exact amount and recipient-owned refund address |

## Who can do what (custody stays with the DAO)

| Action | Who | How |
|---|---|---|
| A scheduled payday, within the amounts and cadence the council voted | nobody signs; the keeper triggers it | `run_due`, callable with a key limited to that one method |
| Emergency stop | any **guardian** the DAO named, e.g. one council member, alone | `pause_plan`, no vote; the pause is logged with who did it |
| Fund or create a plan, top up, resume, change amounts, cancel, sweep back | the full DAO vote | Sputnik `FunctionCall` proposals, filed by hand or from Trezu templates |

No new multisig and no new treasury: the Sputnik DAO stays the owner of every plan, and escrowed
tokens can be swept back by a vote at any time.

## How it works

```
 Sputnik DAO (council votes once)                     Standing Order contract              Recipients
 ───────────────────────────────                      ───────────────────────              ──────────
 FunctionCall proposal on the token:                  ft_on_transfer → create_plan        dev1.near  (paid on NEAR)
   ft_transfer_call(standing-order, 1200 USDC,  ──►   plan { recipients, interval,        dev2.near  (paid on NEAR)
                    msg = create_plan{...})            cap_per_run, balance }              design.near → registered: USDC on Base
 pause_plan / resume_plan / cancel_plan  ──────►      owner-only management
                                                              ▲
 Keeper (function-call key, run_due only) ────────────────────┘ run_due(plan_id, routes?)
   every 15 s: get_due_plans → for recipients with a destination, fetch a signed 1Click quote →
   contract verifies signature + bindings → pays NEAR accounts directly and routed recipients via the
   1Click deposit address → NEAR Intents delivers USDC on Base; refunds go to the recipient.
```

NEAR tools and why each one is needed (none is decorative; remove one and a column of the table above breaks):

| Tool | Role |
|---|---|
| **Sputnik DAO** (`sputnik-v2.testnet` factory) | Policy stays with the DAO; funded tokens are escrowed in the Standing Order contract until paid or swept back by a DAO vote. One `FunctionCall` proposal funds a plan; pause/resume/cancel are proposals too. |
| **Trezu custom proposal templates** | Seven manifests turn those proposals into forms inside Trezu; validated and compiled with Trezu's own engine (`trezu-templates/`). |
| **Function-call access keys** | The keeper account holds a key restricted to `standing-order.testnet::run_due`. The keeper refuses to start with anything broader. |
| **NEAR Intents 1Click API** | Cross-chain delivery. Quotes are signed by 1Click; the contract re-derives the signed message (`base58(sha256(stable_json))`) and checks it with `env::ed25519_verify`. |
| **NEAR AI Cloud** (confidential inference) | The payroll clerk (`clerk/`): reads invoices, drafts the proposal, flags units slips, duplicates, unknown or unregistered accounts, raises and runway; runs on a NEAR-operated TEE model with nonce-bound attestation and a signed response receipt the dashboard re-verifies. |
| **Named accounts** | Recipients and treasuries are human-readable; no address-poisoning vector on the NEAR leg. |
| **NEP-141 / NEP-297** | Token funding through `ft_transfer_call`; every plan, payout and config change emits a standard event. |

## Try it ("do X, see Y")

### 0. One-command verification (no keys, no funds, about 20 s)

```bash
git clone https://github.com/unajijacob6-create/standing-order && cd standing-order
npm ci
npm run judge            # behind a proxy: export NODE_USE_ENV_PROXY=1
```

See: a six-line checklist, each `[ok]` with its evidence, ending in `judge: 6 checks, 6 ok`
(non-zero exit on any failure; the same job runs in CI). It reads the live contract (`get_plans`),
finds the most recent payout and its age, lists the keeper account's access keys and requires every
one of them to be `standing-order.testnet::run_due` only, re-verifies the real 1Click quote in
`contract/tests/fixtures/quote_live.json` against 1Click's ed25519 key offline, re-verifies every
clerk receipt in `clerk/reviews/` offline (the EIP-191 signer must be the attested NEAR AI TEE) and,
if the network allows, fetches today's NEAR AI attestation report for the clerk's model.
Details: [docs/JUDGE.md](docs/JUDGE.md).

```bash
npm run ledger -- --out payouts.csv     # or: npm run ledger -- --json
```

See: every payout the contract has ever made as a CSV (date, plan, recipient, amount, token,
status, cross-chain route if any, source DAO), for an accountant or auditor.

### A. Run the full test suite locally (no network, no funds)

Requires Rust 1.95+ (the `contract/rust-toolchain.toml` pins 1.97.0 and adds the `wasm32-unknown-unknown`
target for you) and a C compiler. The first run takes 5-15 minutes cold: it compiles `near-workspaces`
and downloads the NEAR sandbox binary. Later runs take about 3 minutes. On containers with a low
open-file limit the C compiler builds a small fd-limit shim for the sandbox node (`scripts/sandbox-rlimit-shim.c`).

```bash
git clone https://github.com/unajijacob6-create/standing-order && cd standing-order
./scripts/test.sh
```

See: `test result: ok. 53 passed` (unit tests, including verification of a **real signed 1Click quote** against
1Click's production key), then three sandbox suites: `native_plans` 5 passed, `ft_plans` 3 passed,
`routed_payouts` 1 passed. The sandbox tests deploy the contract to a local NEAR node, create and fund
plans through `ft_transfer_call`, pay recipients, re-credit failed transfers, refuse five forged or
mismatched cross-chain quotes and pay the genuine one.

### B. Watch the live testnet deployment (no keys needed)

```bash
npm install
npm run status          # behind a proxy: export NODE_USE_ENV_PROXY=1
```

See: the contract `standing-order.testnet`, DAO `payroll-demo.sputnik-v2.testnet`, each plan with its
next run time, balance and recent payouts, and the recipients' USDC.e balances rising over time.
`npm run watch` keeps printing new payouts as the keeper pays them: plan #3 every 10 minutes, the
others every 30–60 minutes, while they are funded; when a plan cannot afford a full run, `status` says
`underfunded, needs top-up` instead and the keeper leaves it alone.

```bash
cd web && npm install && npm run dev      # then open http://localhost:3000
```

Live: https://unajijacob6-create.github.io/standing-order/

See: the dashboard with active plans, countdown to the next payday, payout history with explorer
links, the DAO's Standing Order proposals (including proposal #5, compiled and filed with Trezu's
template engine from `trezu-templates/testnet/so-create-plan.json`), and a "Get paid on another
chain" panel. Connect a NEAR testnet wallet to register a destination.

### C. Run the whole loop with your own testnet account (~10 minutes, ~25 testnet NEAR)

```bash
npx near-cli-rs account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
# repeat for two more accounts and move their NEAR to <you>.testnet, or use the faucet at near-faucet.io
export SO_MASTER=<you>.testnet SO_CONTRACT=<you>.testnet SO_DAO_NAME=<unique-dao-name> \
       SO_COUNCIL=c1.<you>.testnet,c2.<you>.testnet SO_RECIPIENTS=a.<you>.testnet,b.<you>.testnet,c.<you>.testnet SO_KEEPER=keeper.<you>.testnet
./scripts/demo-full-loop.sh      # or: npm run demo
```

See, step by step (11 steps, each announced with `▶`): contract built → sub-accounts created →
contract deployed and initialised → DAO created with a 2-of-2 council → test USDC.e minted to the
DAO → council and keeper accounts funded → plan proposal filed and both council members vote →
first run: `run_due(1) {"Sent":{"sent":3,...}}` and `Plan #1 ... [Active] balance 1200 USDC.e` with
recipients at 100 / 80 / 60 USDC.e → keeper function-call key created (`run_due` only, written to
`keeper/.env`) → `npm run keeper:once` ticks with that key: `{"event":"key verified",...}` then
`{"event":"sent",...}` if a period is due, otherwise `{"event":"idle","due":0}` → `pause_plan`
proposal filed and approved → `run_due` returns `"Paused"` and the script prints
`OK: run_due returned Paused, nothing moved`. The script is idempotent; re-running skips what exists.

### D. Run the keeper

The demo keeper runs from this repository's GitHub Actions ([keeper.yml](.github/workflows/keeper.yml)): each run
polls the contract every 30 s for ~55 minutes, then dispatches the next run itself, because GitHub's cron fired
10–70 minutes apart instead of every 5 (cron stays as a restart path). The `KEEPER_KEY` secret is a key that can only
call `run_due`.
To run your own:

```bash
npm run keeper:key                                   # adds a run_due-only key to $SO_KEEPER, writes keeper/.env
CROSSCHAIN=dry KEEPER_HTTP_PORT=8787 npm run keeper   # long-running; npm run keeper:once for a single tick
```

`keeper/.env` carries `NEAR_NETWORK`, `SO_CONTRACT`, `KEEPER_ACCOUNT` and `KEEPER_KEY`. Optional:
`POLL_SECONDS` (15), `NEAR_RPC_URL`, `KEEPER_HTTP_PORT` (serves JSON status for the dashboard's
`VITE_KEEPER_URL`), `KEEPER_LOG` (JSONL run log, default `keeper/data/runs.jsonl`),
`CROSSCHAIN=off|dry|live` (testnet default `dry`), `ONE_CLICK_URL`, `ONE_CLICK_JWT`,
`ROUTE_SLIPPAGE_BPS` (100). The keeper refuses to start with a full-access key or any key not
limited to `<SO_CONTRACT>:run_due`.

Expected log lines (one JSON object per line):

```
{"event":"keeper starting","network":"testnet","contract":"...","account":"keeper...","pollSeconds":15,"crosschain":"dry"}
{"event":"key verified","receiver":"standing-order.testnet","methods":["run_due"],"allowance_near":2}
{"event":"status endpoint","url":"http://localhost:8787/"}
{"event":"idle","due":0}
{"event":"dry quote","recipient":"design...","amountIn":"...","amountOut":"...","destination":"base:..."}   # recipient with a destination
{"event":"route unavailable, paying on NEAR","recipient":"...","error":"..."}                           # 1Click rejects the testnet token
{"event":"sent","plan_id":1,"outcome":{"Sent":{"sent":3,"completed":true}},"tx":"..."}
```

Cross-chain routes run on mainnet only: NEAR Intents has no testnet, and the hackathon accepts testnet-only
projects in every track (HACKATHON.md, Q-007 and Q-010). So everything else runs live on testnet, and the routing
step is proven by tests: the unit test `real_live_quote_verifies` checks a genuine signed 1Click mainnet quote
against 1Click's production key, the sandbox test `routed_payouts` runs the full verify-and-pay path and refuses
five forged or mismatched quotes, and a unit test refuses a replayed quote. On testnet the keeper runs with
`CROSSCHAIN=dry`: for a recipient with a registered destination it fetches a real 1Click quote and logs it, then
pays on NEAR. Turning it on is a mainnet deploy plus `CROSSCHAIN=live` (`docs/MAINNET.md`). See `docs/TESTNET.md`
for the live accounts and transactions.

## Private payroll clerk: what the model sees, what is kept

The clerk (`clerk/`) sends contributor invoices to a model on NEAR AI Cloud (`https://cloud-api.near.ai/v1`)
that runs inside a hardware enclave, with a fresh random nonce in the attestation request. Standing Order
runs no server of its own: the CLI talks to the TEE endpoint directly from the operator's machine. After a
response returns, the clerk keeps only the verdict, the findings and the receipt (model, nonce, attestation
summary, chat id, `sha256(request)`, `sha256(response)`, signature, recovered signer) under `clerk/reviews/`;
the documents themselves are not written anywhere. Nothing is sent to any other service, and the API key
lives in `.env`. The dashboard and `npm run judge` re-verify every receipt from the stored hashes, so the
documents are never needed again. Fictional sample invoices live in `clerk/samples/`; proposal #23 on the
demo DAO was drafted from them. Details and the exact checks: [clerk/README.md](clerk/README.md).

## Repository layout

| Path | What |
|---|---|
| `contract/` | Rust contract (`near-sdk` 5.30): plans, schedule, payouts, routes, migration. `src/routes.rs` has the 1Click signature verification. Tests in `src/tests.rs`, `src/routes.rs`, `tests/*.rs`. |
| `contract/test-contracts/test-token` | Minimal NEP-141 token used only by sandbox tests. |
| `keeper/` | TypeScript keeper: `run_due`-only key, split-run continuation, 1Click quoting, swap tracking, status endpoint. |
| `scripts/` | Testnet operations: accounts, deploy (+ `--migrate`), DAO creation, token setup, proposals, votes, keeper key, status/watch. |
| `clerk/` | Private payroll clerk: NEAR AI Cloud TEE inference with attestation + signature verification, deterministic checks, review/draft/file commands, sample invoices, published reviews. |
| `trezu-templates/` | Trezu manifests per network, generator, and a checker that runs Trezu's real validator/engine and can file the compiled proposal. |
| `web/` | Dashboard (Vite + React) in NEAR's brand system; Playwright smoke test. |
| `docs/` | See the table below. |

| Doc | What |
|---|---|
| `docs/PLAN.md` | Phases, exit tests, what was dropped. |
| `docs/TESTNET.md` | Live accounts, proposals and transactions. |
| `docs/MAINNET.md` | Mainnet runbook for the first routed payout. |
| `docs/SECURITY.md` | Threat model, admin keys, what we rely on NEAR Intents for, privacy. |
| `docs/DEMO.md` | Video storyboard, X post, pre-submission feedback post. |
| `docs/SUBMISSION.md` | Submission form payload. |

## Contract API (short)

| Method | Who | What |
|---|---|---|
| `create_plan(plan)` payable | anyone (owner = caller) | Native-NEAR plans; deposit covers storage, remainder funds the plan. |
| `ft_on_transfer(sender, amount, msg)` | allowlisted token contract | `{"action":"create_plan","plan":{…}}` or `{"action":"fund_plan","plan_id":N}`; storage from credits or sponsorship. |
| `storage_deposit(account_id?)` payable | anyone (≥ 0.00125 NEAR) | Prepays storage for plan creation and for every payout record of plans the account owns. |
| `set_config(sponsor_storage?, min_interval_seconds?, max_recipients?, oneclick_public_key?, allowed_tokens?)` | contract owner | Limits, sponsorship, 1Click key rotation, token allowlist; emits `config_updated`. |
| `run_due(plan_id, routes?)` | anyone | Pays the next due period (or continues a split run). `routes` carry signed 1Click quotes for opted-in recipients. |
| `pause_plan(plan_id)` | plan owner **or a guardian** | Emergency stop; logged with the caller. |
| `set_guardians(plan_id, accounts)` / `get_guardians` | plan owner / view | Up to 10 accounts that may pause without a vote; also settable as `guardians` in the plan input. |
| `resume_plan(plan_id, skip_missed?)`, `update_plan`, `cancel_plan`, `sweep` | plan owner (the DAO) | Governance of a plan. |
| `register_destination(asset_id, address)` / `clear_destination()` | recipient | Where cross-chain payouts land. |
| `get_plans`, `get_plan`, `get_due_plans`, `get_underfunded_plans`, `get_payouts`, `get_route`, `get_destination`, `get_plan_destinations`, `get_config` | view | Everything the dashboard and keeper read. |

Rules enforced on-chain: a run starts only if the plan can fund it in full, and `sum(recipients) ≤ cap_per_run`;
`balance` is debited when a transfer is dispatched and re-credited if the transfer fails; the schedule stays aligned
(`next_run_at += interval`), so missed periods are back-paid one per call unless the council resumes with
`skip_missed` (also correct when the pause interrupted a split run); a new plan can start at most one interval in
the past and intervals are capped at 10 years; recipients in a plan are unique; only tokens on the contract's
allowlist (`get_config().allowed_tokens`) can fund plans, because any account can call `ft_on_transfer` and claim to
be a token; payout and route records are paid from the plan owner's storage credits (or sponsored when
`sponsor_storage` is on), never silently from the balance that holds NEAR plans' funds; `storage_deposit` needs at
least 0.00125 NEAR; a route is accepted only if its 1Click signature verifies **and** origin asset = plan token,
amount = recipient's payout, destination asset/address = the recipient's own registration, `refundTo` = the
recipient's NEAR account, the deposit address is live for at least another minute, **and** that deposit address has
never been paid before (one signed quote, one payout). If a guardian pauses a plan in the middle of a split run, the
DAO can still update, sweep or cancel it: the unpaid rest of that run is dropped and a `run_aborted` event records
how many recipients were and were not paid.

## Threat model and limits

See `docs/SECURITY.md`. In short: the DAO can always pause, sweep or cancel; the keeper can only make
a due payment happen (at most one polling interval early); a compromised keeper cannot redirect
funds because routes must carry 1Click's signature over the recipient's registered address, but it
does choose the quote's slippage (`ROUTE_SLIPPAGE_BPS`, no on-chain floor) and can omit a route so a
recipient is paid on NEAR instead of their registered chain; the 1Click key is owner-rotatable; and
the remaining trust is in 1Click executing the swap it signed, with refunds flowing to the recipient,
not to the keeper or the contract. This automates payroll operations; it is not a vesting lock: the
DAO can sweep at any time, and `resume_plan` pays missed periods unless `skip_missed` is set.

## What was built during the hackathon, and what was reused

Everything in this repository was written inside the hackathon window (code counts from the
2026-10-19 announcement; development 2026-11-01 to 2026-11-14; this repo's first commit is
2026-11-08). It was built with AI coding assistance (Claude Code); the testnet transactions, the
captured 1Click fixtures and the tests were verified by running them. Reused: `near-sdk` 5.30 and
`near-contract-standards` (test token), `near-workspaces`, `near-api-js` 7.4,
`@defuse-protocol/one-click-sdk-typescript` (keeper-side quote verification), `@hot-labs/near-connect`,
React/Vite, `@fontsource` fonts. Trezu's template engine is **not** vendored:
`trezu-templates/fetch-trezu.sh` clones NEAR-DevHub/trezu so our checker can run Trezu's own validator.

Second project by the same builder: [Plinth](https://github.com/unajijacob6-create/plinth), a keyless NEAR fund with an exit nobody can block. Full history: https://github.com/unajijacob6-create/standing-order/commits/main.

## Credits and prior art

- Arbitrum DAO, [Wind Down the MSS](https://forum.arbitrum.foundation/t/wind-down-the-mss-transfer-payment-responsibilities-to-the-arbitrum-foundation/29279): the cost and coordination numbers in "The problem".
- [Trezu](https://github.com/NEAR-DevHub/trezu): custom proposal template docs (the integration surface) and the `bulk-payment` contract (gas-metered batching with callbacks, the pattern our payout loop follows).
- [Sputnik DAO v2](https://github.com/near-daos/sputnik-dao-contract): proposal kinds, policy and gas limits.
- [NEAR Intents 1Click SDK](https://github.com/defuse-protocol/one-click-sdk-typescript): quote signature scheme, re-implemented on-chain in `contract/src/routes.rs`.
- [Roketo](https://defillama.com/protocol/roketo): NEAR's earlier streaming-payments approach.
- [near-sdk-rs](https://github.com/near/near-sdk-rs) and `near-workspaces-rs`: contract framework and sandbox tests.

## License

MIT (see `LICENSE`).
