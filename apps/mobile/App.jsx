import React, { useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LoginScreen } from './src/screens/LoginScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { BalanceScreen } from './src/screens/BalanceScreen';
import { VotesScreen } from './src/screens/VotesScreen';
import { ShopScreen } from './src/screens/ShopScreen';
import { FeedScreen } from './src/screens/FeedScreen';
import { RoleHomeScreen } from './src/screens/RoleHomeScreen';
import { AuthContextProvider, useAuth } from './src/AuthContext';
import { homeForRole } from './src/contracts';

const Stack = createNativeStackNavigator();

const TABS = [
  { key: 'overview', label: 'Home', icon: '⌂' },
  { key: 'balance', label: 'Balance', icon: '€' },
  { key: 'votes', label: 'Votes', icon: '✓' },
  { key: 'shop', label: 'Shop', icon: '🛒' },
  { key: 'feed', label: 'Feed', icon: '≡' },
];

function ResidentTabs() {
  const [active, setActive] = useState('overview');
  let Screen;
  switch (active) {
    case 'balance':
      Screen = BalanceScreen;
      break;
    case 'votes':
      Screen = VotesScreen;
      break;
    case 'shop':
      Screen = ShopScreen;
      break;
    case 'feed':
      Screen = FeedScreen;
      break;
    default:
      Screen = DashboardScreen;
  }
  return (
    <View style={styles.main}>
      <View style={styles.screen}>
        <Screen />
      </View>
      <SafeAreaView edges={['bottom']} style={styles.tabBar}>
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActive(tab.key)}
              style={[styles.tab, isActive && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.tabIcon, isActive && styles.tabIconActive]}>
                {tab.icon}
              </Text>
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </SafeAreaView>
    </View>
  );
}

function UnsupportedRole() {
  const { user, signOut } = useAuth();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.title}>PolykatoikiaOS</Text>
        <Text style={styles.body}>
          This role ({user?.role ?? 'unknown'}) is not available in the resident
          mobile app.
        </Text>
        <TouchableOpacity style={styles.button} onPress={signOut}>
          <Text style={styles.buttonText}>Log out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  main: { flex: 1 },
  screen: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  title: { fontSize: 26, fontWeight: '800', color: '#0f766e', textAlign: 'center' },
  body: { color: '#475569', textAlign: 'center', lineHeight: 22, marginVertical: 16 },
  button: { backgroundColor: '#0f766e', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#fff',
    paddingVertical: 6,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  tabActive: {},
  tabIcon: { fontSize: 16, color: '#64748b' },
  tabIconActive: { color: '#0f766e' },
  tabLabel: { fontSize: 10, color: '#64748b', marginTop: 2, fontWeight: '600' },
  tabLabelActive: { color: '#0f766e' },
});

function Root() {
  const { token, user, ready } = useAuth();
  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#0f766e" />
      </View>
    );
  }

  const roleRoute = homeForRole(user?.role);
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!token ? (
          <Stack.Screen name="Login" component={LoginScreen} />
        ) : roleRoute === 'resident' ? (
          <Stack.Screen name="ResidentTabs" component={ResidentTabs} />
        ) : roleRoute === 'staff' ? (
          <Stack.Screen name="RoleHome" component={RoleHomeScreen} />
        ) : (
          <Stack.Screen name="Unsupported" component={UnsupportedRole} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AuthContextProvider>
      <StatusBar style="dark" />
      <Root />
    </AuthContextProvider>
  );
}
