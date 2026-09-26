import { Logger } from '@nestjs/common';

import {
  hasLiveConfig,
  isMockPaymentsEnabled,
} from './payment-config';

export type MercadoPagoStatus =
  | 'PENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export interface MercadoPagoPaymentStatus {
  status: MercadoPagoStatus;
  /** external_reference from the preference (our invoice id). */
  externalReference?: string | null;
  /** Preference/session reference returned by the payment API. */
  preferenceId?: string | null;
  /** Mercado Pago order reference, when supplied by the API. */
  orderId?: string | null;
  /** Exact amount in the application's minor-unit convention. */
  amountCents?: number;
  currency?: string;
}

export interface MercadoPagoAdapter {
  readonly isMock?: boolean;
  readonly isAvailable?: boolean;
  createCheckout(input: {
    amountCents: number;
    invoiceRef: string;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    buildingName?: string;
  }): Promise<{ checkoutRef: string; checkoutUrl: string }>;
  getPaymentStatus(paymentId: string): Promise<MercadoPagoPaymentStatus>;
}

export const MERCADOPAGO_ADAPTER = Symbol('MERCADOPAGO_ADAPTER');

interface MercadoPagoPreferenceResponse {
  id?: string;
  init_point?: string;
  sandbox_init_point?: string;
}

function decimalToCents(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed * 100);
  }
  return undefined;
}

/**
 * Mercado Pago Checkout Pro adapter (P0-2). Covers BR (PIX), MX (SPEI/OXXO),
 * AR/CL/CO/PE via Mercado Pago's hosted checkout. Amounts in cents; the SDK
 * expects decimal amounts, so we convert at the boundary (÷100).
 */
export class RealMercadoPagoAdapter implements MercadoPagoAdapter {
  readonly isMock = false;
  readonly isAvailable = true;

  private readonly logger = new Logger(RealMercadoPagoAdapter.name);

  constructor(
    private readonly accessToken: string,
    private readonly baseUrl = 'https://api.mercadopago.com',
  ) {
    if (!accessToken?.trim() || !baseUrl?.trim()) {
      throw new Error('Mercado Pago live configuration is incomplete');
    }
  }

  async createCheckout(input: {
    amountCents: number;
    invoiceRef: string;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    buildingName?: string;
  }): Promise<{ checkoutRef: string; checkoutUrl: string }> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error(`Invalid Mercado Pago amount for invoice ${input.invoiceRef}`);
    }
    if (!input.invoiceRef || !input.currency) {
      throw new Error('Mercado Pago checkout reference and currency are required');
    }

    const res = await fetch(`${this.baseUrl}/checkout/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [
          {
            id: input.invoiceRef,
            title: input.buildingName
              ? `PolykatoikiaOS ${input.buildingName}`
              : 'PolykatoikiaOS',
            quantity: 1,
            unit_price: input.amountCents / 100,
            currency_id: input.currency,
          },
        ],
        back_urls: { success: input.successUrl, failure: input.cancelUrl },
        auto_return: 'approved',
        external_reference: input.invoiceRef,
        notification_url: `${process.env.APP_BASE_URL ?? 'http://localhost:4200'}/api/payments/webhook/mercadopago`,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Mercado Pago preference creation failed (${res.status}) for invoice ${input.invoiceRef}`,
      );
    }
    const data = (await res.json()) as MercadoPagoPreferenceResponse;
    const checkoutRef = data.id?.trim();
    const checkoutUrl = data.init_point?.trim();
    if (!checkoutRef || !checkoutUrl) {
      throw new Error(
        `Mercado Pago returned no preference for invoice ${input.invoiceRef}`,
      );
    }
    this.logger.log(
      `Created Mercado Pago preference ${checkoutRef} for invoice ${input.invoiceRef}`,
    );
    return { checkoutRef, checkoutUrl };
  }

  async getPaymentStatus(paymentId: string): Promise<MercadoPagoPaymentStatus> {
    if (!paymentId?.trim()) throw new Error('Mercado Pago payment id is required');
    const res = await fetch(
      `${this.baseUrl}/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(
        `Mercado Pago status check failed (${res.status}) for ${paymentId}`,
      );
    }
    const data = (await res.json().catch(() => null)) as unknown;
    const row = (data ?? {}) as Record<string, unknown>;
    const responseId = typeof row.id === 'string' ? row.id : undefined;
    if (responseId && responseId !== paymentId) {
      throw new Error('Mercado Pago returned a different payment id');
    }
    const raw = typeof row.status === 'string' ? row.status : '';
    const externalReference =
      typeof row.external_reference === 'string' ? row.external_reference : null;
    const preferenceId =
      typeof row.preference_id === 'string' ? row.preference_id : null;
    const orderId = typeof row.order_id === 'string' ? row.order_id : null;
    const amountCents = decimalToCents(row.transaction_amount);
    const currency =
      typeof row.currency_id === 'string' ? row.currency_id : undefined;

    // MP statuses: approved → COMPLETED; pending/in_process → PENDING;
    // rejected/cancelled → FAILED; expired → EXPIRED.
    let status: MercadoPagoStatus;
    switch (raw.toLowerCase()) {
      case 'approved':
        status = 'COMPLETED';
        break;
      case 'pending':
      case 'in_process':
        status = 'PENDING';
        break;
      case 'expired':
        status = 'EXPIRED';
        break;
      default:
        status = 'FAILED';
    }

    const result: MercadoPagoPaymentStatus = {
      status,
      externalReference,
    };
    if (preferenceId) result.preferenceId = preferenceId;
    if (orderId) result.orderId = orderId;
    if (amountCents !== undefined) result.amountCents = amountCents;
    if (currency) result.currency = currency;
    return result;
  }
}

/** Local adapter, usable only after an explicit non-production opt-in. */
export class MockMercadoPagoAdapter implements MercadoPagoAdapter {
  readonly isMock = true;
  readonly isAvailable = true;
  private readonly checkouts = new Map<
    string,
    { invoiceRef: string; amountCents: number; currency: string }
  >();

  async createCheckout(input: {
    amountCents: number;
    invoiceRef: string;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    buildingName?: string;
  }): Promise<{ checkoutRef: string; checkoutUrl: string }> {
    if (!isMockPaymentsEnabled()) {
      throw new Error('Mock Mercado Pago adapter requires explicit non-production mock mode');
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || !input.invoiceRef) {
      throw new Error('Invalid mock Mercado Pago checkout input');
    }
    const checkoutRef = `MP-MOCK-${input.invoiceRef}-${Date.now()}`;
    this.checkouts.set(checkoutRef, {
      invoiceRef: input.invoiceRef,
      amountCents: input.amountCents,
      currency: input.currency,
    });
    const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:4200';
    return {
      checkoutRef,
      checkoutUrl: `${appBaseUrl}/balance?mockOrder=${checkoutRef}`,
    };
  }

  async getPaymentStatus(paymentId?: string): Promise<MercadoPagoPaymentStatus> {
    if (!isMockPaymentsEnabled()) {
      throw new Error('Mock Mercado Pago adapter requires explicit non-production mock mode');
    }
    const checkout = paymentId ? this.checkouts.get(paymentId) : undefined;
    if (!checkout) return { status: 'COMPLETED' };
    return {
      status: 'COMPLETED',
      externalReference: checkout.invoiceRef,
      preferenceId: paymentId,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
    };
  }
}

/** Non-mock placeholder used by the optional Nest provider. */
export class UnavailableMercadoPagoAdapter implements MercadoPagoAdapter {
  readonly isMock = false;
  readonly isAvailable = false;

  async createCheckout(): Promise<{ checkoutRef: string; checkoutUrl: string }> {
    throw new Error('Mercado Pago live configuration is missing');
  }

  async getPaymentStatus(): Promise<MercadoPagoPaymentStatus> {
    throw new Error('Mercado Pago live configuration is missing');
  }
}

/** Strict factory; missing live config never silently enables the mock. */
export function createMercadoPagoAdapter(): MercadoPagoAdapter {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (hasLiveConfig(accessToken)) {
    return new RealMercadoPagoAdapter(accessToken!);
  }
  if (accessToken?.trim()) {
    throw new Error('Mercado Pago live configuration is incomplete');
  }
  if (isMockPaymentsEnabled()) {
    return new MockMercadoPagoAdapter();
  }
  throw new Error(
    'Mercado Pago live configuration is missing; checkout is disabled until MERCADOPAGO_ACCESS_TOKEN is configured',
  );
}
