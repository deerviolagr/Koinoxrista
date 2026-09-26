/** Single source of truth for local and CI API E2E endpoints. */
const configuredUrl =
  process.env.E2E_API_URL ?? process.env.API_BASE_URL ?? undefined;

function parseConfiguredUrl(value: string | undefined): {
  origin: string;
  basePath: string;
} {
  if (!value) return { origin: '', basePath: '/api' };
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, '');
    return {
      origin: parsed.origin,
      basePath: path.toLowerCase().endsWith('/api') ? path : `${path}/api`,
    };
  } catch {
    return { origin: '', basePath: '/api' };
  }
}

const configured = parseConfiguredUrl(configuredUrl);
const host =
  process.env.E2E_HOST ??
  process.env.HOST ??
  '127.0.0.1';
const port = Number(process.env.E2E_PORT ?? process.env.PORT ?? 3000);

export const API_HOST = host === '0.0.0.0' ? '127.0.0.1' : host;
export const API_PORT = Number.isFinite(port) && port > 0 ? port : 3000;
export const API_ORIGIN = configured.origin || `http://${API_HOST}:${API_PORT}`;
export const API_BASE_PATH = configured.basePath;
export const API_BASE_URL = `${API_ORIGIN}${API_BASE_PATH}`;

/** Build a URL while accepting both `/auth/...` and legacy `/api/auth/...`. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized === API_BASE_PATH || normalized.startsWith(`${API_BASE_PATH}/`)) {
    return `${API_ORIGIN}${normalized}`;
  }
  return `${API_BASE_URL}${normalized}`;
}
