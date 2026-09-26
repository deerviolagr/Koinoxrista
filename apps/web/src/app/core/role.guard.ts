import { inject } from '@angular/core';
import {
  CanActivateFn,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { Role } from '@org/shared';
import { AuthService } from './auth.service';

/** Pure helper: the home route for a given role. */
export function homeForRole(role: Role | null | undefined): string {
  if (!role) return '/login';
  switch (role) {
    case 'ADMIN':
    case 'BUILDING_OWNER':
      return '/admin';
    case 'PROVIDER':
      return '/provider';
    case 'ACCOUNTANT':
      return '/accountant';
    case 'PLATFORM_ADMIN':
      return '/platform/billing';
    default:
      return '/balance';
  }
}

/**
 * Accepts only an in-app absolute path. Protocol-relative URLs, backslashes and
 * control characters are rejected before Router receives a return URL.
 */
export function safeReturnUrl(
  value: string | null | undefined,
  fallback = '/',
): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    /[\u0000-\u001f]/.test(candidate)
  ) {
    return fallback;
  }
  try {
    const base = new URL('https://return.invalid');
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base.origin) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/** Login URL which remembers the protected in-app path that was requested. */
export function loginTreeFor(router: Router, requestedUrl: string): UrlTree {
  const returnUrl = safeReturnUrl(requestedUrl, '/');
  return router.createUrlTree(['/login'], {
    queryParams: returnUrl === '/' ? {} : { returnUrl },
  });
}

/** Restricts a route to the given roles; unauthenticated users go to /login. */
export function canActivateRole(...roles: Role[]): CanActivateFn {
  return (_route, state: RouterStateSnapshot) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const user = auth.currentUser();
    if (!user) return loginTreeFor(router, state.url);
    if (!roles.includes(user.role)) {
      return router.createUrlTree([homeForRole(user.role)]);
    }
    return true;
  };
}

/** Requires any authenticated user (no specific role). */
export const canActivateAuthed: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = auth.currentUser();
  if (!user) return loginTreeFor(router, state.url);
  return true;
};

/** Redirects '' and wildcard routes based on the current session role. */
export const homeRedirectGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = auth.currentUser();
  return router.createUrlTree([user ? homeForRole(user.role) : '/login']);
};
