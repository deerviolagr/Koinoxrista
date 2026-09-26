import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../api';
import { getBuildingId, normalizeAnnouncements } from '../contracts';
import { useAuth } from '../AuthContext';

const ROLE_LABELS = {
  ADMIN: 'Building administrator',
  BUILDING_OWNER: 'Building owner',
  PROVIDER: 'Service provider',
  ACCOUNTANT: 'Accountant',
  PLATFORM_ADMIN: 'Platform administrator',
};

/** A deliberately small staff/role landing screen for sessions without resident tabs. */
export function RoleHomeScreen() {
  const { user, signOut } = useAuth();
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const buildingId = getBuildingId(user);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!buildingId) {
        setLoading(false);
        return;
      }
      try {
        const data = await api.announcements(buildingId);
        if (active) setAnnouncements(normalizeAnnouncements(data));
      } catch {
        if (active) setAnnouncements([]);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [buildingId]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>PolykatoikiaOS</Text>
          <Text style={styles.role}>{ROLE_LABELS[user?.role] ?? 'Account'}</Text>
        </View>
        <TouchableOpacity onPress={signOut} accessibilityRole="button">
          <Text style={styles.logout}>Log out</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>Resident app access</Text>
        <Text style={styles.noticeBody}>
          This account does not have a resident unit attached. Use the web
          workspace for role-specific management tools.
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 32 }} color="#0f766e" />
      ) : (
        <FlatList
          data={announcements}
          keyExtractor={(item, index) => String(item.id ?? index)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardBody}>{item.body}</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No building announcements yet.</Text>
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
  title: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  role: { color: '#64748b', marginTop: 3 },
  logout: { color: '#0f766e', fontWeight: '700' },
  notice: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#ccfbf1',
  },
  noticeTitle: { color: '#115e59', fontWeight: '800', marginBottom: 4 },
  noticeBody: { color: '#0f766e', lineHeight: 20 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
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
