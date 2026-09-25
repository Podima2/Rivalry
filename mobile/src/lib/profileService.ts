const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function isProfileServiceConfigured() {
  return Boolean(supabaseUrl && publishableKey);
}

export class ProfileServiceError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'ProfileServiceError';
  }
}

async function requestProfile(accessToken: string, method: 'GET' | 'POST', handle?: string) {
  if (!supabaseUrl || !publishableKey) throw new ProfileServiceError('Profile service is not configured.', 'not_configured', 503);

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/runner-profile`, {
      method,
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(method === 'POST' ? { body: JSON.stringify({ handle }) } : {}),
    });
  } catch {
    throw new ProfileServiceError('Could not reach Rivalry’s profile service.', 'network_error', 0);
  }

  let body: { handle?: unknown; error?: unknown } = {};
  try {
    body = await response.json();
  } catch {
    // The status below still gives the caller a useful failure state.
  }

  if (!response.ok) {
    throw new ProfileServiceError('Profile request was not accepted.', typeof body.error === 'string' ? body.error : 'request_failed', response.status);
  }

  return body;
}

export async function getRemoteRunnerHandle(accessToken: string) {
  const body = await requestProfile(accessToken, 'GET');
  return typeof body.handle === 'string' ? body.handle : null;
}

export async function reserveRemoteRunnerHandle(accessToken: string, handle: string) {
  const body = await requestProfile(accessToken, 'POST', handle);
  if (typeof body.handle !== 'string') {
    throw new ProfileServiceError('Profile service returned an invalid response.', 'invalid_response', 502);
  }
  return body.handle;
}
