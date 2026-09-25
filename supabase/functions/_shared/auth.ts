import { verifyAccessToken } from 'npm:@privy-io/node@0.22.0';

export function privyVerificationConfigured() {
  return Boolean(Deno.env.get('PRIVY_APP_ID') && Deno.env.get('PRIVY_VERIFICATION_KEY'));
}

export async function getPrivyUserId(request: Request) {
  const authorization = request.headers.get('Authorization');
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const appId = Deno.env.get('PRIVY_APP_ID');
  const verificationKey = Deno.env.get('PRIVY_VERIFICATION_KEY');

  if (!accessToken || !appId || !verificationKey) return null;

  try {
    const result = await verifyAccessToken({
      access_token: accessToken,
      app_id: appId,
      verification_key: verificationKey,
    });
    return result.user_id;
  } catch {
    return null;
  }
}
