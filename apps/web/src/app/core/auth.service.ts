import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  finalize,
  map,
  of,
  shareReplay,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import type { MembershipDto, Role } from '@org/shared';
import { environment } from '../../environments/environment';
import { AnalyticsService } from './analytics.service';

export type AccountStatus =
  | 'ACTIVE'
  | 'PENDING_VERIFICATION'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'SUSPENDED';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  buildingId: string | null;
  status?: AccountStatus;
  /** Present once the API serves the 2FA flag from /auth/me. */
  twoFactorEnabled?: boolean;
  /** Synthetic region code for the active building (defaults to GR). */
  market?: string;
  /** ISO-4217 currency for the active building (defaults to EUR). */
  currency?: string;
  /** Returned by /auth/me so a building switch can update the selector too. */
  memberships?: MembershipDto[];
}

export interface RegisterPayload {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  /** Raw invite token; role/building are derived from it server-side. */
  inviteToken?: string;
  /** Referral code (`BLD-XXXXXX`) captured at /register?ref=… */
  referralCode?: string;
}

export interface RegisterOpenPayload {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  /** Eight alphanumeric characters supplied by the building administrator. */
  buildingCode: string;
}

export interface RegistrationResult {
  id: string;
  email: string;
  status: AccountStatus;
}

/** Result of POST /auth/login: signed in, challenged for 2FA, or not active. */
export type LoginStep =
  | { status: 'signed-in'; user: AuthUser }
  | { status: 'two-factor'; ticket: string };

/** A correctly authenticated account which is not allowed into the app yet. */
export class AuthAccountStatusError extends Error {
  constructor(
    readonly accountStatus: AccountStatus,
    readonly email: string,
  ) {
    super(`Account status is ${accountStatus}`);
    this.name = 'AuthAccountStatusError';
  }
}

/** Missing status is treated as ACTIVE for compatibility with older API builds. */
export function isActiveAccount(user: Pick<AuthUser, 'status'>): boolean {
  return !user.status || user.status === 'ACTIVE';
}

/**
 * Result of POST /auth/login (mirrors libs/shared/src/lib/two-factor.ts until
 * the shared barrel export lands): either signed in, or a 2FA challenge.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly analytics = inject(AnalyticsService);
  private token: string | null = null;

  /** All concurrent 401 retries share this one refresh/rotation request. */
  private refreshInFlight: Observable<string> | null = null;
  private logoutInFlight: Observable<void> | null = null;
  /** Invalidates a refresh response which resolves after logout/session change. */
  private sessionEpoch = 0;

  readonly currentUser = signal<AuthUser | null>(null);
  readonly memberships = signal<MembershipDto[]>([]);

  get accessToken(): string | null {
    return this.token;
  }

  get role(): Role | null {
    return this.currentUser()?.role ?? null;
  }

  get isAdmin(): boolean {
    return this.role === 'ADMIN' || this.role === 'BUILDING_OWNER';
  }

  get isResident(): boolean {
    return this.role === 'RESIDENT';
  }

  login(email: string, password: string): Observable<LoginStep> {
    return this.http
      .post<{
        accessToken?: string;
        twoFactorRequired?: boolean;
        ticket?: string;
      }>(`${environment.apiUrl}/auth/login`, {
        email,
        password,
      })
      .pipe(
        switchMap((res) => {
          if (res.twoFactorRequired && res.ticket) {
            // Second step required; tokens are NOT stored yet.
            return of<LoginStep>({ status: 'two-factor', ticket: res.ticket });
          }
          this.sessionEpoch += 1;
          this.token = res.accessToken ?? null;
          return this.fetchMe().pipe(
            map((user): LoginStep => {
              this.assertActive(user);
              this.setCurrentUser(user);
              this.analytics.identify(user.id);
              this.analytics.capture('login_success');
              return { status: 'signed-in', user };
            }),
          );
        }),
        catchError((error: unknown) => {
          this.clearSession();
          return throwError(() => error);
        }),
      );
  }

  /** Second login step: redeems the ticket with a TOTP/recovery code. */
  loginWith2fa(ticket: string, token: string): Observable<AuthUser> {
    return this.http
      .post<{ accessToken: string }>(`${environment.apiUrl}/auth/login/2fa`, {
        ticket,
        token,
      })
      .pipe(
        tap((res) => {
          this.sessionEpoch += 1;
          this.token = res.accessToken;
        }),
        switchMap(() => this.fetchMe()),
        map((user) => {
          this.assertActive(user);
          this.setCurrentUser(user);
          this.analytics.identify(user.id);
          this.analytics.capture('login_success');
          return user;
        }),
        catchError((error: unknown) => {
          this.clearSession();
          return throwError(() => error);
        }),
      );
  }

  /** Invite/referral registration keeps the legacy auto-login behaviour. */
  register(payload: RegisterPayload): Observable<AuthUser> {
    return this.http
      .post<unknown>(`${environment.apiUrl}/auth/register`, payload)
      .pipe(
        switchMap(() => this.login(payload.email, payload.password)),
        map((step) => {
          // A freshly registered account can never have 2FA enabled.
          if (step.status !== 'signed-in') {
            throw new Error('unexpected 2FA challenge after registration');
          }
          return step.user;
        }),
      );
  }

  /** Open resident registration: creates PENDING_VERIFICATION; no login. */
  registerOpen(payload: RegisterOpenPayload): Observable<RegistrationResult> {
    return this.http.post<RegistrationResult>(
      `${environment.apiUrl}/auth/register-open`,
      payload,
    );
  }

  verifyEmail(token: string): Observable<RegistrationResult> {
    return this.http.post<RegistrationResult>(
      `${environment.apiUrl}/auth/verify-email`,
      { token },
    );
  }

  /** Resend is deliberately generic to avoid disclosing account existence. */
  resendVerification(email: string): Observable<void> {
    return this.http
      .post<void>(`${environment.apiUrl}/auth/resend-verification`, { email })
      .pipe(map(() => undefined));
  }

  refreshAccessToken(): Observable<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const epoch = this.sessionEpoch;

    const refresh$ = defer(() =>
      this.http.post<{ accessToken: string }>(
        `${environment.apiUrl}/auth/refresh`,
        {},
      ),
    ).pipe(
      tap((res) => {
        if (epoch === this.sessionEpoch) this.token = res.accessToken;
      }),
      map((res) => res.accessToken),
      catchError((error: unknown) => {
        this.refreshInFlight = null;
        return throwError(() => error);
      }),
      finalize(() => (this.refreshInFlight = null)),
      // Keep the successful result for every request which joined this refresh.
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.refreshInFlight = refresh$;
    return refresh$;
  }

  tryRestoreSession(): Observable<AuthUser> {
    return this.refreshAccessToken().pipe(
      switchMap(() => this.fetchMe()),
      map((user) => {
        this.assertActive(user);
        this.setCurrentUser(user);
        return user;
      }),
      catchError(() => {
        this.clearSession();
        return throwError(() => new Error('session expired'));
      }),
    );
  }

  fetchMyBuildings(): Observable<MembershipDto[]> {
    return this.http
      .get<MembershipDto[]>(`${environment.apiUrl}/auth/buildings`)
      .pipe(tap((memberships) => this.memberships.set(memberships)));
  }

  /** Feature 7: change password after re-checking the current one. */
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Observable<void> {
    return this.http
      .post<void>(`${environment.apiUrl}/auth/change-password`, {
        currentPassword,
        newPassword,
      })
      .pipe(map(() => undefined));
  }

  /** Feature 7: change email (re-authenticated; uniqueness enforced). */
  changeEmail(password: string, newEmail: string): Observable<string> {
    return this.http
      .post<{ email: string }>(`${environment.apiUrl}/auth/change-email`, {
        password,
        newEmail,
      })
      .pipe(map((res) => res.email));
  }

  switchBuilding(buildingId: string): Observable<void> {
    return this.http
      .post<{ accessToken: string }>(
        `${environment.apiUrl}/auth/switch-building`,
        { buildingId },
      )
      .pipe(
        tap((res) => {
          this.sessionEpoch += 1;
          this.token = res.accessToken;
        }),
        switchMap(() => this.fetchMe()),
        tap((user) => this.setCurrentUser(user)),
        map(() => undefined),
      );
  }

  /**
   * Revoke the refresh session on the server and always clear local identity.
   * Network failures are swallowed so the user can still leave the application.
   */
  logout(): Observable<void> {
    if (this.logoutInFlight) return this.logoutInFlight;
    const logout$ = defer(() =>
      this.http.post<void>(`${environment.apiUrl}/auth/logout`, {}),
    ).pipe(
      catchError(() => EMPTY),
      finalize(() => {
        this.logoutInFlight = null;
        this.clearSession();
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.logoutInFlight = logout$;
    return logout$;
  }

  fetchMe(): Observable<AuthUser> {
    return this.http
      .get<AuthUser>(`${environment.apiUrl}/auth/me`)
      .pipe(tap((user) => this.setCurrentUser(user)));
  }

  /** Local-only cleanup for account deletion or an already-revoked session. */
  clearSession(): void {
    this.sessionEpoch += 1;
    this.token = null;
    this.refreshInFlight = null;
    this.currentUser.set(null);
    this.memberships.set([]);
  }

  private assertActive(user: AuthUser): void {
    if (!isActiveAccount(user)) {
      this.clearSession();
      throw new AuthAccountStatusError(user.status!, user.email);
    }
  }

  private setCurrentUser(user: AuthUser): void {
    this.currentUser.set(user);
    if (user.memberships) this.memberships.set(user.memberships);
  }
}
