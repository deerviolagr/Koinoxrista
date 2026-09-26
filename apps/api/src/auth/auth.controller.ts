import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';

import {
  REFRESH_COOKIE_MAX_AGE_MS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  HttpRequest,
  HttpResponse,
} from './auth.types';
import { AuthService } from './auth.service';
import { normalizeEmail } from './auth.types';
import { isAllowedAuthOrigin } from './security-config';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  ChangeEmailDto,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  TwoFactorLoginDto,
} from './dto/auth.dto';
import { hashRefreshToken } from '../sessions/sessions.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { SwitchBuildingDto } from '../memberships/dto/switch-building.dto';
import { MembershipsService } from '../memberships/memberships.service';
import {
  TwoFactorDisableDto,
  TwoFactorEnableDto,
} from '../two-factor/dto/two-factor.dto';
import { TwoFactorService } from '../two-factor/two-factor.service';
import { throttleDefaults, routes } from '../security/throttle.config';
import type { AuthenticatedUser } from './auth.types';

const authThrottle = {
  default: {
    limit: throttleDefaults.authLimit,
    ttl: throttleDefaults.authTtlMs,
  },
};

const loginThrottle = {
  default: {
    limit: routes.login.limit,
    ttl: routes.login.ttlMs,
  },
};

const registerThrottle = {
  default: {
    limit: routes.register.limit,
    ttl: routes.register.ttlMs,
  },
};

function safeRefererOrigin(referer: string): string | undefined {
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

@Controller('auth')
@UsePipes(new ValidationPipe({ whitelist: true }))
@UseGuards(RolesGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly membershipsService: MembershipsService,
    private readonly twoFactorService: TwoFactorService,
  ) {}

  @Post('register')
  @Throttle(registerThrottle)
  async register(@Body() dto: RegisterDto) {
    // ADMIN/PROVIDER accounts are provisioned via admin-sent invites
    // (inviteToken in the payload); plain signup stays RESIDENT-only.
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(loginThrottle)
  async login(
    @Body() dto: LoginDto,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    this.assertTrustedOrigin(req);
    const result = await this.authService.login(dto, this.sessionMeta(req));
    if (result.twoFactorRequired === true) {
      // No tokens, no refresh cookie until the second factor is verified.
      return { twoFactorRequired: true, ticket: result.ticket };
    }
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Post('login/2fa')
  @HttpCode(200)
  @Throttle(authThrottle)
  async login2fa(
    @Body() dto: TwoFactorLoginDto,
    @Res({ passthrough: true }) res: HttpResponse,
    @Req() req?: HttpRequest,
  ) {
    this.assertTrustedOrigin(req);
    const tokens =
      req === undefined
        ? await this.authService.verifyTwoFactorLogin(dto)
        : await this.authService.verifyTwoFactorLogin(
            dto,
            this.sessionMeta(req),
          );
    const { accessToken, refreshToken } = tokens;
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @Post('2fa/setup')
  @UseGuards(JwtAuthGuard)
  setup2fa(@CurrentUser() user: AuthenticatedUser) {
    return this.twoFactorService.setup(user.email);
  }

  @Post('2fa/enable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async enable2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TwoFactorEnableDto,
  ) {
    const recoveryCodes = await this.twoFactorService.enable(
      user.id,
      dto.secret,
      dto.token,
    );
    return { enabled: true as const, recoveryCodes };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: HttpRequest,
  ) {
    await this.authService.changePassword(
      user.id,
      dto,
      this.currentRefreshHash(req),
    );
    return { changed: true as const };
  }

  @Post('change-email')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changeEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeEmailDto,
  ) {
    await this.authService.changeEmail(user.id, dto);
    return { email: normalizeEmail(dto.newEmail) };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @Throttle(authThrottle)
  @UseGuards(JwtAuthGuard)
  async disable2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TwoFactorDisableDto,
  ) {
    await this.twoFactorService.disable(user.id, dto.password);
    return { twoFactorEnabled: false as const };
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle(authThrottle)
  async refresh(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    this.assertTrustedOrigin(req);
    const refreshToken = this.readRefreshCookie(req);
    const { accessToken, refreshToken: rotatedRefreshToken } =
      await this.authService.refresh(refreshToken, this.sessionMeta(req));
    this.setRefreshCookie(res, rotatedRefreshToken);
    return { accessToken };
  }

  @Post('logout')
  @HttpCode(200)
  @Throttle(authThrottle)
  async logout(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    this.assertTrustedOrigin(req);
    const refreshToken = this.readRefreshCookie(req);
    try {
      if (
        typeof (this.authService as unknown as { logout?: unknown }).logout ===
        'function'
      ) {
        await (
          this.authService as unknown as {
            logout(token: string | undefined): Promise<{ revoked: boolean }>;
          }
        ).logout(refreshToken);
      }
    } finally {
      // Always clear the browser credential, including expired/replayed ones.
      this.clearRefreshCookie(res);
    }
    return { loggedOut: true as const };
  }

  @Get('buildings')
  @UseGuards(JwtAuthGuard)
  buildings(@CurrentUser() user: AuthenticatedUser) {
    return this.membershipsService.listForUser(user.id);
  }

  @Post('switch-building')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async switchBuilding(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SwitchBuildingDto,
    @Res({ passthrough: true }) res: HttpResponse,
    @Req() req?: HttpRequest,
  ) {
    this.assertTrustedOrigin(req);
    if (user.role === Role.ACCOUNTANT) {
      // Λογιστές switch via per-building grants, not memberships.
      await this.authService.assertAccountantBuildingAccess(
        user.id,
        dto.buildingId,
      );
    } else {
      await this.membershipsService.requireMembership(user.id, dto.buildingId);
    }
    const updatedUser = await this.membershipsService.activateBuilding(
      user.id,
      dto.buildingId,
    );
    const { accessToken, refreshToken } =
      await this.authService.issueTokens(updatedUser);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is not active');
    }
    const memberships = await this.membershipsService.listForUser(user.id);
    const active = memberships.find((m) => m.building.id === user.buildingId);
    const response = {
      id: user.id,
      email: user.email,
      role: user.role,
      buildingId: user.buildingId,
      market: active?.building.market ?? 'GR',
      currency: active?.building.currency ?? 'EUR',
      twoFactorEnabled: await this.twoFactorService.isEnabled(user.id),
      memberships,
      ...(user.status !== undefined ? { status: user.status } : {}),
    };
    return response;
  }

  /** Device info attached to refresh-session rows (login/refresh bookkeeping). */
  private sessionMeta(req: HttpRequest): {
    userAgent: string | null;
    ip: string | null;
  } {
    return {
      userAgent: req?.headers?.['user-agent'] ?? null,
      ip: req?.ip ?? null,
    };
  }

  private assertTrustedOrigin(req?: HttpRequest): void {
    const origin = req?.headers?.origin;
    const referer = req?.headers?.referer;
    const candidate =
      origin ?? (referer ? safeRefererOrigin(referer) : undefined);
    if (!isAllowedAuthOrigin(candidate)) {
      throw new ForbiddenException('Untrusted request origin');
    }
  }

  private setRefreshCookie(res: HttpResponse, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      // Strict in production prevents cross-site cookie-authenticated writes;
      // development retains lax behavior for local proxy setups.
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      path: REFRESH_COOKIE_PATH,
    });
  }

  private clearRefreshCookie(res: HttpResponse): void {
    const options = {
      httpOnly: true,
      sameSite: (process.env.NODE_ENV === 'production' ? 'strict' : 'lax') as
        'strict' | 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: REFRESH_COOKIE_PATH,
    };
    if (typeof res.clearCookie === 'function') {
      res.clearCookie(REFRESH_COOKIE_NAME, options);
      return;
    }
    // Minimal response mocks and non-Express adapters may not expose
    // clearCookie; an expiring empty cookie is equivalent there.
    res.cookie(REFRESH_COOKIE_NAME, '', {
      ...options,
      maxAge: 0,
      expires: new Date(0),
    });
  }

  private currentRefreshHash(req: HttpRequest): string | undefined {
    const raw = this.readRefreshCookie(req);
    return raw ? hashRefreshToken(raw) : undefined;
  }

  private readRefreshCookie(req: HttpRequest): string | undefined {
    const header = req?.headers?.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      const name = part.slice(0, separator).trim();
      if (name === REFRESH_COOKIE_NAME) {
        try {
          return decodeURIComponent(part.slice(separator + 1).trim());
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
}
