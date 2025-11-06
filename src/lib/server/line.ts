import { env } from '$env/dynamic/private';
import { messagingApi } from '@line/bot-sdk';

export function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function unauthorized(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function serverError(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
}

export type MessagingClient = ReturnType<typeof createMessagingClient>;

export function createMessagingClient() {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  return new messagingApi.MessagingApiClient({ channelAccessToken: token });
}

export type AuthenticatedLiffRequest = {
  token: string;
  userId: string;
  displayName: string | null;
};

export async function authenticateLiffRequest(
  request: Request,
  fetchFn: typeof fetch
): Promise<AuthenticatedLiffRequest | Response> {
  const auth = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return unauthorized('No token provided');
  const token = match[1];

  let userId: string | null = null;
  let displayName: string | null = null;

  try {
    const verifyUrl = `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`;
    const verifyRes = await fetchFn(verifyUrl, { method: 'GET' });
    if (!verifyRes.ok) {
      const text = await verifyRes.text().catch(() => '');
      return unauthorized(`Invalid token (${verifyRes.status}) ${text}`);
    }
    const verifyJson = await verifyRes.json();
    if (!env.LINE_LIFF_CHANNEL_ID || verifyJson.client_id !== env.LINE_LIFF_CHANNEL_ID) {
      return unauthorized('Invalid LIFF token (client_id mismatch)');
    }
    if (typeof verifyJson.sub === 'string' && verifyJson.sub) {
      userId = verifyJson.sub;
    }
  } catch (error) {
    console.error('LIFF verify error:', error);
    return serverError('Failed to verify LIFF token');
  }

  try {
    const profileRes = await fetchFn('https://api.line.me/v2/profile', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      if (!userId && typeof profile?.userId === 'string' && profile.userId) {
        userId = profile.userId;
      }
      if (typeof profile?.displayName === 'string') {
        displayName = profile.displayName;
      }
    } else {
      const text = await profileRes.text().catch(() => '');
      console.warn('LINE profile fetch failed:', profileRes.status, text);
    }
  } catch (error) {
    console.error('LINE profile fetch error:', error);
  }

  if (!userId) {
    return serverError('Failed to resolve LINE user ID');
  }

  return { token, userId, displayName };
}

export async function getChatMemberProfile(
  client: MessagingClient,
  chatType: 'group' | 'room',
  chatId: string,
  userId: string
) {
  if (!client) return null;
  try {
    return chatType === 'room'
      ? await client.getRoomMemberProfile(chatId, userId)
      : await client.getGroupMemberProfile(chatId, userId);
  } catch (error: any) {
    const detail = error?.originalError?.response?.data ?? error?.message ?? error;
    console.warn('getMemberProfile failed:', detail);
    return null;
  }
}

export async function listChatMemberIds(
  client: MessagingClient,
  chatType: 'group' | 'room',
  chatId: string
): Promise<string[]> {
  if (!client) return [];

  const ids: string[] = [];
  let start: string | undefined;

  while (true) {
    try {
      const response =
        chatType === 'room'
          ? await client.getRoomMembersIds(chatId, start)
          : await client.getGroupMembersIds(chatId, start);

      const memberIds = (response as { memberIds?: string[] }).memberIds ?? [];
      ids.push(...memberIds);
      const nextToken = (response as { next?: string | null }).next ?? null;
      if (!nextToken) break;
      start = nextToken;
    } catch (error: any) {
      const detail = error?.originalError?.response?.data ?? error?.message ?? error;
      console.warn('listChatMemberIds failed:', detail);
      break;
    }
  }

  return Array.from(new Set(ids));
}
