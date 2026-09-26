import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

export const ACCESS_TOKEN_STORAGE_KEY = 'accessToken';
export const LEGACY_ACCESS_TOKEN_STORAGE_KEY = 'token';
export const DEFAULT_API_URL = 'http://localhost:3000/api';

const envApiUrl =
  typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_API_URL : undefined;

/**
 * Normalize every supported configuration value to the API's public prefix.
 * Keeping this in one place prevents duplicated `/api` segments and
 * inconsistent development ports when the same client is used by iOS,
 * Android and web.
 */
export function normalizeApiUrl(value) {
  let candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return DEFAULT_API_URL;

  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/api';
    } else if (!parsed.pathname.toLowerCase().endsWith('/api')) {
      parsed.pathname = `${parsed.pathname}/api`;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // A malformed config should fail closed to a usable local default rather
    // than constructing URLs such as `undefined/auth/login`.
    return DEFAULT_API_URL;
  }
}

const configuredApiUrl =
  envApiUrl ?? Constants?.expoConfig?.extra?.apiUrl ?? Constants?.expoConfig?.extra?.apiBaseUrl;

export const API_URL = normalizeApiUrl(configuredApiUrl);

let refreshPromise = null;
let sessionExpiredHandler = null;

/** Register a single owner (normally AuthContext) for forced sign-out. */
export function setSessionExpiredHandler(handler) {
  sessionExpiredHandler = typeof handler === 'function' ? handler : null;
  return () => {
    if (sessionExpiredHandler === handler) sessionExpiredHandler = null;
  };
}

async function getStoredAccessToken() {
  try {
    const current = await AsyncStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    if (current) return current;
    // Migrate sessions created by the first mobile prototype transparently.
    return AsyncStorage.getItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function storeAccessToken(token) {
  if (!token) return;
  try {
    await AsyncStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } catch {
    // Authentication can still complete in memory when storage is unavailable.
  }
}

export async function clearAuthStorage() {
  try {
    if (typeof AsyncStorage.removeItem === 'function') {
      await AsyncStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      await AsyncStorage.removeItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY);
      return;
    }
    await AsyncStorage.multiRemove([
      ACCESS_TOKEN_STORAGE_KEY,
      LEGACY_ACCESS_TOKEN_STORAGE_KEY,
    ]);
  } catch {
    // Best effort: the in-memory session is still cleared by AuthContext.
  }
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function buildQuery(params) {
  if (!params) return '';
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&');
  return query ? `?${query}` : '';
}

async function readResponseBody(response) {
  if (response.status === 204) return null;
  if (typeof response.json === 'function') {
    try {
      return (await response.json()) ?? null;
    } catch {
      // A few native fetch implementations expose an empty/invalid json()
      // method for 204-like responses; fall through to text when available.
    }
  }
  if (typeof response.text === 'function') {
    try {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function errorMessage(body, status) {
  if (typeof body === 'string' && body.trim()) return body;
  if (body && typeof body.message === 'string') return body.message;
  if (Array.isArray(body?.message) && body.message.length > 0) {
    return body.message.join(', ');
  }
  return `Request failed: ${status}`;
}

function makeError(body, status) {
  const error = new Error(errorMessage(body, status));
  error.status = status;
  error.body = body;
  return error;
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = request('/auth/refresh', {
      method: 'POST',
      auth: false,
      retryOnUnauthorized: false,
    })
      .then((response) => {
        const token = response?.accessToken;
        if (!token) throw new Error('Refresh response did not include accessToken');
        return storeAccessToken(token).then(() => token);
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function request(
  path,
  {
    method = 'GET',
    body,
    params,
    token,
    auth = true,
    headers: extraHeaders,
    retryOnUnauthorized = true,
  } = {},
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const authToken = auth
    ? token === undefined
      ? await getStoredAccessToken()
      : token
    : null;
  const headers = {
    Accept: 'application/json',
    ...(extraHeaders ?? {}),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const response = await fetch(
    `${API_URL}${normalizedPath}${buildQuery(params)}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Required for the HttpOnly refresh cookie on web and supported native
      // fetch implementations.
      credentials: 'include',
    },
  );

  if (
    response.status === 401 &&
    retryOnUnauthorized &&
    auth &&
    !normalizedPath.startsWith('/auth/')
  ) {
    try {
      const refreshedToken = await refreshAccessToken();
      return request(normalizedPath, {
        method,
        body,
        params,
        token: refreshedToken,
        auth: true,
        headers: extraHeaders,
        retryOnUnauthorized: false,
      });
    } catch {
      await clearAuthStorage();
      sessionExpiredHandler?.();
      // Continue to the original response so callers receive the API's
      // useful status/message rather than a generic refresh error.
    }
  }

  const data = await readResponseBody(response);
  const ok =
    typeof response.ok === 'boolean'
      ? response.ok
      : response.status >= 200 && response.status < 300;
  if (!ok) throw makeError(data, response.status);
  return data;
}

export function formatMoney(cents, currency = 'EUR', locale = 'el-GR') {
  const amount = Number.isFinite(Number(cents)) ? Number(cents) : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

export const api = {
  login: (body) =>
    request('/auth/login', {
      method: 'POST',
      body,
      auth: false,
      retryOnUnauthorized: false,
    }),
  login2fa: (body) =>
    request('/auth/login/2fa', {
      method: 'POST',
      body,
      auth: false,
      retryOnUnauthorized: false,
    }),
  me: (accessToken) => request('/auth/me', { token: accessToken }),
  logout: () =>
    request('/auth/logout', {
      method: 'POST',
      body: {},
      retryOnUnauthorized: false,
    }),
  refresh: async () => {
    const response = await request('/auth/refresh', {
      method: 'POST',
      auth: false,
      retryOnUnauthorized: false,
    });
    const token = response?.accessToken;
    if (!token) throw new Error('Refresh response did not include accessToken');
    await storeAccessToken(token);
    return response;
  },
  balance: () => request('/invoices/mine'),
  invoices: () => request('/invoices/mine'),
  invoice: (id) => request(`/invoices/${encodeSegment(id)}`),
  checkoutInvoice: (id) =>
    request(`/invoices/${encodeSegment(id)}/pay`, {
      method: 'POST',
      body: {},
    }),
  payInvoice: (id) =>
    request(`/invoices/${encodeSegment(id)}/pay`, {
      method: 'POST',
      body: {},
    }),
  invoicePdf: (id) => request(`/invoices/${encodeSegment(id)}/pdf`),
  announcements: (buildingId) =>
    buildingId
      ? request(`/buildings/${encodeSegment(buildingId)}/feed`)
      : Promise.resolve([]),
  feed: (buildingId) =>
    buildingId
      ? request(`/buildings/${encodeSegment(buildingId)}/feed`)
      : Promise.resolve([]),
  votes: (buildingId) =>
    buildingId
      ? request(`/buildings/${encodeSegment(buildingId)}/votes`)
      : Promise.resolve([]),
  vote: (voteId) => request(`/votes/${encodeSegment(voteId)}`),
  ballot: (voteId, body) =>
    request(`/votes/${encodeSegment(voteId)}/ballots`, {
      method: 'POST',
      body,
    }),
  products: (buildingId) =>
    request(`/buildings/${encodeSegment(buildingId)}/shop/products`),
  catalog: (buildingId) =>
    request(`/buildings/${encodeSegment(buildingId)}/shop/catalog`),
  createOrder: (buildingId, body) =>
    request(`/buildings/${encodeSegment(buildingId)}/shop/orders`, {
      method: 'POST',
      body,
    }),
  orders: (buildingId) =>
    request(`/buildings/${encodeSegment(buildingId)}/shop/orders`),
  createDefect: (buildingId, body) =>
    request(`/buildings/${encodeSegment(buildingId)}/defects`, {
      method: 'POST',
      body,
    }),
  pushSubscribe: (body) =>
    request('/push/subscriptions', { method: 'POST', body }),
  pushUnsubscribe: (body) =>
    request('/push/subscriptions', { method: 'DELETE', body }),
};
