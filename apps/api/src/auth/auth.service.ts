import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role } from '@prisma/client';
import type { Invite, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import {
  ACCESS_TOKEN_TTL,
  AccessTokenPayload,
  isActiveStatus,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  normalizeEmail,
  RefreshTokenPayload,
  REFRESH_TOKEN_TTL,
} from './auth.types';
import {
  ChangeEmailDto,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  TwoFactorLoginDto,
} from './dto/auth.dto';
import { LoginLockoutService } from '../security/login-lockout.service';
import { hashInviteToken, isInvitableRole } from '../invites/invites.service';
import {
  assertLoginTicketAttemptsOpen,
  consumeLoginTicketLocally,
  hashLoginTicket,
  LoginTicketRateLimitError,
  recordLoginTicketFailure,
  resetLoginTicketAttempts,
  signLoginTicket,
  verifyLoginTicket,
} from '../two-factor/login-ticket';
import {
  TwoFactorService,
  twoFactorFields,
} from '../two-factor/two-factor.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionMeta, SessionsService } from '../sessions/sessions.service';

const BCRYPT_ROUNDS = 10;

// Public registration stays RESIDENT-only; ADMIN/PROVIDER/ACCOUNTANT accounts
// are provisioned through admin-sent invites (see InvitesService).
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly twoFactor: TwoFactorService,
    // Optional so legacy constructions (specs/tools) keep working without it.
    private readonly sessions?: SessionsService,
    private readonly lockout?: LoginLockoutService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<Pick<User, 'id' | 'email' | 'role'>> {
    const email = normalizeEmail(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const rawInviteToken = dto.inviteToken;
    const invite = rawInviteToken
      ? await this.requireActiveInvite(rawInviteToken, email)
      : null;
    try {
      if (!invite) {
        const user = await this.prisma.user.create({
          data: {
            email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: Role.RESIDENT,
            status: 'ACTIVE',
          },
        });
        return { id: user.id, email: user.email, role: user.role };
      }

      // Invited signup: role/building/membership are derived only from the
      // invite, never from client input. Claiming the invite is an atomic
      // conditional update inside the same transaction as all provisioning.
      if (!rawInviteToken) {
        throw new BadRequestException('Invalid invite token');
      }
      const user = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.invite.updateMany({
          where: {
            id: invite.id,
            tokenHash: hashInviteToken(rawInviteToken),
            email,
            acceptedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('Invite has already been used');
        }

        const created = await tx.user.create({
          data: {
            email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: invite.role,
            status: 'ACTIVE',
            ...(invite.buildingId ? { buildingId: invite.buildingId } : {}),
          },
        });

        if (!invite.buildingId) {
          throw new BadRequestException('Invite is missing its building');
        }
        if (invite.role === Role.RESIDENT) {
          if (!invite.unitId) {
            throw new BadRequestException('Invite is missing its unit');
          }
          const unit = await tx.unit.findFirst({
            where: { id: invite.unitId, buildingId: invite.buildingId },
            select: { id: true, millimes: true },
          });
          if (!unit) {
            throw new BadRequestException('Invite unit is not in its building');
          }
          await tx.ownership.create({
            data: {
              unitId: unit.id,
              userId: created.id,
              shareMillimes: unit.millimes,
              periodStart: new Date(),
            },
          });
        }

        // Every building-bound invite gets the same authoritative Membership
        // row. Previously only ADMIN did, leaving residents/providers without
        // a building switcher entry and making authorization inconsistent.
        await tx.membership.create({
          data: {
            userId: created.id,
            buildingId: invite.buildingId,
            role: invite.role,
            isDefault: true,
          },
        });
        return created;
      });
      return { id: user.id, email: user.email, role: user.role };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }
  }

  private async requireActiveInvite(
    rawToken: string,
    registrationEmail?: string,
  ): Promise<Invite> {
    const invite = await this.prisma.invite.findUnique({
      where: { tokenHash: hashInviteToken(rawToken) },
    });
    if (!invite) {
      throw new BadRequestException('Invalid invite token');
    }
    if (invite.acceptedAt) {
      throw new BadRequestException('Invite has already been used');
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invite has expired');
    }
    if (!isInvitableRole(invite.role)) {
      throw new BadRequestException('Invite role is not supported');
    }
    if (
      registrationEmail !== undefined &&
      normalizeEmail(invite.email) !== normalizeEmail(registrationEmail)
    ) {
      throw new BadRequestException(
        'Invite email does not match registration email',
      );
    }
    if (!invite.buildingId) {
      throw new BadRequestException('Invite is missing its building');
    }
    if (invite.role === Role.RESIDENT && !invite.unitId) {
      throw new BadRequestException('Invite is missing its unit');
    }
    return invite;
  }

  async login(dto: LoginDto, sessionMeta?: SessionMeta): Promise<LoginResult> {
    const emailKey = normalizeEmail(dto.email);
    // Feature 12: brute-force lockout before doing any work.
    this.lockout?.assertOpen(emailKey);

    const user = await this.prisma.user.findUnique({
      where: { email: emailKey },
    });
    if (!user) {
      await bcrypt.hash(dto.password, BCRYPT_ROUNDS); // constant-ish time
      this.lockout?.recordFailure(emailKey);
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      this.lockout?.recordFailure(emailKey);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Do not disclose account state through a different status code/message.
    if (!isActiveStatus(user.status)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Correct password clears the failure counter.
    this.lockout?.reset(emailKey);

    // Correct password + 2FA enabled → do NOT issue tokens; hand out a
    // short-lived ticket that POST /auth/login/2fa redeems with a TOTP code.
    if (twoFactorFields(user).twoFactorEnabled === true) {
      this.logger.log(`User ${user.id} prompted for second factor`);
      const ticket =
        typeof (this.twoFactor as unknown as { issueLoginTicket?: unknown })
          .issueLoginTicket === 'function'
          ? await (
              this.twoFactor as unknown as {
                issueLoginTicket(userId: string): Promise<string>;
              }
            ).issueLoginTicket(user.id)
          : signLoginTicket(user.id);
      return { twoFactorRequired: true, ticket };
    }

    this.logger.log(`User ${user.id} logged in`);
    return this.issueTokens(user, sessionMeta);
  }

  /**
   * Second login step: redeem a signed, expiring, one-use ticket together
   * with a TOTP or unused recovery code. Invalid attempts are rate limited and
   * a successful code atomically consumes the durable ticket row.
   */
  async verifyTwoFactorLogin(
    dto: TwoFactorLoginDto,
    sessionMeta?: SessionMeta,
  ): Promise<AuthTokens> {
    const userId = verifyLoginTicket(dto.ticket);
    if (!userId) {
      throw new UnauthorizedException('Invalid or expired 2FA ticket');
    }

    const ticketKey = `2fa:${userId}:${hashLoginTicket(dto.ticket)}`;
    try {
      this.lockout?.assertOpen(ticketKey);
      assertLoginTicketAttemptsOpen(dto.ticket);
    } catch (error) {
      if (error instanceof LoginTicketRateLimitError) {
        throw new HttpException(error.message, 429);
      }
      throw error;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !isActiveStatus(user.status)) {
      throw new UnauthorizedException('Invalid verification code');
    }

    let valid = false;
    try {
      valid =
        twoFactorFields(user).twoFactorEnabled === true &&
        (await this.twoFactor.verifyLoginCode(user, dto.token));
    } catch {
      valid = false;
    }
    if (!valid) {
      this.lockout?.recordFailure(ticketKey);
      const locked = recordLoginTicketFailure(dto.ticket);
      if (locked) {
        throw new HttpException('Too many invalid two-factor attempts', 429);
      }
      throw new UnauthorizedException('Invalid verification code');
    }

    const consumer = this.twoFactor as unknown as {
      consumeLoginTicket?: (
        ticket: string,
        subject: string,
      ) => Promise<boolean>;
    };
    const consumed =
      typeof consumer.consumeLoginTicket === 'function'
        ? await consumer.consumeLoginTicket(dto.ticket, userId)
        : consumeLoginTicketLocally(dto.ticket);
    if (!consumed) {
      throw new UnauthorizedException('Invalid or expired 2FA ticket');
    }

    resetLoginTicketAttempts(dto.ticket);
    this.lockout?.reset(ticketKey);
    this.logger.log(`User ${user.id} logged in via 2FA`);
    return this.issueTokens(user, sessionMeta);
  }

  async refresh(
    refreshToken: string | undefined,
    sessionMeta?: SessionMeta,
  ): Promise<AuthTokens> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        refreshToken,
        { secret: JWT_REFRESH_SECRET },
      );
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh' || !payload.sub) {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !isActiveStatus(user.status)) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Refresh is fail-closed: a revoked, unknown, or mismatched session can
    // never mint a replacement token.
    if (!this.sessions) {
      throw new UnauthorizedException('Invalid session');
    }
    await this.sessions.assertNotRevoked(refreshToken, payload.sub);
    const tokens = this.signTokenPair(user);
    await this.sessions.rotate(payload.sub, refreshToken, tokens.refreshToken);
    // Metadata is intentionally not changed on rotation: the row represents
    // the original device, while lastUsedAt is updated atomically above.
    void sessionMeta;
    return tokens;
  }

  /** Revoke only the current refresh session; safe to call with a missing cookie. */
  async logout(
    refreshTokenOrUserId: string | undefined,
    maybeRefreshToken?: string,
  ): Promise<{ revoked: boolean }> {
    const suppliedToken = maybeRefreshToken ?? refreshTokenOrUserId;
    if (!suppliedToken || !this.sessions) return { revoked: false };
    try {
      let userId = maybeRefreshToken ? refreshTokenOrUserId : undefined;
      if (!userId) {
        const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
          suppliedToken,
          { secret: JWT_REFRESH_SECRET },
        );
        if (payload.type !== 'refresh' || !payload.sub) {
          return { revoked: false };
        }
        userId = payload.sub;
      }
      return {
        revoked: await this.sessions.revokeCurrent(userId, suppliedToken),
      };
    } catch {
      // Logout is idempotent and must still clear the browser cookie when the
      // presented token has already expired or been tampered with.
      return { revoked: false };
    }
  }

  /** Signs access + refresh tokens for the given user row. */
  async issueTokens(
    user: User,
    sessionMeta?: SessionMeta,
  ): Promise<AuthTokens> {
    if (!isActiveStatus(user.status)) {
      throw new UnauthorizedException('User is not active');
    }
    const tokens = this.signTokenPair(user);
    if (this.sessions) {
      await this.sessions.record(user.id, tokens.refreshToken, sessionMeta);
    }
    return tokens;
  }

  /**
   * Even when an accountant has a tenant membership, access to financial
   * buildings still resolves through explicit AccountantAccess grants.
   */
  async assertAccountantBuildingAccess(
    userId: string,
    buildingId: string,
  ): Promise<void> {
    const access = await this.prisma.accountantAccess.findUnique({
      where: { accountantId_buildingId: { accountantId: userId, buildingId } },
      select: { id: true },
    });
    if (!access) {
      throw new ForbiddenException('No accountant access to this building');
    }
  }

  /**
   * Change password. Requires the current password, rehashes the new one, and
   * revokes every refresh session EXCEPT the one tied to the current device.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    currentRefreshTokenHash?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !isActiveStatus(user.status)) {
      throw new UnauthorizedException('User not found');
    }
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    await this.prisma.refreshSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentRefreshTokenHash
          ? { tokenHash: { not: currentRefreshTokenHash } }
          : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  /** Change email (re-authenticated + uniqueness enforced). */
  async changeEmail(userId: string, dto: ChangeEmailDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !isActiveStatus(user.status)) {
      throw new UnauthorizedException('User not found');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Password is incorrect');

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { email: normalizeEmail(dto.newEmail) },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }
  }

  private signTokenPair(user: User): AuthTokens {
    return {
      accessToken: this.signAccessToken(user),
      refreshToken: this.signRefreshToken(user.id),
    };
  }

  private signAccessToken(user: User): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      type: 'access',
      email: user.email,
      role: user.role,
      buildingId: user.buildingId ?? null,
    };
    return this.jwtService.sign(payload, {
      secret: JWT_ACCESS_SECRET,
      expiresIn: ACCESS_TOKEN_TTL,
    });
  }

  private signRefreshToken(userId: string): string {
    const payload: RefreshTokenPayload = { sub: userId, type: 'refresh' };
    return this.jwtService.sign(payload, {
      secret: JWT_REFRESH_SECRET,
      expiresIn: REFRESH_TOKEN_TTL,
    });
  }
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Token pair with an explicit "no 2FA" discriminant for the login union. */
export interface LoginTokens extends AuthTokens {
  twoFactorRequired?: false;
}

/** Returned instead of tokens when the password step succeeded but 2FA is on. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  ticket: string;
}

export type LoginResult = LoginTokens | TwoFactorChallenge;
