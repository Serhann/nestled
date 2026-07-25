# JetFood ↔ JetChat integration

**Goal:** the agent sees the visitor's **real** customer + order data, and that data
can't be faked from the browser.

**How:** JetFood (PHP, server-rendered) already knows the logged-in customer and
their orders. It signs that data into a short-lived **JWT (HS256)** using a
per-site shared secret and drops the token into the page. The JetChat widget
carries the token to our backend, which verifies the signature with the same
secret. A valid signature proves the data came from JetFood's server, so it is
trusted — even though it travelled through the browser. This is read-only: we
display the data, we never call back into JetFood.

```
JetFood PHP (session)                 Browser                 JetChat backend
────────────────────                  ───────                 ───────────────
build context array   ──sign(HS256)──▶ token in page
                                        embed.js → widget
                                        POST /api/conversations { context_token }
                                                              ──▶ verify(secret)
                                                                  store trusted
                                                                  show to agent
```

## 1. Set the shared secret (once)

In JetChat admin → **Sites** → (JetFood site) → **Signed visitor context**:
click **Generate**, then **Save**. Copy that secret into JetFood config as
`JETCHAT_CONTEXT_SECRET`. Keep it secret — anyone holding it can assert customer
identity to the chat.

## 2. JetFood: build + sign the context (dependency-free PHP)

Drop this on any page where the widget loads. It reads from your existing
session/models — no new endpoint required.

```php
<?php
function jetchat_b64url(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function jetchat_sign_context(array $context, string $secret, int $ttl = 3600): string {
    $header  = ['alg' => 'HS256', 'typ' => 'JWT'];
    $now     = time();
    $payload = array_merge($context, [
        'iss' => 'jetfood',
        'iat' => $now,
        'exp' => $now + $ttl,   // short-lived; refresh on each page render
    ]);
    $segments = [
        jetchat_b64url(json_encode($header, JSON_UNESCAPED_UNICODE)),
        jetchat_b64url(json_encode($payload, JSON_UNESCAPED_UNICODE)),
    ];
    $signing = implode('.', $segments);
    $sig     = hash_hmac('sha256', $signing, $secret, true); // raw bytes
    $segments[] = jetchat_b64url($sig);
    return implode('.', $segments);
}

// --- Build ONLY for a logged-in customer; skip for guests ---------------------
$token = '';
if ($customer = current_customer()) {           // your existing session lookup
    $context = [
        'customer' => [
            'id'           => $customer->id,
            'name'         => $customer->name,
            'email'        => $customer->email,
            'phone'        => $customer->phone,
            'orders_count' => $customer->orders_count,
        ],
    ];
    // IMPORTANT: only an order that is genuinely still in progress. A delivered,
    // cancelled or refunded order belongs in `recent_orders` — while
    // `current_order` is set, the widget offers order buttons ("Where's my
    // order?", "Running late?") and answers them from this status.
    if ($order = $customer->active_order()) {    // optional: the live order
        $context['current_order'] = [
            'id'         => $order->id,
            'status'     => $order->status,       // e.g. "on_the_way"
            'eta'        => $order->eta,           // e.g. "18:40"
            'restaurant' => $order->restaurant_name,
            'total'      => $order->total,
            'currency'   => 'TRY',
        ];
    }
    // optional: last few orders (max 20)
    $context['recent_orders'] = array_map(fn($o) => [
        'id' => $o->id, 'status' => $o->status, 'total' => $o->total, 'date' => $o->date,
    ], $customer->recent_orders(5));

    $token = jetchat_sign_context($context, getenv('JETCHAT_CONTEXT_SECRET'));
}
?>
```

## 3. JetFood: hand the token to the widget

Set it **before** the embed script (the embed reads it on load):

```html
<?php if ($token): ?>
  <script>window.JetChatContext = <?= json_encode($token) ?>;</script>
<?php endif; ?>

<script src="https://chat.iydo.com/embed.js"
        data-api-base="https://chat.iydo.com"
        data-mode="food"></script>
```

Alternatives to `window.JetChatContext` (any one works):

- Script attribute: `<script src=".../embed.js" data-mode="food" data-context="<?= htmlspecialchars($token) ?>">`
- Runtime (e.g. SPA, or after login without a full reload):
  ```js
  JetChat('context', '<?= $token ?>');
  ```

## 4. JetFood: refresh the token when something changes

Re-sign and push the token whenever the customer logs in or an order status
changes. One call updates both the open conversation and the **Live visitors**
board (the agent sees the new status without the visitor writing a word):

```js
JetChat('context', '<new signed token>');
```

Pages that reload on navigation get this for free (a fresh token per render);
SPA/AJAX flows need the call. Repeats of the same token are ignored, so calling
it on every poll tick is safe.

## 5. No active order? Send no order.

The widget hides every order-only button (`where`, `status`, `late`,
`change_address`, `missing_item`, `wrong`, `refund`) while it has no order in
context, and the backend answers such an intent with "I can't see an active
order… send me the order number" instead of a made-up status. That only works if
JetFood stops advertising finished orders:

- Omit `current_order` from the signed context once the order is done.
- Don't render `data-order-*` attributes (or `?order_id=…` params) for a finished
  order — those unsigned hints also drive the order card and buttons.
- After an order completes mid-session, clear it at runtime:
  ```js
  JetChat('order', { id: null });   // no order → order buttons disappear
  ```

## 6. Live view (optional)

Live visitors → a visitor → **Watch live session** replays the visitor's screen.
Nothing to build on JetFood's side, but two things must hold:

- JetChat admin → **Settings & AI** → *Live session replay* is on (it also gates
  the host-side recorder, so it's off until you enable it).
- JetFood's CSP allows the chat origin: `script-src` for `embed.js` /
  `presence.js` / `vendor/rrweb-record.min.js`, `connect-src` for `https:` +
  `wss:` to that origin, and `frame-src` for the widget iframe.

Inputs are masked and `iframe`, `[data-cc]`, `[autocomplete*="cc-"]` are blocked
from capture. Mark anything else sensitive with `data-jetchat-block` (skip the
element) or `data-jetchat-mask` (mask its text).

## What the agent sees

On conversation open, JetChat verifies the signature and, if valid, shows a
green **VERIFIED CONTEXT** card in the conversation info panel (customer, current
order, recent orders) and uses the verified name/email for the visitor identity
+ cross-site people pool. If the token is missing, expired, or tampered with, we
silently ignore it and fall back to the (untrusted) client hints for display
only — nothing breaks.

The same verified card (plus geo/IP/device/language/timezone, page history, IP
history and the cross-site identity) shows in **Live visitors** before any chat
exists — the token sent with the presence connection is what fills it, so a
logged-in customer is named on the board from their first page view. The verified
context is also fed to the AI, which may quote its order facts and is told to ask
for an order number when there is no active order.

## Notes / scope

- **Read-only** by design. Cancel/refund/reorder actions would need write
  endpoints on JetFood + auth; not built.
- The unsigned client hints (`data-order-*`, `JetChat('order', …)`) still work
  for instant on-page order context, but only the **signed** context is trusted
  and drives identity.
- Refresh the token on each render (short TTL). An expired token is treated as
  "no context", not an error.
- `embed.js` / `presence.js` are served by JetChat, so these behaviours arrive on
  the next page load. If JetFood ever self-hosts a copy of either script, re-pull
  it (and bust the cache) after a JetChat deploy.
