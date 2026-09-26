import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/** Request-scoped device info attached to a session on creation. */
export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/** Client-facing shape of an active (non-revoked) refresh session. */
export interface SessionView {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  userAgent: string | null;
  ip: string | null;
  /** True when the row belongs to the token the request itself presented. */
  isCurrent: boolean;
}

/** sha256 hex of the full refresh-token string — the only stored form. */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tracks a freshly issued refresh token. The write is awaited: a login is
   * not considered established until its session can be persisted, otherwise
   * a later refresh would have to fail open.
   */
  async record(
    userId: string,
    rawToken: string,
    meta?: SessionMeta,
  ): Promise<void> {
    const tokenHash = hashRefreshToken(rawToken);
    const existing = await this.prisma.refreshSession.findFirst({
      where: { tokenHash },
      select: { id: true },
    });
    if (existing) return;
    try {
      await this.prisma.refreshSession.create({
        data: {
          userId,
          tokenHash,
          userAgent: meta?.userAgent ?? null,
          ip: meta?.ip ?? null,
        },
      });
    } catch (error) {
      // A concurrent login may have recorded the same deterministic JWT. The
      // unique token hash makes that outcome idempotent; all other failures
      // must propagate so the caller fails closed.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * Atomically re-points a live session from the presented refresh token to
   * its replacement. There is deliberately no "create if missing" fallback:
   * accepting an untracked token would make revocation and replay protection
   * fail open.
   */
  async rotate(
    userId: string,
    previousRawToken: string,
    nextRawToken: string,
  ): Promise<void> {
    const previousHash = hashRefreshToken(previousRawToken);
    const nextHash = hashRefreshToken(nextRawToken);
    if (previousHash === nextHash) {
      const touched = await this.prisma.refreshSession.updateMany({
        where: { userId, tokenHash: previousHash, revokedAt: null },
        data: { lastUsedAt: new Date() },
      });
      if (touched.count !== 1) {
        throw new UnauthorizedException('Session is no longer active');
      }
      return;
    }

    const result = await this.prisma.refreshSession.updateMany({
      where: {
        userId,
        tokenHash: previousHash,
        revokedAt: null,
      },
      data: {
        tokenHash: nextHash,
        lastUsedAt: new Date(),
      },
    });
    if (result.count !== 1) {
      throw new UnauthorizedException('Session is no longer active');
    }
  }

  /**
   * Fails closed for both revoked and untracked refresh tokens. The optional
   * user id binds the lookup to the subject in the verified JWT as an extra
   * defence against a token/session mismatch.
   */
  async assertNotRevoked(
    rawToken: string,
    expectedUserId?: string,
  ): Promise<void> {
    const session = await this.prisma.refreshSession.findFirst({
      where: {
        tokenHash: hashRefreshToken(rawToken),
        ...(expectedUserId ? { userId: expectedUserId } : {}),
      },
      select: { revokedAt: true, userId: true },
    });
    if (!session) {
      throw new UnauthorizedException('Invalid session');
    }
    if (session.revokedAt) {
      throw new UnauthorizedException('Session revoked');
    }
    if (expectedUserId && session.userId !== expectedUserId) {
      throw new UnauthorizedException('Invalid session');
    }
  }

  /** Revokes only the session represented by the current refresh cookie. */
  async revokeCurrent(userId: string, rawToken: string): Promise<boolean> {
    const result = await this.prisma.refreshSession.updateMany({
      where: {
        userId,
        tokenHash: hashRefreshToken(rawToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (result.count === 1) {
      this.audit.record({
        actorId: userId,
        action: 'session.logout',
        entity: 'RefreshSession',
      });
    }
    return result.count === 1;
  }

  /** Active sessions of one user, newest first, flagged against currentHash. */
  async list(userId: string, currentHash?: string): Promise<SessionView[]> {
    const rows = await this.prisma.refreshSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      userAgent: row.userAgent,
      ip: row.ip,
      isCurrent: currentHash !== undefined && row.tokenHash === currentHash,
    }));
  }

  /** Owner-scoped revocation; the current session must be logged out instead. */
  async revoke(
    userId: string,
    sessionId: string,
    currentHash?: string,
  ): Promise<void> {
    const session = await this.prisma.refreshSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session || session.revokedAt) {
      throw new NotFoundException('Session not found');
    }
    if (currentHash !== undefined && session.tokenHash === currentHash) {
      throw new BadRequestException(
        'Δεν μπορείτε να ανακαλέσετε την τρέχουσα συνεδρία — αποσυνδεθείτε αντ’ αυτού.',
      );
    }
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    this.audit.record({
      actorId: userId,
      action: 'session.revoke',
      entity: 'RefreshSession',
      entityId: session.id,
    });
  }

  /** Revokes every active session except the caller's own. */
  async revokeOthers(
    userId: string,
    currentHash: string | undefined,
  ): Promise<{ revoked: number }> {
    if (!currentHash) {
      throw new BadRequestException('Current session could not be identified');
    }
    const res = await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null, tokenHash: { not: currentHash } },
      data: { revokedAt: new Date() },
    });
    if (res.count > 0) {
      this.audit.record({
        actorId: userId,
        action: 'session.revokeOthers',
        entity: 'RefreshSession',
        metadata: { revoked: res.count },
      });
    }
    return { revoked: res.count };
  }
}
