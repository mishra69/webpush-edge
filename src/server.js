// Server half — runs in the Worker. Encrypts, signs and delivers push messages,
// and keeps a per-user set of device subscriptions.

import { encryptPayload, vapidAuthHeader } from "./crypto.js";

export { encryptPayload, vapidAuthHeader } from "./crypto.js";

/**
 * Build the JSON payload a subscriber receives.
 *
 * The `web_push: 8030` key is the Declarative Web Push marker (RFC 8030 homage).
 * We include it because it costs nothing and is the shape `createPushHandler`
 * parses — but note that delivery still depends on a service-worker `push`
 * handler. Declarative-only rendering was tested on iOS and did not display;
 * see the README. Do not set a `Content-Type` on the request expecting the
 * declarative path to take over.
 */
export function buildPayload({ title, body, navigate, icon, badge, tag, ...rest }) {
  return {
    web_push: 8030,
    notification: {
      title,
      ...(body !== undefined && { body }),
      ...(navigate !== undefined && { navigate }),
      ...(icon !== undefined && { icon }),
      ...(badge !== undefined && { badge }),
      ...(tag !== undefined && { tag }),
      ...rest,
    },
  };
}

/**
 * Deliver one already-built payload to one subscription.
 *
 * Returns the raw Response. Callers should treat 404 and 410 as "this device is
 * gone for good" and drop the subscription; other non-2xx codes are transient.
 */
export async function sendOne({ subscription, payload, publicKey, privateJwk, contact, ttl = 600, urgency = "high", topic }) {
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);
  const body = await encryptPayload(plaintext, subscription.keys.p256dh, subscription.keys.auth);
  const authorization = await vapidAuthHeader({
    endpoint: subscription.endpoint, publicKey, privateJwk, contact,
  });

  const headers = {
    TTL: String(ttl),
    "Content-Encoding": "aes128gcm",
    Urgency: urgency,
    Authorization: authorization,
  };
  if (topic) headers.Topic = topic;

  return fetch(subscription.endpoint, { method: "POST", headers, body });
}

/**
 * Subscription storage backed by a Workers KV namespace.
 *
 * Stores an array per user so one account can be subscribed on several devices
 * (an iPhone home-screen app and a desktop browser hold entirely separate
 * subscriptions — with a single slot they overwrite each other).
 */
export function kvStore(namespace, { prefix = "push:" } = {}) {
  return {
    async get(userId) {
      const raw = await namespace.get(prefix + userId);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // Tolerate the single-object shape written by earlier versions.
      return Array.isArray(parsed) ? parsed : [parsed];
    },
    async set(userId, subs) {
      if (subs.length === 0) await namespace.delete(prefix + userId);
      else await namespace.put(prefix + userId, JSON.stringify(subs));
    },
  };
}

/** Keep only the fields needed to send, so we never persist extra browser data. */
function normalize(subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Invalid push subscription: expected { endpoint, keys: { p256dh, auth } }");
  }
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
  };
}

/**
 * @param {object} config
 * @param {string} config.publicKey  VAPID public key (base64url raw point)
 * @param {object|string} config.privateJwk  VAPID private key as a JWK
 * @param {string} config.contact  `mailto:` or `https:` contact for the push service
 * @param {object} config.store  subscription storage; see `kvStore`
 */
export function createPusher({ publicKey, privateJwk, contact, store }) {
  if (!publicKey) throw new Error("createPusher: publicKey is required");
  if (!privateJwk) throw new Error("createPusher: privateJwk is required");
  if (!contact) throw new Error("createPusher: contact is required");

  return {
    /** Register (or refresh) one device. Idempotent on endpoint. */
    async subscribe(userId, subscription) {
      const clean = normalize(subscription);
      const subs = await store.get(userId);
      const idx = subs.findIndex((s) => s.endpoint === clean.endpoint);
      if (idx >= 0) subs[idx] = clean; else subs.push(clean);
      await store.set(userId, subs);
      return subs.length;
    },

    /** Drop one device by endpoint, or every device with `{ all: true }`. */
    async unsubscribe(userId, endpointOrOptions) {
      const all = endpointOrOptions?.all === true;
      const endpoint = typeof endpointOrOptions === "string" ? endpointOrOptions : endpointOrOptions?.endpoint;
      const subs = await store.get(userId);
      const remaining = all ? [] : subs.filter((s) => s.endpoint !== endpoint);
      await store.set(userId, remaining);
      return remaining.length;
    },

    list(userId) {
      return store.get(userId);
    },

    /**
     * Fan a notification out to every device registered to `userId`.
     * Subscriptions the push service reports as gone (404/410) are pruned.
     *
     * @returns {Promise<{sent:number, failed:number, pruned:number, results:Array}>}
     */
    async send(userId, notification, options = {}) {
      const subs = await store.get(userId);
      if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0, results: [] };

      const payload = buildPayload(notification);
      const results = await Promise.all(subs.map(async (subscription) => {
        try {
          const res = await sendOne({ subscription, payload, publicKey, privateJwk, contact, ...options });
          return { endpoint: subscription.endpoint, status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 };
        } catch (error) {
          return { endpoint: subscription.endpoint, status: 0, ok: false, gone: false, error: String(error?.message || error) };
        }
      }));

      const gone = results.filter((r) => r.gone).map((r) => r.endpoint);
      if (gone.length) await store.set(userId, subs.filter((s) => !gone.includes(s.endpoint)));

      return {
        sent: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        pruned: gone.length,
        results,
      };
    },
  };
}
