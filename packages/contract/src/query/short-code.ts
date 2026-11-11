import { canonicalJson } from "./canonical.ts";
import type { QuerySpec } from "./spec.ts";

// This package compiles without DOM or Node types. The browser and Node both have these globals.
declare const crypto: {
  subtle: { digest: (algorithm: "SHA-256", data: Uint8Array) => Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode: (text: string) => Uint8Array };

/** What a short link opens: a builder query or a SQL statement. */
export type ShortLinkTarget = { kind: "spec"; spec: QuerySpec } | { kind: "sql"; text: string };

// Crockford's base32 in lower case: no i, l, o, or u, so a code reads aloud without mix-ups.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const LENGTH = 10;
const BITS = 5n * BigInt(LENGTH);
const BYTES = 7;

/**
 * The code in `/s/<code>`: ten characters from the SHA-256 of the target. The same query always
 * gets the same code. The hash covers the kind, so a spec and a SQL text never share one.
 */
export async function shortCode(target: ShortLinkTarget): Promise<string> {
  const text = target.kind === "spec" ? canonicalJson(target.spec) : target.text.trim();
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${target.kind}\n${text}`),
  );
  const leading = new Uint8Array(hash)
    .slice(0, BYTES)
    .reduce((bits, byte) => (bits << 8n) | BigInt(byte), 0n);
  const bits = leading >> (BigInt(BYTES * 8) - BITS);

  return Array.from({ length: LENGTH }, (_, index) =>
    ALPHABET.charAt(Number((bits >> (5n * BigInt(LENGTH - 1 - index))) & 31n)),
  ).join("");
}
