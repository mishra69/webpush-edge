// Reproduces the RFC 8291 §5 "Push Message Encryption Example" byte-for-byte.
//
// This is the whole reason to trust this implementation: encryption bugs here are
// silent. A wrong CEK or a mis-built header doesn't throw — the push service accepts
// the POST with a 201 and the device simply never shows a notification. The published
// vector pins every derivation step against known-good output.
//
// Run: node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptPayload, b64urlToBytes, bytesToB64url } from "../src/crypto.js";

// RFC 8291 §5
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AS_PRIVATE_D = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const EXPECTED_BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

// The 65-byte uncompressed point is 0x04 || x || y.
function pointToXY(b64) {
  const raw = b64urlToBytes(b64);
  return { x: bytesToB64url(raw.slice(1, 33)), y: bytesToB64url(raw.slice(33, 65)) };
}

async function importAsKeys() {
  const { x, y } = pointToXY(AS_PUBLIC);
  const jwk = { kty: "EC", crv: "P-256", x, y, d: AS_PRIVATE_D, ext: true };
  const privateKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, true, []
  );
  return { privateKey, publicKey };
}

test("RFC 8291 §5 encrypted message body matches the published vector", async () => {
  const body = await encryptPayload(PLAINTEXT, UA_PUBLIC, AUTH_SECRET, {
    asKeys: await importAsKeys(),
    salt: b64urlToBytes(SALT),
  });
  assert.equal(bytesToB64url(body), EXPECTED_BODY);
});

test("aes128gcm header framing is well formed", async () => {
  const body = await encryptPayload(PLAINTEXT, UA_PUBLIC, AUTH_SECRET, {
    asKeys: await importAsKeys(),
    salt: b64urlToBytes(SALT),
  });
  assert.deepEqual(body.slice(0, 16), b64urlToBytes(SALT), "salt is the first 16 bytes");
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, "record size is 4096");
  assert.equal(body[20], 65, "key id length is 65");
  assert.equal(bytesToB64url(body.slice(21, 86)), AS_PUBLIC, "key id is the AS public key");
});

test("each call uses a fresh salt and ephemeral key", async () => {
  const a = await encryptPayload(PLAINTEXT, UA_PUBLIC, AUTH_SECRET);
  const b = await encryptPayload(PLAINTEXT, UA_PUBLIC, AUTH_SECRET);
  assert.notEqual(bytesToB64url(a), bytesToB64url(b));
});
