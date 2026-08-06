// Service-worker half — import inside your sw.js.
//
// A `push` handler is not optional. Apple's Declarative Web Push (Safari 18.4+)
// promises rendering straight from the JSON payload with no service worker, but
// on-device testing showed it not displaying on iOS; the handler below is what
// actually puts a notification on screen. It parses the same payload shape either
// way, so declarative-capable browsers lose nothing.

/**
 * Register `push`, `notificationclick` and `pushsubscriptionchange` handlers.
 *
 * @param {object} options
 * @param {string} [options.title]  fallback title when the payload omits one
 * @param {string} [options.icon]
 * @param {string} [options.badge]
 * @param {string} [options.tag]  collapse key; same tag replaces the previous notification
 * @param {string} [options.defaultUrl]  opened when the payload carries no navigate URL
 * @param {string} [options.keyUrl]  endpoint returning `{ key }`, for re-subscribing
 * @param {string} [options.subscribeUrl]  endpoint accepting `{ subscription }`
 */
export function createPushHandler({
  title: fallbackTitle = "Notification",
  icon = "/icon-192.png",
  badge = "/icon-192.png",
  tag = "default",
  defaultUrl = "/",
  keyUrl = "/push/key",
  subscribeUrl = "/push/subscribe",
} = {}) {
  self.addEventListener("push", (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
    // Accept the declarative shape ({ notification: {...} }) or a flat object.
    const n = data.notification || data;
    event.waitUntil(self.registration.showNotification(n.title || fallbackTitle, {
      body: n.body || "",
      icon: n.icon || icon,
      badge: n.badge || badge,
      tag: n.tag || tag,
      data: { url: n.navigate || n.url || defaultUrl },
    }));
  });

  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = event.notification.data?.url || defaultUrl;
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client && client.url !== url) await client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })());
  });

  // Push services rotate endpoints. Without this the subscription silently dies
  // and notifications just stop, with nothing user-visible to explain it.
  self.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil((async () => {
      try {
        const { key } = await (await fetch(keyUrl)).json();
        const subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(key),
        });
        await fetch(subscribeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
      } catch { /* nothing useful to do from here; the page re-subscribes on next open */ }
    })());
  });
}

export function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
