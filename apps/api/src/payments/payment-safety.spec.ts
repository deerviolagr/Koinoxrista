import { ServiceUnavailableException } from '@nestjs/common';
import {
  PaymentOrderState,
  PaymentStatus,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseVerifiedStripeEvent } from './stripe-webhook';
import { PaymentsService } from './payments.service';
import { StripeWebhookController } from './payments.controller';
import { createMercadoPagoAdapter } from './mercadopago.adapter';
import { createVivaAdapter, MockVivaAdapter, UnavailableVivaAdapter } from './viva.adapter';
import { RealStripeAdapter, StripeLike } from './stripe.adapter';

const audit = () => ({ record: jest.fn() }) as unknown as AuditService;

const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'invoice-1',
  buildingId: 'building-1',
  unitId: 'unit-1',
  totalCents: 10_000,
  paidCents: 0,
  status: PaymentStatus.PENDING,
  unit: {
    id: 'unit-1',
    building: {
      pspProvider: 'viva',
      name: 'Test building',
      currency: 'EUR',
    },
  },
  ...overrides,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  invoiceId: 'invoice-1',
  orderCode: 'viva-1',
  amountCents: 10_000,
  status: PaymentOrderState.PENDING,
  provider: 'viva',
  currency: 'EUR',
  sessionRef: 'viva-1',
  ...overrides,
});

function prismaForStripe(
  initialOrder: Record<string, any> = order(),
  initialInvoice: Record<string, any> = invoice(),
) {
  const state = {
    orderStatus: initialOrder.status as PaymentOrderState,
    paidCents: initialInvoice.paidCents as number,
    paymentCreates: 0,
    invoiceUpdates: 0,
  };
  const tx = {
    paymentOrder: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (
          where.id === initialOrder.id &&
          where.status === PaymentOrderState.PENDING &&
          state.orderStatus === PaymentOrderState.PENDING
        ) {
          state.orderStatus = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findUnique: jest.fn(async () => ({
        ...initialOrder,
        status: state.orderStatus,
      })),
    },
    invoice: {
      findUnique: jest.fn(async () => ({
        ...initialInvoice,
        paidCents: state.paidCents,
      })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== initialInvoice.id || state.paidCents > where.paidCents.lte) {
          return { count: 0 };
        }
        state.paidCents += data.paidCents.increment;
        state.invoiceUpdates += 1;
        return { count: 1 };
      }),
    },
    payment: {
      create: jest.fn(async () => {
        state.paymentCreates += 1;
        return { id: 'payment-1' };
      }),
    },
  };
  const prisma = {
    invoice: { findUnique: jest.fn().mockResolvedValue(initialInvoice) },
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    paymentOrder: {
      findUnique: jest.fn(async () => ({
        ...initialOrder,
        status: state.orderStatus,
      })),
      findFirst: jest.fn(),
      findMany: jest.fn(async () => [
        { ...initialOrder, status: state.orderStatus },
      ]),
    },
    $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    __state: state,
  };
  return { prisma, tx, state };
}

function stripeAdapter(claim: Record<string, unknown>) {
  return {
    isMock: false,
    isAvailable: true,
    createCheckout: jest.fn(),
    verifyWebhook: jest.fn().mockResolvedValue(claim),
  };
}

describe('payment safety: Stripe raw event validation', () => {
  it('rejects an invalid signature without touching the database', async () => {
    const fakeStripe: StripeLike = {
      checkout: { sessions: { create: jest.fn() } },
      webhooks: {
        constructEvent: jest.fn(() => {
          throw new Error('bad signature');
        }),
      },
    } as unknown as StripeLike;
    const adapter = new RealStripeAdapter('sk_test');
    (adapter as unknown as { stripe: StripeLike }).stripe = fakeStripe;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

    const service = new PaymentsService(
      {} as PrismaService,
      audit(),
      undefined,
      undefined,
      adapter,
    );
    await expect(
      service.handleStripeWebhook(Buffer.from('{"id":"evt"}'), 'bad-signature'),
    ).resolves.toEqual({ ok: false });
    expect(fakeStripe.webhooks.constructEvent).toHaveBeenCalledWith(
      Buffer.from('{"id":"evt"}'),
      'bad-signature',
      'whsec_test',
    );
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it('rejects a signed event with an invalid success-event shape', () => {
    expect(
      parseVerifiedStripeEvent({
        id: 'evt_bad',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_bad', metadata: { invoiceRef: 'invoice-1' } } },
      }),
    ).toBeNull();
    expect(
      parseVerifiedStripeEvent({
        id: 'evt_failed',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            object: 'payment_intent',
            id: 'pi_bad',
            amount_received: 100,
            currency: 'usd',
          },
        },
      }),
    ).toBeNull();
  });

  it('passes the untouched raw body and signature header from the controller', async () => {
    const service = {
      handleStripeWebhook: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new StripeWebhookController(service as any);
    const rawBody = Buffer.from('{"id":"evt_1"}');
    await expect(
      controller.webhook({ rawBody }, 't=1,v1=abc'),
    ).resolves.toEqual({ ok: true });
    expect(service.handleStripeWebhook).toHaveBeenCalledWith(rawBody, 't=1,v1=abc');
  });
});

describe('payment safety: exact references, replay, and overpayment', () => {
  it('rejects a signed event whose session reference is not the stored order', async () => {
    const { prisma } = prismaForStripe(
      order({ provider: 'stripe', sessionRef: 'cs_good', currency: 'USD' }),
      invoice({
        totalCents: 10_000,
        paidCents: 0,
        unit: {
          id: 'unit-1',
          building: { pspProvider: 'stripe', name: 'Stripe', currency: 'USD' },
        },
      }),
    );
    const adapter = stripeAdapter({
      eventId: 'evt_wrong',
      type: 'checkout.session.completed',
      object: 'checkout.session.completed',
      objectType: 'checkout.session',
      sessionRef: 'cs_other',
      paymentRef: 'pi_other',
      amountCents: 10_000,
      currency: 'USD',
      invoiceRef: 'invoice-1',
      paymentIntent: { id: 'pi_other' },
    });
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      undefined,
      undefined,
      adapter as any,
    );
    await expect(
      service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature'),
    ).resolves.toEqual({ ok: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts an exact payment_intent.succeeded reference', async () => {
    const { prisma, state } = prismaForStripe(
      order({ provider: 'stripe', sessionRef: 'cs_pi', paymentRef: 'pi_exact', currency: 'USD' }),
      invoice({
        totalCents: 10_000,
        paidCents: 0,
        unit: {
          id: 'unit-1',
          building: { pspProvider: 'stripe', name: 'Stripe', currency: 'USD' },
        },
      }),
    );
    const adapter = stripeAdapter({
      eventId: 'evt_pi',
      type: 'payment_intent.succeeded',
      object: 'payment_intent.succeeded',
      objectType: 'payment_intent',
      paymentRef: 'pi_exact',
      amountCents: 10_000,
      currency: 'USD',
      invoiceRef: 'invoice-1',
      paymentIntent: { id: 'pi_exact' },
    });
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      undefined,
      undefined,
      adapter as any,
    );
    await expect(
      service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature'),
    ).resolves.toEqual({ ok: true });
    expect(state.paymentCreates).toBe(1);
  });

  it('rejects a signed event with the wrong amount or currency', async () => {
    const { prisma } = prismaForStripe(
      order({ provider: 'stripe', sessionRef: 'cs_amount', currency: 'USD' }),
      invoice({
        totalCents: 10_000,
        paidCents: 0,
        unit: {
          id: 'unit-1',
          building: { pspProvider: 'stripe', name: 'Stripe', currency: 'USD' },
        },
      }),
    );
    const adapter = stripeAdapter({
      eventId: 'evt_amount',
      type: 'checkout.session.completed',
      object: 'checkout.session.completed',
      objectType: 'checkout.session',
      sessionRef: 'cs_amount',
      amountCents: 9_999,
      currency: 'USD',
      invoiceRef: 'invoice-1',
      paymentIntent: null,
    });
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      undefined,
      undefined,
      adapter as any,
    );
    await expect(
      service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature'),
    ).resolves.toEqual({ ok: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('claims a pending order once under duplicate/concurrent settlement', async () => {
    const { prisma, state } = prismaForStripe(
      order({ provider: 'stripe', sessionRef: 'cs_1', paymentRef: 'pi_1', currency: 'USD' }),
      invoice({
        totalCents: 10_000,
        paidCents: 0,
        unit: {
          id: 'unit-1',
          building: { pspProvider: 'stripe', name: 'Stripe', currency: 'USD' },
        },
      }),
    );
    const adapter = stripeAdapter({
      eventId: 'evt_1',
      type: 'checkout.session.completed',
      object: 'checkout.session.completed',
      objectType: 'checkout.session',
      sessionRef: 'cs_1',
      paymentRef: 'pi_1',
      amountCents: 10_000,
      currency: 'USD',
      invoiceRef: 'invoice-1',
      paymentIntent: { id: 'pi_1' },
    });
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      undefined,
      undefined,
      adapter as any,
    );
    const results = await Promise.all([
      service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature'),
      service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature'),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(state.paymentCreates).toBe(1);
    expect(state.invoiceUpdates).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects a payment that would exceed the invoice remainder', async () => {
    const { prisma, state } = prismaForStripe(
      order({ amountCents: 3_000 }),
      invoice({ totalCents: 10_000, paidCents: 8_000 }),
    );
    const adapter = {
      isMock: false,
      isAvailable: true,
      createCheckout: jest.fn(),
      verifyWebhook: jest.fn(),
    };
    // Use the Viva path so no external Stripe claim is needed.
    const viva = {
      isMock: false,
      isAvailable: true,
      createOrder: jest.fn(),
      getOrderStatus: jest.fn().mockResolvedValue('COMPLETED'),
    };
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      viva as any,
      undefined,
      adapter as any,
    );
    await expect(service.handleWebhook({ orderCode: 'viva-1' })).resolves.toEqual({
      ok: false,
    });
    expect(state.paymentCreates).toBe(0);
    expect(state.invoiceUpdates).toBe(0);
  });
});

describe('payment safety: production configuration', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMock = process.env.PAYMENTS_MOCK_MODE;

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMock === undefined) delete process.env.PAYMENTS_MOCK_MODE;
    else process.env.PAYMENTS_MOCK_MODE = previousMock;
    delete process.env.PSP_VIVA_CLIENT_ID;
    delete process.env.PSP_VIVA_CLIENT_SECRET;
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  });

  it('does not enable Viva or Mercado Pago mocks in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_MOCK_MODE = 'true';
    delete process.env.PSP_VIVA_CLIENT_ID;
    delete process.env.PSP_VIVA_CLIENT_SECRET;
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    expect(() => createVivaAdapter()).toThrow(/configuration is missing/);
    expect(() => createMercadoPagoAdapter()).toThrow(/configuration is missing/);
  });

  it('rejects checkout when the live Viva adapter is unavailable', async () => {
    process.env.NODE_ENV = 'production';
    const { prisma } = prismaForStripe(invoice());
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      new UnavailableVivaAdapter(),
    );
    await expect(service.startCheckout('invoice-1', {
      id: 'user-1',
      email: 'resident@example.test',
      role: 'ADMIN' as any,
      buildingId: 'building-1',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects an injected mock adapter in production', async () => {
    process.env.NODE_ENV = 'production';
    const { prisma } = prismaForStripe(invoice());
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      new MockVivaAdapter(),
    );
    await expect(service.startCheckout('invoice-1', {
      id: 'user-1',
      email: 'resident@example.test',
      role: 'ADMIN' as any,
      buildingId: 'building-1',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('never falls back from GMO to Viva', async () => {
    const { prisma } = prismaForStripe(
      order(),
      invoice({
        unit: {
          id: 'unit-1',
          building: { pspProvider: 'gmo', name: 'GMO building', currency: 'EUR' },
        },
      }),
    );
    const viva = {
      isMock: false,
      isAvailable: true,
      createOrder: jest.fn(),
      getOrderStatus: jest.fn(),
    };
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      audit(),
      viva as any,
    );
    await expect(service.startCheckout('invoice-1', {
      id: 'admin-1',
      email: 'admin@example.test',
      role: 'ADMIN' as any,
      buildingId: 'building-1',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(viva.createOrder).not.toHaveBeenCalled();
  });
});
