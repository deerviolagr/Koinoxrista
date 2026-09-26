import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, formatMoney } from '../api';
import {
  calculateInvoiceTotals,
  invoiceDueCents,
  invoicePaidCents,
  invoiceTotalCents,
  normalizeInvoices,
} from '../contracts';
import { useAuth } from '../AuthContext';
import { invoiceStatus } from './screen-helpers';

export function BalanceScreen() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [payingId, setPayingId] = useState(null);
  const [error, setError] = useState(null);

  const currency = user?.currency ?? 'EUR';
  const locale =
    currency === 'USD' ? 'en-US' : currency === 'BRL' ? 'pt-BR' : 'el-GR';

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api.invoices();
      setInvoices(normalizeInvoices(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load invoices');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    return load();
  }, [load]);

  const totals = useMemo(() => calculateInvoiceTotals(invoices), [invoices]);

  async function checkout(invoice) {
    if (!invoice?.id || payingId) return;
    setPayingId(invoice.id);
    try {
      const result = await api.checkoutInvoice(invoice.id);
      const checkoutUrl = result?.order?.checkoutUrl ?? result?.checkoutUrl;
      if (checkoutUrl) {
        await Linking.openURL(checkoutUrl);
      } else {
        Alert.alert('Checkout', 'The payment order was created.');
      }
      await load();
    } catch (e) {
      Alert.alert('Payment failed', e instanceof Error ? e.message : 'Unable to start checkout');
    } finally {
      setPayingId(null);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 48 }} color="#0f766e" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <FlatList
        data={invoices}
        keyExtractor={(item, index) => String(item.id ?? item.periodYearMonth ?? index)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Outstanding</Text>
              <Text style={styles.summaryValue}>
                {formatMoney(totals.outstandingCents, currency, locale)}
              </Text>
              <Text style={styles.summarySub}>
                {totals.count} periods · paid {formatMoney(totals.paidCents, currency, locale)}
              </Text>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.sectionTitle}>Invoices</Text>
          </View>
        }
        renderItem={({ item }) => {
          const status = invoiceStatus(item);
          const due = invoiceDueCents(item);
          const paid = invoicePaidCents(item);
          return (
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.cardTitle}>
                  {item.periodYearMonth ?? item.period ?? '—'}
                </Text>
                <Text style={[styles.badge, status === 'PAID' ? styles.badgePaid : styles.badgePending]}>
                  {status}
                </Text>
              </View>
              <Text style={styles.cardAmount}>
                {formatMoney(invoiceTotalCents(item), currency, locale)}
              </Text>
              {status !== 'PAID' ? (
                <Text style={styles.cardDue}>
                  Due: {formatMoney(due, currency, locale)}
                </Text>
              ) : null}
              {status !== 'PAID' && due > 0 ? (
                <TouchableOpacity
                  style={[styles.payButton, payingId === item.id && styles.payButtonDisabled]}
                  onPress={() => checkout(item)}
                  disabled={payingId === item.id}
                  accessibilityRole="button"
                >
                  <Text style={styles.payButtonText}>
                    {payingId === item.id ? 'Opening…' : 'Pay invoice'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {status !== 'PAID' && paid > 0 ? (
                <Text style={styles.partial}>Partially paid</Text>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No invoices yet.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  list: { padding: 16 },
  summaryCard: { backgroundColor: '#0f766e', borderRadius: 14, padding: 20, marginBottom: 16 },
  summaryLabel: { color: '#ccfbf1', fontSize: 14 },
  summaryValue: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 4 },
  summarySub: { color: '#99f6e4', fontSize: 12, marginTop: 4 },
  error: { color: '#dc2626', marginBottom: 12 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  cardAmount: { fontSize: 18, fontWeight: '700', color: '#0f172a', marginTop: 6 },
  cardDue: { fontSize: 13, color: '#dc2626', marginTop: 2 },
  partial: { fontSize: 12, color: '#854d0e', marginTop: 6 },
  badge: {
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  badgePaid: { backgroundColor: '#dcfce7', color: '#166534' },
  badgePending: { backgroundColor: '#fef9c3', color: '#854d0e' },
  payButton: {
    backgroundColor: '#0f766e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  payButtonDisabled: { opacity: 0.6 },
  payButtonText: { color: '#fff', fontWeight: '700' },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 32 },
});
