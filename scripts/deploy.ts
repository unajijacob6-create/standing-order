// Deploy the Standing Order contract and initialise it (idempotent).
// Usage: tsx scripts/deploy.ts [--migrate]   (--migrate runs `migrate` in the same transaction as the deploy)
import fs from "node:fs";
import { actions } from "near-api-js";
import { account, cfg, log, provider, TGAS, view } from "./lib/near.ts";

const wasm = fs.readFileSync(new URL("../contract/target/wasm32-unknown-unknown/release/standing_order.wasm", import.meta.url));
const owner = account(cfg.contract);
const migrate = process.argv.includes("--migrate");
log("deploying", `${wasm.length} bytes to ${cfg.contract}${migrate ? " + migrate" : ""}`);
if (migrate) {
  await owner.signAndSendTransaction({
    receiverId: cfg.contract,
    actions: [actions.deployContract(new Uint8Array(wasm)), actions.functionCall("migrate", {}, TGAS(50), 0n)],
  });
} else {
  await owner.deployContract(new Uint8Array(wasm));
}
try {
  const config = await view(cfg.contract, "get_config");
  log("already initialised", config);
} catch {
  await owner.callFunction({
    contractId: cfg.contract,
    methodName: "new",
    // Only the configured token may fund plans: any account can call ft_on_transfer and claim to be a token.
    args: { owner_id: cfg.master, sponsor_storage: true, min_interval_seconds: Number(process.env.SO_MIN_INTERVAL ?? 60), allowed_tokens: cfg.token ? [cfg.token] : null },
    gas: TGAS(30),
  });
  log("initialised", await view(cfg.contract, "get_config"));
}
const state = await provider.viewAccount({ accountId: cfg.contract });
log("contract account", { storage_usage: state.storage_usage, balance_near: (Number(state.amount) / 1e24).toFixed(3) });
