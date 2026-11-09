# Judge checks (`npm run judge`) and ledger export (`npm run ledger`)

Both commands need only `npm ci` on a fresh clone: no NEAR account, no keys, no funds, no API key.
They only make view calls against the public testnet RPC (`https://test.rpc.fastnear.com`,
override with `NEAR_RPC_URL`) and read files already in the repository. Behind an HTTP proxy set
`NODE_USE_ENV_PROXY=1`.

## `npm run judge` (`scripts/judge.ts`)

Prints a numbered checklist, one line per check with `[ok]`, `[FAIL]` or `[skip]` and the
evidence under it, then `judge: N checks, N ok`. The exit code is non-zero if any check fails.
The same job runs in CI (`.github/workflows/test.yml`, job `judge`).

| # | Check | How | Needs |
|---|---|---|---|
| 1 | Contract reachable | `get_plans` on `standing-order.testnet`; prints plan count, active count and plan owners (the Sputnik DAO). | RPC |
| 2 | Payroll is actually running | Considers only plans whose owner is the demo DAO (`SO_DAO`, default `payroll-demo.sputnik-v2.testnet`), because anyone can create a plan on the contract. For each DAO plan it reads the newest run with `get_payouts` and fails if any payout in that run is `Failed`, or still `Pending` more than 10 minutes after it was dispatched. It prints the newest DAO payout (recipient, token-formatted amount via `ft_metadata` decimals, status, age) and fails if it is older than 180 minutes. Live plans run every 10–60 minutes. | RPC |
| 3 | Keeper key is restricted | `view_access_key_list` for every keeper account (`KEEPER_ACCOUNTS`, default `keeper.standing-order.testnet,keeper2.standing-order.testnet`). Passes only if every key is a `FunctionCall` key with `receiver_id = standing-order.testnet` and `method_names = ["run_due"]`; prints each key's permission and remaining allowance. | RPC |
| 4 | 1Click quote signature | Offline. Loads `contract/tests/fixtures/quote_live.json` (a real non-dry quote from the 1Click API), rebuilds the signed message exactly as `contract/src/routes.rs::signed_message` and the official SDK's `quoteHash` do (`base58(sha256(stable_json({...signedRequestFields, ...signedQuoteFields, timestamp})))`), and verifies the ed25519 signature against the 1Click manager key `reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` with Node's built-in `crypto`. Also confirms that changing the deposit address breaks the signature. | nothing |
| 5 | Clerk receipts are internally consistent | Offline. For every `clerk/reviews/proposal-*.json` and `draft-*.json`: signed text must equal `<model>:<request_hash>:<response_hash>`, the EIP-191 signer recovered with `ethers.verifyMessage` must equal the stored `recovered_signer` and appear exactly once in the `model_signing_addresses` that the same receipt recorded from the attestation report, the receipt must record the nonce as echoed and `verified = true`. This replays the `provider_tee` branch of `clerk/src/nearai.ts`. Because the address list comes from the same JSON file, this proves only that each receipt is internally consistent and that its signature is over these exact hashes; on its own it does not show that the address belonged to a NEAR AI TEE. | nothing |
| 6 | Receipt signer is in today's attestation report | Live. For each model named by the receipts, fetches `https://cloud-api.near.ai/v1/attestation/report?model=<model>` with a fresh nonce and no API key; requires at least one model attestation, the nonce echoed by every model attestation, and at least one stored receipt signer listed among today's model signing addresses. Fails if none of the stored signers is listed (for example after a key rotation; regenerate the receipts with the clerk). Skipped only if the endpoint cannot be reached (network error or HTTP 5xx). It prints whether the report carries Intel TDX and NVIDIA evidence but does not verify that evidence. | network |

What the checks do not prove: 4 and 5 verify signatures over data stored in the repository, so
they show the verification logic is sound and the stored artefacts are self-consistent, not that the
contract on testnet runs the same code as `contract/src` (the sandbox tests in `./scripts/test.sh`
cover the contract itself). Check 2 is a liveness probe and depends on the hosted keeper being up.

Checks 5 and 6 together show that the clerk's answers were signed by a key that NEAR AI Cloud's
attestation report lists, today, for that model. Neither check verifies the hardware quotes in the
report (the Intel TDX quote and the NVIDIA GPU evidence), so neither proves by itself that the key
lives in a genuine enclave; that hardware-quote verification follows NEAR AI's verification docs
(see the [verification example](https://github.com/near-examples/nearai-cloud-verification-example))
and is not done offline or by `npm run judge`. A listed signer today also does not prove the key
was listed at the moment a receipt was signed, only that the stored receipt recorded it so.

## `npm run ledger` (`scripts/ledger.ts`)

Exports every `PayoutRecord` on the contract (all plans, paged through `get_payouts`) joined with
its `RouteRecord` (`get_route`) when the payout went cross-chain.

```bash
npm run ledger                          # CSV on stdout
npm run ledger -- --out payouts.csv     # CSV to a file
npm run ledger -- --json                # JSON array
npm run ledger -- --owner payroll-demo.sputnik-v2.testnet   # only plans owned by this account
```

`--owner <account>` keeps only plans whose `owner` equals the account (default: every plan on the
contract; anyone can create a plan, so filter by your DAO for accounting).

Columns: `date` (ISO 8601 from the block timestamp), `plan_id`, `plan_title`, `seq`, `run_index`,
`recipient`, `amount` (decimal, token units), `token_symbol`, `token_contract` (`near` for native),
`status` (`Pending` / `Sent` / `Failed`; a failed transfer is re-credited to the plan),
`route` (`near` when paid directly, otherwise `<destination asset> → <destination address>`),
`route_destination_asset`, `route_destination_address`, `route_deposit_address` (the 1Click deposit
account the contract paid), `route_amount_out_base_units` (the quoted output in the destination
asset's base units, unformatted because its decimals differ from the source token's),
`route_correlation_id`, `source_dao` (plan owner), `amount_base_units`, `block_height`, `note`.
`route` is `unknown` (with a note) when the `get_route` lookup failed. Token metadata comes from
whatever contract a plan names, so `decimals` must be an integer from 0 to 36; otherwise `amount` is
shown in base units and `note` says why. A plan whose payouts cannot be read is skipped with a
warning on stderr instead of aborting the export. Text cells that start with `=`, `+`, `-`, `@`, a
tab or a carriage return are prefixed with `'` so spreadsheet apps do not evaluate them as formulas.
Rows are sorted by date, then plan and sequence.
