import { ProfileServiceError } from '@/lib/profileService';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

type RaceApiResponse = {
  raceId?: unknown;
  inviteCode?: unknown;
  distanceKm?: unknown;
  status?: unknown;
  error?: unknown;
};

async function requestFriendRace(accessToken: string, payload: Record<string, unknown>) {
  if (!supabaseUrl || !publishableKey) {
    throw new ProfileServiceError('Race service is not configured.', 'not_configured', 503);
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/friend-races`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ProfileServiceError('Could not reach Rivalry’s race service.', 'network_error', 0);
  }

  let body: RaceApiResponse = {};
  try {
    body = await response.json();
  } catch {
    // A non-JSON error still maps to a general request failure below.
  }

  if (!response.ok) {
    throw new ProfileServiceError('Race request was not accepted.', typeof body.error === 'string' ? body.error : 'request_failed', response.status);
  }
  return body;
}

export async function createFriendInvite(accessToken: string, distanceKm: 1 | 3 | 5 | 10) {
  const result = await requestFriendRace(accessToken, { action: 'create', distanceKm });
  if (typeof result.raceId !== 'string' || typeof result.inviteCode !== 'string') {
    throw new ProfileServiceError('Race service returned an invalid invite.', 'invalid_response', 502);
  }
  return { raceId: result.raceId, inviteCode: result.inviteCode };
}

export async function joinFriendInvite(accessToken: string, inviteCode: string) {
  const result = await requestFriendRace(accessToken, { action: 'join', inviteCode });
  if (typeof result.raceId !== 'string' || typeof result.distanceKm !== 'number') {
    throw new ProfileServiceError('Race service returned an invalid race.', 'invalid_response', 502);
  }
  return { raceId: result.raceId, distanceKm: result.distanceKm as 1 | 3 | 5 | 10 };
}
