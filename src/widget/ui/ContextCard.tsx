import type { ContextCard as ContextCardPayload } from '../../types/chat';
import { ExternalIcon } from './icons';

/**
 * A server-rendered card about whatever the host site signed for us.
 *
 * This replaces the old order tracker, and the point of it is what it does NOT
 * do. The pre-tenant widget decoded the host's context JWT in the browser, read
 * fields called `order`, `items` and `courier` out of it, and drew a delivery
 * progress bar. Three things were wrong with that: the client learned one
 * customer's domain model and shipped it to all of them; it rendered
 * cryptographically unverified data as if it were trusted (the signature is only
 * checked server side); and every new customer field meant a widget release.
 *
 * So the contract is inverted. The server verifies the HMAC, maps the attributes
 * through the customer's own per-website field mapping, and sends back a
 * presentation payload — title, subtitle, badge, fields, progress, actions. This
 * component renders exactly that and knows the meaning of none of it.
 *
 * GAP, and it is the honest state of things: the server does not produce this
 * payload yet. `verifyContextToken` returns `{customer, attributes, events}` —
 * the raw verified bag — and `POST /conversations/:id/attributes` answers
 * `{ok: boolean}`. Until a presentation mapper exists behind that endpoint (and
 * on `/boot`), this component never renders, which is the correct failure: no
 * card at all beats a card the client invented.
 */

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    // The widget is cross-origin to the host page and `target=_blank` on a
    // javascript: or data: URL is a script-execution primitive, so only real
    // web links are ever rendered as links.
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function ContextCard({ card }: { card: ContextCardPayload }) {
  const fields = card.fields ?? [];
  const steps = card.progress?.steps ?? [];
  const current = card.progress?.current ?? 0;
  const actions = (card.actions ?? [])
    .map((a) => ({ label: a.label, href: safeHref(a.url) }))
    .filter((a): a is { label: string; href: string } => Boolean(a.href));

  return (
    <section className="n-card">
      {card.badge && (
        <span className="n-tag" data-tone={card.badge.tone ?? 'neutral'}>
          {card.badge.label}
        </span>
      )}
      {card.title && <p className="n-card-title">{card.title}</p>}
      {card.subtitle && <p className="n-card-sub">{card.subtitle}</p>}

      {steps.length > 0 && (
        <div>
          <div className="n-progress">
            {steps.map((step, index) => (
              <span key={step} className="n-progress-step" data-done={index <= current} />
            ))}
          </div>
          <div className="n-progress-labels">
            <span>{steps[Math.min(current, steps.length - 1)]}</span>
            <span>{steps[steps.length - 1]}</span>
          </div>
        </div>
      )}

      {fields.length > 0 && (
        <dl className="n-card-fields">
          {fields.map((field) => (
            <div key={field.label} style={{ display: 'contents' }}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {actions.length > 0 && (
        <div className="n-chips">
          {actions.map((action) => (
            <a
              key={action.href}
              className="n-chip"
              href={action.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {action.label} <ExternalIcon />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
