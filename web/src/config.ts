export const NETWORK = (import.meta.env.VITE_NETWORK as "testnet" | "mainnet") ?? "testnet";
export const RPC_URL = import.meta.env.VITE_RPC ?? (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
export const CONTRACT = import.meta.env.VITE_CONTRACT ?? "standing-order.testnet";
export const DAO = import.meta.env.VITE_DAO ?? "payroll-demo.sputnik-v2.testnet";
export const TOKEN = import.meta.env.VITE_TOKEN ?? "usdc.fakes.testnet";
export const KEEPER_URL = import.meta.env.VITE_KEEPER_URL ?? "";
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const REPO_URL = import.meta.env.VITE_REPO_URL ?? "https://github.com/unajijacob6-create/standing-order";

/** Curated cross-chain destinations (NEAR Intents asset ids, from https://1click.chaindefuser.com/v0/tokens). */
export const DESTINATIONS = [
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", label: "USDC on Base", chain: "Base", symbol: "USDC" },
  { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", label: "USDC on Arbitrum", chain: "Arbitrum", symbol: "USDC" },
  { id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", label: "USDC on Ethereum", chain: "Ethereum", symbol: "USDC" },
  { id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", label: "USDC on Solana", chain: "Solana", symbol: "USDC" },
  { id: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", label: "USDT on Ethereum", chain: "Ethereum", symbol: "USDT" },
  { id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", label: "USDT on Solana", chain: "Solana", symbol: "USDT" },
];

export function destinationLabel(assetId: string): string {
  return DESTINATIONS.find((d) => d.id === assetId)?.label ?? assetId.replace("nep141:", "").slice(0, 24) + "…";
}
