// Covers the delivery/storage layer with a fake KV namespace and a stubbed fetch,
// so the multi-device fan-out and pruning rules are pinned without a network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPusher, kvStore, buildPayload } from "../src/server.js";
import { bytesToB64url } from "../src/crypto.js";

function fakeKV() {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

// A subscription needs a real P-256 point, otherwise ECDH import fails.
async function fakeSubscription(id) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    endpoint: `https://web.push.apple.com/${id}`,
    keys: { p256dh: bytesToB64url(raw), auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

async function vapidJwk() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: bytesToB64url(raw), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}

let calls;
const realFetch = globalThis.fetch;
let respond = () => new Response(null, { status: 201 });

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  respond = () => new Response(null, { status: 201 });
});

async function makePusher(kv) {
  const { publicKey, privateJwk } = await vapidJwk();
  return createPusher({ publicKey, privateJwk, contact: "mailto:test@example.com", store: kvStore(kv) });
}

test("subscribe stores multiple devices and is idempotent per endpoint", async () => {
  const kv = fakeKV();
  const push = await makePusher(kv);
  const a = await fakeSubscription("device-a");
  const b = await fakeSubscription("device-b");

  assert.equal(await push.subscribe("user1", a), 1);
  assert.equal(await push.subscribe("user1", b), 2);
  assert.equal(await push.subscribe("user1", a), 2, "re-subscribing the same endpoint does not duplicate");
  assert.equal((await push.list("user1")).length, 2);
});

test("subscribe rejects a malformed subscription", async () => {
  const push = await makePusher(fakeKV());
  await assert.rejects(() => push.subscribe("user1", { endpoint: "https://x/y" }), /Invalid push subscription/);
});

test("send fans out to every registered device", async () => {
  const kv = fakeKV();
  const push = await makePusher(kv);
  await push.subscribe("user1", await fakeSubscription("device-a"));
  await push.subscribe("user1", await fakeSubscription("device-b"));

  const result = await push.send("user1", { title: "Hi", body: "there", navigate: "/x" });

  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.init.headers["Content-Encoding"], "aes128gcm");
    assert.match(c.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  }
});

test("send prunes subscriptions the push service reports as gone", async () => {
  const kv = fakeKV();
  const push = await makePusher(kv);
  const dead = await fakeSubscription("dead");
  await push.subscribe("user1", dead);
  await push.subscribe("user1", await fakeSubscription("alive"));

  respond = (url) => new Response(null, { status: url.includes("dead") ? 410 : 201 });
  const result = await push.send("user1", { title: "Hi" });

  assert.equal(result.sent, 1);
  assert.equal(result.pruned, 1);
  const left = await push.list("user1");
  assert.equal(left.length, 1);
  assert.ok(!left.some((s) => s.endpoint === dead.endpoint));
});

test("a transient failure does not prune the device", async () => {
  const kv = fakeKV();
  const push = await makePusher(kv);
  await push.subscribe("user1", await fakeSubscription("device-a"));

  respond = () => new Response(null, { status: 500 });
  const result = await push.send("user1", { title: "Hi" });

  assert.equal(result.failed, 1);
  assert.equal(result.pruned, 0);
  assert.equal((await push.list("user1")).length, 1, "500 is retryable, so the device stays");
});

test("send to a user with no devices is a no-op", async () => {
  const push = await makePusher(fakeKV());
  const result = await push.send("nobody", { title: "Hi" });
  assert.deepEqual(result, { sent: 0, failed: 0, pruned: 0, results: [] });
  assert.equal(calls.length, 0);
});

test("unsubscribe removes one device, or all of them", async () => {
  const kv = fakeKV();
  const push = await makePusher(kv);
  const a = await fakeSubscription("device-a");
  await push.subscribe("user1", a);
  await push.subscribe("user1", await fakeSubscription("device-b"));

  assert.equal(await push.unsubscribe("user1", a.endpoint), 1);
  assert.equal(await push.unsubscribe("user1", { all: true }), 0);
  assert.equal(kv.map.has("push:user1"), false, "the key is deleted once empty");
});

test("kvStore reads the legacy single-object shape", async () => {
  const kv = fakeKV();
  const one = await fakeSubscription("legacy");
  await kv.put("push:user1", JSON.stringify(one)); // pre-array format
  const subs = await kvStore(kv).get("user1");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, one.endpoint);
});

test("buildPayload emits the declarative shape and drops absent fields", () => {
  assert.deepEqual(buildPayload({ title: "T", body: "B", navigate: "/u" }), {
    web_push: 8030,
    notification: { title: "T", body: "B", navigate: "/u" },
  });
  assert.deepEqual(buildPayload({ title: "T" }), { web_push: 8030, notification: { title: "T" } });
});
