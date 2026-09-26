import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'node:fs';

import {
  formatMoney,
  isCurrencyCode,
  isCurrencySupportedByMarket,
  isMarketCode,
  resolveMarket,
  type CurrencyCode,
} from '@org/shared';
import { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';

export interface PdfFile {
  body: Buffer;
  contentType: string;
  filename: string;
  etag: string;
}

export const PDF_CONTENT_TYPE = 'application/pdf';

export interface PdfMoneySettings {
  currency: CurrencyCode;
  locale: string;
}

export interface PdfBuildingSettings {
  market?: string | null;
  currency?: string | null;
}

/**
 * Resolve presentation settings from the building profile.  A caller may
 * override the locale for a one-off response, but invalid persisted values
 * fall back to the market profile rather than silently formatting as yen.
 */
export function resolvePdfSettings(
  building: PdfBuildingSettings | null | undefined,
  overrides: { locale?: string; currency?: string } = {},
): PdfMoneySettings {
  const market = isMarketCode(building?.market) ? building?.market : 'GR';
  const profile = resolveMarket(market);
  const overrideCurrency =
    overrides.currency &&
    isCurrencyCode(overrides.currency) &&
    isCurrencySupportedByMarket(market, overrides.currency)
      ? overrides.currency
      : undefined;
  const buildingCurrency =
    building?.currency &&
    isCurrencyCode(building.currency) &&
    isCurrencySupportedByMarket(market, building.currency)
      ? building.currency
      : undefined;
  const currency = overrideCurrency ?? buildingCurrency ?? profile.currency;
  const locale = overrides.locale?.trim() || profile.locale;
  return { currency, locale };
}

/** Format a stored integer minor-unit amount with the PDF's locale/profile. */
export function formatPdfMoney(
  minorUnits: number,
  settings: PdfMoneySettings,
): string {
  return formatMoney(minorUnits, settings);
}

/**
 * A font is optional.  The service only uses an explicitly configured local
 * TTF; it does not download or claim a Japanese/CJK font.  PdfKit's built-in
 * Helvetica remains the safe Latin fallback.
 */
function resolveFontPath(): string | undefined {
  const configured = process.env.PDF_FONT_PATH?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  return undefined;
}

const FONT_PATH = resolveFontPath();
const FONT = FONT_PATH ? 'ConfiguredPdfFont' : 'Helvetica';

/** Renders a pdfkit document into a Buffer (async — pdfkit streams data). */
async function renderDoc(
  build: (doc: PdfKit.PDFDocument) => void,
): Promise<Buffer> {
  const PDFDocument = require('pdfkit') as {
    new (options?: { size?: string; margin?: number }): PdfKit.PDFDocument;
  };
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  if (FONT_PATH) doc.registerFont(FONT, FONT_PATH);
  build(doc);
  doc.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    doc.on('data', (chunk: unknown) =>
      chunks.push(Buffer.from(chunk as string)),
    );
    doc.on('end', () => resolve());
    doc.on('error', (error: unknown) => reject(error));
  });
  return Buffer.concat(chunks);
}

@Injectable()
export class PdfService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /invoices/:id/pdf — an invoice for one unit. */
  async invoicePdf(
    invoiceId: string,
    user: AuthenticatedUser,
    overrides: { locale?: string; currency?: string } = {},
  ): Promise<PdfFile> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        unit: { include: { building: { include: { branding: true } } } },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    assertSameBuilding(user, invoice.buildingId);
    if (user.role !== 'ADMIN' && user.role !== 'BUILDING_OWNER') {
      const ownership = await this.prisma.ownership.findFirst({
        where: { userId: user.id, unitId: invoice.unitId },
      });
      if (!ownership) {
        throw new ForbiddenException('You do not own this unit');
      }
    }

    const expenses = await this.prisma.expense.findMany({
      where: {
        buildingId: invoice.buildingId,
        periodYearMonth: invoice.periodYearMonth,
      },
      include: { shares: { where: { unitId: invoice.unitId } }, category: true },
    });
    const lineItems = expenses
      .map((expense) => ({
        description: expense.description,
        category: expense.category.name,
        amountCents: expense.shares[0]?.amountCents ?? 0,
      }))
      .filter((item) => item.amountCents > 0);

    const building = invoice.unit.building;
    const branding = building.branding;
    const settings = resolvePdfSettings(building, overrides);
    const body = await renderDoc((doc) =>
      buildInvoicePdf(doc, {
        buildingName: building.name,
        orgName: branding?.orgName ?? building.name,
        primaryColor: branding?.primaryColor ?? '#1e40af',
        invoiceRegistrationNo: building.invoiceRegistrationNo ?? null,
        unitLabel: invoice.unit.label,
        periodYearMonth: invoice.periodYearMonth,
        totalCents: invoice.totalCents,
        paidCents: invoice.paidCents,
        status: invoice.status,
        lineItems,
        settings,
      }),
    );

    return {
      body,
      contentType: PDF_CONTENT_TYPE,
      filename: `invoice-${invoice.periodYearMonth}-${invoice.unit.label}.pdf`,
      etag: `${invoice.id}-${invoice.periodYearMonth}-${settings.currency}-${settings.locale}`,
    };
  }

  /** GET /statements/:unitId/pdf?year=… — annual statement PDF. */
  async statementPdf(
    unitId: string,
    year: string,
    user: AuthenticatedUser,
    overrides: { locale?: string; currency?: string } = {},
  ): Promise<PdfFile> {
    const unit = await this.prisma.unit.findUnique({
      where: { id: unitId },
      include: { building: { include: { branding: true } } },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    assertSameBuilding(user, unit.buildingId);
    if (user.role !== 'ADMIN' && user.role !== 'BUILDING_OWNER') {
      const ownership = await this.prisma.ownership.findFirst({
        where: { userId: user.id, unitId },
      });
      if (!ownership) {
        throw new ForbiddenException('You do not own this unit');
      }
    }

    const expenses = await this.prisma.expense.findMany({
      where: {
        buildingId: unit.buildingId,
        periodYearMonth: { startsWith: `${year}-` },
      },
      include: { shares: { where: { unitId } } },
      orderBy: { periodYearMonth: 'asc' },
    });
    const invoices = await this.prisma.invoice.findMany({
      where: {
        buildingId: unit.buildingId,
        unitId,
        periodYearMonth: { startsWith: `${year}-` },
      },
      orderBy: { periodYearMonth: 'asc' },
    });

    const rows = expenses
      .map((expense) => ({
        period: expense.periodYearMonth,
        description: expense.description,
        invoicedCents: expense.shares[0]?.amountCents ?? 0,
      }))
      .filter((row) => row.invoicedCents > 0);
    const totalInvoiced = rows.reduce((sum, row) => sum + row.invoicedCents, 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + inv.paidCents, 0);
    const branding = unit.building.branding;
    const settings = resolvePdfSettings(unit.building, overrides);

    const body = await renderDoc((doc) =>
      buildStatementPdf(doc, {
        buildingName: unit.building.name,
        orgName: branding?.orgName ?? unit.building.name,
        primaryColor: branding?.primaryColor ?? '#1e40af',
        unitLabel: unit.label,
        year,
        rows,
        totalInvoicedCents: totalInvoiced,
        totalPaidCents: totalPaid,
        balanceCents: totalInvoiced - totalPaid,
        settings,
      }),
    );

    return {
      body,
      contentType: PDF_CONTENT_TYPE,
      filename: `statement-${unit.label}-${year}.pdf`,
      etag: `${unit.id}-${year}-${settings.currency}-${settings.locale}`,
    };
  }
}

interface InvoicePdfInput {
  buildingName: string;
  orgName: string;
  primaryColor: string;
  invoiceRegistrationNo: string | null;
  unitLabel: string;
  periodYearMonth: string;
  totalCents: number;
  paidCents: number;
  status: string;
  lineItems: { description: string; category: string; amountCents: number }[];
  settings: PdfMoneySettings;
}

function buildInvoicePdf(doc: PdfKit.PDFDocument, input: InvoicePdfInput): void {
  const money = (minor: number): string =>
    formatPdfMoney(minor, input.settings);
  doc.font(FONT).fontSize(10).fillColor('#6b7280').text('INVOICE', 48, 48, { align: 'center' });
  doc.font(FONT).fontSize(18).fillColor(input.primaryColor).text('Invoice', 48, 64, { align: 'center' });
  doc.moveDown(1);
  doc.font(FONT).fontSize(11).fillColor('#111827');
  doc.text(input.orgName);
  doc.moveDown(0.2);
  doc.font(FONT).fontSize(9).fillColor('#6b7280');
  doc.text(`Tax registration: ${input.invoiceRegistrationNo ?? '(not provided)'}`);
  doc.moveDown();

  doc.font(FONT).fontSize(11).fillColor('#111827');
  doc.text(`Unit: ${input.unitLabel}`);
  doc.text(`Period: ${input.periodYearMonth}`);
  doc.text(`Total: ${money(input.totalCents)}`);
  doc.text(`Paid: ${money(input.paidCents)}`);
  doc.text(`Balance: ${money(input.totalCents - input.paidCents)}`);
  doc.text(`Status: ${input.status}`);

  doc.moveDown();
  doc.font(FONT).fontSize(12).text('Details');
  doc.moveDown(0.2);
  for (const item of input.lineItems) {
    doc.font(FONT).fontSize(10);
    doc.text(`${item.category} — ${item.description}`);
    doc.font(FONT).fontSize(10);
    doc.text(`  ${money(item.amountCents)}`, 100);
  }
  if (input.lineItems.length === 0) {
    doc.font(FONT).fontSize(10).text('No details', 100);
  }
}

interface StatementPdfInput {
  buildingName: string;
  orgName: string;
  primaryColor: string;
  unitLabel: string;
  year: string;
  rows: { period: string; description: string; invoicedCents: number }[];
  totalInvoicedCents: number;
  totalPaidCents: number;
  balanceCents: number;
  settings: PdfMoneySettings;
}

function buildStatementPdf(doc: PdfKit.PDFDocument, input: StatementPdfInput): void {
  const money = (minor: number): string =>
    formatPdfMoney(minor, input.settings);
  doc.font(FONT).fontSize(18).fillColor(input.primaryColor).text('ANNUAL STATEMENT', 48, 48, { align: 'center' });
  doc.moveDown(0.6);
  doc.font(FONT).fontSize(11).fillColor('#111827');
  doc.text(input.orgName);
  doc.moveDown();
  doc.text(`Unit: ${input.unitLabel}`);
  doc.text(`Year: ${input.year}`);
  doc.moveDown();

  doc.font(FONT).fontSize(12).text('Monthly details');
  doc.moveDown(0.2);
  for (const row of input.rows) {
    doc.font(FONT).fontSize(10);
    doc.text(`${row.period}  ${row.description}`);
    doc.font(FONT).fontSize(10);
    doc.text(`  ${money(row.invoicedCents)}`, 100);
  }
  if (input.rows.length === 0) {
    doc.font(FONT).fontSize(10).text('No data', 100);
  }

  doc.moveDown();
  doc.font(FONT).fontSize(11);
  doc.text(`Annual total: ${money(input.totalInvoicedCents)}`);
  doc.text(`Paid: ${money(input.totalPaidCents)}`);
  doc.text(`Balance: ${money(input.balanceCents)}`);
}
