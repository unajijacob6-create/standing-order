# Private payroll clerk (NEAR AI Cloud)

The clerk is the one place in Standing Order where a language model earns its keep: reading the
documents humans actually have (invoices, agreements, a CSV from the community lead) and turning
them into a payroll proposal the council can vote on, plus a plain-English brief of what a pending
proposal really does. Everything else in Standing Order is deterministic on purpose.

Why private: salary data is the most sensitive thing a treasury holds. The clerk sends documents only
to a **NEAR-operated model inside a hardware enclave (TEE)** on [NEAR AI Cloud](https://cloud.near.ai),
and keeps a receipt that lets anyone re-verify the run.

## What a receipt proves

For every model call (`clerk/src/nearai.ts`):

1. **Preflight attestation with a fresh nonce.** `GET /v1/attestation/report?model=…&provider=near&nonce=…`
   returns the gateway and model-TEE signing addresses with Intel TDX and NVIDIA evidence; the nonce must be
   echoed back (replay protection).
2. **Exact bytes.** The request body is hashed before sending; the response bytes are hashed before parsing.
3. **Signature.** `GET /v1/signature/<chat id>` returns `text = <model>:<sha256(request)>:<sha256(response)>`
   signed by the model TEE (`signature_kind = provider_tee`). The clerk recovers the EIP-191 signer and requires
   it to equal exactly one attested model address from step 1.
4. The receipt (`model`, `nonce`, hashes, signature, recovered signer, per-check results) is stored next to the review.

`verified = true` additionally requires that the report contains at least one model attestation and that
every model attestation (and the gateway attestation, when present) echoes our nonce; a missing nonce
counts as not echoed.

Limits, stated plainly: the clerk checks the signer against the signing addresses the attestation report
lists and checks the nonce echo. It does **not** verify the Intel TDX quote or the NVIDIA GPU evidence in
that report (no TDX quote / event-log replay, no call to NVIDIA's attestation service); that hardware-quote
verification follows NEAR AI's verification docs and the official
[verification example](https://github.com/near-examples/nearai-cloud-verification-example), and is not done
by the clerk or offline by `npm run judge`. So a verified receipt shows that the answer to this exact input
was signed by the key NEAR AI Cloud's attestation report named for this model at the time; that the key
lives in a genuine enclave rests on the report's hardware quotes, which you verify separately. It never
proves the answer is correct. That is why deterministic checks run regardless.

## Deterministic checks (always run, never hidden by the model)

`clerk/src/checks.ts` and on-chain lookups: invalid or non-existent accounts, missing token storage
registration (the transfer would fail), duplicates, decimals slips (USDC has 6 decimals; 100 USDC is
`100000000` base units), dust, cap below the run total, loose caps, new recipients, raises above 50%,
cuts below 50%, removed recipients, unknown accounts, runway in runs, leftover funds.

`review` looks at **every action** of the proposal (`clerk/src/actions.ts`), not just the first. It
recognises `ft_transfer_call` on the plan token to the Standing Order contract with a `create_plan` /
`fund_plan` msg, and direct calls to the contract (`create_plan`, `fund_plan`, `update_plan`,
`pause_plan`, `resume_plan`, `cancel_plan`, `sweep`, `set_guardians`). It blocks any other action, any
`ft_transfer_call` on a different token, and any action that moves tokens to an account other than the
contract (for example an extra `ft_transfer`). `update_plan` without a recipients list, `sweep`,
`cancel_plan` and `set_guardians` always produce a warning, so they are never silently `ok`.

On the demo DAO the first draft was **blocked** because the new joiner's account did not exist yet on
testnet (the payout would have failed); after the account was created the same documents produced
proposal #23, approved as plan #4.

## Use

```bash
export NEARAI_CLOUD_API_KEY=sk-…        # cloud.near.ai → API Keys (hackathon builders get $10 via nearbuilders.org/join)
npm run clerk -- review 7               # brief + checks for a pending Sputnik proposal that touches Standing Order
npm run clerk -- draft clerk/samples --plan 3            # read invoices, compare with plan #3, propose an update
npm run clerk -- draft clerk/samples --file --vote \
   --title "November payroll" --interval 2592000 --runs 3   # file the drafted proposal on the DAO (and, on the demo DAO, approve it)
```

Each run writes `clerk/reviews/<proposal>.json` and refreshes `clerk/reviews/index.json`; the dashboard
publishes them (`web/public/reviews/`) and shows a **Clerk · ask · TEE-verified** badge on the request.
Model: `Qwen/Qwen3.8-27B` (NEAR-hosted, attested) with `z-ai/glm-5.3-flash` as fallback; reasoning is
disabled and output capped at 1,200 tokens because hackathon-tier accounts reserve credit per request.

Sample documents in `clerk/samples/` are fictional.
