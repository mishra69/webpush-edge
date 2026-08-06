# webpush-edge

Web Push for edge runtimes — RFC 8291 (`aes128gcm`) payload encryption and RFC 8292 (VAPID)
signing, built on Web Crypto only. Zero dependencies. Runs on Cloudflare Workers, Deno, Bun
and Node 18+.

Ships all three halves of a working setup: the sender (Worker), the `push` handler
(service worker), and the subscription dance (page).

```bash
npm install github:mishra69/webpush-edge
```

## Why this exists

Two things reliably break Web Push on Apple devices, and most libraries get at least one wrong.

**1. The content coding.** There are two payload encryption formats in the wild:

| Coding | Spec | Status |
|---|---|---|
| `aesgcm` | draft-04 (2016) | superseded |
| `aes128gcm` | [RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291) | current |

Apple's push service accepts only `aes128gcm` — Safari's
[`PushManager.supportedContentEncodings`](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/supportedContentEncodings_static)
returns exactly `["aes128gcm"]`. Apple shipped Web Push in 2023, long after the draft was
superseded, so it never supported the old one. Chrome and Firefox still tolerate `aesgcm`,
which is why libraries emitting it appear to work — right up until you test on an iPhone.
Both `@pushforge/builder` and `@block65/webcrypto-web-push` hardcode `aesgcm` despite
advertising edge-runtime support.

The failure is silent: the push service returns `201 Created` and the device shows nothing.

**2. Declarative Web Push does not remove the need for a service worker.** Safari 18.4+
advertises rendering a notification straight from a JSON payload with no service worker.
On-device testing on iOS showed it not displaying. `createPushHandler` is what actually puts a
notification on screen. The payload this library sends carries the `web_push: 8030` declarative
marker anyway — it costs nothing and the handler parses the same shape — but don't rely on the
declarative path alone, and don't set a `Content-Type` header expecting it to take over.

## iOS requirements

Web Push on iPhone and iPad works **only** for a web app added to the Home Screen. Not in a
Safari tab, in any browser — every iOS browser uses WebKit, so this is not a Chrome-vs-Safari
thing. Still true as of iOS 26. macOS Safari 16+ works in an ordinary tab.

Which means the sequence is: user installs to Home Screen → opens from there → taps your button
→ *then* the permission prompt can appear. `pushSupport()` returns `needs-install` for exactly
this case so you can show install instructions instead of a button that can't work.

Other iOS constraints worth knowing: notification `actions` (buttons) are ignored, and the
permission request must happen inside a user gesture.

## Setup

Generate a keypair once:

```bash
npx webpush-edge-vapid
```

Commit `VAPID_PUBLIC_KEY`; store the private half as a secret:

```bash
npx wrangler secret put VAPID_PRIVATE_JWK
```

Rotating these invalidates every existing subscription — devices must re-subscribe.

## Server (Worker)

```js
import { createPusher, kvStore } from "webpush-edge";

const push = createPusher({
  publicKey: env.VAPID_PUBLIC_KEY,
  privateJwk: env.VAPID_PRIVATE_JWK,
  contact: "mailto:you@example.com",
  store: kvStore(env.MY_KV),          // stores an array per user → multi-device
});

await push.subscribe(userId, subscription);
await push.send(userId, {
  title: "🔔 RSI Alert",
  body: "AAPL crossed into BUY territory (RSI 28.4)",
  navigate: "https://example.com/dashboard",
});
```

`send` fans out to every device registered to that user and returns
`{ sent, failed, pruned, results }`. Subscriptions the push service reports as gone (404/410)
are pruned automatically; other failures are left alone as retryable.

| Method | Purpose |
|---|---|
| `subscribe(userId, subscription)` | register a device; idempotent per endpoint |
| `unsubscribe(userId, endpoint \| { all: true })` | drop one device or all |
| `list(userId)` | current subscriptions |
| `send(userId, notification, options?)` | fan out; `options` takes `ttl`, `urgency`, `topic` |

`ttl` (seconds) is how long the push service holds the message for an offline device.

Managing your own storage? `sendOne({ subscription, payload, publicKey, privateJwk, contact })`
skips the store entirely, and `kvStore` can be swapped for any `{ get(id), set(id, subs) }`.

## Service worker (`sw.js`)

```js
import { createPushHandler } from "webpush-edge/sw";

createPushHandler({
  title: "RSI Tracker",
  icon: "/icon-192.png",
  defaultUrl: "/",
  keyUrl: "/push/key",
  subscribeUrl: "/push/subscribe",
});
```

Registers `push`, `notificationclick`, and `pushsubscriptionchange`. That last one matters more
than it looks: push services rotate endpoints, and without it a subscription silently dies and
notifications just stop with nothing user-visible to explain why.

Cloudflare Workers can serve this file directly — no build step — but it must be served from the
origin root with `Service-Worker-Allowed: /` for a `/` scope, and it must be reachable **without
authentication**, or iOS can't install the web app.

## Client (page)

```js
import { pushSupport, subscribe, unsubscribe } from "webpush-edge/client";

const { state } = pushSupport();
// "unsupported" | "needs-install" | "blocked" | "granted" | "prompt"

button.addEventListener("click", async () => {
  const result = await subscribe();     // must be inside the gesture
  if (!result.ok) showError(result.reason);
});
```

Handles the gesture-scoped permission request, the iOS install check, and discarding a
subscription minted under a rotated VAPID key (which would otherwise throw on re-subscribe).
Your markup and copy stay yours — this library has no opinion about your UI.

## Server endpoints you need to provide

The client and service worker expect three routes (names configurable):

| Route | Returns |
|---|---|
| `GET /push/key` | `{ key: env.VAPID_PUBLIC_KEY }` |
| `POST /push/subscribe` | accepts `{ subscription }` → `{ ok: true, devices }` |
| `POST /push/unsubscribe` | accepts `{ endpoint }` → `{ ok: true, devices }` |

## Tests

```bash
npm test
```

The crypto is verified against the complete worked example in
[RFC 8291 §5](https://datatracker.ietf.org/doc/html/rfc8291#section-5) — same keys, same salt,
byte-identical output. That vector is the point: encryption bugs here don't throw, they just
produce notifications that never arrive.

## License

MIT
