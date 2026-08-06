#!/usr/bin/env node
// One-time VAPID keypair generator (RFC 8292).
//
//   npx webpush-edge-vapid
//
// The public key is safe to commit and is what the browser passes as
// applicationServerKey. The private JWK must be stored as a secret.

import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey)); // 65-byte uncompressed point
const jwk = await subtle.exportKey("jwk", kp.privateKey);
const b64url = (b) => Buffer.from(b).toString("base64url");

console.log("\nVAPID_PUBLIC_KEY  — commit this (wrangler.toml [vars] / wrangler.jsonc vars):");
console.log(b64url(pubRaw));
console.log("\nVAPID_PRIVATE_JWK — keep secret (npx wrangler secret put VAPID_PRIVATE_JWK, then paste):");
console.log(JSON.stringify(jwk));
console.log("\nRotating these invalidates every existing subscription; devices must re-subscribe.\n");
