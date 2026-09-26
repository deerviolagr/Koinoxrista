import { Injectable, NotImplementedException } from '@nestjs/common';

/**
 * NL→SQL is intentionally not registered as an assistant route.
 *
 * The previous implementation accepted model-generated SQL and executed it
 * with `$queryRawUnsafe`.  A SELECT-only string check is not a sufficient
 * boundary for a tenant database (aliases, comments, functions, and future
 * schema changes can bypass it), so this seam remains unavailable until a
 * parameterized, allowlisted/read-only implementation exists.
 */
export interface NlSqlResult {
  sql: string;
  rows: Record<string, unknown>[];
  via: string;
  disclaimer: string;
}

export const NL_SQL_AVAILABLE = false;

@Injectable()
export class NlSqlService {
  constructor(..._dependencies: unknown[]) {
    // The old constructor accepted Prisma/audit/LLM dependencies. Keep the
    // call signature harmless while ensuring none can enable raw SQL.
    void _dependencies;
  }

  async query(
    _buildingId?: string,
    _question?: string,
    _userId?: string,
    _userRole?: string,
  ): Promise<NlSqlResult> {
    void _buildingId;
    void _question;
    void _userId;
    void _userRole;
    throw new NotImplementedException(
      'NL→SQL is unavailable: use a reviewed, parameterized read-only query endpoint',
    );
  }

  // Kept for callers/tests that used the old in-memory limiter seam. It does
  // not make the feature available and is intentionally side-effect free.
  _clearRateLimit(userId: string): void {
    void userId;
    // no-op
  }
}
