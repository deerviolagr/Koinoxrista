import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { apiUrl } from '../support/config';

export const prisma = new PrismaClient();

export const SEED_ADMIN = { email: 'admin@demo.gr', password: 'Admin1234!' };
export const SEED_RESIDENT = { email: 'maria@demo.gr', password: 'Password123!' };

let adminToken: string | null = null;
let residentToken: string | null = null;
/** HttpOnly refresh cookie captured from the cached resident login. */
let residentCookie: string | null = null;
const RUN_ID = process.env.E2E_RUN_ID ?? randomBytes(4).toString('hex');
const loginTokenCache = new Map<string, string>();

function accessToken(data: unknown): string {
  if (!data || typeof data !== 'object') {
    throw new Error('Login response did not contain an object');
  }
  const token = (data as { accessToken?: unknown }).accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Login response did not contain accessToken');
  }
  return token;
}

export async function login(email: string, password: string): Promise<string> {
  const cacheKey = `${email.toLowerCase()}\u0000${password}`;
  const cached = loginTokenCache.get(cacheKey);
  if (cached) return cached;
  const res = await axios.post(apiUrl('/auth/login'), { email, password });
  const token = accessToken(res.data);
  loginTokenCache.set(cacheKey, token);
  return token;
}

export async function adminHeaders(): Promise<Record<string, string>> {
  if (!adminToken) adminToken = await login(SEED_ADMIN.email, SEED_ADMIN.password);
  return { Authorization: `Bearer ${adminToken}` };
}

export async function residentHeaders(): Promise<Record<string, string>> {
  if (!residentToken) {
    const res = await axios.post(apiUrl('/auth/login'), {
      email: SEED_RESIDENT.email,
      password: SEED_RESIDENT.password,
    });
    residentToken = accessToken(res.data);
    const setCookie = res.headers['set-cookie'] ?? [];
    residentCookie =
      (Array.isArray(setCookie) ? setCookie : [setCookie])
        .filter((cookie): cookie is string => typeof cookie === 'string')
        .map((cookie) => cookie.split(';')[0])
        .find((cookie) => cookie.startsWith('refresh_token=')) ?? null;
  }
  return { Authorization: `Bearer ${residentToken}` };
}

/** The refresh cookie from the cached resident login (for SSE auth). */
export function residentRefreshCookie(): string | null {
  return residentCookie;
}

export interface SeedUnit {
  id: string;
  label: string;
}

export interface SeedBuilding {
  id: string;
  name: string;
  units: SeedUnit[];
}

let buildingCache: SeedBuilding | null = null;

export async function seedBuilding(): Promise<SeedBuilding> {
  if (buildingCache) return buildingCache;
  const res = await axios.get(apiUrl('/buildings/mine'), {
    headers: await adminHeaders(),
  });
  buildingCache = res.data as SeedBuilding;
  return buildingCache;
}

/** Unique short suffix for labels/descriptions so reruns never collide. */
export function uniqueSuffix(): string {
  return `${RUN_ID}-${randomBytes(4).toString('hex')}`;
}

/** Valid YYYY-MM period far in the future; unique for each fixture. */
export function uniquePeriod(): string {
  const offset = randomBytes(2).readUInt16BE(0);
  const year = 2100 + (offset % 80);
  const month = (offset % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Create an expense + run invoices for a fresh period; returns ids for cleanup. */
export async function createExpenseAndRun(buildingId: string, period: string) {
  const suffix = uniqueSuffix();
  const cat = await axios.post(
    apiUrl(`/buildings/${buildingId}/categories`),
    { name: `E2E Κατηγορία ${suffix}`, strategy: 'MILIMES' },
    { headers: await adminHeaders() },
  );
  const categoryId = cat.data.id as string;

  const exp = await axios.post(
    apiUrl(`/buildings/${buildingId}/expenses`),
    {
      categoryId,
      description: `E2E Δαπάνη ${suffix}`,
      totalCents: 10000,
      periodYearMonth: period,
    },
    { headers: await adminHeaders() },
  );
  const expenseId = exp.data.id as string;

  const run = await axios.post(
    apiUrl(`/buildings/${buildingId}/invoices/run`),
    { periodYearMonth: period },
    { headers: await adminHeaders() },
  );
  const invoices = run.data as Array<{ id: string; unitId: string }>;

  return { categoryId, expenseId, invoices };
}

let prismaClosed = false;
export async function closePrisma(): Promise<void> {
  if (prismaClosed) return;
  prismaClosed = true;
  await prisma.$disconnect();
}
