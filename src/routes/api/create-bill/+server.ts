import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as line from '@line/bot-sdk';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { createBillFlexMessage } from '$lib/lineMessages';

type ChatType = 'group' | 'room';

type CreateBillRequest = {
  title?: unknown;
  amount?: unknown;
  groupId?: unknown;
  chatType?: unknown;
};

type ValidatedRequest = {
  title: string;
  amount: number;
  chatType: ChatType;
  chatId: string;
};

export const prerender = false;

function makeLineClient() {
  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) return null;
  return new line.messagingApi.MessagingApiClient({ channelAccessToken: accessToken });
}

function badRequest(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
}
function unauthorized(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}
function serverError(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
}

function parseAndValidate(body: CreateBillRequest): ValidatedRequest | Response {
  const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
  const amountNum = Number(body.amount);
  const chatType = body.chatType === 'group' || body.chatType === 'room' ? body.chatType : null;
  const chatId = typeof body.groupId === 'string' ? body.groupId.trim() : '';

  if (!titleRaw) {
    return badRequest('ต้องระบุชื่อบิล');
  }
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return badRequest('ยอดรวมต้องเป็นตัวเลขที่มากกว่า 0');
  }
  if (!chatType) {
    return badRequest('ไม่พบประเภทแชทจาก LINE');
  }
  if (!chatId) {
    return badRequest('ไม่พบรหัสแชทจาก LINE');
  }

  const expectedPrefix = chatType === 'group' ? 'C' : 'R';
  if (!chatId.toUpperCase().startsWith(expectedPrefix)) {
    const message =
      chatType === 'group'
        ? 'ไม่สามารถอ่านรหัสกลุ่ม LINE ได้ กรุณาเปิด LIFF จากกลุ่มอีกครั้ง'
        : 'ไม่สามารถอ่านรหัสห้อง LINE ได้ กรุณาเปิด LIFF จากห้องสนทนาอีกครั้ง';
    return badRequest(message);
  }

  return {
    title: titleRaw,
    amount: Math.round(amountNum * 100) / 100,
    chatType,
    chatId
  };
}

export async function POST({ request, fetch }) {
  const lineClient = makeLineClient();
  let payload: CreateBillRequest | null = null;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Invalid JSON');
  }

  const validated = parseAndValidate(payload ?? {});
  if (validated instanceof Response) return validated;

  const { amount, chatId, chatType, title } = validated;

  // 2) ดึง/ตรวจ token จาก Authorization header
  const auth = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return unauthorized('No token provided');
  const token = m[1];

  // 3) Verify LIFF access token กับ LINE
  let userId: string | null = null;
  let resolvedCreatorName: string | null = null;
  try {
    const url = `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`;
    const vr = await fetch(url, { method: 'GET' });
    if (!vr.ok) {
      const t = await vr.text().catch(() => '');
      return unauthorized(`Invalid token (${vr.status}) ${t}`);
    }
    const vj = await vr.json();
    // หมายเหตุ: client_id ควรตรงกับ "Channel ID" ของ LINE Login/LIFF
    if (!env.LINE_LIFF_CHANNEL_ID || vj.client_id !== env.LINE_LIFF_CHANNEL_ID) {
      return unauthorized('Invalid LIFF token (client_id mismatch)');
    }
    if (typeof vj.sub === 'string' && vj.sub) {
      userId = vj.sub; // user id ของคนเปิด LIFF (อาจไม่มีใน LIFF access token)
    }
  } catch (e: any) {
    console.error('LIFF verify error:', e);
    return serverError('Failed to verify LIFF token');
  }

  if (!userId || !resolvedCreatorName) {
    try {
      const profileRes = await fetch('https://api.line.me/v2/profile', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        if (!userId && typeof profile?.userId === 'string' && profile.userId) {
          userId = profile.userId;
        }
        if (!resolvedCreatorName && typeof profile?.displayName === 'string' && profile.displayName) {
          resolvedCreatorName = profile.displayName;
        }
      } else {
        const text = await profileRes.text().catch(() => '');
        console.warn('LINE profile fetch failed:', profileRes.status, text);
      }
    } catch (e: any) {
      console.error('LINE profile fetch error:', e?.message ?? e);
    }
  }

  const isRoomChat = chatType === 'room';

  if (userId && lineClient) {
    try {
      const profile = isRoomChat
        ? await lineClient.getRoomMemberProfile(chatId, userId)
        : await lineClient.getGroupMemberProfile(chatId, userId);
      if (profile?.displayName) {
        resolvedCreatorName = profile.displayName;
      }
    } catch (e: any) {
      const detail = e?.originalError?.response?.data ?? e?.message ?? e;
      console.warn('getMemberProfile failed:', detail);
    }
  }

  if (!userId) {
    console.error('Missing LINE user ID after verification/profile lookup');
    return serverError('Failed to resolve LINE user ID');
  }

  // 4) บันทึก DB อย่างระมัดระวัง
  try {
    // Ensure the group exists to satisfy the foreign key constraint on bills.group_id
    const { error: groupError } = await supabaseAdmin.from('groups').upsert({
      group_id: chatId
    });
    if (groupError) throw groupError;
  } catch (e: any) {
    console.error('Supabase upsert group error:', e?.message ?? e);
    return serverError('Failed to sync group metadata');
  }

  try {
    const { error: userError } = await supabaseAdmin.from('users').upsert({
      user_id: userId,
      display_name: resolvedCreatorName ?? null
    });
    if (userError) {
      throw userError;
    }
  } catch (e: any) {
    console.error('Supabase upsert user error:', e?.message ?? e);
  }

  let billId: string | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('bills')
      .insert({
        group_id: chatId, // ระวัง: ต้องเป็น groupId/roomId ของ LINE (C.../R...)
        created_by: userId,
        title,
        total_amount: amount
      })
      .select('bill_id')
      .single();
    if (error) throw error;
    billId = data.bill_id;
  } catch (e: any) {
    console.error('Insert bill error:', e?.message ?? e);
    return serverError('Failed to create bill');
  }

  // 5) Push Flex message เข้า group
  const flexMessage = createBillFlexMessage({
    billId: billId!,
    title,
    amount,
    creatorName: resolvedCreatorName ?? ''
  });
  if (!lineClient || isRoomChat) {
    if (!lineClient) {
      console.warn('LINE_CHANNEL_ACCESS_TOKEN is missing. Skip pushMessage.');
    }
    return json({
      success: true,
      billId,
      pushSent: false,
      warning:
        chatType === 'room'
          ? 'สร้างบิลสำเร็จ ส่งเข้าแชทผ่าน LIFF ให้เรียบร้อยครับ'
          : 'สร้างบิลสำเร็จ แต่ส่งข้อความผ่านบอทไม่สำเร็จ จะพยายามส่งจาก LIFF แทน',
      message: flexMessage
    });
  }

  try {
    await lineClient.pushMessage({
      to: chatId,
      messages: [flexMessage]
    });

    return json({ success: true, billId, pushSent: true });
  } catch (e: any) {
    const detail = e?.originalError?.response?.data ?? e?.response?.data;
    if (detail) {
      console.error('pushMessage error detail:', JSON.stringify(detail));
    }
    console.error('pushMessage error:', e?.message ?? e);
    // อาจตอบ 200 แต่แจ้ง warning ให้ client ก็ได้
    return json({
      success: true,
      billId,
      pushSent: false,
      warning: 'สร้างบิลสำเร็จ แต่ส่งข้อความผ่านบอทไม่สำเร็จ จะพยายามส่งจาก LIFF แทน',
      message: flexMessage
    });
  }
}
