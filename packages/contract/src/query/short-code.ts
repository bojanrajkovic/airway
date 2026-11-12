import { canonicalJson } from "./canonical.ts";
import type { QuerySpec } from "./spec.ts";

// This package is built without DOM or Node types, so it declares the two globals it uses. Node
// and browsers both provide them.
declare const crypto: {
  subtle: { digest: (algorithm: "SHA-256", data: Uint8Array) => Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode: (text: string) => Uint8Array };

/** What a short link opens: a builder query or a SQL statement. */
export type ShortLinkTarget = { kind: "spec"; spec: QuerySpec } | { kind: "sql"; text: string };

// Crockford's base32 in lower case. It leaves out i, l, o, and u, which are easy to misread.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const LENGTH = 10;
// Each character holds 5 bits, so a code needs 50 bits: the first 7 bytes of the hash hold 56.
const BITS = 5n * BigInt(LENGTH);
const BYTES = 7;

/**
 * Makes the code in `/s/<code>`: ten characters from the SHA-256 hash of the target. The same
 * target always gets the same code. The hash includes the kind, so a spec and a SQL statement
 * with the same text get different codes. A SQL statement is hashed without the white space at
 * its ends.
 */
export async function shortCode(target: ShortLinkTarget): Promise<string> {
  const text = target.kind === "spec" ? canonicalJson(target.spec) : target.text.trim();
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${target.kind}\n${text}`),
  );
  // Read the first 7 bytes as one number, keep its top 50 bits, and write them 5 bits at a time.
  const leading = new Uint8Array(hash)
    .slice(0, BYTES)
    .reduce((bits, byte) => (bits << 8n) | BigInt(byte), 0n);
  const bits = leading >> (BigInt(BYTES * 8) - BITS);

  return Array.from({ length: LENGTH }, (_, index) =>
    ALPHABET.charAt(Number((bits >> (5n * BigInt(LENGTH - 1 - index))) & 31n)),
  ).join("");
}
