import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PrivyProvider } from '@privy-io/expo';
import { Text, View } from 'react-native';

const appId = process.env.EXPO_PUBLIC_PRIVY_APP_ID;
const clientId = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID;

export default function RootLayout() {
  const content = appId && clientId ? (
    <PrivyProvider
      appId={appId}
      clientId={clientId}
      config={{ embedded: { ethereum: { createOnLogin: 'users-without-wallets' } } }}
    >
      <Stack screenOptions={{ headerShown: false }} />
    </PrivyProvider>
  ) : (
    <View style={{ flex: 1, justifyContent: 'center', padding: 28, backgroundColor: '#F4F0E8' }}>
      <Text style={{ color: '#E24B35', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 12 }}>
        RIVALRY SETUP
      </Text>
      <Text style={{ color: '#292722', fontFamily: 'serif', fontSize: 34, lineHeight: 40 }}>
        Add your sign-in keys to get started.
      </Text>
      <Text style={{ color: '#706B63', fontSize: 15, lineHeight: 23, marginTop: 14 }}>
        Copy mobile/.env.example to mobile/.env and add the Privy App ID and Client ID from your Privy dashboard, then restart the development server.
      </Text>
    </View>
  );

  return (
    <>
      <StatusBar style="dark" />
      {content}
    </>
  );
}
