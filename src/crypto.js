// Web Push payload encryption — RFC 8291 (aes128gcm) over RFC 8188.
//
// Deliberately built on Web Crypto only, so the same code runs on Cloudflare
// Workers, Deno, Bun and Node 18+. Most npm push libraries can't: they either
// reach for Node's `crypto.createECDH`, or they still emit the superseded
// `aesgcm` (draft-04) content coding, which Apple's push service rejects
// outright. Safari's PushManager.supportedContentEncodings is ["aes128gcm"].

export function concatBytes(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

export function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf) {
  const arr = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encrypt a push payload for one subscription.
 *
 * `testVector` injects the ephemeral keypair and salt that are otherwise random;
 * it exists so the RFC 8291 §5 example can be reproduced byte-for-byte, and has
 * no use in production.
 *
 * @returns {Promise<Uint8Array>} the aes128gcm request body
 */
export async function encryptPayload(plaintext, p256dhB64, authB64, testVector) {
  const uaPublic = b64urlToBytes(p256dhB64);  // recipient public key, 65 bytes
  const authSecret = b64urlToBytes(authB64);  // 16 bytes

  // Ephemeral application-server ECDH keypair.
  const asKeys = testVector?.asKeys || await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey)); // 65 bytes

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256)
  );

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0"||ua_public||as_public)
  const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
  const ecdhKey = await crypto.subtle.importKey("raw", ecdhSecret, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo }, ecdhKey, 256
  ));

  const salt = testVector?.salt || crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: aes128gcm\0") }, ikmKey, 128
  ));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: nonce\0") }, ikmKey, 96
  ));

  // Single record: plaintext followed by the 0x02 last-record delimiter (RFC 8188).
  const record = concatBytes(new TextEncoder().encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concatBytes(header, ciphertext);
}

/**
 * Build the VAPID `Authorization` header for one push endpoint (RFC 8292).
 * The JWT is scoped to the endpoint's origin, so it can't be replayed elsewhere.
 */
export async function vapidAuthHeader({ endpoint, publicKey, privateJwk, contact, ttlSeconds = 12 * 60 * 60 }) {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds, // must be < 24h per spec
    sub: contact,
  };
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;

  const key = await crypto.subtle.importKey(
    "jwk", typeof privateJwk === "string" ? JSON.parse(privateJwk) : privateJwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  // Web Crypto ECDSA returns raw r||s — already the JOSE signature format.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${publicKey}`;
}
