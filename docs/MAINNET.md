# Mainnet runbook (cross-chain payouts need mainnet: 1Click has no testnet)

Budget: ~8 NEAR (contract storage ≈ 4 NEAR for the ~410 KB wasm, DAO creation 6 NEAR if you create one,
sub-accounts, keeper gas) plus the USDC you want to pay out (a $5 plan is enough to prove a routed payout).

1. Accounts: a funded mainnet account `<you>.near` with credentials in `~/.near-credentials/mainnet/`.
   ```bash
   export NEAR_NETWORK=mainnet SO_MASTER=<you>.near SO_CONTRACT=so.<you>.near \
          SO_TOKEN=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 \
          SO_DAO=<your-dao>.sputnik-dao.near SO_KEEPER=keeper.<you>.near SO_RECIPIENTS=<a>.near,<b>.near
   ```
2. Deploy: `npx tsx scripts/deploy.ts` (creates nothing; deploy the wasm to `SO_CONTRACT`, which you create as a sub-account first:
   `npx tsx scripts/setup-accounts.ts` creates recipients/keeper; create `so.<you>.near` with 5 NEAR via your wallet or near-cli).
   Register the contract on USDC: `storage_deposit` for `SO_CONTRACT` on the USDC contract (0.00125 NEAR).
   `scripts/deploy.ts` initialises with `allowed_tokens = [SO_TOKEN]` (only mainnet USDC can fund plans) and
   `sponsor_storage = true`; for production turn sponsorship off (`set_config`) and have the DAO prepay storage with
   `storage_deposit` on the Standing Order contract (about 0.0012 NEAR per payout).
3. Fund a plan. Generate the mainnet Trezu templates for your contract and token first:
   ```bash
   SO_CONTRACT=so.<you>.near SO_TOKEN=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 npx tsx trezu-templates/generate.ts mainnet
   ```
   Then from your DAO (Trezu → Custom → paste `trezu-templates/mainnet/so-create-plan.json`), or from a plain account:
   `ft_transfer_call` on USDC with `msg = {"action":"create_plan","plan":{...}}` (see `scripts/propose-plan.ts` for the exact JSON).
4. Recipient registers a destination: `npx tsx scripts/register-destination.ts <a>.near nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near 0xYourBaseAddress`.
5. Keeper: `npx tsx scripts/keeper-key.ts` then `CROSSCHAIN=live KEEPER_HTTP_PORT=8787 npm run keeper`.
   Watch: `route quoted` → `sent` with `payout_routed` in the receipt → keeper `swap status` transitions to `SUCCESS`
   with the Base transaction hash. The recipient's Base wallet shows USDC within ~1 minute.
6. Verify on-chain: `get_route(plan_id, seq)` returns the deposit address, destination and 1Click correlation id.

Quote minimums (Sep 2026 changelog): NEAR, Base, Arbitrum, Ethereum, Solana and BTC have none; several other
chains require $1,000+ per swap. Fees: 0.25% without a partner JWT (`ONE_CLICK_JWT`), 1 bp on stablecoin routes with one.
