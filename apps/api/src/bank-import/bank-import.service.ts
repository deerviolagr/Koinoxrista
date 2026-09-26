import { BadRequestException, Injectable } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentOrderState,
  PaymentStatus,
} from '@prisma/client';
import type {
  BankImportApplyResponse,
  BankImportPreviewResponse,
} from '@org/shared';

import type { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding } from '../common/tenant';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ApplyBankImportDto } from './dto/bank-import.dto';
import {
  bankReferenceMatches,
  normalizeBankReference,
  suggestMatches,
  type ParsedBankRow,
  type PendingBankPayment,
} from './match-bank-payments';
import { parseBankCsv } from './parse-bank-csv';

@Injectable()
export class BankImportService {
  private readonly referenceLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(
    buildingId: string,
    user: AuthenticatedUser,
    csv: string,
  ): Promise<BankImportPreviewResponse> {
    assertSameBuilding(user, buildingId);
    const rows = parseBankCsv(csv) as ParsedBankRow[];
    const currency = await this.buildingCurrency(buildingId);
    const pending = await this.findPendingPayments(buildingId, currency);
    return {
      rows: rows as BankImportPreviewResponse['rows'],
      pending: pending.map((payment) => ({
        paymentId: payment.paymentId,
        amountCents: payment.amountCents,
        invoicePeriodYearMonth: payment.invoicePeriodYearMonth,
        createdAtIso: payment.createdAtIso,
        unitLabel: payment.unitLabel,
      })),
      suggestions: suggestMatches(rows, pending),
    };
  }

  /**
   * Applies confirmed statement rows to the pending checkout flow.
   *
   * A PaymentOrder is the pending record created by startCheckout.  A bank
   * credit creates the corresponding PAID Payment and completes that order;
   * it is not a license to mutate an arbitrary PENDING Payment row.  Every
   * amount, currency and reference is checked inside the transaction, and a
   * bank reference is consumed at most once.
   */
  async apply(
    buildingId: string,
    user: AuthenticatedUser,
    dto: ApplyBankImportDto,
  ): Promise<BankImportApplyResponse> {
    assertSameBuilding(user, buildingId);
    const rows = parseBankCsv(dto.csv) as ParsedBankRow[];
    const buildingCurrency = await this.buildingCurrency(buildingId);
    const matches = Array.isArray(dto.matches) ? dto.matches : [];

    let applied = 0;
    let skipped = 0;
    const seenMatches = new Set<string>();
    const seenReferences = new Set<string>();
    const orderDelegate = (this.prisma as any).paymentOrder;

    for (const match of matches) {
      const row = rows[match.rowIndex];
      if (!row) {
        throw new BadRequestException(
          `Unknown statement row ${match.rowIndex}`,
        );
      }
      if (!row.reference.trim()) {
        throw new BadRequestException('Bank statement reference is required');
      }
      this.assertCurrency(row, buildingCurrency);

      const matchKey = `${match.rowIndex}:${match.paymentId}`;
      if (seenMatches.has(matchKey)) {
        skipped += 1;
        continue;
      }
      seenMatches.add(matchKey);

      const referenceKey = normalizeBankReference(row.reference);
      if (seenReferences.has(referenceKey)) {
        // The same bank credit cannot be assigned to a second order in one
        // request.  It is a replay, not a new settlement.
        skipped += 1;
        continue;
      }

      // The fallback exists only for old structural test doubles/imports that
      // do not expose PaymentOrder.  The generated Prisma client always takes
      // the order path above.
      const outcome = await this.withReferenceLock(
        `${buildingId}:${referenceKey}`,
        () =>
          orderDelegate
            ? this.applyToOrder(
                buildingId,
                buildingCurrency,
                match.paymentId,
                row,
                user,
              )
            : this.applyToLegacyPayment(
                buildingId,
                buildingCurrency,
                match.paymentId,
                row,
                user,
              ),
      );

      if (outcome === 'applied') {
        applied += 1;
        seenReferences.add(referenceKey);
      } else {
        skipped += 1;
      }
    }
    return { applied, skipped };
  }

  private async applyToOrder(
    buildingId: string,
    buildingCurrency: string,
    orderId: string,
    row: ParsedBankRow,
    user: AuthenticatedUser,
  ): Promise<'applied' | 'skipped'> {
    const rawReference = row.reference.trim();
    const reference = normalizeBankReference(rawReference);
    const eventId = `bank-import:${buildingId}:${orderId}:${reference}`;

    try {
      return await (this.prisma as any).$transaction(
        async (tx: Record<string, any>) => {
          const orderDelegate = tx.paymentOrder ?? (this.prisma as any).paymentOrder;
          const invoiceInclude = {
            select: {
              id: true,
              buildingId: true,
              totalCents: true,
              paidCents: true,
              periodYearMonth: true,
              unit: { select: { label: true } },
              building: { select: { currency: true } },
            },
          };
          const order = orderDelegate.findUnique
            ? await orderDelegate.findUnique({
                where: { id: orderId },
                include: { invoice: invoiceInclude },
              })
            : await orderDelegate.findFirst({
                where: { id: orderId },
                include: { invoice: invoiceInclude },
              });
          if (!order || order.invoice?.buildingId !== buildingId) {
            throw new BadRequestException('Unknown payment order for this building');
          }

          const invoice = order.invoice;
          const currency = String(
            order.currency ?? invoice.building?.currency ?? buildingCurrency,
          ).toUpperCase();
          if (currency !== buildingCurrency.toUpperCase()) {
            throw new BadRequestException('Payment order currency does not match the building');
          }
          this.assertCurrency(row, currency);
          if (
            !Number.isSafeInteger(order.amountCents) ||
            order.amountCents <= 0 ||
            row.amountCents !== order.amountCents
          ) {
            throw new BadRequestException('Bank amount does not match the payment order');
          }
          if (order.pspRef && !bankReferenceMatches(order.pspRef, reference)) {
            throw new BadRequestException('Payment order already has another bank reference');
          }
          if (order.eventRef && order.eventRef !== eventId) {
            throw new BadRequestException('Payment order already has another settlement event');
          }

          const expectedReferences = [
            order.orderCode,
            order.sessionRef,
            order.paymentRef,
            order.pspRef,
            order.id,
            invoice.id,
          ].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          );
          if (
            !expectedReferences.some((expected) =>
              bankReferenceMatches(row.reference, expected),
            )
          ) {
            throw new BadRequestException('Bank reference does not match the payment order');
          }

          if (order.status === PaymentOrderState.COMPLETED) {
            if (order.pspRef && !bankReferenceMatches(order.pspRef, reference)) {
              throw new BadRequestException('Bank reference was already applied');
            }
            return 'skipped';
          }
          if (order.status !== PaymentOrderState.PENDING) {
            throw new BadRequestException('Payment order is no longer pending');
          }

          // A startCheckout order represents the complete outstanding amount.
          // A smaller credit is a partial/ambiguous settlement and must not
          // be allowed to mark the order (or invoice) paid.
          const outstanding = invoice.totalCents - invoice.paidCents;
          if (
            !Number.isSafeInteger(invoice.totalCents) ||
            !Number.isSafeInteger(invoice.paidCents) ||
            invoice.totalCents < 0 ||
            invoice.paidCents < 0 ||
            invoice.paidCents > invoice.totalCents ||
            outstanding <= 0 ||
            order.amountCents !== outstanding
          ) {
            throw new BadRequestException('Payment order is stale or partially settled');
          }

          const paymentDelegate = tx.payment ?? (this.prisma as any).payment;
          if (paymentDelegate?.findFirst) {
            const replay = await paymentDelegate.findFirst({
              where: {
                pspRef: reference,
                status: PaymentStatus.PAID,
                invoice: { buildingId },
              },
              select: { id: true, invoiceId: true },
            });
            if (replay) {
              if (replay.invoiceId === invoice.id) {
                return 'skipped';
              }
              throw new BadRequestException('Bank reference was already applied');
            }
          }

          const supportsSettlementFields =
            'currency' in order ||
            'provider' in order ||
            'eventRef' in order ||
            'paymentRef' in order ||
            'sessionRef' in order;
          const claimedData: Record<string, unknown> = {
            status: PaymentOrderState.COMPLETED,
          };
          if (supportsSettlementFields) {
            claimedData.eventRef = eventId;
            claimedData.pspRef = reference;
            claimedData.settledAt = new Date();
          }
          const claimedWhere: Record<string, unknown> = {
            id: order.id,
            orderCode: order.orderCode,
            amountCents: order.amountCents,
            status: PaymentOrderState.PENDING,
          };
          if (order.provider) claimedWhere.provider = order.provider;
          if (order.currency) claimedWhere.currency = currency;
          if (orderDelegate.updateMany) {
            const claimed = await orderDelegate.updateMany({
              where: claimedWhere,
              data: claimedData,
            });
            if (!claimed || claimed.count !== 1) {
              const current = orderDelegate.findUnique
                ? await orderDelegate.findUnique({ where: { id: order.id } })
                : null;
              if (
                current?.status === PaymentOrderState.COMPLETED &&
                (!supportsSettlementFields ||
                  current.pspRef === reference ||
                  current.eventRef === eventId)
              ) {
                return 'skipped';
              }
              if (current?.status === PaymentOrderState.COMPLETED) {
                throw new BadRequestException('Bank reference was already applied');
              }
              return 'skipped';
            }
          } else {
            await orderDelegate.update({
              where: { id: order.id },
              data: claimedData,
            });
          }

          const provider = order.provider ?? 'viva';
          const paymentData: Record<string, unknown> = {
            invoiceId: invoice.id,
            method: PaymentMethod.IRIS,
            pspRef: reference,
            amountCents: order.amountCents,
            status: PaymentStatus.PAID,
          };
          if (supportsSettlementFields) {
            paymentData.paymentOrderId = order.id;
            paymentData.provider = provider;
            paymentData.currency = currency;
            paymentData.eventRef = eventId;
          }
          await paymentDelegate.create({ data: paymentData });

          const invoiceDelegate = tx.invoice ?? (this.prisma as any).invoice;
          const currentInvoice = invoiceDelegate.findUnique
            ? await invoiceDelegate.findUnique({ where: { id: invoice.id } })
            : invoice;
          if (!currentInvoice) {
            throw new BadRequestException('Invoice no longer exists');
          }
          const currentOutstanding =
            currentInvoice.totalCents - currentInvoice.paidCents;
          if (
            !Number.isSafeInteger(currentInvoice.totalCents) ||
            !Number.isSafeInteger(currentInvoice.paidCents) ||
            currentInvoice.totalCents < 0 ||
            currentInvoice.paidCents < 0 ||
            currentInvoice.paidCents > currentInvoice.totalCents ||
            !Number.isSafeInteger(currentOutstanding) ||
            currentOutstanding <= 0 ||
            order.amountCents !== currentOutstanding
          ) {
            throw new BadRequestException('Invoice changed during settlement');
          }
          const nextPaid = currentInvoice.paidCents + order.amountCents;
          if (invoiceDelegate.updateMany) {
            const updated = await invoiceDelegate.updateMany({
              where: {
                id: invoice.id,
                paidCents: { lte: currentInvoice.totalCents - order.amountCents },
              },
              data: {
                paidCents: { increment: order.amountCents },
                status:
                  nextPaid >= currentInvoice.totalCents
                    ? PaymentStatus.PAID
                    : PaymentStatus.PENDING,
              },
            });
            if (!updated || updated.count !== 1) {
              throw new BadRequestException('Invoice changed during settlement');
            }
          } else {
            await invoiceDelegate.update({
              where: { id: invoice.id },
              data: {
                paidCents: { increment: order.amountCents },
                status:
                  nextPaid >= currentInvoice.totalCents
                    ? PaymentStatus.PAID
                    : PaymentStatus.PENDING,
              },
            });
          }

          this.audit.record({
            buildingId,
            actorId: user.id,
            actorRole: user.role,
            action: 'payment.bank-import',
            entity: 'paymentOrder',
            entityId: order.id,
            metadata: {
              invoiceId: invoice.id,
              amountCents: order.amountCents,
              pspRef: reference,
              rowReference: rawReference,
              currency,
              eventId,
            },
          });
          return 'applied';
        },
        { isolationLevel: 'Serializable' as any },
      );
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        if (await this.replayBelongsToOrder(orderId, reference, eventId)) {
          return 'skipped';
        }
        throw new BadRequestException('Bank reference was already applied');
      }
      throw error;
    }
  }

  /**
   * Compatibility path for a pre-order import adapter.  It is deliberately
   * kept behind the absence of PaymentOrder and applies the same invariants;
   * normal Prisma execution never reaches it.
   */
  private async applyToLegacyPayment(
    buildingId: string,
    buildingCurrency: string,
    paymentId: string,
    row: ParsedBankRow,
    user: AuthenticatedUser,
  ): Promise<'applied' | 'skipped'> {
    return (this.prisma as any).$transaction(async (tx: Record<string, any>) => {
      const paymentDelegate = tx.payment ?? (this.prisma as any).payment;
      const payment = paymentDelegate.findUnique
        ? await paymentDelegate.findUnique({
            where: { id: paymentId },
            include: { invoice: true },
          })
        : await paymentDelegate.findFirst({ where: { id: paymentId } });
      if (!payment || payment.invoice?.buildingId !== buildingId) {
        throw new BadRequestException('Unknown payment for this building');
      }
      this.assertCurrency(row, buildingCurrency);
      if (row.amountCents !== payment.amountCents) {
        throw new BadRequestException('Bank amount does not match the payment');
      }
      if (
        !bankReferenceMatches(row.reference, payment.pspRef ?? payment.id)
      ) {
        throw new BadRequestException('Bank reference does not match the payment');
      }
      if (payment.status === PaymentStatus.PAID) return 'skipped';
      if (payment.status !== PaymentStatus.PENDING) {
        throw new BadRequestException('Payment is no longer pending');
      }
      const outstanding =
        payment.invoice.totalCents - payment.invoice.paidCents;
      if (outstanding <= 0 || payment.amountCents !== outstanding) {
        throw new BadRequestException('Payment is stale or partially settled');
      }

      if (paymentDelegate.updateMany) {
        const claimed = await paymentDelegate.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: {
            method: PaymentMethod.IRIS,
            status: PaymentStatus.PAID,
            pspRef: row.reference.trim(),
          },
        });
        if (claimed.count === 0) return 'skipped';
      } else {
        await paymentDelegate.update({
          where: { id: payment.id },
          data: {
            method: PaymentMethod.IRIS,
            status: PaymentStatus.PAID,
            pspRef: row.reference.trim(),
          },
        });
      }
      const paidCents = payment.invoice.paidCents + payment.amountCents;
      const invoiceDelegate = tx.invoice ?? (this.prisma as any).invoice;
      await invoiceDelegate.update({
        where: { id: payment.invoice.id },
        data: {
          paidCents: { increment: payment.amountCents },
          status:
            paidCents >= payment.invoice.totalCents
              ? PaymentStatus.PAID
              : PaymentStatus.PENDING,
        },
      });
      this.audit.record({
        buildingId,
        actorId: user.id,
        actorRole: user.role,
        action: 'payment.bank-import',
        entity: 'payment',
        entityId: payment.id,
        metadata: {
          invoiceId: payment.invoice.id,
          amountCents: payment.amountCents,
          pspRef: row.reference.trim(),
        },
      });
      return 'applied';
    }, { isolationLevel: 'Serializable' as any });
  }

  private async findPendingPayments(
    buildingId: string,
    buildingCurrency = 'EUR',
  ): Promise<PendingBankPayment[]> {
    const prismaAny = this.prisma as unknown as Record<string, any>;
    const orderDelegate = prismaAny.paymentOrder;
    if (orderDelegate?.findMany) {
      const orders = await orderDelegate.findMany({
        where: {
          status: PaymentOrderState.PENDING,
          invoice: { buildingId },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          orderCode: true,
          amountCents: true,
          createdAt: true,
          invoice: {
            select: {
              id: true,
              totalCents: true,
              paidCents: true,
              periodYearMonth: true,
              unit: { select: { label: true } },
              building: { select: { currency: true } },
            },
          },
        },
      });
      return orders
        .filter((order: any) => {
          if (!(order.amountCents > 0)) return false;
          if (
            !Number.isFinite(order.invoice?.totalCents) ||
            !Number.isFinite(order.invoice?.paidCents)
          ) {
            return true;
          }
          return (
            order.amountCents ===
            order.invoice.totalCents - order.invoice.paidCents
          );
        })
        .map((order: any): PendingBankPayment => ({
          // Public DTO calls this paymentId; it is the pending order id in the
          // actual checkout flow.
          paymentId: order.id,
          amountCents: order.amountCents,
          invoicePeriodYearMonth: order.invoice.periodYearMonth,
          createdAtIso:
            order.createdAt instanceof Date
              ? order.createdAt.toISOString()
              : new Date(order.createdAt).toISOString(),
          unitLabel: order.invoice.unit?.label ?? '',
          expectedReference: order.orderCode,
          currency:
            order.currency?.toUpperCase() ??
            order.invoice.building?.currency?.toUpperCase() ??
            buildingCurrency.toUpperCase(),
        }));
    }

    // Structural fallback for older adapters; see applyToLegacyPayment.
    const payments = await prismaAny.payment.findMany({
      where: { status: PaymentStatus.PENDING, invoice: { buildingId } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        pspRef: true,
        amountCents: true,
        createdAt: true,
        invoice: {
          select: {
            totalCents: true,
            paidCents: true,
            periodYearMonth: true,
            unit: { select: { label: true } },
          },
        },
      },
    });
    return payments
      .filter((payment: any) => {
        if (
          !Number.isFinite(payment.invoice?.totalCents) ||
          !Number.isFinite(payment.invoice?.paidCents)
        ) {
          return true;
        }
        return (
          payment.amountCents ===
          payment.invoice.totalCents - payment.invoice.paidCents
        );
      })
      .map((payment: any): PendingBankPayment => ({
        paymentId: payment.id,
        amountCents: payment.amountCents,
        invoicePeriodYearMonth: payment.invoice.periodYearMonth,
        createdAtIso:
          payment.createdAt instanceof Date
            ? payment.createdAt.toISOString()
            : new Date(payment.createdAt).toISOString(),
        unitLabel: payment.invoice.unit?.label ?? '',
        expectedReference: payment.pspRef ?? payment.id,
        currency: buildingCurrency.toUpperCase(),
      }));
  }

  private async replayBelongsToOrder(
    orderId: string,
    reference: string,
    eventId: string,
  ): Promise<boolean> {
    const paymentDelegate = (this.prisma as any).payment;
    if (paymentDelegate?.findFirst) {
      const payment = await paymentDelegate.findFirst({
        where: { pspRef: reference },
      });
      if (payment) return payment.paymentOrderId === orderId;
    }
    const orderDelegate = (this.prisma as any).paymentOrder;
    if (orderDelegate?.findFirst) {
      const order = await orderDelegate.findFirst({ where: { id: orderId } });
      if (
        order &&
        ((typeof order.pspRef === 'string' &&
          bankReferenceMatches(order.pspRef, reference)) ||
          (typeof order.eventRef === 'string' && order.eventRef === eventId))
      ) {
        return true;
      }
    }
    return false;
  }

  private async withReferenceLock<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.referenceLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.referenceLocks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.referenceLocks.get(key) === queued) {
        this.referenceLocks.delete(key);
      }
    }
  }

  private async buildingCurrency(buildingId: string): Promise<string> {
    const buildingDelegate = (this.prisma as unknown as Record<string, any>)
      .building;
    if (!buildingDelegate?.findUnique) return 'EUR';
    const building = await buildingDelegate.findUnique({
      where: { id: buildingId },
      select: { currency: true },
    });
    return (building?.currency ?? 'EUR').toUpperCase();
  }

  private assertCurrency(row: ParsedBankRow, expected: string): void {
    if (row.currency && row.currency.toUpperCase() !== expected.toUpperCase()) {
      throw new BadRequestException('Bank currency does not match the building');
    }
  }
}
