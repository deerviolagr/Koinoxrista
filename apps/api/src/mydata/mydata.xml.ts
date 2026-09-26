import { minorUnitsToMajor, type CurrencyCode } from '@org/shared';

/** One myDATA record rendered into the XML export. */
export interface MyDataXmlRecord {
  mark: string;
  series: string;
  seqNo: number;
  issueDate: Date;
  paymentMethodCode: string;
  classificationCategory: string;
  classificationType: string;
  netAmountCents: number;
  vatAmountCents: number;
  /** Explicit currency from the validated Greek building profile. */
  currency: CurrencyCode;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

function amountToDecimal(minorUnits: number, currency: CurrencyCode): string {
  return minorUnitsToMajor(minorUnits, currency).toFixed(2);
}

function isoDay(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError('myDATA issueDate must be a valid Date');
  }
  return date.toISOString().slice(0, 10);
}

/** Deterministic, namespace-light myDATA invoice document. */
export function buildMyDataXml(records: readonly MyDataXmlRecord[]): string {
  const invoices = [...records]
    .sort((a, b) => a.seqNo - b.seqNo || a.mark.localeCompare(b.mark))
    .map((record) => {
      if (record.currency !== 'EUR') {
        throw new Error('myDATA XML supports only explicitly validated EUR records');
      }
      return [
        '  <invoice>',
        `    <series>${escapeXml(record.series)}</series>`,
        `    <aa>${record.seqNo}</aa>`,
        `    <issueDate>${isoDay(record.issueDate)}</issueDate>`,
        `    <mark>${escapeXml(record.mark)}</mark>`,
        `    <currency>${escapeXml(record.currency)}</currency>`,
        `    <paymentMethod>${escapeXml(record.paymentMethodCode)}</paymentMethod>`,
        '    <invoiceDetails>',
        '      <lineNumber>1</lineNumber>',
        `      <netValue>${amountToDecimal(record.netAmountCents, record.currency)}</netValue>`,
        `      <vatAmount>${amountToDecimal(record.vatAmountCents, record.currency)}</vatAmount>`,
        '      <classifications>',
        `        <classificationCategory>${escapeXml(record.classificationCategory)}</classificationCategory>`,
        `        <classificationType>${escapeXml(record.classificationType)}</classificationType>`,
        '      </classifications>',
        '    </invoiceDetails>',
        '  </invoice>',
      ].join('\n');
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<InvoicesDoc>',
    ...invoices,
    '</InvoicesDoc>',
    '',
  ].join('\n');
}
