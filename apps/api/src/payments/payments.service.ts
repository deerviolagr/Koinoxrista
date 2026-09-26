import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentOrderState,
  PaymentStatus,
} from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding } from '../common/tenant';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertLiveAdapter,
  isProductionEnvironment,
  normalizeCurrency,
  normalizeProvider,
} from './payment-config';
import type { PaymentProvider } from './payment-config';
import {
  VIVA_ADAPTER,
  VivaAdapter,
  VivaOrderStatus,
} from './viva.adapter';
import {
  STRIPE_JP_ADAPTER,
  StripeJpAdapter,
} from './stripejp.adapter';
import {
  STRIPE_ADAPTER,
  StripeAdapter,
} from './stripe.adapter';
import {
  MERCADOPAGO_ADAPTER,
  MercadoPagoAdapter,
  MercadoPagoPaymentStatus,
} from './mercadopago.adapter';
import { STRIPE_SUCCESS_EVENT_TYPES } from './stripe-webhook';
import type { StripeWebhookClaim } from './stripe-webhook';

const STRIPE_PROVIDERS = new Set<PaymentProvider>(['stripe', 'stripejp']);

type PaymentOrderRecord = {
  id: string;
  invoiceId: string;
  orderCode: string;
  amountCents: number;
  status: PaymentOrderState;
  provider?: string | null;
  currency?: string | null;
  sessionRef?: string | null;
  paymentRef?: string | null;
  eventRef?: string | null;
  pspRef?: string | null;
  createdAt?: Date;
  invoice?: {
    id?: string;
    buildingId: string;
    totalCents: number;
    paidCents: number;
    status?: PaymentStatus;
  } | null;
};

type SettlementInput = {
  order: PaymentOrderRecord;
  provider: PaymentProvider;
  pspRef: string;
  paymentRef?: string;
  eventId: string;
  eventType: string;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
};

class SettlementRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementRejectedError';
  }
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(VIVA_ADAPTER) private readonly viva?: VivaAdapter,
    @Optional() @Inject(STRIPE_JP_ADAPTER)
    private readonly stripeJp?: StripeJpAdapter,
    @Optional() @Inject(STRIPE_ADAPTER)
    private readonly stripe?: StripeAdapter,
    @Optional() @Inject(MERCADOPAGO_ADAPTER)
    private readonly mercadopago?: MercadoPagoAdapter,
  ) {}

  async startCheckout(invoiceId: string, user: AuthenticatedUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        unit: {
          include: {
            building: {
              select: {
                pspProvider: true,
                name: true,
                currency: true,
              },
            },
          },
        },
      },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    await this.assertAccess(invoice.buildingId, invoice.unitId, user);

    if (
      !Number.isSafeInteger(invoice.totalCents) ||
      !Number.isSafeInteger(invoice.paidCents) ||
      invoice.totalCents < 0 ||
      invoice.paidCents < 0
    ) {
      throw new BadRequestException('Invoice has invalid payment amounts');
    }
    if (invoice.paidCents > invoice.totalCents) {
      throw new BadRequestException('Invoice is already paid');
    }
    const outstandingCents = invoice.totalCents - invoice.paidCents;
    if (invoice.status === PaymentStatus.PAID || outstandingCents <= 0) {
      throw new BadRequestException('Invoice is already paid');
    }
    if (!Number.isSafeInteger(outstandingCents) || outstandingCents <= 0) {
      throw new BadRequestException('Invoice has an invalid outstanding amount');
    }

    const configuredProvider = invoice.unit.building.pspProvider;
    const provider = normalizeProvider(
      configuredProvider === null || configuredProvider === undefined || configuredProvider === ''
        ? 'viva'
        : configuredProvider,
    );
    if (!provider) {
      throw new BadRequestException('Unsupported payment provider');
    }

    const currency = normalizeCurrency(
      invoice.unit.building.currency ??
        (isProductionEnvironment() ? undefined : 'EUR'),
    );
    if (!currency) {
      throw new BadRequestException('Building has an invalid payment currency');
    }

    const appUrl = process.env.APP_BASE_URL ?? 'http://localhost:4200';
    let orderCode: string;
    let checkoutUrl: string;
    let paymentRef: string | undefined;
    let sessionRef: string | undefined;

    if (provider === 'viva' && currency !== 'EUR') {
      throw new BadRequestException('Viva checkout only supports EUR');
    }
    if (provider === 'stripejp' && currency !== 'JPY') {
      throw new BadRequestException('Stripe JP checkout requires JPY');
    }

    switch (provider) {
      case 'viva': {
        this.requireAvailableAdapter(this.viva, 'Viva');
        const checkout = await this.viva!.createOrder(
          outstandingCents,
          invoice.id,
        );
        orderCode = checkout.orderCode;
        checkoutUrl = checkout.checkoutUrl;
        sessionRef = checkout.orderCode;
        break;
      }
      case 'stripe': {
        this.requireAvailableAdapter(this.stripe, 'Stripe');
        const checkout = await this.stripe!.createCheckout({
          amountCents: outstandingCents,
          invoiceRef: invoice.id,
          currency,
          successUrl: `${appUrl}/balance?stripe=success`,
          cancelUrl: `${appUrl}/balance?stripe=cancelled`,
          buildingName: invoice.unit.building.name,
        });
        orderCode = checkout.sessionRef ?? checkout.paymentIntentRef;
        checkoutUrl = checkout.checkoutUrl;
        sessionRef = checkout.sessionRef ?? checkout.paymentIntentRef;
        paymentRef = checkout.paymentRef;
        break;
      }
      case 'mercadopago': {
        this.requireAvailableAdapter(this.mercadopago, 'Mercado Pago');
        const checkout = await this.mercadopago!.createCheckout({
          amountCents: outstandingCents,
          invoiceRef: invoice.id,
          currency,
          successUrl: `${appUrl}/balance?stripe=success`,
          cancelUrl: `${appUrl}/balance?stripe=cancelled`,
          buildingName: invoice.unit.building.name,
        });
        orderCode = checkout.checkoutRef;
        checkoutUrl = checkout.checkoutUrl;
        sessionRef = checkout.checkoutRef;
        break;
      }
      case 'stripejp': {
        this.requireAvailableAdapter(this.stripeJp, 'Stripe JP');
        const checkout = await this.stripeJp!.createCheckout({
          amountCents: outstandingCents,
          invoiceRef: invoice.id,
          currency,
          successUrl: `${appUrl}/balance?stripe=success`,
          cancelUrl: `${appUrl}/balance?stripe=cancelled`,
          buildingName: invoice.unit.building.name,
        });
        orderCode = checkout.sessionRef ?? checkout.paymentIntentRef;
        checkoutUrl = checkout.checkoutUrl;
        sessionRef = checkout.sessionRef ?? checkout.paymentIntentRef;
        paymentRef = checkout.paymentRef;
        break;
      }
      case 'gmo':
        // GMO has no adapter yet. Never silently send a GMO order through Viva.
        throw new ServiceUnavailableException('GMO payment provider is not available');
      default:
        throw new BadRequestException('Unsupported payment provider');
    }

    if (!orderCode || !checkoutUrl || !sessionRef) {
      throw new ServiceUnavailableException('Payment provider returned an invalid checkout');
    }

    const order = await (this.prisma.paymentOrder.create as any)({
      data: {
        invoiceId: invoice.id,
        orderCode,
        amountCents: outstandingCents,
        status: PaymentOrderState.PENDING,
        checkoutUrl,
        provider,
        currency,
        sessionRef,
        ...(paymentRef ? { paymentRef } : {}),
      },
    });

    this.audit.record({
      buildingId: invoice.buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'payment.checkout',
      entity: 'paymentOrder',
      entityId: order.id,
      metadata: {
        invoiceId: invoice.id,
        amountCents: outstandingCents,
        currency,
        provider,
      },
    });
    return { order, provider };
  }

  async getOrder(orderId: string, user: AuthenticatedUser) {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      include: {
        invoice: { select: { buildingId: true, unitId: true } },
      },
    });
    if (!order) {
      throw new NotFoundException('Payment order not found');
    }
    await this.assertAccess(
      order.invoice.buildingId,
      order.invoice.unitId,
      user,
    );
    return order;
  }

  async getInvoiceDetail(invoiceId: string, user: AuthenticatedUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true, orders: true, unit: { select: { label: true } } },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    await this.assertAccess(invoice.buildingId, invoice.unitId, user);
    return invoice;
  }

  /** Viva callback. The callback is only a trigger; status is fetched live. */
  async handleWebhook(body: { orderCode: string; transactionId?: string }): Promise<{
    ok: boolean;
  }> {
    const orderCode = typeof body?.orderCode === 'string' ? body.orderCode.trim() : '';
    if (!orderCode || !this.viva || !this.isUsableAdapter(this.viva)) {
      return { ok: false };
    }
    try {
      assertLiveAdapter(this.viva, 'Viva');
    } catch {
      return { ok: false };
    }

    const order = (await this.prisma.paymentOrder.findUnique({
      where: { orderCode },
      include: { invoice: true },
    })) as unknown as PaymentOrderRecord | null;
    if (!order || this.orderProvider(order) !== 'viva') {
      return { ok: false };
    }
    if (order.status === PaymentOrderState.COMPLETED) {
      const callbackTransactionId =
        typeof body.transactionId === 'string' ? body.transactionId.trim() : '';
      if (order.pspRef && callbackTransactionId && order.pspRef !== callbackTransactionId) {
        return { ok: false };
      }
      return { ok: true };
    }
    if (order.status !== PaymentOrderState.PENDING) {
      return { ok: false };
    }

    let pspStatus: VivaOrderStatus;
    try {
      pspStatus = await this.viva.getOrderStatus(order.orderCode);
    } catch {
      return { ok: false };
    }
    if (pspStatus !== 'COMPLETED') {
      // A pending provider response is not proof of failure. Mark only
      // terminal failures, and do so conditionally to avoid clobbering a
      // concurrent successful settlement.
      if (pspStatus === 'FAILED' || pspStatus === 'EXPIRED') {
        const delegate = this.prisma.paymentOrder as any;
        if (typeof delegate.updateMany === 'function') {
          await delegate.updateMany({
            where: { id: order.id, status: PaymentOrderState.PENDING },
            data: {
              status:
                pspStatus === 'EXPIRED'
                  ? PaymentOrderState.EXPIRED
                  : PaymentOrderState.FAILED,
            },
          });
        }
      }
      return { ok: false };
    }

    const transactionId =
      typeof body.transactionId === 'string' && body.transactionId.trim()
        ? body.transactionId.trim()
        : order.orderCode;
    return {
      ok: await this.settleOrder({
        order,
        provider: 'viva',
        pspRef: transactionId,
        eventId: `viva:${order.orderCode}:${transactionId}`,
        eventType: 'order.completed',
        method: PaymentMethod.CARD,
        amountCents: order.amountCents,
        currency: this.orderCurrency(order),
      }),
    };
  }

  /**
   * Stripe webhook entry point. The HTTP controller must pass the untouched
   * raw body and `stripe-signature`; parsed JSON is intentionally not accepted
   * here because a modified body cannot be authenticated.
   */
  async handleStripeWebhook(
    rawBody: string | Buffer,
    signatureHeader?: string,
  ): Promise<{ ok: boolean }> {
    if (
      (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) ||
      rawBody.length === 0 ||
      typeof signatureHeader !== 'string' ||
      !signatureHeader.trim()
    ) {
      return { ok: false };
    }

    const verifier = this.isUsableAdapter(this.stripe)
      ? this.stripe
      : this.isUsableAdapter(this.stripeJp)
        ? this.stripeJp
        : undefined;
    if (!verifier) return { ok: false };
    try {
      assertLiveAdapter(verifier, 'Stripe');
    } catch {
      return { ok: false };
    }

    let claim: StripeWebhookClaim | null;
    try {
      claim = await verifier.verifyWebhook(rawBody, signatureHeader);
    } catch {
      return { ok: false };
    }
    if (!claim) return { ok: false };
    return { ok: await this.settleStripeClaim(claim) };
  }

  /** Mercado Pago callback: verify the payment with the PSP before settlement. */
  async handleMercadoPagoWebhook(body: {
    type?: string;
    data?: { id?: string } | null;
    eventId?: string;
  }): Promise<{ ok: boolean }> {
    const type = typeof body?.type === 'string' ? body.type : '';
    const paymentId =
      typeof body?.data?.id === 'string' ? body.data.id.trim() : '';
    if (
      !['payment', 'merchant_order'].includes(type) ||
      !paymentId ||
      !this.mercadopago ||
      !this.isUsableAdapter(this.mercadopago)
    ) {
      return { ok: false };
    }
    try {
      assertLiveAdapter(this.mercadopago, 'Mercado Pago');
    } catch {
      return { ok: false };
    }

    let pspStatus: MercadoPagoPaymentStatus;
    try {
      pspStatus = await this.mercadopago.getPaymentStatus(paymentId);
    } catch {
      return { ok: false };
    }
    if (pspStatus.status !== 'COMPLETED') return { ok: false };

    const order = await this.findMercadoPagoOrder(paymentId, pspStatus);
    if (!order || this.orderProvider(order) !== 'mercadopago') {
      return { ok: false };
    }

    const invoiceRef =
      typeof pspStatus.externalReference === 'string'
        ? pspStatus.externalReference.trim()
        : undefined;
    if (invoiceRef && invoiceRef !== order.invoiceId) return { ok: false };

    const amountCents = pspStatus.amountCents;
    const currency = normalizeCurrency(pspStatus.currency);
    // A real PSP response must contain both values and an exact checkout
    // reference. The explicit mock adapter is the only path allowed to omit
    // server fields, and it still settles against the immutable order values.
    if (
      (amountCents === undefined || !currency) &&
      this.mercadopago.isMock !== true
    ) {
      return { ok: false };
    }
    if (
      this.mercadopago.isMock !== true &&
      (!pspStatus.externalReference ||
        (!pspStatus.preferenceId && !pspStatus.orderId))
    ) {
      return { ok: false };
    }

    const effectiveAmount = amountCents ?? order.amountCents;
    const effectiveCurrency = currency ?? this.orderCurrency(order);
    if (
      !this.matchesOrderAmountAndCurrency(
        order,
        effectiveAmount,
        effectiveCurrency,
      )
    ) {
      return { ok: false };
    }

    const rawCheckoutRef =
      typeof pspStatus.preferenceId === 'string'
        ? pspStatus.preferenceId
        : typeof pspStatus.orderId === 'string'
          ? pspStatus.orderId
          : undefined;
    const exactCheckoutRef = rawCheckoutRef?.trim();
    if (exactCheckoutRef) {
      const storedSession = order.sessionRef ?? order.orderCode;
      if (storedSession !== exactCheckoutRef) return { ok: false };
    }

    if (order.status === PaymentOrderState.COMPLETED) {
      const storedPaymentRef = order.paymentRef ?? order.pspRef;
      if (storedPaymentRef !== paymentId) {
        return { ok: false };
      }
      return { ok: true };
    }
    if (order.status !== PaymentOrderState.PENDING) return { ok: false };

    return {
      ok: await this.settleOrder({
        order,
        provider: 'mercadopago',
        pspRef: paymentId,
        paymentRef: paymentId,
        eventId:
          typeof body.eventId === 'string' && body.eventId.trim()
            ? body.eventId.trim()
            : `mercadopago:${paymentId}`,
        eventType: type,
        method: PaymentMethod.PIX,
        amountCents: effectiveAmount,
        currency: effectiveCurrency,
      }),
    };
  }

  private async settleStripeClaim(claim: StripeWebhookClaim): Promise<boolean> {
    if (
      typeof claim.eventId !== 'string' ||
      !claim.eventId.trim() ||
      typeof claim.type !== 'string' ||
      !claim.type ||
      !STRIPE_SUCCESS_EVENT_TYPES.has(claim.type) ||
      claim.object !== claim.type ||
      (claim.objectType !== 'checkout.session' && claim.objectType !== 'payment_intent') ||
      (claim.objectType === 'checkout.session' &&
        !claim.type.startsWith('checkout.session.')) ||
      (claim.objectType === 'payment_intent' &&
        claim.type !== 'payment_intent.succeeded')
    ) {
      return false;
    }
    if (
      !claim.amountCents ||
      !Number.isSafeInteger(claim.amountCents) ||
      claim.amountCents <= 0 ||
      typeof claim.currency !== 'string' ||
      !normalizeCurrency(claim.currency) ||
      (claim.sessionRef !== undefined && typeof claim.sessionRef !== 'string') ||
      (claim.paymentRef !== undefined && typeof claim.paymentRef !== 'string') ||
      (claim.invoiceRef !== undefined && typeof claim.invoiceRef !== 'string')
    ) {
      return false;
    }
    if (claim.objectType === 'checkout.session' && !claim.sessionRef) {
      return false;
    }
    if (claim.objectType === 'payment_intent' && !claim.paymentRef) {
      return false;
    }

    const orders = await this.findStripeOrders(claim);
    if (orders.length !== 1) return false;
    const order = orders[0];
    const provider = this.orderProvider(order);
    if (!provider || !STRIPE_PROVIDERS.has(provider)) return false;

    if (!this.matchesOrderAmountAndCurrency(order, claim.amountCents, claim.currency)) {
      return false;
    }
    if (claim.invoiceRef && claim.invoiceRef !== order.invoiceId) {
      return false;
    }
    if (!this.matchesStripeReference(order, claim)) return false;

    if (order.status === PaymentOrderState.COMPLETED) {
      // A later success event for the same, already-settled PSP reference is a
      // harmless replay. A different reference is not silently acknowledged.
      return this.matchesSettledReference(order, claim);
    }
    if (order.status !== PaymentOrderState.PENDING) return false;

    return this.settleOrder({
      order,
      provider,
      pspRef: claim.paymentRef ?? claim.sessionRef!,
      ...(claim.paymentRef ? { paymentRef: claim.paymentRef } : {}),
      eventId: claim.eventId,
      eventType: claim.type,
      method: PaymentMethod.CARD,
      amountCents: claim.amountCents,
      currency: normalizeCurrency(claim.currency)!,
    });
  }

  private async findStripeOrders(claim: StripeWebhookClaim): Promise<PaymentOrderRecord[]> {
    const conditions: Record<string, unknown>[] = [];
    if (claim.sessionRef) {
      conditions.push({ sessionRef: claim.sessionRef }, { orderCode: claim.sessionRef });
    }
    if (claim.paymentRef) {
      conditions.push({ paymentRef: claim.paymentRef }, { orderCode: claim.paymentRef });
    }
    if (conditions.length === 0) return [];

    const delegate = this.prisma.paymentOrder as any;
    const where = { OR: conditions };
    if (typeof delegate.findMany === 'function') {
      const result = await delegate.findMany({ where });
      const rows = (Array.isArray(result) ? result : []) as PaymentOrderRecord[];
      const refs = [claim.sessionRef, claim.paymentRef].filter(Boolean) as string[];
      const filtered = rows.filter((row) => {
        const provider = this.orderProvider(row);
        const exactReference = refs.some(
          (ref) =>
            row.sessionRef === ref ||
            row.paymentRef === ref ||
            row.orderCode === ref,
        );
        return (
          provider !== null &&
          STRIPE_PROVIDERS.has(provider) &&
          exactReference
        );
      });
      if (filtered.length > 0 || typeof delegate.findFirst !== 'function') {
        return filtered;
      }
    }
    const refs = [...new Set([claim.sessionRef, claim.paymentRef].filter(Boolean))] as string[];
    const exactRows = (rows: PaymentOrderRecord[]) =>
      rows.filter((row) => {
        const provider = this.orderProvider(row);
        return (
          provider !== null &&
          STRIPE_PROVIDERS.has(provider) &&
          refs.some(
            (ref) =>
              row.sessionRef === ref ||
              row.paymentRef === ref ||
              row.orderCode === ref,
          )
        );
      });
    const row = (await delegate.findFirst?.({ where })) as PaymentOrderRecord | null | undefined;
    if (row) return exactRows([row]);
    if (typeof delegate.findUnique === 'function') {
      const fallbackRows: PaymentOrderRecord[] = [];
      for (const ref of refs) {
        const candidate = (await delegate.findUnique({ where: { orderCode: ref } })) as PaymentOrderRecord | null;
        if (candidate) fallbackRows.push(candidate);
      }
      return exactRows(fallbackRows);
    }
    return [];
  }

  private async findMercadoPagoOrder(
    paymentId: string,
    status: MercadoPagoPaymentStatus,
  ): Promise<PaymentOrderRecord | null> {
    const conditions: Record<string, unknown>[] = [];
    const rawCheckoutRef =
      typeof status.preferenceId === 'string'
        ? status.preferenceId
        : typeof status.orderId === 'string'
          ? status.orderId
          : undefined;
    const exactCheckoutRef = rawCheckoutRef?.trim();
    if (exactCheckoutRef) {
      conditions.push(
        { sessionRef: exactCheckoutRef },
        { orderCode: exactCheckoutRef },
      );
    }
    conditions.push({ paymentRef: paymentId }, { orderCode: paymentId });

    const delegate = this.prisma.paymentOrder as any;
    let rows: PaymentOrderRecord[];
    if (typeof delegate.findMany === 'function') {
      const exactWhere = { OR: conditions };
      const exactRows = await delegate.findMany({ where: exactWhere });
      rows = (Array.isArray(exactRows) ? exactRows : []) as PaymentOrderRecord[];
      rows = rows.filter((row) => {
        const providerMatches = this.orderProvider(row) === 'mercadopago';
        const referenceMatches =
          (exactCheckoutRef !== undefined &&
            (row.sessionRef === exactCheckoutRef || row.orderCode === exactCheckoutRef)) ||
          row.paymentRef === paymentId ||
          row.orderCode === paymentId;
        return providerMatches && referenceMatches;
      });
      if (rows.length === 0 && status.externalReference && !exactCheckoutRef) {
        const invoiceRows = await delegate.findMany({
          where: {
            invoiceId: status.externalReference,
            status: PaymentOrderState.PENDING,
          },
        });
        rows = (Array.isArray(invoiceRows) ? invoiceRows : []) as PaymentOrderRecord[];
        rows = rows.filter((row) => this.orderProvider(row) === 'mercadopago');
      }
    } else {
      const row = (await delegate.findFirst?.({
        where: { OR: conditions },
      })) as PaymentOrderRecord | null;
      rows = row ? [row] : [];
    }
    if (rows.length === 0 && typeof delegate.findFirst === 'function') {
      const row = (await delegate.findFirst({
        where: { OR: conditions },
      })) as PaymentOrderRecord | null;
      rows =
        row &&
        this.orderProvider(row) === 'mercadopago' &&
        ((exactCheckoutRef !== undefined &&
          (row.sessionRef === exactCheckoutRef || row.orderCode === exactCheckoutRef)) ||
          row.paymentRef === paymentId ||
          row.orderCode === paymentId)
          ? [row]
          : [];
    }
    if (rows.length === 0 && typeof delegate.findUnique === 'function') {
      const refs = [...new Set([exactCheckoutRef, paymentId].filter(Boolean))] as string[];
      for (const ref of refs) {
        const row = (await delegate.findUnique({ where: { orderCode: ref } })) as PaymentOrderRecord | null;
        if (
          row &&
          this.orderProvider(row) === 'mercadopago' &&
          (exactCheckoutRef === undefined
            ? row.paymentRef === paymentId || row.orderCode === paymentId
            : row.sessionRef === exactCheckoutRef || row.orderCode === exactCheckoutRef)
        ) {
          rows.push(row);
          break;
        }
      }
    }
    // Never choose the newest order for an invoice when more than one
    // outstanding checkout could match an external reference.
    return rows.length === 1 ? rows[0] : null;
  }

  private matchesOrderAmountAndCurrency(
    order: PaymentOrderRecord,
    amountCents: number,
    currency: string,
  ): boolean {
    const normalizedCurrency = normalizeCurrency(currency);
    return (
      Number.isSafeInteger(amountCents) &&
      amountCents > 0 &&
      amountCents === order.amountCents &&
      normalizedCurrency !== null &&
      normalizedCurrency === this.orderCurrency(order)
    );
  }

  private matchesStripeReference(
    order: PaymentOrderRecord,
    claim: StripeWebhookClaim,
  ): boolean {
    const storedSession = order.sessionRef ?? order.orderCode;
    const storedPayment = order.paymentRef ?? order.pspRef;
    if (claim.sessionRef && claim.sessionRef !== storedSession) return false;
    if (claim.paymentRef) {
      if (claim.objectType === 'payment_intent') {
        if (storedPayment !== claim.paymentRef && order.orderCode !== claim.paymentRef) {
          return false;
        }
      } else if (storedPayment && claim.paymentRef !== storedPayment) {
        return false;
      }
    }
    return Boolean(claim.sessionRef || claim.paymentRef);
  }

  private matchesSettledReference(
    order: PaymentOrderRecord,
    claim: StripeWebhookClaim,
  ): boolean {
    const storedSession = order.sessionRef ?? order.orderCode;
    const storedPayment = order.paymentRef ?? order.pspRef;
    if (claim.sessionRef && claim.sessionRef !== storedSession) return false;
    if (claim.paymentRef && claim.paymentRef !== storedPayment) {
      return false;
    }
    if (claim.objectType === 'payment_intent' && !claim.paymentRef) {
      return false;
    }
    return true;
  }

  private orderProvider(order: PaymentOrderRecord): PaymentProvider | null {
    return normalizeProvider(order.provider ?? 'viva');
  }

  private orderCurrency(order: PaymentOrderRecord): string {
    return normalizeCurrency(order.currency ?? 'EUR') ?? 'EUR';
  }

  private isUsableAdapter(adapter: unknown): boolean {
    if (!adapter) return false;
    const candidate = adapter as { isAvailable?: boolean };
    return candidate.isAvailable !== false;
  }

  private requireAvailableAdapter(adapter: unknown, provider: string): void {
    if (
      isProductionEnvironment() &&
      (provider === 'Stripe' || provider === 'Stripe JP') &&
      !process.env.STRIPE_WEBHOOK_SECRET?.trim()
    ) {
      throw new ServiceUnavailableException('Stripe webhook configuration is missing');
    }
    if (!this.isUsableAdapter(adapter)) {
      throw new ServiceUnavailableException(`${provider} live configuration is missing`);
    }
    try {
      assertLiveAdapter(adapter, provider);
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : `${provider} adapter is unavailable`,
      );
    }
  }

  /**
   * Atomically claim PENDING → COMPLETED, create the unique PSP payment, and
   * conditionally increment the invoice. Every operation is in one transaction;
   * any failed claim, replay, or overpayment rolls back the whole operation.
   */
  private async settleOrder(input: SettlementInput): Promise<boolean> {
    if (
      !input.order.id ||
      !input.order.orderCode ||
      !input.pspRef ||
      !input.eventId ||
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents <= 0 ||
      input.amountCents !== input.order.amountCents
    ) {
      return false;
    }
    const currency = normalizeCurrency(input.currency);
    if (!currency) return false;
    if (
      isProductionEnvironment() &&
      (!input.order.provider || !normalizeCurrency(input.order.currency))
    ) {
      return false;
    }

    try {
      const outcome = (await this.prisma.$transaction(
        async (tx) => {
          const delegate = tx as any;
          const orderDelegate = delegate.paymentOrder;
          if (
            !orderDelegate ||
            typeof orderDelegate.updateMany !== 'function' ||
            typeof orderDelegate.findUnique !== 'function' ||
            !delegate.payment ||
            typeof delegate.payment.create !== 'function' ||
            !delegate.invoice ||
            typeof delegate.invoice.findUnique !== 'function' ||
            typeof delegate.invoice.updateMany !== 'function'
          ) {
            // A deployment without the additive safety migration/client is not
            // allowed to fall back to an unsafe update. Treat it as rejected.
            return { ok: false, buildingId: null };
          }

          const orderUpdate: Record<string, unknown> = {
            status: PaymentOrderState.COMPLETED,
            eventRef: input.eventId,
            pspRef: input.pspRef,
            settledAt: new Date(),
          };
          if (input.paymentRef) orderUpdate.paymentRef = input.paymentRef;

          // The status predicate is the compare-and-swap. A concurrent
          // settlement gets count=0 and cannot touch the invoice.
          const claimed = await orderDelegate.updateMany({
            where: {
              id: input.order.id,
              orderCode: input.order.orderCode,
              amountCents: input.order.amountCents,
              provider: input.provider,
              currency,
              status: PaymentOrderState.PENDING,
            },
            data: orderUpdate,
          });
          if (!claimed || claimed.count !== 1) {
            const current = await orderDelegate.findUnique({
              where: { id: input.order.id },
            });
            const sameSettlement =
              current?.status === PaymentOrderState.COMPLETED &&
              current.orderCode === input.order.orderCode &&
              (!current.eventRef || current.eventRef === input.eventId) &&
              (!current.pspRef || current.pspRef === input.pspRef);
            return { ok: sameSettlement, buildingId: null };
          }

          const invoice = (await delegate.invoice.findUnique({
            where: { id: input.order.invoiceId },
          })) as {
            id: string;
            buildingId: string;
            totalCents: number;
            paidCents: number;
            status?: PaymentStatus;
          } | null;
          if (!invoice) {
            throw new SettlementRejectedError('Invoice no longer exists');
          }
          if (
            !Number.isSafeInteger(invoice.totalCents) ||
            !Number.isSafeInteger(invoice.paidCents) ||
            invoice.totalCents < 0 ||
            invoice.paidCents < 0 ||
            invoice.paidCents > invoice.totalCents ||
            (invoice.status === PaymentStatus.PAID &&
              invoice.paidCents !== invoice.totalCents)
          ) {
            throw new SettlementRejectedError('Invoice amounts are invalid');
          }
          const remaining = invoice.totalCents - invoice.paidCents;
          if (input.amountCents > remaining) {
            throw new SettlementRejectedError('Payment would overpay the invoice');
          }

          await delegate.payment.create({
            data: {
              invoiceId: invoice.id,
              paymentOrderId: input.order.id,
              provider: input.provider,
              currency,
              eventRef: input.eventId,
              method: input.method,
              pspRef: input.pspRef,
              amountCents: input.amountCents,
              status: PaymentStatus.PAID,
            },
          });

          const nextPaid = invoice.paidCents + input.amountCents;
          // The predicate is rechecked in the same transaction, so two
          // different pending orders cannot both consume the same remainder.
          const updated = await delegate.invoice.updateMany({
            where: {
              id: invoice.id,
              paidCents: { lte: invoice.totalCents - input.amountCents },
            },
            data: {
              paidCents: { increment: input.amountCents },
              status:
                nextPaid >= invoice.totalCents
                  ? PaymentStatus.PAID
                  : PaymentStatus.PENDING,
            },
          });
          if (!updated || updated.count !== 1) {
            throw new SettlementRejectedError('Invoice changed during settlement');
          }
          return { ok: true, buildingId: invoice.buildingId };
        },
        { isolationLevel: 'Serializable' },
      )) as { ok: boolean; buildingId: string | null };

      if (outcome.ok && outcome.buildingId) {
        this.audit.record({
          buildingId: outcome.buildingId,
          action: `payment.webhook.${input.provider}`,
          entity: 'paymentOrder',
          entityId: input.order.id,
          metadata: {
            provider: input.provider,
            eventId: input.eventId,
            pspRef: input.pspRef,
            amountCents: input.amountCents,
            currency,
          },
        });
      }
      return outcome.ok;
    } catch (error) {
      if (error instanceof SettlementRejectedError) return false;
      if (this.isUniqueViolation(error)) {
        return this.replayBelongsToOrder(input);
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  private async replayBelongsToOrder(input: SettlementInput): Promise<boolean> {
    const paymentDelegate = this.prisma.payment as any;
    if (paymentDelegate && typeof paymentDelegate.findFirst === 'function') {
      const payment = await paymentDelegate.findFirst({
        where: { pspRef: input.pspRef },
        select: { paymentOrderId: true },
      });
      if (payment) return payment.paymentOrderId === input.order.id;
    }
    const orderDelegate = this.prisma.paymentOrder as any;
    if (orderDelegate && typeof orderDelegate.findFirst === 'function') {
      const order = await orderDelegate.findFirst({
        where: { eventRef: input.eventId },
        select: { id: true },
      });
      if (order) return order.id === input.order.id;
    }
    return false;
  }

  private async assertAccess(
    buildingId: string,
    unitId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    assertSameBuilding(user, buildingId);
    if (user.role === 'ADMIN' || user.role === 'BUILDING_OWNER') {
      return;
    }
    const ownership = await this.prisma.ownership.findFirst({
      where: { userId: user.id, unitId },
    });
    if (!ownership) {
      throw new ForbiddenException('You do not own this unit');
    }
  }
}
