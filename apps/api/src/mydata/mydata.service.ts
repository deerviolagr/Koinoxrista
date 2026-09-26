import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MyDataStatus, PaymentMethod, PaymentStatus } from '@prisma/client';

import type { CurrencyCode } from '@org/shared';
import { requireValidPeriod } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import {
  MYDATA_PROVIDER,
  MyDataProvider,
  MyDataPollResult,
} from './mydata.adapter';
import { SubmissionError } from './mydata.live';
import { buildMyDataXml, MyDataXmlRecord } from './mydata.xml';

const GR_MYDATA_CURRENCY: CurrencyCode = 'EUR';
const VAT_RATE_ENV = 'MYDATA_VAT_RATE_BPS';
const GREEK_VAT_RATES_BPS = new Set([0, 400, 600, 900, 1300, 1700, 2400]);

/**
 * Split a gross amount into net and VAT using an explicitly configured rate.
 * There is intentionally no default rate: an invoice total alone does not
 * contain enough information to invent a Greek VAT breakdown.
 */
export function computeNetVat(
  paidCents: number,
  vatRateBps?: number,
): { netAmountCents: number; vatAmountCents: number } {
  if (!Number.isSafeInteger(paidCents) || paidCents < 0) {
    throw new TypeError('paidCents must be a non-negative safe integer');
  }
  if (vatRateBps === undefined) {
    throw new Error(
      'A VAT rate is required; myDATA never assumes a VAT percentage',
    );
  }
  if (!Number.isSafeInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10_000) {
    throw new RangeError('vatRateBps must be an integer between 0 and 10000');
  }
  const netAmountCents = Math.round(
    (paidCents * 10_000) / (10_000 + vatRateBps),
  );
  if (!Number.isSafeInteger(netAmountCents)) {
    throw new RangeError('VAT result is outside the safe integer range');
  }
  return {
    netAmountCents,
    vatAmountCents: paidCents - netAmountCents,
  };
}

/** Invoice series; configurable later. */
const SERIES = 'A';
// AADE invoice-type code 2.1 (service provision); configurable later.
const INVOICE_TYPE = '2.1';
// AADE income classification for service income; configurable later.
const CLASSIFICATION_CATEGORY = 'category1_1';
const CLASSIFICATION_TYPE = 'E3_561_001';
// myDATA payment-method codes: '3' = card/POS, '9' = IRIS transfer.
// GR only writes these two explicitly supported rails; no method is guessed.
const PAYMENT_METHOD_CODES: Partial<Record<PaymentMethod, string>> = {
  [PaymentMethod.CARD]: '3',
  [PaymentMethod.IRIS]: '9',
};

function myDataPaymentCode(method: PaymentMethod): string {
  const code = PAYMENT_METHOD_CODES[method];
  if (!code) {
    throw new Error(`Payment method ${method} has no myDATA GR mapping`);
  }
  return code;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** Synthetic MARK for rows AADE never registered (mark column is required). */
const REJECTED_MARK_PREFIX = 'REJ-';

function rejectedMark(invoiceId: string): string {
  return (
    REJECTED_MARK_PREFIX +
    createHash('sha1')
      .update(invoiceId)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase()
  );
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

function configuredVatRateBps(): number {
  const raw = process.env[VAT_RATE_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new BadRequestException(
      `${VAT_RATE_ENV} is required; myDATA does not infer VAT from a gross amount`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !GREEK_VAT_RATES_BPS.has(value)) {
    throw new BadRequestException(
      `${VAT_RATE_ENV} must be one of the configured Greek AADE rates: 0, 400, 600, 900, 1300, 1700, 2400`,
    );
  }
  return value;
}

export function isGreekMyDataBuilding(building: {
  market?: string | null;
  currency?: string | null;
}): boolean {
  return (
    (building.market ?? 'GR').toUpperCase() === 'GR' &&
    (building.currency ?? GR_MYDATA_CURRENCY).toUpperCase() ===
      GR_MYDATA_CURRENCY
  );
}

export interface MyDataFile {
  body: string;
  contentType: string;
  filename: string;
}

@Injectable()
export class MyDataService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MYDATA_PROVIDER) private readonly provider: MyDataProvider,
  ) {}

  /**
   * myDATA is an ΑΑΔΕ/Greek adapter, not a generic invoice exporter. Every
   * public operation checks the building profile before touching invoice data
   * or a provider.
   */
  private async assertGreekBuilding(
    buildingId: string,
  ): Promise<{ currency: CurrencyCode }> {
    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { market: true, currency: true },
    });
    if (!building) {
      throw new NotFoundException('Building not found');
    }
    if ((building.market ?? 'GR').toUpperCase() !== 'GR') {
      throw new ForbiddenException(
        'myDATA is available only for Greek buildings (market=GR)',
      );
    }
    if (
      (building.currency ?? GR_MYDATA_CURRENCY).toUpperCase() !==
      GR_MYDATA_CURRENCY
    ) {
      throw new BadRequestException(
        'myDATA requires a Greek building with currency EUR',
      );
    }
    return { currency: GR_MYDATA_CURRENCY };
  }

  async generateForPeriod(
    buildingId: string,
    periodYearMonth: string,
  ): Promise<{ created: number; skipped: number }> {
    const period = requireValidPeriod(periodYearMonth);
    const { currency } = await this.assertGreekBuilding(buildingId);

    const paid = await this.prisma.invoice.findMany({
      where: {
        buildingId,
        periodYearMonth: period,
        status: PaymentStatus.PAID,
      },
      select: {
        id: true,
        paidCents: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          select: { method: true },
        },
        myData: { select: { id: true } },
      },
      orderBy: { unitId: 'asc' },
    });
    const pending = paid.filter((invoice) => !invoice.myData);
    if (pending.length === 0) {
      return { created: 0, skipped: paid.length };
    }
    const vatRateBps = configuredVatRateBps();

    let created = 0;
    await this.prisma.$transaction(async (tx) => {
      let seqNo = await tx.myDataInvoice.count({ where: { buildingId } });
      for (const invoice of pending) {
        let attempts = 0;
        for (;;) {
          seqNo += 1;
          try {
            const recorded = await this.submitOne(
              tx,
              buildingId,
              invoice,
              seqNo,
              currency,
              vatRateBps,
            );
            if (recorded === MyDataStatus.SUBMITTED) {
              created += 1;
            }
            break;
          } catch (error) {
            attempts += 1;
            if (attempts > 1 || !isUniqueConflict(error)) {
              throw error;
            }
            // A concurrent run won the unique race — resync and retry once.
            seqNo = await tx.myDataInvoice.count({ where: { buildingId } });
          }
        }
      }
    });

    return { created, skipped: paid.length - pending.length };
  }

  async listForPeriod(buildingId: string, periodYearMonth: string | undefined) {
    await this.assertGreekBuilding(buildingId);
    return this.findForPeriod(buildingId, periodYearMonth);
  }

  private async findForPeriod(
    buildingId: string,
    periodYearMonth: string | undefined,
  ) {
    const period =
      periodYearMonth !== undefined
        ? requireValidPeriod(periodYearMonth)
        : undefined;

    const records = await this.prisma.myDataInvoice.findMany({
      where: {
        buildingId,
        ...(period ? { invoice: { periodYearMonth: period } } : {}),
      },
      include: {
        invoice: {
          select: { unit: { select: { label: true } }, periodYearMonth: true },
        },
      },
      orderBy: { seqNo: 'desc' },
    });
    return records.map((record) => ({
      ...record,
      currency: GR_MYDATA_CURRENCY,
    }));
  }

  async xmlForPeriod(
    buildingId: string,
    periodYearMonth: string | undefined,
  ): Promise<MyDataFile> {
    const { currency } = await this.assertGreekBuilding(buildingId);
    const records = await this.findForPeriod(buildingId, periodYearMonth);
    const xmlRecords = records.map<MyDataXmlRecord>((record) => ({
      mark: record.mark,
      series: record.series,
      seqNo: record.seqNo,
      issueDate: record.issueDate,
      paymentMethodCode: record.paymentMethodCode,
      classificationCategory: record.classificationCategory,
      classificationType: record.classificationType,
      netAmountCents: record.netAmountCents,
      vatAmountCents: record.vatAmountCents,
      currency,
    }));
    const suffix = periodYearMonth
      ? `-${requireValidPeriod(periodYearMonth)}`
      : '-all';
    return {
      body: buildMyDataXml(xmlRecords),
      contentType: 'text/xml;charset=utf-8',
      filename: `mydata${suffix}.xml`,
    };
  }

  /**
   * Re-queries AADE for records still marked SUBMITTED and settles them to
   * ACCEPTED/REJECTED from the RequestDocs response. Providers without a
   * pollStatus (offline) reconcile nothing.
   */
  async reconcile(
    buildingId: string,
    periodYearMonth: string,
  ): Promise<{ checked: number; accepted: number; rejected: number }> {
    const period = requireValidPeriod(periodYearMonth);
    await this.assertGreekBuilding(buildingId);
    if (!this.provider.pollStatus) {
      return { checked: 0, accepted: 0, rejected: 0 };
    }

    const records = await this.prisma.myDataInvoice.findMany({
      where: {
        buildingId,
        status: MyDataStatus.SUBMITTED,
        invoice: { periodYearMonth: period },
        responseRaw: { contains: '<uid>' },
      },
      select: { id: true, mark: true },
      orderBy: { seqNo: 'asc' },
    });

    let accepted = 0;
    let rejected = 0;
    for (const record of records) {
      let result: MyDataPollResult;
      try {
        result = await this.provider.pollStatus(record.mark);
      } catch (error) {
        // Exhausted retries — leave the record for the next reconciliation run.
        if (!(error instanceof SubmissionError)) {
          throw error;
        }
        continue;
      }
      if (result.state === 'PENDING') {
        continue;
      }
      await this.prisma.myDataInvoice.update({
        where: { id: record.id },
        data: {
          status:
            result.state === 'ACCEPTED'
              ? MyDataStatus.ACCEPTED
              : MyDataStatus.REJECTED,
          responseRaw: result.raw,
        },
      });
      if (result.state === 'ACCEPTED') {
        accepted += 1;
      } else {
        rejected += 1;
      }
    }

    return { checked: records.length, accepted, rejected };
  }

  private async submitOne(
    tx: Tx,
    buildingId: string,
    invoice: {
      id: string;
      paidCents: number;
      payments: { method: PaymentMethod }[];
    },
    seqNo: number,
    currency: CurrencyCode,
    vatRateBps: number,
  ): Promise<'SUBMITTED' | 'REJECTED'> {
    const method = invoice.payments[0]?.method;
    if (!method) {
      throw new Error(`Invoice ${invoice.id} has no payment method for myDATA`);
    }
    const { netAmountCents, vatAmountCents } = computeNetVat(
      invoice.paidCents,
      vatRateBps,
    );
    const now = new Date();
    const input = {
      invoiceId: invoice.id,
      series: SERIES,
      seqNo,
      issueDate: now.toISOString().slice(0, 10),
      invoiceType: INVOICE_TYPE,
      currency,
      paymentMethodCode: myDataPaymentCode(method),
      netAmountCents,
      vatAmountCents,
      classificationCategory: CLASSIFICATION_CATEGORY,
      classificationType: CLASSIFICATION_TYPE,
    };

    let mark: string;
    let raw: string;
    let status: 'SUBMITTED' | 'REJECTED';
    try {
      const result = await this.provider.submit(input);
      mark = result.mark;
      raw = result.raw;
      status = MyDataStatus.SUBMITTED;
    } catch (error) {
      // AADE said no — persist the rejection without failing the whole run.
      if (!(error instanceof SubmissionError)) {
        throw error;
      }
      mark = rejectedMark(input.invoiceId);
      raw = error.message;
      status = MyDataStatus.REJECTED;
    }

    await tx.myDataInvoice.create({
      data: {
        invoiceId: input.invoiceId,
        buildingId,
        mark,
        series: SERIES,
        seqNo,
        issueDate: now,
        paymentMethodCode: input.paymentMethodCode,
        classificationCategory: CLASSIFICATION_CATEGORY,
        classificationType: CLASSIFICATION_TYPE,
        netAmountCents,
        vatAmountCents,
        status,
        responseRaw: raw,
      },
    });
    return status;
  }
}
