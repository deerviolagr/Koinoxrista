import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService, isActiveAccount } from './auth.service';

function setup(): { auth: AuthService; http: HttpTestingController } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    auth: TestBed.inject(AuthService),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('AuthService', () => {
  it('shares one in-flight refresh across concurrent callers', () => {
    const { auth, http } = setup();
    const first: string[] = [];
    const second: string[] = [];

    auth.refreshAccessToken().subscribe((token) => first.push(token));
    auth.refreshAccessToken().subscribe((token) => second.push(token));

    const request = http.expectOne('/api/auth/refresh');
    expect(request.request.method).toBe('POST');
    request.flush({ accessToken: 'rotated-access-token' });

    expect(first).toEqual(['rotated-access-token']);
    expect(second).toEqual(['rotated-access-token']);
    expect(auth.accessToken).toBe('rotated-access-token');
    http.verify();
  });

  it('keeps open registration pending instead of signing in', () => {
    const { auth, http } = setup();
    let status = '';
    auth
      .registerOpen({
        email: 'resident@example.gr',
        password: 'Password1!',
        firstName: 'Resident',
        lastName: 'One',
        buildingCode: 'ABCD1234',
      })
      .subscribe((result) => (status = result.status));

    const request = http.expectOne('/api/auth/register-open');
    expect(request.request.body).toEqual({
      email: 'resident@example.gr',
      password: 'Password1!',
      firstName: 'Resident',
      lastName: 'One',
      buildingCode: 'ABCD1234',
    });
    request.flush({
      id: 'user-1',
      email: 'resident@example.gr',
      status: 'PENDING_VERIFICATION',
    });

    expect(status).toBe('PENDING_VERIFICATION');
    expect(auth.currentUser()).toBeNull();
    http.verify();
  });

  it('resends verification without creating a session', () => {
    const { auth, http } = setup();
    let completed = false;
    auth
      .resendVerification('resident@example.gr')
      .subscribe(() => (completed = true));

    const request = http.expectOne('/api/auth/resend-verification');
    expect(request.request.body).toEqual({ email: 'resident@example.gr' });
    request.flush({});

    expect(completed).toBe(true);
    expect(auth.currentUser()).toBeNull();
    http.verify();
  });

  it('revokes the server refresh session and always clears local state', () => {
    const { auth, http } = setup();
    auth.currentUser.set({
      id: 'user-1',
      email: 'resident@example.gr',
      role: 'RESIDENT',
      buildingId: 'building-1',
    });

    auth.logout().subscribe();
    auth.logout().subscribe();
    http.expectOne('/api/auth/logout').flush({ loggedOut: true });

    expect(auth.currentUser()).toBeNull();
    expect(auth.accessToken).toBeNull();
    http.verify();
  });

  it('treats a missing status as active for API compatibility', () => {
    expect(isActiveAccount({})).toBe(true);
    expect(isActiveAccount({ status: 'ACTIVE' })).toBe(true);
    expect(isActiveAccount({ status: 'PENDING_APPROVAL' })).toBe(false);
  });
});
