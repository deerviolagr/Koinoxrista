import axios from 'axios';

import { apiUrl } from '../support/config';
import {
  prisma,
  seedBuilding,
  residentHeaders,
  adminHeaders,
  uniquePeriod,
  createExpenseAndRun,
  closePrisma,
} from './helpers';

function requireBuilding(
  value: Awaited<ReturnType<typeof seedBuilding>> | undefined,
): Awaited<ReturnType<typeof seedBuilding>> {
  if (!value) throw new Error('Seeded building was not available');
  return value;
}

/** Full money flow against the seeded demo building. */
describe('billing lifecycle', () => {
  const period = uniquePeriod();
  let building: Awaited<ReturnType<typeof seedBuilding>> | undefined;
  let unitId: string | undefined;
  let categoryId: string | undefined;
  let expenseId: string | undefined;
  let invoiceId: string | undefined;

  beforeAll(async () => {
    building = await seedBuilding();
    unitId = building.units[0]?.id;
    if (!unitId) throw new Error('Seeded building has no units');
    const created = await createExpenseAndRun(building.id, period);
    categoryId = created.categoryId;
    expenseId = created.expenseId;
    const invoice = created.invoices.find((inv) => inv.unitId === unitId);
    if (!invoice) throw new Error('No invoice produced for resident unit');
    invoiceId = invoice.id;
  });

  it('creates one invoice per unit for the period', async () => {
    const activeBuilding = requireBuilding(building);
    const res = await axios.get(
      apiUrl(`/buildings/${activeBuilding.id}/invoices?periodYearMonth=${period}`),
      { headers: await adminHeaders() },
    );
    expect(res.data.length).toBe(activeBuilding.units.length);
    const first = res.data[0];
    expect(first.unitId).toBeTruthy();
    expect(first.totalCents).toBeGreaterThan(0);
  });

  it('resident sees the invoice in their balance', async () => {
    const res = await axios.get(
      apiUrl(`/invoices/mine?periodYearMonth=${period}`),
      { headers: await residentHeaders() },
    );
    const found = res.data.find(
      (inv: { id: string }) => inv.id === invoiceId,
    );
    expect(found).toBeTruthy();
    expect(found.status).toBe('PENDING');
  });

  it('resident starts checkout and the webhook marks the invoice paid', async () => {
    const checkout = await axios.post(
      apiUrl(`/invoices/${invoiceId}/pay`),
      {},
      { headers: await residentHeaders() },
    );
    const orderCode = checkout.data.order.orderCode as string;
    expect(orderCode).toBeTruthy();
    expect(checkout.data.order.status).toBe('PENDING');

    const webhook = await axios.post(apiUrl('/payments/webhook'), { orderCode });
    expect(webhook.data.ok).toBe(true);

    const detail = await axios.get(apiUrl(`/invoices/${invoiceId}`), {
      headers: await residentHeaders(),
    });
    expect(detail.data.status).toBe('PAID');
    expect(detail.data.paidCents).toBe(detail.data.totalCents);
    expect(detail.data.payments.length).toBe(1);
  });

  it('blocks paying an already-paid invoice', async () => {
    await expect(
      axios.post(
        apiUrl(`/invoices/${invoiceId}/pay`),
        {},
        { headers: await residentHeaders() },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  afterAll(async () => {
    try {
      if (invoiceId) {
        await prisma.payment.deleteMany({ where: { invoiceId } });
        await prisma.paymentOrder.deleteMany({ where: { invoiceId } });
        await prisma.invoice.deleteMany({
          where: {
            id: invoiceId,
            ...(building ? { buildingId: building.id } : {}),
          },
        });
      }
      if (expenseId) {
        await prisma.share.deleteMany({ where: { expenseId } });
        await prisma.expense.deleteMany({ where: { id: expenseId } });
      }
      if (categoryId) {
        await prisma.expenseCategory.deleteMany({ where: { id: categoryId } });
      }
    } finally {
      await closePrisma();
    }
  });
});
