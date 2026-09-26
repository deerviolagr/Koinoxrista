import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, formatMoney } from '../api';
import {
  balanceCents,
  getBuildingId,
  normalizeAnnouncements,
} from '../contracts';
import { useAuth } from '../AuthContext';

export function DashboardScreen() {
  const { user, signOut } = useAuth();
  const buildingId = getBuildingId(user);
  const [balancePayload, setBalancePayload] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setError(null);
        const [invoiceResult, announcementResult] = await Promise.allSettled([
          api.balance(),
          buildingId ? api.announcements(buildingId) : Promise.resolve([]),
        ]);
        if (!active) return;
        if (invoiceResult.status === 'fulfilled') {
          setBalancePayload(invoiceResult.value ?? []);
        }
        if (announcementResult.status === 'fulfilled') {
          setAnnouncements(normalizeAnnouncements(announcementResult.value));
        }
        const failure = [invoiceResult, announcementResult].find(
          (result) => result.status === 'rejected',
        );
        if (failure?.status === 'rejected') {
          setError(
            failure.reason instanceof Error
              ? failure.reason.message
              : 'Unable to load dashboard',
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [buildingId]);

  const balance = useMemo(() => balanceCents(balancePayload), [balancePayload]);
  const currency = user?.currency ?? 'EUR';
  const locale = currency === 'USD' ? 'en-US' : currency === 'BRL' ? 'pt-BR' : 'el-GR';

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.greeting}>
          {user?.firstName || user?.name ? `Hi, ${user.firstName || user.name}` : 'Resident'}
        </Text>
        <TouchableOpacity onPress={signOut} accessibilityRole="button">
          <Text style={styles.logout}>Log out</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 48 }} color="#0f766e" />
      ) : (
        <FlatList
          data={announcements}
          keyExtractor={(item, index) => String(item.id ?? index)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View>
              <View style={styles.balanceCard}>
                <Text style={styles.balanceLabel}>Outstanding balance</Text>
                <Text style={styles.balanceValue}>
                  {formatMoney(balance, currency, locale)}
                </Text>
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              {item.pinned ? <Text style={styles.pinned}>📌 Pinned</Text> : null}
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardBody}>{item.body}</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No announcements yet.</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  greeting: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  logout: { color: '#0f766e', fontWeight: '600' },
  list: { padding: 16 },
  balanceCard: {
    backgroundColor: '#0f766e',
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
  },
  balanceLabel: { color: '#ccfbf1', fontSize: 14 },
  balanceValue: { color: '#fff', fontSize: 30, fontWeight: '800', marginTop: 4 },
  error: { color: '#dc2626', marginBottom: 12 },
  pinned: { fontSize: 11, fontWeight: '800', color: '#0f766e', marginBottom: 4 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  cardBody: { fontSize: 14, color: '#334155', marginTop: 4 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 32 },
});
