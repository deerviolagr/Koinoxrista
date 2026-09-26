import type { Role } from './domain';

/**
 * Registry of auditable mutation actions.  The API intentionally accepts
 * additional strings for forward-compatible modules, but these values are the
 * stable contract exposed to clients and documentation.
 */
export const AUDIT_ACTIONS = [
  'expense.created',
  'invoice.run',
  'payment.checkout',
  'payment.webhook',
  'payment.bank-import',
  'vote.created',
  'vote.ballot',
  'vote.closed',
  'subscription.changed',
  'gdpr.deleted',
  'apikey.created',
  'apikey.revoked',
  'assistant.query',
  'tenancy.occupancy.set',
  'tenancy.rule.upsert',
  'legal.case.created',
  'legal.case.escalated',
  'legal.notice.sent',
  'legal.case.note',
  'legal.case.closed',
  'compliance.created',
  'compliance.updated',
  'compliance.deleted',
  'compliance.expiry_check',
  'building.transfer.import',
  'supplier_invoice.manual_created',
  'supplier_invoice.imported_json',
  'supplier_invoice.imported_pdf',
  'supplier_invoice.pull_mydata',
  'supplier_invoice.matched',
  'supplier_invoice.voided',
  'supplier-payment.create',
  'supplier-payment.update',
  'supplier-payment.delete',
  'kpi.alert_rule.upsert',
  'permissions.set',
  'late-fee.settings.update',
  'late-fee.run',
  'late-fee.waive',
  'maintenance.asset.created',
  'maintenance.asset.updated',
  'maintenance.asset.deleted',
  'maintenance.schedule.created',
  'maintenance.schedule.updated',
  'maintenance.schedule.deleted',
  'maintenance.schedule.mark_done',
  'maintenance.generate_jobs',
  'accountant-access.grant',
  'accountant-access.revoke',
  'auth.2fa.enabled',
  'auth.2fa.disabled',
  'webhook.create',
  'webhook.delete',
  'points.adjust',
  'platform_invoice.issued',
  'partner_lead.created',
  'partner_lead.updated',
  'partner_lead.status_changed',
  'partner_lead.deleted',
  'referral.code.created',
  'referral.code.rotated',
  'referral.reward.granted',
  'referral.credit.redeemed',
  'reserve.fund.target_updated',
  'reserve.contribution.created',
  'reserve.drawdown.created',
  'reserve.levy.created',
  'reserve.levy.collected',
  'reserve.levy.issued',
  'reserve.levy.closed',
  'shop.product.create',
  'shop.order.create',
] as const;

export type KnownAuditAction = (typeof AUDIT_ACTIONS)[number];
/** Keep unknown module actions assignable while retaining known-action hints. */
export type AuditAction = KnownAuditAction | (string & {});

export interface AuditMetadata {
  _hash?: string;
  _prev?: string | null;
  _chain?: number;
  [key: string]: unknown;
}

export interface AuditLogDto {
  id: string;
  buildingId: string | null;
  actorId: string | null;
  actorRole: Role | null;
  action: AuditAction;
  entity: string;
  entityId: string | null;
  metadata: AuditMetadata | null;
  ip: string | null;
  /** ISO-8601 date-time after JSON serialization. */
  createdAt: string;
}

export interface AuditQueryDto {
  action?: string;
  entity?: string;
  entityId?: string;
  fromISO?: string;
  toISO?: string;
  skip?: number;
  take?: number;
}

export interface AuditLogPage {
  items: AuditLogDto[];
  total: number;
}
