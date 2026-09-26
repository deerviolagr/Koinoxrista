import axios from 'axios';

import { apiUrl } from '../support/config';
import {
  SEED_ADMIN,
  SEED_RESIDENT,
  login,
  adminHeaders,
  residentHeaders,
  prisma,
  uniqueSuffix,
  closePrisma,
} from './helpers';

describe('auth', () => {
  afterAll(async () => {
    await closePrisma();
  });

  it('logs in as the seeded admin and returns an accessToken', async () => {
    const res = await axios.post(apiUrl('/auth/login'), {
      email: SEED_ADMIN.email,
      password: SEED_ADMIN.password,
    });
    expect(res.status).toBe(200);
    expect(typeof res.data.accessToken).toBe('string');
    expect(res.data.accessToken.length).toBeGreaterThan(20);
    expect(res.data.token).toBeUndefined();
  });

  it('rejects bad credentials with 401', async () => {
    await expect(
      axios.post(apiUrl('/auth/login'), {
        email: SEED_ADMIN.email,
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('returns the current user with role and memberships', async () => {
    const res = await axios.get(apiUrl('/auth/me'), {
      headers: await adminHeaders(),
    });
    expect(res.data.email).toBe(SEED_ADMIN.email);
    expect(res.data.role).toBe('ADMIN');
    expect(Array.isArray(res.data.memberships)).toBe(true);
  });

  it('refreshes the accessToken via the refresh cookie', async () => {
    const loginRes = await axios.post(apiUrl('/auth/login'), {
      email: SEED_RESIDENT.email,
      password: SEED_RESIDENT.password,
    });
    const setCookie = loginRes.headers['set-cookie'] as unknown as
      | string[]
      | undefined;
    expect(Array.isArray(setCookie)).toBe(true);

    const refreshCookie = (setCookie ?? [])
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    const refreshRes = await axios.post(
      apiUrl('/auth/refresh'),
      {},
      { headers: { Cookie: refreshCookie } },
    );
    expect(refreshRes.status).toBe(200);
    expect(typeof refreshRes.data.accessToken).toBe('string');
  });

  it('rejects unauthenticated access to a guarded route', async () => {
    await expect(axios.get(apiUrl('/buildings/mine'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('returns the resident profile with their active building', async () => {
    const headers = await residentHeaders();
    const res = await axios.get(apiUrl('/auth/me'), { headers });
    expect(res.data.role).toBe('RESIDENT');
    expect(res.data.buildingId).toBeTruthy();
    expect(Array.isArray(res.data.memberships)).toBe(true);
  });

  it('accepts the mobile push subscription contract', async () => {
    const endpoint = `https://push.example/e2e/${uniqueSuffix()}`;
    try {
      const response = await axios.post(
        apiUrl('/push/subscriptions'),
        { endpoint, p256dh: 'e2e-public-key', auth: 'e2e-auth-secret' },
        { headers: await residentHeaders() },
      );
      expect(response.status).toBe(204);
    } finally {
      await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    }
  });

  it('keeps the login helper aligned with the accessToken contract', async () => {
    const token = await login(SEED_RESIDENT.email, SEED_RESIDENT.password);
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(20);
  });
});
