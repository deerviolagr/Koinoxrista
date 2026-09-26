import { SetMetadata } from '@nestjs/common';

import type { PermissionKey } from './permissions.service';

export const PERMISSION_KEY = 'permissions';
export const PERMISSIONS_KEY = PERMISSION_KEY;
export const REQUIRED_PERMISSION_KEY = PERMISSION_KEY;

/** Require every listed granular permission for a building mutation. */
export const RequirePermission = (...keys: PermissionKey[]) =>
  SetMetadata(PERMISSION_KEY, keys);

// Friendly aliases used by feature modules and by integrations that call the
// decorator a "permission" rather than a "required permission".
export const RequirePermissions = RequirePermission;
export const Permission = RequirePermission;
