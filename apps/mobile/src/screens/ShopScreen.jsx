import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, formatMoney } from '../api';
import { getBuildingId, normalizeProducts } from '../contracts';
import { useAuth } from '../AuthContext';

export function ShopScreen() {
  const { user } = useAuth();
  const buildingId = getBuildingId(user);
  const currency = user?.currency ?? 'EUR';
  const locale =
    currency === 'USD' ? 'en-US' : currency === 'BRL' ? 'pt-BR' : 'el-GR';
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ordering, setOrdering] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!buildingId) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      setError(null);
      const data = await api.catalog(buildingId);
      setProducts(normalizeProducts(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load the catalog');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [buildingId]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    return load();
  }, [load]);

  async function order(product) {
    if (!buildingId || ordering) return;
    setOrdering(product.id);
    try {
      await api.createOrder(buildingId, { productId: product.id, qty: 1 });
      Alert.alert('Ordered', `${product.name} ordered.`);
      await load();
    } catch (e) {
      Alert.alert('Order failed', e instanceof Error ? e.message : 'Unable to place order');
    } finally {
      setOrdering(null);
    }
  }

  if (!buildingId) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.empty}>No building assigned.</Text>
        </View>
      </SafeAreaView>
    );
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
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Shop</Text>
        <TouchableOpacity onPress={refresh} accessibilityRole="button">
          <Text style={styles.refresh}>Refresh</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={products}
        keyExtractor={(item, index) => String(item.id ?? index)}
        numColumns={2}
        columnWrapperStyle={products.length > 1 ? styles.row : undefined}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListHeaderComponent={error ? <Text style={styles.error}>{error}</Text> : null}
        renderItem={({ item }) => {
          const stock = Number(item.stock ?? 0);
          return (
            <View style={styles.card}>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.cardPrice}>
                {formatMoney(item.priceCents ?? 0, currency, locale)}
              </Text>
              <Text style={styles.cardStock}>
                {stock > 0 ? `${stock} in stock` : 'Out of stock'}
              </Text>
              <TouchableOpacity
                style={[styles.button, stock <= 0 || ordering ? styles.buttonDisabled : null]}
                disabled={stock <= 0 || !!ordering}
                onPress={() => order(item)}
                accessibilityRole="button"
              >
                {ordering === item.id ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Order</Text>
                )}
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No products in this building.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  refresh: { color: '#0f766e', fontWeight: '600' },
  list: { padding: 16, gap: 12 },
  row: { gap: 12 },
  error: { color: '#dc2626', marginBottom: 10 },
  card: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', minHeight: 38 },
  cardPrice: { fontSize: 16, fontWeight: '800', color: '#0f766e', marginTop: 6 },
  cardStock: { fontSize: 11, color: '#64748b', marginTop: 2 },
  button: {
    backgroundColor: '#0f766e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonDisabled: { backgroundColor: '#94a3b8' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 32 },
});
