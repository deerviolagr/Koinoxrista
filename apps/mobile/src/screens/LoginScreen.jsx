import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../api';
import { useAuth } from '../AuthContext';

export function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function completeSignIn(accessToken) {
    if (!accessToken) throw new Error('No accessToken returned');
    // Fetch the profile with the explicit token; do not persist a token before
    // validating that /auth/me accepts it.
    const user = await api.me(accessToken);
    await signIn(accessToken, user);
  }

  async function handleLogin() {
    setError(null);
    setLoading(true);
    try {
      const response = await api.login({
        email: email.trim().toLowerCase(),
        password,
      });
      if (response?.twoFactorRequired) {
        if (!response.ticket) throw new Error('2FA response did not include a ticket');
        setTicket(response.ticket);
        return;
      }
      // The API contract is deliberately singular: login returns
      // { accessToken }, never an untyped `token` field.
      await completeSignIn(response?.accessToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  }

  async function handle2fa() {
    setError(null);
    setLoading(true);
    try {
      const response = await api.login2fa({ ticket, token: code.trim() });
      await completeSignIn(response?.accessToken);
      setTicket(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to verify code');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <Text style={styles.title}>PolykatoikiaOS</Text>
        <Text style={styles.subtitle}>Koinoxrista</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          secureTextEntry
          textContentType="password"
          value={password}
          onChangeText={setPassword}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {ticket ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="6-digit code or recovery code"
              autoCapitalize="none"
              value={code}
              onChangeText={setCode}
            />
            <TouchableOpacity
              style={styles.button}
              onPress={handle2fa}
              disabled={loading || !code.trim()}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Verify</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.link} onPress={() => setTicket(null)}>
              <Text style={styles.linkText}>Back to sign in</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.button}
            onPress={handleLogin}
            disabled={loading || !email.trim() || !password}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0f766e',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 32,
  },
  input: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#dc2626', marginBottom: 8, textAlign: 'center' },
  link: { paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  linkText: { color: '#0f766e', fontWeight: '600' },
});
