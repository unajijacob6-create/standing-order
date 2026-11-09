// Destination address checks, run before the user is asked to sign register_destination. A wrong address on another
// chain cannot be recovered, so the form refuses anything that is not well-formed for the chosen chain.
// keccak_256 comes from @noble/hashes, which near-api-js already depends on and ships in the bundle.
import { keccak_256 } from "@noble/hashes/sha3.js";

const EVM_CHAINS = new Set(["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "BNB Chain", "Avalanche", "Gnosis"]);

/** EIP-55 mixed-case checksum of a 0x + 40 hex address. */
export function toChecksumAddress(addr: string): string {
  const lower = addr.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (Bitcoin alphabet) decode; null when a character is outside the alphabet. */
export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** null when `address` is valid for `chain`, else a short human explanation of what is wrong. */
export function validateDestination(chain: string, address: string): string | null {
  const a = address.trim();
  if (!a) return "Enter your address on " + chain + ".";
  if (/\s/.test(a)) return "The address contains spaces.";
  if (EVM_CHAINS.has(chain)) {
    if (!/^0x/i.test(a)) return `${chain} addresses start with 0x.`;
    if (!/^0x[0-9a-fA-F]*$/.test(a)) return `${chain} addresses contain only 0-9 and a-f after 0x.`;
    if (a.length !== 42) return `${chain} addresses are 0x followed by 40 hex characters (this one has ${a.length - 2}).`;
    if (!a.startsWith("0x")) return "Use a lowercase 0x prefix.";
    const body = a.slice(2);
    const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
    if (mixed && toChecksumAddress(a) !== a) return "The capitalisation does not match the EIP-55 checksum: there is probably a typo. Copy the address again from your wallet.";
    if (/^0x0{40}$/i.test(a)) return "That is the zero address.";
    return null;
  }
  if (chain === "Solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return "Solana addresses use base58 (no 0, O, I or l).";
    const bytes = base58Decode(a);
    if (!bytes || bytes.length !== 32) return `Not a Solana address: it decodes to ${bytes?.length ?? 0} bytes, expected 32.`;
    return null;
  }
  if (chain === "Bitcoin") {
    if (/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a)) return null;
    return "Not a Bitcoin address (expected bc1…, 1… or 3…).";
  }
  return a.length >= 20 && a.length <= 128 ? null : "That does not look like an address.";
}
