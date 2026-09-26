import { Logger } from '@nestjs/common';

import { parseVerifiedStripeEvent } from './stripe-webhook';
import type { StripeWebhookClaim } from './stripe-webhook';

/**
 * Stripe JP adapter (Feature 2). Uses Stripe Checkout sessions with whole JPY
 * (no minor-unit scaling for JPY: `unit_amount` is expressed in the currency's
 * smallest unit, which for JPY is ¥1). Selected per building via
 * `Building.pspProvider = 'stripejp'`; default remains Viva.
 */
export interface StripeJpAdapter {
  readonly isMock?: boolean;
  readonly isAvailable?: boolean;
  createCheckout(input: {
    amountCents: number;
    invoiceRef: string;
    currency?: string;
    successUrl: string;
    cancelUrl: string;
    buildingName?: string;
  }): Promise<{
    checkoutUrl: string;
    /** Historical name; it is the Checkout Session id. */
    paymentIntentRef: string;
    sessionRef?: string;
    paymentRef?: string;
  }>;
  verifyWebhook(
    payload: string | Buffer,
    signatureHeader?: string,
  ): Promise<StripeWebhookClaim | null>;
}

export type { StripeWebhookClaim } from './stripe-webhook';
export const STRIPE_JP_ADAPTER = Symbol('STRIPE_JP_ADAPTER');

/** Minimal structural shape of the Stripe client we depend on. */
export interface StripeLike {
  checkout: {
    sessions: {
      create(input: {
        mode: string;
        line_items: unknown[];
        success_url: string;
        cancel_url: string;
        metadata: Record<string, string>;
        payment_intent_data?: { metadata: Record<string, string> };
      }): Promise<{
        url: string | null;
        id: string;
        payment_intent?: string | { id: string } | null;
      }>;
    };
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      signatureHeader: string,
      secret: string,
    ): unknown;
  };
}

/** Real adapter backed by the stripe SDK (imported lazily to keep typing loose). */
export class RealStripeJpAdapter implements StripeJpAdapter {
  readonly isMock = false;
  readonly isAvailable = true;

  private readonly logger = new Logger(RealStripeJpAdapter.name);
  private readonly stripe: StripeLike;

  constructor(secretKey: string) {
    if (!secretKey?.trim()) throw new Error('STRIPE_SECRET_KEY is required');
    const Stripe = require('stripe') as new (
      secret: string,
      options?: { apiVersion?: string },
    ) => StripeLike;
    this.stripe = new Stripe(secretKey, { apiVersion: '2024-11-20.acacia' });
  }

  async createCheckout(input: {
    amountCents: number;
    invoiceRef: string;
    currency?: string;
    successUrl: string;
    cancelUrl: string;
    buildingName?: string;
  }): Promise<{
    checkoutUrl: string;
    paymentIntentRef: string;
    sessionRef?: string;
    paymentRef?: string;
  }> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error(`Invalid Stripe JP amount for invoice ${input.invoiceRef}`);
    }
    if (!input.invoiceRef || !input.successUrl || !input.cancelUrl) {
      throw new Error('Stripe JP checkout reference and URLs are required');
    }
    const currency = (input.currency ?? 'JPY').toLowerCase();
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: input.amountCents, // JPY: cents == yen
            product_data: {
              name: input.buildingName
                ? `PolykatoikiaOS ${input.buildingName}`
                : 'PolykatoikiaOS',
              description: `請求書 ${input.invoiceRef}`,
            },
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: { invoiceRef: input.invoiceRef },
      payment_intent_data: { metadata: { invoiceRef: input.invoiceRef } },
    });
    if (!session.url || !session.id) {
      throw new Error('Stripe returned no checkout URL');
    }
    const paymentRef =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    this.logger.log(
      `Created Stripe checkout ${session.id} for invoice ${input.invoiceRef}`,
    );
    return {
      checkoutUrl: session.url,
      paymentIntentRef: session.id,
      sessionRef: session.id,
      ...(paymentRef ? { paymentRef } : {}),
    };
  }

  async verifyWebhook(
    payload: string | Buffer,
    signatureHeader?: string,
  ): Promise<StripeWebhookClaim | null> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret?.trim() || !signatureHeader?.trim()) return null;
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signatureHeader,
        secret,
      );
      return parseVerifiedStripeEvent(event);
    } catch {
      return null;
    }
  }
}

/** Factory used by the DI container. Requires both live Stripe secrets. */
export function createStripeJpAdapter(): StripeJpAdapter {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey?.trim() || !webhookSecret?.trim()) {
    throw new Error(
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when Building.pspProvider = "stripejp"',
    );
  }
  return new RealStripeJpAdapter(secretKey);
}
