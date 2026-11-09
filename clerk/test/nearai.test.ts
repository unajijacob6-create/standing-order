import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeReport } from "../src/nearai.ts";

const nonce = "ab".repeat(32);

test("nonce is echoed only when every model attestation returns it", () => {
  assert.equal(summarizeReport({ model_attestations: [{ signing_address: "0xA", request_nonce: nonce }] }, nonce).nonce_echoed, true);
  assert.equal(summarizeReport({ model_attestations: [{ signing_address: "0xA", request_nonce: "00" }] }, nonce).nonce_echoed, false);
});

test("no model attestations is not echoed (no vacuous truth)", () => {
  assert.equal(summarizeReport({ model_attestations: [] }, nonce).nonce_echoed, false);
  assert.equal(summarizeReport({}, nonce).nonce_echoed, false);
  assert.equal(summarizeReport({ gateway_attestation: { signing_address: "0xG", request_nonce: nonce } }, nonce).nonce_echoed, false);
});

test("a missing request_nonce is not echoed", () => {
  assert.equal(summarizeReport({ model_attestations: [{ signing_address: "0xA" }] }, nonce).nonce_echoed, false);
  const gwMissing = { model_attestations: [{ signing_address: "0xA", request_nonce: nonce }], gateway_attestation: { signing_address: "0xG" } };
  assert.equal(summarizeReport(gwMissing, nonce).nonce_echoed, false);
  const gwOk = { ...gwMissing, gateway_attestation: { signing_address: "0xG", request_nonce: nonce } };
  const s = summarizeReport(gwOk, nonce);
  assert.equal(s.nonce_echoed, true);
  assert.deepEqual(s.model_signing_addresses, ["0xa"]);
  assert.equal(s.gateway_signing_address, "0xg");
});
