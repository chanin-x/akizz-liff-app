import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as line from '@line/bot-sdk';
import { supabaseAdmin } from '$lib/supabaseAdmin';

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

export async function POST({ request, fetch }) {
  // 1) Parse JSON อย่างปลอดภัย
  let payload: any = null;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Invalid JSON');
  }

  const { title, amount, groupId, creatorName } = payload ?? {};
  if (!title || typeof amount !== 'number' || amount <= 0 || !groupId) {
    return badRequest('Missing/invalid fields: title, amount (>0), groupId');
  }

  // 2) ดึง/ตรวจ token จาก Authorization header
  const auth = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return unauthorized('No token provided');
  const token = m[1];

  // 3) Verify LIFF access token กับ LINE
  let userId = '';
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
    userId = vj.sub; // user id ของคนเปิด LIFF
  } catch (e: any) {
    console.error('LIFF verify error:', e);
    return serverError('Failed to verify LIFF token');
  }

  // 4) บันทึก DB อย่างระมัดระวัง
  try {
    // Ensure the group exists to satisfy the foreign key constraint on bills.group_id
    const { error: groupError } = await supabaseAdmin.from('groups').upsert({
      group_id: groupId
    });
    if (groupError) throw groupError;
  } catch (e: any) {
    console.error('Supabase upsert group error:', e?.message ?? e);
    return serverError('Failed to sync group metadata');
  }

  try {
    const { error: userError } = await supabaseAdmin.from('users').upsert({
      user_id: userId,
      display_name: creatorName ?? null
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
        group_id: groupId,        // ระวัง: ต้องเป็น groupId แบบที่ LINE ใช้ push ได้ (C.../R...)
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
  try {
    const client = makeLineClient();
    if (!client) {
      console.warn('LINE_CHANNEL_ACCESS_TOKEN is missing. Skip pushMessage.');
    } else {
      await client.pushMessage({
        to: groupId,
        messages: [createBillFlex(billId!, title, amount, creatorName ?? '')]
      });
    }
  } catch (e: any) {
    // อย่าโยนออกนอก → กัน 500
    console.error('pushMessage error:', e?.message ?? e);
    // อาจตอบ 200 แต่แจ้ง warning ให้ client ก็ได้
    return json({ success: true, billId, warning: 'Bill created but failed to push message to group.' });
  }

  return json({ success: true, billId });
}

// Helper Flex
function createBillFlex(billId: string, title: string, amount: number, creator: string): line.FlexMessage {
  return {
    type: 'flex',
    altText: `บิลใหม่: ${title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '🧾 บิลใหม่!', weight: 'bold', color: '#1DB446', size: 'lg' }]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: title, size: 'xl', weight: 'bold', wrap: true },
          { type: 'text', text: `ยอดรวม ${amount.toFixed(2)} บาท`, size: 'lg' },
          { type: 'text', text: `สร้างโดย: ${creator || '-'}`, size: 'sm', color: '#888888', margin: 'md' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: 'คนที่ยังไม่จ่าย:', margin: 'lg', weight: 'bold' },
          { type: 'text', text: '(ยังไม่มีคนเข้าร่วมหาร)', color: '#888888' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            action: { type: 'postback', label: '✅ ฉันจ่ายแล้ว', data: `action=mark_paid&bill_id=${billId}` },
            style: 'primary',
            height: 'sm'
          }
        ]
      }
    }
  };
}
