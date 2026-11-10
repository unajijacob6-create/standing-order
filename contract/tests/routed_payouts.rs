//! Sandbox tests for cross-chain routed payouts: the contract pays a 1Click deposit address only
//! when the keeper presents a quote signed by the configured 1Click key and bound to the
//! recipient's registered destination. A test key stands in for 1Click here; the real 1Click
//! signature is covered by the unit tests in `src/routes.rs`.

use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{network::Sandbox, Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const WASM_PATH: &str = "target/wasm32-unknown-unknown/release/standing_order.wasm";
const TOKEN_WASM_PATH: &str = "test-contracts/test-token/target/wasm32-unknown-unknown/release/test_token.wasm";
const USD: u128 = 1_000_000;
const BASE_USDC: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const BASE_ADDR: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

struct Env {
    worker: Worker<Sandbox>,
    so: Contract,
    token: Contract,
    dao: Account,
    signer: SigningKey,
}

fn pubkey_string(k: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(k.verifying_key().to_bytes()).into_string())
}

async fn setup() -> anyhow::Result<Env> {
    let wasm = std::fs::read(WASM_PATH)?;
    let token_wasm = std::fs::read(TOKEN_WASM_PATH)?;
    let worker = near_workspaces::sandbox().await?;
    let so = worker.dev_deploy(&wasm).await?;
    let token = worker.dev_deploy(&token_wasm).await?;
    let admin = worker.dev_create_account().await?;
    so.call("new").args_json(json!({"owner_id": admin.id(), "sponsor_storage": true, "min_interval_seconds": 1})).transact().await?.into_result()?;
    token.call("new").args_json(json!({"decimals": 6})).transact().await?.into_result()?;
    // Stand-in for the 1Click manager key.
    let signer = SigningKey::generate(&mut rand::rngs::OsRng);
    admin
        .call(so.id(), "set_config")
        .args_json(json!({"oneclick_public_key": pubkey_string(&signer)}))
        .transact()
        .await?
        .into_result()?;
    let cfg: Value = so.view("get_config").await?.json()?;
    assert_eq!(cfg["oneclick_public_key"], pubkey_string(&signer));
    let dao = worker.dev_create_account().await?;
    register(&token, &admin, so.id()).await?;
    token.call("mint").args_json(json!({"account_id": dao.id(), "amount": (10_000 * USD).to_string()})).transact().await?.into_result()?;
    Ok(Env { worker, so, token, dao, signer })
}

async fn register(token: &Contract, payer: &Account, account: &near_workspaces::AccountId) -> anyhow::Result<()> {
    payer.call(token.id(), "storage_deposit").args_json(json!({"account_id": account, "registration_only": true})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    Ok(())
}

async fn ft_balance(token: &Contract, account: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let v: String = token.view("ft_balance_of").args_json(json!({"account_id": account})).await?.json()?;
    Ok(v.parse()?)
}

/// Build a quote response exactly like 1Click's, signed by `signer`.
fn signed_quote(signer: &SigningKey, origin_asset: &str, amount: u128, recipient: &str, refund_to: &str, deposit_address: &str, deadline: &str) -> String {
    let request = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 100,
        "originAsset": origin_asset, "depositType": "ORIGIN_CHAIN", "destinationAsset": BASE_USDC,
        "amount": amount.to_string(), "refundTo": refund_to, "refundType": "ORIGIN_CHAIN",
        "recipient": recipient, "recipientType": "DESTINATION_CHAIN", "deadline": "2026-11-09T06:00:00.000Z",
        "confidentiality": "public", "quoteWaitingTimeMs": 0, "insured": false,
        "appFees": [{"recipient": "5880ad2b", "fee": 1, "limitOrderId": null}]
    });
    let amount_out = amount - amount / 1000;
    let quote = json!({
        "amountIn": amount.to_string(), "amountInFormatted": "x", "amountInUsd": "x", "minAmountIn": amount.to_string(),
        "amountOut": amount_out.to_string(), "amountOutFormatted": "x", "amountOutUsd": "x", "minAmountOut": (amount_out - 1000).to_string(),
        "timeEstimate": 22, "refundFee": "4528", "withdrawFee": "2400",
        "deadline": deadline, "timeWhenInactive": deadline, "depositAddress": deposit_address
    });
    let timestamp = "2026-11-08T20:25:36.811Z";
    // Same subset + ordering rules as the SDK: request fields, then quote fields override, then timestamp.
    let mut m: BTreeMap<&str, Value> = BTreeMap::new();
    for k in ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"] {
        m.insert(k, request[k].clone());
    }
    for k in ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut", "depositAddress", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"] {
        m.insert(k, quote[k].clone());
    }
    m.insert("timestamp", Value::String(timestamp.into()));
    let canonical = format!("{{{}}}", m.iter().map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), serde_json::to_string(v).unwrap())).collect::<Vec<_>>().join(","));
    let message = bs58::encode(Sha256::digest(canonical.as_bytes())).into_string();
    let signature = format!("ed25519:{}", bs58::encode(signer.sign(message.as_bytes()).to_bytes()).into_string());
    json!({"quote": quote, "quoteRequest": request, "signature": signature, "timestamp": timestamp, "correlationId": "test-corr"}).to_string()
}

#[tokio::test]
async fn routed_payout_goes_to_verified_deposit_address() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.worker.dev_create_account().await?; // wants USDC on Base
    let bob = env.worker.dev_create_account().await?; // paid on NEAR
    // A real 1Click deposit address: a fresh 64-hex implicit account, NOT registered on the token.
    // The contract must register it before transferring (a plain ft_transfer would fail).
    let deposit_id: near_workspaces::AccountId = "702bb1cdf6e6d1f80776679b6e0f2745226efd76cda7563fe0f45ee1d1929d87".parse()?;
    for a in [alice.id(), bob.id()] {
        register(&env.token, &env.dao, a).await?;
    }
    alice
        .call(env.so.id(), "register_destination")
        .args_json(json!({"asset_id": BASE_USDC, "address": BASE_ADDR}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;

    let msg = json!({"action": "create_plan", "plan": {"title": "routed", "asset": {"Ft": {"contract": env.token.id()}}, "recipients": [{"account_id": alice.id(), "amount": (100 * USD).to_string()}, {"account_id": bob.id(), "amount": (50 * USD).to_string()}], "interval_seconds": 3600}}).to_string();
    env.dao
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": env.so.id(), "amount": (300 * USD).to_string(), "msg": msg}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let dests: Vec<(String, Value)> = env.so.view("get_plan_destinations").args_json(json!({"plan_id": 1})).await?.json()?;
    assert_eq!(dests.len(), 1);
    assert_eq!(dests[0].0, alice.id().to_string());

    let origin = format!("nep141:{}", env.token.id());
    let good = signed_quote(&env.signer, &origin, 100 * USD, BASE_ADDR, alice.id().as_str(), deposit_id.as_str(), "2026-11-12T06:00:00.000Z");

    // Wrong amount: refused, nothing paid.
    let bad_amount = signed_quote(&env.signer, &origin, 99 * USD, BASE_ADDR, alice.id().as_str(), deposit_id.as_str(), "2026-11-12T06:00:00.000Z");
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": alice.id(), "quote": bad_amount}]})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(res.is_failure());
    assert!(format!("{:?}", res.failures()).contains("Route amount does not match"), "{:?}", res.failures());

    // Refund target that is not the recipient: refused.
    let bad_refund = signed_quote(&env.signer, &origin, 100 * USD, BASE_ADDR, "attacker.near", deposit_id.as_str(), "2026-11-12T06:00:00.000Z");
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": alice.id(), "quote": bad_refund}]})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(format!("{:?}", res.failures()).contains("refund target"), "{:?}", res.failures());

    // Quote for a different address than alice registered: refused.
    let bad_addr = signed_quote(&env.signer, &origin, 100 * USD, "0x1111111111111111111111111111111111111111", alice.id().as_str(), deposit_id.as_str(), "2026-11-12T06:00:00.000Z");
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": alice.id(), "quote": bad_addr}]})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(format!("{:?}", res.failures()).contains("recipient address differs"), "{:?}", res.failures());

    // Signed by someone other than the configured key: refused.
    let other = SigningKey::generate(&mut rand::rngs::OsRng);
    let forged = signed_quote(&other, &origin, 100 * USD, BASE_ADDR, alice.id().as_str(), deposit_id.as_str(), "2026-11-12T06:00:00.000Z");
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": alice.id(), "quote": forged}]})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(format!("{:?}", res.failures()).contains("does not verify"), "{:?}", res.failures());

    // A route for bob, who never registered a destination: refused.
    let for_bob = signed_quote(&env.signer, &origin, 50 * USD, BASE_ADDR, bob.id().as_str(), deposit_id.as_str(), "2026-11-12T06:00:00.000Z");
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": bob.id(), "quote": for_bob}]})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(format!("{:?}", res.failures()).contains("no registered destination"), "{:?}", res.failures());

    // Nothing moved so far.
    assert_eq!(ft_balance(&env.token, &deposit_id).await?, 0);
    assert_eq!(ft_balance(&env.token, alice.id()).await?, 0);

    // The genuine route: alice's 100 goes to the deposit address, bob's 50 to bob.
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": alice.id(), "quote": good}]})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(res.is_success(), "{:?}", res.failures());
    let logs = res.logs().iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(logs.iter().any(|l| l.contains("payout_routed")), "{logs:?}");
    assert_eq!(ft_balance(&env.token, &deposit_id).await?, 100 * USD);
    assert_eq!(ft_balance(&env.token, alice.id()).await?, 0);
    assert_eq!(ft_balance(&env.token, bob.id()).await?, 50 * USD);
    let route: Value = env.so.view("get_route").args_json(json!({"plan_id": 1, "seq": 0})).await?.json()?;
    assert_eq!(route["deposit_address"], deposit_id.to_string());
    assert_eq!(route["destination_address"], BASE_ADDR);
    assert_eq!(route["destination_asset"], BASE_USDC);
    let none: Option<Value> = env.so.view("get_route").args_json(json!({"plan_id": 1, "seq": 1})).await?.json()?;
    assert!(none.is_none(), "bob's payout has no route");

    // Expired deposit address: refused on the next run.
    env.worker.fast_forward(5).await?;
    let expired = signed_quote(&env.signer, &origin, 100 * USD, BASE_ADDR, alice.id().as_str(), deposit_id.as_str(), "2020-01-01T00:00:00.000Z");
    let res = env.dao.call(env.so.id(), "run_due").args_json(json!({"plan_id": 1, "routes": [{"recipient": alice.id(), "quote": expired}]})).gas(Gas::from_tgas(300)).transact().await?;
    // Either NotDue (interval not elapsed) or the expiry error; both mean no payment went out.
    if res.is_failure() {
        assert!(format!("{:?}", res.failures()).contains("expires too soon"), "{:?}", res.failures());
    }
    assert_eq!(ft_balance(&env.token, &deposit_id).await?, 100 * USD);
    Ok(())
}
