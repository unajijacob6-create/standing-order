// Cross-chain routes for the keeper: ask NEAR Intents 1Click for a signed quote per recipient who
// registered a destination, verify the signature locally, and hand the raw quote to the contract,
// which verifies it again on-chain before paying the deposit address.
//
// CROSSCHAIN=off   never quote (pay everyone on NEAR)
// CROSSCHAIN=dry   fetch dry quotes for logging only, still pay on NEAR (default on testnet)
// CROSSCHAIN=live  fetch real quotes and route payouts (mainnet)
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";

export type Mode = "off" | "dry" | "live";
export interface Destination {
  asset_id: string;
  address: string;
  updated_at: number;
}
export interface Route {
  recipient: string;
  quote: string;
}
export interface RouteLog {
  recipient: string;
  destination: Destination;
  ok: boolean;
  mode: Mode;
  depositAddress?: string;
  amountOut?: string;
  correlationId?: string;
  error?: string;
}

const ONE_CLICK = process.env.ONE_CLICK_URL ?? "https://1click.chaindefuser.com";
const JWT = process.env.ONE_CLICK_JWT; // optional partner token (lower fee); 0.25% without

/** Ask 1Click for a quote that is bound to exactly this recipient's payout. */
export async function quoteRoute(
  mode: Mode,
  tokenContract: string,
  recipient: string,
  amount: string,
  dest: Destination,
  log: (e: string, d?: unknown) => void,
): Promise<{ route?: Route; info: RouteLog }> {
  const info: RouteLog = { recipient, destination: dest, ok: false, mode };
  if (mode === "off") return { info };
  const deadline = new Date(Date.now() + 20 * 60_000).toISOString();
  const body = {
    dry: mode !== "live",
    swapType: "EXACT_INPUT",
    slippageTolerance: Number(process.env.ROUTE_SLIPPAGE_BPS ?? 100),
    originAsset: `nep141:${tokenContract}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: dest.asset_id,
    amount,
    refundTo: recipient, // refunds go to the recipient's own NEAR account, never to the keeper
    refundType: "ORIGIN_CHAIN",
    recipient: dest.address,
    recipientType: "DESTINATION_CHAIN",
    deadline,
  };
  try {
    const res = await fetch(`${ONE_CLICK}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(JWT ? { authorization: `Bearer ${JWT}` } : {}) },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    if (!res.ok) {
      info.error = json?.message ?? `HTTP ${res.status}`;
      log("route unavailable, paying on NEAR", { recipient, error: info.error });
      return { info };
    }
    if (!verifyQuoteSignature(json)) {
      info.error = "quote signature invalid";
      log("route rejected", { recipient, error: info.error });
      return { info };
    }
    info.correlationId = json.correlationId;
    info.amountOut = json.quote?.amountOut;
    info.depositAddress = json.quote?.depositAddress;
    info.ok = true;
    if (mode !== "live") {
      // Only live mode routes payouts; any other mode requested a dry (unexecutable) quote.
      log("dry quote", { recipient, amountIn: amount, amountOut: info.amountOut, destination: dest.asset_id });
      return { info };
    }
    return { route: { recipient, quote: JSON.stringify(json) }, info };
  } catch (e) {
    info.error = String(e).slice(0, 200);
    log("route error, paying on NEAR", { recipient, error: info.error });
    return { info };
  }
}

export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

/** Poll the swap status of a deposit address. */
export async function swapStatus(depositAddress: string): Promise<{ status: SwapStatus; details?: any } | undefined> {
  const res = await fetch(`${ONE_CLICK}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
    headers: JWT ? { authorization: `Bearer ${JWT}` } : {},
  });
  if (!res.ok) return undefined;
  const json: any = await res.json();
  return { status: json.status, details: json.swapDetails };
}
