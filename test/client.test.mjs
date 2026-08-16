// Covers the page half against stubbed browser globals. The subscription dance
// is mostly branching, and the branch that matters here is whether caller
// headers reach the app's own endpoints — a bearer-token app gets 401 without
// them, which is invisible until you try it on a device.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { subscribe, unsubscribe, pushSupport } from "../src/client.js";

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const VAPID_KEY = "BEXzgCB83VdIlmxHp2j9fIme5Cax69agi3doyXJgDpM8oa-nBIJrkZ1VKYssyImvKj9F_jgF7A-Le5ZrMC20XKM";
let calls;

function stubBrowser({ permission = "granted", existingSubscription = null } = {}) {
  calls = [];
  const subscription = {
    endpoint: "https://web.push.apple.com/abc",
    options: {},
    toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "x", auth: "y" } }),
    unsubscribe: async () => true,
  };
  const registration = {
    pushManager: {
      getSubscription: async () => existingSubscription,
      subscribe: async () => subscription,
    },
  };

  // pushSupport() probes `window`, so the capability flags must live there —
  // putting them on globalThis alone reads as "unsupported".
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    navigator: { standalone: false },
    PushManager: function () {},
    Notification: { permission },
  };
  // Node exposes `navigator` as a getter-only global, so it can't be assigned.
  define("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    platform: "MacIntel",
    maxTouchPoints: 0,
    serviceWorker: {
      register: async () => registration,
      get ready() { return Promise.resolve(registration); },
    },
  });
  globalThis.Notification = { permission, requestPermission: async () => permission };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    if (String(url).includes("key")) {
      return { ok: true, json: async () => ({ key: VAPID_KEY }) };
    }
    return { ok: true, json: async () => ({ ok: true, devices: 1 }) };
  };
}

afterEach(() => {
  delete globalThis.window; delete globalThis.navigator;
  delete globalThis.Notification; delete globalThis.fetch;
});

test("subscribe sends caller headers to both the key and subscribe endpoints", async () => {
  stubBrowser();
  const res = await subscribe({ headers: { Authorization: "Bearer tok123" } });
  assert.equal(res.ok, true);

  const key = calls.find(c => c.url.includes("key"));
  const sub = calls.find(c => c.url.includes("subscribe"));
  assert.equal(key.headers.Authorization, "Bearer tok123", "key fetch must carry the token");
  assert.equal(sub.headers.Authorization, "Bearer tok123", "subscribe fetch must carry the token");
  // and must not clobber the content type it sets itself
  assert.equal(sub.headers["Content-Type"], "application/json");
});

test("subscribe works with no headers supplied", async () => {
  stubBrowser();
  const res = await subscribe();
  assert.equal(res.ok, true);
  assert.equal(calls.find(c => c.url.includes("subscribe")).headers.Authorization, undefined);
});

test("unsubscribe sends caller headers", async () => {
  stubBrowser({ existingSubscription: {
    endpoint: "https://web.push.apple.com/abc",
    unsubscribe: async () => true,
  } });
  await unsubscribe({ headers: { Authorization: "Bearer tok123" } });
  const call = calls.find(c => c.url.includes("unsubscribe"));
  assert.equal(call.headers.Authorization, "Bearer tok123");
});

test("pushSupport reports needs-install for iOS outside a home-screen app", () => {
  stubBrowser();
  globalThis.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  globalThis.window.matchMedia = () => ({ matches: false });
  assert.equal(pushSupport().state, "needs-install");
});
