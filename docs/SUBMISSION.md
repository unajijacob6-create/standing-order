# Submission (fill the blanks, then submit once)

Form: https://nearhackathon.com/#apply (or POST https://nearhackathon.com/api/applications, see HACKATHON.md).

| Field | Value |
|---|---|
| projectName | Standing Order |
| leadName | _____ |
| email | _____ |
| size | `1` |
| tracks | `["social", "realworld", "business", "privacy"]` |
| nearAddress | _____ (mainnet account for the prize) |
| projectUrl | https://github.com/unajijacob6-create/standing-order |
| demoUrl | https://x.com/_____/status/_____ |
| idea | see below |
| consent | true (after reading: "I agree that the organizers may use these details to review our submission and contact us about this hackathon.") |

## idea (20–2000 chars)

Treasuries on NEAR pay the same contributors every month, yet every payment is a fresh Sputnik proposal that humans must file, vote on and sign; Trezu and NEAR Business offer single, bulk and vesting payments but nothing recurring. Standing Order is a recurring-payroll primitive for Sputnik DAO treasuries. The DAO funds and authorises a plan in one vote (a FunctionCall proposal on the token, exactly the shape Trezu's custom templates file). From then on the contract pays each recipient on schedule within the council's caps; a keeper whose access key can only call run_due triggers each period (the keeper accounts hold no other keys), a run starts only when fully funded, failed transfers re-credit, any guardian the DAO names (one council member) can pause alone as an emergency stop, and the council can resume (with or without back pay), update or cancel by vote. Recipients choose where to be paid: on mainnet a registered destination routes their payout through NEAR Intents (Intents has no testnet, so here it is proven by tests), and the contract verifies 1Click's ed25519 quote signature, binds the quote to the recipient's own address, the exact amount and a recipient-owned refund target, and pays each signed deposit address only once. A private payroll clerk on NEAR AI Cloud reads contributor invoices inside a TEE, drafts the proposal, flags units slips, duplicates, unknown accounts, raises and runway across every action, and keeps a nonce-bound receipt signed by the model's enclave key. Live on testnet with a Sputnik DAO, a keeper on GitHub Actions, seven Trezu templates compiled with Trezu's own engine, 78 tests in CI (53 unit, 9 sandbox, 16 clerk) incl. a real signed 1Click quote, a token allowlist and storage accounting hardened after a code review, and `npm run judge`: six zero-key checks any judge can run. NEAR pieces: Sputnik DAO, Trezu templates, function-call keys, NEAR Intents 1Click, named accounts, NEP-141/NEP-297, NEAR AI Cloud.
