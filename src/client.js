// Page half — the subscription dance, minus any opinion about your UI.
//
// The parts that are easy to get subtly wrong and identical in every app:
// requesting permission inside the click gesture, detecting the iOS
// home-screen requirement, and discarding a subscription minted under a
// rotated VAPID key.

export { urlB64ToUint8Array } from "./sw.js";
import { urlB64ToUint8Array } from "./sw.js";

/**
 * What this browser can do right now.
 *
 * `state` is one of:
 *  - `unsupported`   — no Push API here
 *  - `needs-install` — iOS/iPadOS in a Safari tab. Web Push is only granted to
 *                      home-screen web apps; there is no prompt to show yet.
 *  - `blocked`       — permission denied; only site settings can undo it
 *  - `granted`       — permission already given
 *  - `prompt`        — supported, not yet asked
 */
export function pushSupport() {
  if (typeof window === "undefined") return { state: "unsupported", supported: false, isIOS: false, isStandalone: false };

  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  let state;
  if (!supported) state = "unsupported";
  else if (isIOS && !isStandalone) state = "needs-install";
  else if (Notification.permission === "denied") state = "blocked";
  else if (Notification.permission === "granted") state = "granted";
  else state = "prompt";

  return { state, supported, isIOS, isStandalone };
}

/** Register the service worker and wait until it's active. */
export async function registerServiceWorker(path = "/sw.js", options = { scope: "/" }) {
  const registration = await navigator.serviceWorker.register(path, options);
  await navigator.serviceWorker.ready;
  return registration;
}

/**
 * Subscribe this device and hand the subscription to the server.
 *
 * Must be called from a user gesture when `prompt` is true — Safari ignores a
 * permission request that isn't tied to a click.
 *
 * `headers` is merged into the requests to your own endpoints. Apps that
 * authenticate with a bearer token rather than a cookie need it — without it
 * these are bare fetches and a token-gated /push/subscribe returns 401.
 *
 * @returns {Promise<{ok: boolean, reason?: string, subscription?: object, devices?: number}>}
 */
export async function subscribe({
  swPath = "/sw.js",
  keyUrl = "/push/key",
  subscribeUrl = "/push/subscribe",
  prompt = true,
  headers = {},
} = {}) {
  const support = pushSupport();
  if (support.state === "unsupported" || support.state === "needs-install" || support.state === "blocked") {
    return { ok: false, reason: support.state };
  }

  const registration = await registerServiceWorker(swPath);

  if (Notification.permission === "default") {
    if (!prompt) return { ok: false, reason: "prompt-required" };
    if (await Notification.requestPermission() !== "granted") {
      return { ok: false, reason: Notification.permission === "denied" ? "blocked" : "dismissed" };
    }
  }

  const { key } = await (await fetch(keyUrl, { headers })).json();
  if (!key) return { ok: false, reason: "no-vapid-key" };

  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscribedWithKey(subscription, key)) {
    // Minted under a different VAPID key — it can't be reused and subscribe() would throw.
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key),
    });
  }

  const json = subscription.toJSON();
  const res = await fetch(subscribeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ subscription: json }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) return { ok: false, reason: data.error || `server-${res.status}` };

  return { ok: true, subscription: json, devices: data.devices };
}

/** Unsubscribe this device, locally and on the server. */
export async function unsubscribe({ swPath = "/sw.js", unsubscribeUrl = "/push/unsubscribe", headers = {} } = {}) {
  const registration = await registerServiceWorker(swPath);
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { ok: true, devices: undefined };

  const res = await fetch(unsubscribeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe().catch(() => {});
  const data = await res.json().catch(() => ({}));
  return { ok: true, devices: data.devices };
}

/** Is this device currently subscribed with the server's active key? */
export async function currentSubscription({ swPath = "/sw.js" } = {}) {
  if (!pushSupport().supported) return null;
  const registration = await registerServiceWorker(swPath);
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? subscription.toJSON() : null;
}

function subscribedWithKey(subscription, key) {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return true; // can't tell; assume it's fine rather than churn a good subscription
  const a = new Uint8Array(existing);
  const b = urlB64ToUint8Array(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
