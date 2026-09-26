/** Small, dependency-free adapters for the API DTOs used by the screens. */

export const RESIDENT_ROLE = 'RESIDENT';
export const STAFF_ROLES = new Set(['ADMIN', 'BUILDING_OWNER']);

function normalizedRole(role) {
  return typeof role === 'string' ? role.toUpperCase() : role;
}

export function isResidentRole(role) {
  return normalizedRole(role) === RESIDENT_ROLE;
}

export function isStaffRole(role) {
  return STAFF_ROLES.has(normalizedRole(role));
}

/** Resolve the active building from /auth/me and its memberships response. */
export function getBuildingId(user) {
  if (!user) return null;
  if (user.buildingId) return user.buildingId;
  const memberships = Array.isArray(user.memberships) ? user.memberships : [];
  const active =
    memberships.find((membership) => membership?.isDefault) ?? memberships[0];
  return active?.building?.id ?? active?.buildingId ?? null;
}

function asItems(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === 'object') {
    for (const key of keys) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [];
}

export function normalizeInvoices(payload) {
  return asItems(payload, ['invoices', 'items']).filter(
    (invoice) => invoice && typeof invoice === 'object',
  );
}

export function normalizeAnnouncements(payload) {
  return asItems(payload, ['announcements', 'items']).filter(
    (announcement) => announcement && typeof announcement === 'object',
  );
}

export function normalizeProducts(payload) {
  return asItems(payload, ['products', 'items']).filter(
    (product) => product && typeof product === 'object',
  );
}

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function invoiceTotalCents(invoice) {
  return cents(invoice?.totalCents ?? invoice?.amountCents ?? 0);
}

export function invoicePaidCents(invoice) {
  return cents(invoice?.paidCents ?? invoice?.paidAmountCents ?? 0);
}

export function invoiceDueCents(invoice) {
  return Math.max(0, invoiceTotalCents(invoice) - invoicePaidCents(invoice));
}

/**
 * The invoice endpoint returns an array, not a `{ totalOutstanding }`
 * summary. Keep the calculation in one tested place so dashboard and balance
 * cannot disagree about partial payments or paid invoices.
 */
export function calculateInvoiceTotals(payload) {
  const invoices = normalizeInvoices(payload);
  return invoices.reduce(
    (totals, invoice) => {
      const total = invoiceTotalCents(invoice);
      const paid = Math.min(invoicePaidCents(invoice), total);
      const due = Math.max(0, total - paid);
      return {
        totalCents: totals.totalCents + total,
        paidCents: totals.paidCents + paid,
        outstandingCents: totals.outstandingCents + due,
        count: totals.count + 1,
      };
    },
    { totalCents: 0, paidCents: 0, outstandingCents: 0, count: 0 },
  );
}

export function balanceCents(payload) {
  if (typeof payload === 'number' && Number.isFinite(payload)) {
    return Math.max(0, Math.round(payload));
  }
  if (payload && typeof payload === 'object') {
    for (const key of [
      'outstandingCents',
      'totalOutstandingCents',
      'totalOutstanding',
    ]) {
      if (typeof payload[key] === 'number' && Number.isFinite(payload[key])) {
        return Math.max(0, Math.round(payload[key]));
      }
    }
  }
  return calculateInvoiceTotals(payload).outstandingCents;
}

export function formatDate(value, locale = 'el-GR') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale);
}

/** Route names are kept independent from React Navigation for easy testing. */
export function homeForRole(role) {
  if (!role) return 'login';
  if (isResidentRole(role)) return 'resident';
  if (isStaffRole(role)) return 'staff';
  return 'unsupported';
}
