/**
 * The channel contract.
 *
 * One shape for "a message arrived" and one for "send this message", so that adding
 * WhatsApp later is a new adapter rather than a new path through the inbox. The
 * fields here are the intersection of what email, SMS, WhatsApp and Instagram all
 * actually give you — anything provider-specific belongs in the adapter, not here.
 */

export const CHANNELS = ['widget', 'email', 'sms', 'whatsapp', 'instagram'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels an endpoint row can exist for. A website IS its widget. */
export const ENDPOINT_CHANNELS = ['email', 'sms', 'whatsapp', 'instagram'] as const;
export type EndpointChannel = (typeof ENDPOINT_CHANNELS)[number];

/**
 * A message that arrived from outside.
 *
 * `externalId` is required rather than optional. Every one of these providers
 * redelivers webhooks — that is their delivery guarantee, not a bug — so a message
 * with no provider id cannot be made idempotent, and an adapter that cannot supply
 * one should refuse rather than risk duplicating a customer's message in the thread.
 */
export interface InboundMessage {
  channel: EndpointChannel;
  /** OUR address it arrived at. This is the tenant routing key. */
  toAddress: string;
  /** THEIR address. Identifies the person across conversations. */
  fromAddress: string;
  fromName?: string | null;
  text: string;
  externalId: string;
  /** Provider-specific extras kept for the agent's "unverified hints" card. */
  hints?: Record<string, unknown>;
}

export interface DeliveryTarget {
  channel: Channel;
  /** Their address. Null on the widget. */
  address: string | null;
  workspaceId: string;
  websiteId: string;
  conversationId: string;
  /** Provider thread id, where the channel has one (email's Message-ID). */
  threadRef?: string | null;
}

export type DeliveryResult =
  | { ok: true; externalId?: string | null }
  /**
   * `retryable` separates "this address is wrong" from "our credentials expired".
   * The first is the agent's problem and belongs in the thread; the second is ours
   * and must not read to them as a bad address.
   */
  | { ok: false; error: string; retryable: boolean };
