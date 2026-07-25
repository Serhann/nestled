/**
 * Quick-action template rendering. The visitor picks a managed quick action; its
 * visitor/reply templates are filled server-side from the (host-supplied) order
 * context and any collected intake fields.
 *
 * The important rule: never speak about an order the visitor doesn't have. A
 * template that uses order tokens is order-scoped, and with no order in context
 * its reply is replaced by NO_ORDER_REPLY instead of rendering "your order is
 * being processed" at someone who never ordered.
 */

export interface OrderCtx {
  id?: string;
  status?: string;
  eta?: string;
  restaurant?: string;
}

/** Tokens that only make sense with a real order in context. */
const ORDER_TOKENS =
  /\{(order|status|eta|restaurant|restaurant_clause|eta_clause|eta_paren|order_about)\}/;

/** Reply for an order-scoped action run by a visitor with no order in context. */
export const NO_ORDER_REPLY =
  "I can't see an active order for you right now. If you have an order number, send it here and I'll look it up — or tell me what you need and I'll help.";

/** Does this template talk about an order (and therefore need one)? */
export function needsOrder(tpl: string): boolean {
  return ORDER_TOKENS.test(tpl);
}

/** Substitute {placeholders} from the order + collected fields. Missing tokens
 *  render as empty strings; the result is tidied so a dropped token never leaves
 *  a double space or a stray " ?". */
export function renderTemplate(
  tpl: string,
  order: OrderCtx,
  fields: Record<string, string>,
): string {
  const tokens: Record<string, string> = {
    order: order.id ? `#${order.id}` : '',
    // Only claim a status when there is an order to have one.
    status: order.status || (order.id ? 'being processed' : ''),
    eta: order.eta || '',
    restaurant: order.restaurant || '',
    restaurant_clause: order.restaurant ? ` from ${order.restaurant}` : '',
    eta_clause: order.eta ? ` — estimated arrival in ${order.eta}` : '',
    eta_paren: order.eta ? ` (ETA ${order.eta})` : '',
    order_about: order.id ? ` about order #${order.id}` : '',
    ...fields,
  };
  return tpl
    .replace(/\{(\w+)\}/g, (_m, k: string) => tokens[k] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([?!.,;:])/g, '$1')
    .trim();
}

/** The bot reply for a quick action: the rendered template, or a request for the
 *  order number when the template needs an order the visitor doesn't have. */
export function renderReply(
  tpl: string,
  order: OrderCtx,
  fields: Record<string, string>,
): { text: string; missingOrder: boolean } {
  if (!order.id && needsOrder(tpl)) return { text: NO_ORDER_REPLY, missingOrder: true };
  return { text: renderTemplate(tpl, order, fields), missingOrder: false };
}
