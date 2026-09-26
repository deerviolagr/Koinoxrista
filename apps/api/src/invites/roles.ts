import { Role } from '@prisma/client';

/** Roles a building administrator may grant through a tenant invite. */
export const INVITABLE_ROLES = [
  Role.RESIDENT,
  Role.ADMIN,
  Role.PROVIDER,
  Role.ACCOUNTANT,
] as const satisfies readonly Role[];

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(role: unknown): role is InvitableRole {
  return INVITABLE_ROLES.includes(role as InvitableRole);
}
