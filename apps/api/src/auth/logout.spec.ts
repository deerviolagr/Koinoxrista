import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { HttpRequest, HttpResponse } from './auth.types';
import type { MembershipsService } from '../memberships/memberships.service';
import type { TwoFactorService } from '../two-factor/two-factor.service';

const makeResponse = () => {
  const res = {
    cookie: jest.fn().mockReturnThis(),
  };
  return res as unknown as HttpResponse & { cookie: jest.Mock };
};

describe('POST /auth/logout', () => {
  it('revokes the presented session and always clears the refresh cookie', async () => {
    const authService = {
      logout: jest.fn().mockResolvedValue({ revoked: true }),
    };
    const controller = new AuthController(
      authService as unknown as AuthService,
      {} as MembershipsService,
      {} as TwoFactorService,
    );
    const req = {
      headers: {
        cookie: 'refresh_token=raw-refresh',
        origin: 'https://app.example.gr',
      },
    } as unknown as HttpRequest;
    const res = makeResponse();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCors = process.env.CORS_ORIGINS;
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://app.example.gr';

    try {
      await expect(controller.logout(req, res)).resolves.toEqual({
        loggedOut: true,
      });
      expect(authService.logout).toHaveBeenCalledWith('raw-refresh');
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        '',
        expect.objectContaining({
          httpOnly: true,
          maxAge: 0,
          expires: expect.any(Date),
          sameSite: 'strict',
          secure: true,
          path: '/api',
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousCors === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = previousCors;
    }
  });

  it('clears the cookie even when session revocation fails', async () => {
    const authService = {
      logout: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const controller = new AuthController(
      authService as unknown as AuthService,
      {} as MembershipsService,
      {} as TwoFactorService,
    );
    const res = makeResponse();

    await expect(
      controller.logout({ headers: {} } as unknown as HttpRequest, res),
    ).rejects.toThrow('database unavailable');
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      '',
      expect.objectContaining({ maxAge: 0 }),
    );
  });
});
