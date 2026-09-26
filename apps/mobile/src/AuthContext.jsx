import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ACCESS_TOKEN_STORAGE_KEY,
  LEGACY_ACCESS_TOKEN_STORAGE_KEY,
  api,
  clearAuthStorage,
  setSessionExpiredHandler,
} from './api';

const AuthContext = createContext(null);
const USER_STORAGE_KEY = 'user';

export function AuthContextProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const [storedAccessToken, legacyToken] = await Promise.all([
          AsyncStorage.getItem(ACCESS_TOKEN_STORAGE_KEY),
          AsyncStorage.getItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY),
        ]);
        const restoredToken = storedAccessToken ?? legacyToken;
        if (!restoredToken) return;

        // Validate the access token on startup. api.me() transparently uses the
        // HttpOnly refresh cookie once when the access token has expired.
        const restoredUser = await api.me(restoredToken);
        if (!restoredUser) throw new Error('No user returned by /auth/me');
        const activeToken =
          (await AsyncStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)) ?? restoredToken;
        if (!active) return;
        setToken(activeToken);
        setUser(restoredUser);
        // Keep the cached profile in sync, but do not let a corrupt cache
        // prevent a fresh /auth/me response from being used.
        await AsyncStorage.setItem(USER_STORAGE_KEY, JSON.stringify(restoredUser));
      } catch {
        await clearAuthStorage();
        await AsyncStorage.removeItem?.(USER_STORAGE_KEY);
        if (active) {
          setToken(null);
          setUser(null);
        }
      } finally {
        if (active) setReady(true);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // A request that cannot refresh its session must update React state as
    // well as AsyncStorage, otherwise a stale token would keep the tabs alive.
    return setSessionExpiredHandler(() => {
      setToken(null);
      setUser(null);
    });
  }, []);

  async function signIn(newToken, newUser) {
    if (!newToken) throw new Error('An access token is required');
    setToken(newToken);
    setUser(newUser ?? null);
    await AsyncStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, newToken);
    if (newUser) {
      await AsyncStorage.setItem(USER_STORAGE_KEY, JSON.stringify(newUser));
    } else {
      await AsyncStorage.removeItem?.(USER_STORAGE_KEY);
    }
  }

  async function refreshSession() {
    const response = await api.refresh();
    const accessToken =
      typeof response === 'string' ? response : response?.accessToken;
    if (!accessToken) throw new Error('Refresh response did not include accessToken');
    const refreshedUser = await api.me(accessToken);
    await signIn(accessToken, refreshedUser);
    return { accessToken, user: refreshedUser };
  }

  async function signOut() {
    // Revoke the server refresh session when possible, but always clear local
    // credentials so a flaky network can never leave the app "logged in".
    setToken(null);
    setUser(null);
    try {
      await api.logout();
    } catch {
      // Local logout remains authoritative for the mobile client.
    } finally {
      await clearAuthStorage();
      await AsyncStorage.removeItem?.(USER_STORAGE_KEY);
    }
  }

  function updateUser(patch) {
    setUser((previous) => {
      if (!previous) return previous;
      const next = { ...previous, ...patch };
      void AsyncStorage.setItem(USER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return (
    <AuthContext.Provider
      value={{ token, user, ready, signIn, signOut, refreshSession, updateUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthContextProvider');
  return context;
}
