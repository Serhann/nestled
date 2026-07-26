import type { FastifyInstance } from 'fastify';

/**
 * Billing: plan catalog, Stripe Checkout, Billing Portal, webhooks, usage.
 *
 * Registered from index.ts so the surface exists as a seam before it is filled.
 */
export async function billingV1Routes(_app: FastifyInstance): Promise<void> {
  // Phase 12.
}
