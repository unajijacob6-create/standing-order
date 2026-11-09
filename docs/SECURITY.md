# Threat model

## Actors
- **Treasury (plan owner)**: a Sputnik DAO. Can create/fund (via vote), pause, resume, update, cancel, sweep.
- **Guardians**: accounts the plan owner names (`set_guardians`, or `guardians` in the plan input), e.g. one council member. Can pause a plan alone; cannot resume, change or move anything. The pause event records who did it.
- **Keeper**: any account; the reference keeper holds a function-call key limited to `run_due`.
- **Recipients**: NEAR accounts; may register a cross-chain destination.
- **1Click (NEAR Intents)**: signs quotes and executes swaps off-chain.
- **Contract owner**: can toggle storage sponsorship, limits, the token allowlist, and rotate the 1Click public key (`set_config`, owner-only). Cannot touch plan funds.
- **Full-access key holder of the contract account**: can redeploy the contract (see "Upgrade and admin keys").

## What each actor can and cannot do

| Actor | Can | Cannot |
|---|---|---|
| Keeper (compromised key) | Trigger a due run up to one polling interval early; spend its own gas allowance; choose the slippage of the 1Click quotes it fetches (`ROUTE_SLIPPAGE_BPS`, no on-chain floor); omit a route, so a recipient with a registered destination is paid on NEAR instead of their chain | Change recipients, amounts, cadence; move funds to itself; pay a non-due plan; pay partially; route a payout without a 1Click signature over the recipient's registered address |
| Guardian (compromised account) | Pause the plans it guards, i.e. delay pay until the DAO votes to resume (missed periods are back-paid unless the DAO says `skip_missed`) | Resume, change recipients/amounts, sweep, or touch any funds |
| Treasury | Everything above through votes; sweep remaining balance any time (not mid-run) | Claw back a payout already sent |
| Recipient | Register/clear their own destination | Change anyone else's destination or amounts |
| Contract owner | Rotate the 1Click key, toggle sponsored storage | Access plan balances |
| Keeper + contract owner (collusion) | Rotate the 1Click key to one they control, then sign "quotes" whose `depositAddress` is their own while the `recipient` / `destinationAsset` / `refundTo` checks still pass, because those compare against the recipient's registration, not against 1Click | Touch recipients paid on NEAR (no route involved); hide the rotation: `set_config` emits `config_updated`, so a key change is visible on-chain before the next run. Mitigation: hold the owner key under DAO control (see below) |
| 1Click | Execute or refund the swap it quoted | Receive funds for an unquoted address: the contract only pays `depositAddress` from a signed quote whose `recipient`/`destinationAsset` equal the recipient's own registration |

## Upgrade and admin keys
- `standing-order.testnet` (the contract account) holds a full-access key owned by the author, so the contract is
  upgradable (`deploy --migrate`, `migrate()`) by that key holder. On testnet this is deliberate: it is how the
  demo was iterated.
- `keeper.standing-order.testnet` holds the `run_due`-only function-call key the keeper service uses **and** a
  full-access key used by the operations scripts. The keeper service checks the key it is given at start and
  refuses to run with the full-access one (`Refusing to run with a full-access key`).
- `set_config` is owner-only. It toggles sponsorship and limits and rotates the 1Click public key, and emits
  `config_updated`.
- FT plan balances sit in the contract's own token balance at the token contract; they are segregated per plan
  only by the contract's accounting. An upgrade could therefore move them.
- **Recommendation for mainnet:** deploy under a DAO-controlled account (the Sputnik DAO is the only full-access
  signer, upgrades go through a vote) or remove the full-access key after deployment and set `owner` to the DAO,
  so that key rotation and any future upgrade are DAO decisions with an on-chain record.

## Cross-chain route verification (contract/src/routes.rs)
1. Rebuild 1Click's signed message exactly as the SDK does: the documented subset of request and quote fields,
   quote fields overriding request fields, keys sorted, compact JSON, `base58(sha256(json))`.
2. `env::ed25519_verify` against the configured 1Click manager key (default from the official SDK, owner-rotatable).
3. Bindings: non-dry quote; `originAsset == nep141:<plan token>`; `amount == recipient amount`; `destinationAsset` and
   `recipient` equal the recipient's registration; `refundTo == recipient account`; `deadline > now + 60 s`.
4. On any mismatch the whole `run_due` call panics; nothing is paid.

## What we rely on NEAR Intents for
- **Authenticity.** A route is only paid if 1Click signed it. The signature is checked on-chain with ed25519
  (`env::ed25519_verify`), not by the keeper; the unit test `real_live_quote_verifies` checks a genuine production
  quote against 1Click's published key, and the sandbox suite refuses five forged or mismatched quotes.
- **Failure.** If 1Click cannot execute a signed quote, its refund flow returns the deposit to `refundTo`, which the
  contract forces to be the recipient's own NEAR account. The plan was already debited when the deposit was paid,
  so there is no double pay and no re-credit; the recipient ends up paid on NEAR instead. The keeper tracks each
  routed payout's 1Click status (`SUBMITTED` → `SUCCESS` / `REFUNDED` / `FAILED`) and logs transitions.
- **Liveness.** `run_due` is permissionless. If the reference keeper or 1Click is down, anyone can call `run_due`
  without routes and every recipient is paid on NEAR; nothing is stuck behind the keeper.
- **Limits.** The contract cannot force 1Click to execute a swap it signed; the 1Click key is owner-rotatable (see
  the collusion row above); and 1Click has no testnet, so the routed path is proven in the sandbox and by the
  real-quote unit test, not yet by a settled mainnet payout.

Design note: `refundTo` is the recipient, not the treasury. A failed route must not silently return money to the
DAO after the plan has recorded the period as paid; the recipient keeps their pay, on NEAR, and no accounting
diverges.

## Privacy
Recipients and amounts are public on-chain, as with any Sputnik payment proposal; a Standing Order plan additionally
publishes the cadence and the funding horizon. Mitigations available today: pay opaque sub-accounts (one per
contributor, named arbitrarily) and group contributors into plans so a single plan does not identify a person's
salary. Future work: shielded payouts, where the plan records a commitment and the recipient claims the amount.

## Operational notes
- Native transfers to non-existent accounts and token transfers to unregistered accounts fail safely: the
  callback marks the payout `Failed` and re-credits the plan balance; the schedule still advances.
- A plan that cannot afford a full run is reported by `get_underfunded_plans` and is not "due", so keepers do
  not burn gas on it.
- Storage: plan creation and every payout/route record draw on the plan owner's storage credits
  (`storage_deposit`, minimum 0.00125 NEAR), or on sponsorship when enabled (demo default). With sponsorship off and
  no credits, `run_due` is refused with "Insufficient storage credits" rather than spending the contract balance that
  holds NEAR plans' funds. Disable sponsorship in production (`set_config`); a DAO then prepays about 0.0012 NEAR per
  payout (roughly 0.012 NEAR a month for ten contributors paid monthly).
- Token allowlist: `ft_on_transfer` can be called by any account claiming to be a token, so only contracts in
  `allowed_tokens` may fund plans (`None` accepts any token and is meant for local tests only). The v3 → v4 migration
  set it to the tokens existing plans already used (`usdc.fakes.testnet` on the demo deployment).
- Quote replay: each 1Click deposit address can be paid once; reusing a signed quote fails with "Route deposit
  address was already used". `correlation_id` in a route record comes from the unsigned part of 1Click's response
  and is informational only.
- Mid-run pause: a guardian may pause between the chunks of a split run. The owner can then update, sweep or
  cancel; the unpaid remainder of that run is dropped (event `run_aborted` with paid/unpaid counts) and the period
  counts as done, so recipients already paid are never paid twice.
- `resume_plan` defaults to back pay (missed periods are paid one per `run_due` call); `skip_missed: true`
  forgets them. Both are explicit DAO decisions. This is payroll automation, not a vesting lock: the DAO can sweep
  at any time.
- Keeper key allowance is immutable once set; add a new key when it is spent.
- Fiat: out of scope. Standing Order pays tokens to accounts and addresses; off-ramping, invoicing and tax
  reporting are left to the recipient or to tools built on the payout events.

## Payroll clerk (NEAR AI Cloud)
- Inputs (invoices, agreements) go only to a NEAR-operated model in a TEE; the clerk keeps the exact request/response
  hashes, a nonce-bound attestation summary and the model-TEE signature, and the dashboard shows whether they verify.
- What is proven: the model identity and enclave attestation, and that this exact output came from this exact input.
  What is not: that the output is correct. Deterministic checks (`clerk/src/checks.ts`) and on-chain lookups run
  regardless, and the model may only restate or add observations, never remove findings.
- The clerk never signs transactions on its own. It files proposals only with `--file`, through the same council
  account and Sputnik vote as a human would, and refuses to file when a blocking finding exists.
- Residual trust: NEAR AI Cloud's gateway and NVIDIA/Intel attestation roots; the clerk does not yet replay the TDX
  event log or query NVIDIA NRAS (see clerk/README.md).
