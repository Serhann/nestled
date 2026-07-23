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

## What the agent sees

On conversation open, JetChat verifies the signature and, if valid, shows a
green **VERIFIED CONTEXT** card in the conversation info panel (customer, current
order, recent orders) and uses the verified name/email for the visitor identity
+ cross-site people pool. If the token is missing, expired, or tampered with, we
silently ignore it and fall back to the (untrusted) client hints for display
only — nothing breaks.

## Notes / scope

- **Read-only** by design. Cancel/refund/reorder actions would need write
  endpoints on JetFood + auth; not built.
- The unsigned client hints (`data-order-*`, `JetChat('order', …)`) still work
  for instant on-page order context, but only the **signed** context is trusted
  and drives identity.
- Refresh the token on each render (short TTL). An expired token is treated as
  "no context", not an error.
