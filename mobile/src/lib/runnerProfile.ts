import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

function storageKey(privyUserId: string) {
  return `rivalry:runner-handle:${privyUserId}`;
}

export async function getRunnerHandle(privyUserId: string) {
  const key = storageKey(privyUserId);

  if (Platform.OS === 'web') {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  }

  return SecureStore.getItemAsync(key);
}

export async function saveRunnerHandle(privyUserId: string, handle: string) {
  const key = storageKey(privyUserId);

  if (Platform.OS === 'web') {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, handle);
    return;
  }

  await SecureStore.setItemAsync(key, handle);
}
