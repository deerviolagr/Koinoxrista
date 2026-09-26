/**
 * Strict parsing shared by the Stripe and Stripe JP adapters.
 *
 * Signature verification is intentionally not implemented here.  The adapter
 * must call Stripe's `constructEvent` with the exact raw request bytes and the
 * `stripe-signature` header first; this module only accepts the small, known
 * success-event surface needed for settlement.
 */

export const STRIPE_SUCCESS_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'payment_intent.succeeded',
]);

export interface StripeWebhookClaim {
  /** Stripe event id, retained for replay protection. */
  eventId: string;
  type: string;
  object: string;
  objectType: 'checkout.session' | 'payment_intent';
  sessionRef?: string;
  paymentRef?: string;
  amountCents: number;
  currency: string;
  invoiceRef?: string;
  /** Kept for callers using the original adapter contract. */
  paymentIntent: { id: string } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function currencyOf(value: unknown): string | undefined {
  const currency = nonEmptyString(value)?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function metadataInvoiceRef(value: unknown): string | undefined {
  const metadata = record(record(value)?.metadata);
  return nonEmptyString(metadata?.invoiceRef);
}

function paymentIntentId(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmptyString(value);
  return nonEmptyString(record(value)?.id);
}

/**
 * Convert a verified Stripe event into a narrow settlement claim.
 * `null` means the event is not a supported success event or has an invalid
 * shape; callers must not fall back to parsing an unverified request body.
 */
export function parseVerifiedStripeEvent(value: unknown): StripeWebhookClaim | null {
  const event = record(value);
  if (!event) return null;

  // The Stripe SDK exposes the event kind as `type`. Do not infer it from a
  // nested object or from a client-controlled field: a signed event with a
  // missing/invalid event kind is not a settlement event.
  const type = nonEmptyString(event.type);
  if (
    !type ||
    !STRIPE_SUCCESS_EVENT_TYPES.has(type) ||
    nonEmptyString(event.object) !== 'event'
  ) {
    return null;
  }

  const eventId = nonEmptyString(event.id);
  if (!eventId) return null;

  const data = record(event.data);
  const object = record(data?.object);
  if (!object) return null;

  const isCheckout = type.startsWith('checkout.session.');
  const isPaymentIntent = type === 'payment_intent.succeeded';
  if (!isCheckout && !isPaymentIntent) return null;

  const objectType = isCheckout ? 'checkout.session' : 'payment_intent';
  const suppliedObjectType = nonEmptyString(object.object);
  if (suppliedObjectType !== objectType) return null;

  const id = nonEmptyString(object.id);
  if (!id) return null;

  let sessionRef: string | undefined;
  let paymentRef: string | undefined;
  let amountCents: number | undefined;

  if (isCheckout) {
    sessionRef = id;
    paymentRef = paymentIntentId(object.payment_intent);
    if (
      'payment_intent' in object &&
      object.payment_intent !== null &&
      !paymentRef
    ) {
      return null;
    }
    amountCents = positiveInteger(object.amount_total);
    const paymentStatus = nonEmptyString(object.payment_status)?.toLowerCase();
    if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
      return null;
    }
  } else {
    paymentRef = id;
    amountCents = positiveInteger(object.amount_received ?? object.amount);
    const paymentStatus = nonEmptyString(object.status)?.toLowerCase();
    if (paymentStatus !== 'succeeded') return null;
  }

  const currency = currencyOf(object.currency);
  if (amountCents === undefined || !currency) return null;

  const metadata = record(object.metadata);
  if (
    'metadata' in object &&
    object.metadata !== null &&
    !metadata
  ) {
    return null;
  }
  if (
    metadata &&
    'invoiceRef' in metadata &&
    (typeof metadata.invoiceRef !== 'string' || !metadata.invoiceRef.trim())
  ) {
    return null;
  }
  const invoiceRef = metadataInvoiceRef(object);
  return {
    eventId,
    type,
    object: type,
    objectType,
    ...(sessionRef ? { sessionRef } : {}),
    ...(paymentRef ? { paymentRef } : {}),
    amountCents,
    currency,
    ...(invoiceRef ? { invoiceRef } : {}),
    // Preserve the original adapter contract: for Checkout events this
    // historical field exposed the session id. The typed `paymentRef` above is
    // the actual PaymentIntent reference used for settlement.
    paymentIntent: sessionRef ? { id: sessionRef } : paymentRef ? { id: paymentRef } : null,
  };
}
