import { Logger } from '@nestjs/common';

import {
  hasLiveConfig,
  isMockPaymentsEnabled,
  isProductionEnvironment,
} from './payment-config';

export type VivaOrderStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface VivaAdapter {
  /** False for the live adapter, true for the explicit local mock. */
  readonly isMock?: boolean;
  /** Used by the module's optional provider when credentials are absent. */
  readonly isAvailable?: boolean;
  createOrder(
    amountCents: number,
    invoiceRef: string,
  ): Promise<{ orderCode: string; checkoutUrl: string }>;
  getOrderStatus(orderCode: string): Promise<VivaOrderStatus>;
}

export const VIVA_ADAPTER = Symbol('VIVA_ADAPTER');

const STATUSES: readonly VivaOrderStatus[] = [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
];

interface VivaOrderResponse {
  orderCode?: number | string;
}

/** Viva Wallet Smart Checkout adapter (amounts already in cents). */
export class RealVivaAdapter implements VivaAdapter {
  readonly isMock = false;
  readonly isAvailable = true;

  private readonly logger = new Logger(RealVivaAdapter.name);

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {
    if (!baseUrl?.trim() || !clientId?.trim() || !clientSecret?.trim()) {
      throw new Error('Viva live configuration is incomplete');
    }
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
  }

  async createOrder(
    amountCents: number,
    invoiceRef: string,
  ): Promise<{ orderCode: string; checkoutUrl: string }> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error(`Invalid Viva amount for invoice ${invoiceRef}`);
    }
    if (!invoiceRef) {
      throw new Error('Viva invoice reference is required');
    }

    const res = await fetch(`${this.baseUrl}/api/checkout/v1/orders`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: amountCents }),
    });
    if (!res.ok) {
      throw new Error(
        `Viva order creation failed (${res.status}) for invoice ${invoiceRef}`,
      );
    }
    const data = (await res.json()) as VivaOrderResponse;
    if (data.orderCode === undefined || data.orderCode === null || data.orderCode === '') {
      throw new Error(`Viva returned no orderCode for invoice ${invoiceRef}`);
    }
    const orderCode = String(data.orderCode).trim();
    if (!orderCode) {
      throw new Error(`Viva returned an invalid orderCode for invoice ${invoiceRef}`);
    }
    this.logger.log(`Created Viva order ${orderCode} for invoice ${invoiceRef}`);
    return {
      orderCode,
      checkoutUrl: `${this.baseUrl}/web/checkout?ref=${orderCode}`,
    };
  }

  async getOrderStatus(orderCode: string): Promise<VivaOrderStatus> {
    if (!orderCode?.trim()) throw new Error('Viva order code is required');
    const res = await fetch(
      `${this.baseUrl}/api/checkout/v1/orders/${encodeURIComponent(orderCode)}`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!res.ok) {
      throw new Error(`Viva status check failed (${res.status}) for ${orderCode}`);
    }
    const data = (await res.json().catch(() => null)) as unknown;
    const raw =
      typeof data === 'string'
        ? data
        : ((data as { status?: unknown } | null)?.status ?? '');
    const normalized = String(raw).toUpperCase();
    return STATUSES.find((status) => status === normalized) ?? 'PENDING';
  }
}

/** Local adapter, usable only after an explicit non-production opt-in. */
export class MockVivaAdapter implements VivaAdapter {
  readonly isMock = true;
  readonly isAvailable = true;

  async createOrder(
    amountCents: number,
    invoiceRef: string,
  ): Promise<{ orderCode: string; checkoutUrl: string }> {
    if (!isMockPaymentsEnabled()) {
      throw new Error('Mock Viva adapter requires explicit non-production mock mode');
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !invoiceRef) {
      throw new Error('Invalid mock Viva checkout input');
    }
    const orderCode = `MOCK-${invoiceRef}-${Date.now()}`;
    const appBaseUrl =
      process.env.APP_BASE_URL ?? 'http://localhost:4200';
    return {
      orderCode,
      checkoutUrl: `${appBaseUrl}/balance?mockOrder=${orderCode}`,
    };
  }

  async getOrderStatus(): Promise<VivaOrderStatus> {
    if (!isMockPaymentsEnabled()) {
      throw new Error('Mock Viva adapter requires explicit non-production mock mode');
    }
    return 'COMPLETED';
  }
}

/** A non-mock placeholder used by the Nest module to defer failure to checkout. */
export class UnavailableVivaAdapter implements VivaAdapter {
  readonly isMock = false;
  readonly isAvailable = false;

  async createOrder(): Promise<{ orderCode: string; checkoutUrl: string }> {
    throw new Error('Viva live configuration is missing');
  }

  async getOrderStatus(): Promise<VivaOrderStatus> {
    throw new Error('Viva live configuration is missing');
  }
}

/**
 * Strict factory. Missing or partial live configuration never silently turns
 * into a mock; callers must explicitly opt into local mock mode.
 */
export function createVivaAdapter(): VivaAdapter {
  const clientId = process.env.PSP_VIVA_CLIENT_ID;
  const clientSecret = process.env.PSP_VIVA_CLIENT_SECRET;
  if (hasLiveConfig(clientId, clientSecret)) {
    const configuredBaseUrl = process.env.PSP_VIVA_BASE_URL?.trim();
    const baseUrl = configuredBaseUrl || 'https://demo.vivapayments.com';
    if (
      isProductionEnvironment() &&
      (!configuredBaseUrl || /demo\.vivapayments\.com/i.test(configuredBaseUrl))
    ) {
      throw new Error('A non-demo PSP_VIVA_BASE_URL is required in production');
    }
    return new RealVivaAdapter(baseUrl, clientId!, clientSecret!);
  }

  // A partially configured provider is a deployment error, not a request to
  // use a fake.  Only the completely absent configuration may use the mock.
  if ((clientId && clientId.trim()) || (clientSecret && clientSecret.trim())) {
    throw new Error('Viva live configuration is incomplete');
  }
  if (isMockPaymentsEnabled()) {
    return new MockVivaAdapter();
  }
  throw new Error(
    'Viva live configuration is missing; checkout is disabled until PSP_VIVA_CLIENT_ID and PSP_VIVA_CLIENT_SECRET are configured',
  );
}
