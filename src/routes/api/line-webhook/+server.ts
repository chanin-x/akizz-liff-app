// src/routes/api/line-webhook/+server.ts
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import {
  messagingApi,
  validateSignature,
  type FlexMessage,
  type Message,
  type WebhookEvent
} from '@line/bot-sdk';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import crypto from 'node:crypto';

export const prerender = false;

/** สร้าง LINE client เมื่อจำเป็นเท่านั้น (กันพังถ้า ENV หาย) */
function createLineClient() {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  return new messagingApi.MessagingApiClient({ channelAccessToken: token });
}

/** ตรวจลายเซ็นแบบยืดหยุ่น: ถ้าขาด header/secret จะยอมผ่าน (กัน verify fail/กัน 500) */
function verifySignatureFlexible(raw: Buffer, headers: Headers) {
  try {
    const signature = headers.get('x-line-signature') || headers.get('X-Line-Signature') || '';
    const secret = env.LINE_CHANNEL_SECRET || '';
    if (!signature || !secret) return true; // ข้ามเมื่อ verify ไม่ได้
    const valid = validateSignature(raw, secret, signature);

    if (!valid) {
      try {
        const calc = crypto.createHmac('sha256', secret).update(raw).digest('base64');
        console.error('Invalid signature details:', {
          received: signature,
          calculated: calc
        });
      } catch (e) {
        console.error('Failed to calculate signature digest:', e);
      }
    }

    return valid;
  } catch {
    return false;
  }
}

/** สร้าง URL สำหรับเปิด LIFF จาก ENV ที่มี (รองรับได้ทั้ง ID และ URL ตรงๆ) */
function getLiffUrl(): string {
  const candidates = [
    env.LINE_LIFF_URL,
    publicEnv.PUBLIC_LIFF_URL,
    env.LINE_LIFF_ID,
    publicEnv.PUBLIC_LIFF_ID,
    env.LINE_LIFF_CHANNEL_ID
  ].map((value) => (value ?? '').trim());

  for (const value of candidates) {
    if (!value) continue;
    if (/^https?:\/\//i.test(value) || value.startsWith('line://')) return value;
    return `line://app/${value}`;
  }

  console.warn('LIFF URL is not configured; falling back to https://line.me');
  return 'https://line.me';
}

/** ปุ่มเปิด LIFF (ใช้ตอนคำสั่ง !สร้างบิล) */
function createBillButton(): FlexMessage {
  const LIFF_URL = getLiffUrl();
  return {
    type: 'flex',
    altText: 'สร้างบิลใหม่',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'AKizz Bill Bot', weight: 'bold', size: 'xl' },
          { type: 'text', text: 'กดปุ่มด้านล่างเพื่อเปิดฟอร์มสำหรับสร้างบิลและหารบิลในกลุ่มครับ', wrap: true }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: { type: 'uri', label: '📝 สร้างบิลใหม่', uri: LIFF_URL },
            style: 'primary',
            height: 'sm'
          }
        ]
      }
    }
  };
}

function formatMoney(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(num)) return '-';
  return num.toFixed(2);
}

async function buildBillListMessage(groupId: string): Promise<Message> {
  try {
    const { data, error } = await supabaseAdmin
      .from('bills')
      .select('bill_id,title,total_amount,status,due_date,created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    if (!data || data.length === 0) {
      return { type: 'text', text: 'ยังไม่มีบิลในกลุ่มนี้ครับ' };
    }

    const lines = data.map((bill, index) => {
      const status = bill.status ?? 'pending';
      const created = bill.created_at ? new Date(bill.created_at).toLocaleString('th-TH') : '-';
      const due = bill.due_date ? new Date(bill.due_date).toLocaleString('th-TH') : null;

      const duePart = due ? `
กำหนดชำระ: ${due}` : '';

      return `${index + 1}. ${bill.title} — ${formatMoney(bill.total_amount)} บาท
สถานะ: ${status}${duePart}
สร้างเมื่อ: ${created}`.trim();
    });

    return {
      type: 'text',
      text: `บิลล่าสุดในกลุ่ม (สูงสุด 5 รายการ):\n${lines.join('\n\n')}`
    };
  } catch (e: any) {
    console.error('fetch bills error:', e?.message ?? e);
    return { type: 'text', text: 'ดึงข้อมูลบิลไม่สำเร็จ กรุณาลองใหม่ครับ' };
  }
}

export async function GET() {
  return json({ status: 'ok' });
}

export async function POST({ request }) {
  // 1) อ่าน RAW BODY ก่อนเสมอ (เก็บทั้ง Buffer และ String)
  const bodyBuffer = Buffer.from(await request.arrayBuffer());
  const raw = bodyBuffer.toString('utf-8');

  // 2) ตรวจลายเซ็นแบบยืดหยุ่น (กัน verify fail/กัน 500)
  const sigOK = verifySignatureFlexible(bodyBuffer, request.headers);
  if (!sigOK) {
    console.error('Invalid signature');
    return new Response('OK', { status: 200 });
  }

  // 3) แปลง JSON; ไม่มี events ⇒ ตอบ 200 (เช่นตอน verify)
  let payload: any = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch {}
  const events: WebhookEvent[] = payload?.events || [];
  if (!Array.isArray(events) || events.length === 0) return new Response('OK', { status: 200 });

  // 4) เตรียม client (ถ้าไม่มี token จะ reply/push ไม่ได้ แต่เรายังตอบ 200)
  const client = createLineClient();
  if (!client) console.warn('LINE_CHANNEL_ACCESS_TOKEN missing; replies will be skipped.');

  // 5) จัดการทุก event แบบกันพัง + log ชัด
  for (const ev of events) {
    try {
      console.log('EVENT:', ev.type, ev.source?.type, (ev as any).message?.type, (ev as any).message?.text);

      // 5.1 บันทึก group ตอนบอทถูกเชิญเข้ากลุ่ม
      if (ev.type === 'join' && ev.source.type === 'group') {
        try {
          await supabaseAdmin.from('groups').upsert({ group_id: ev.source.groupId });
          console.log('Upsert group done:', ev.source.groupId);
        } catch (e) {
          console.error('Supabase upsert group error:', e);
        }
        continue;
      }

      // 5.2 follow (จาก user) — ไม่ทำอะไรตอนนี้
      if (ev.type === 'follow' && ev.source.type === 'user') continue;

      // 5.3 เฉพาะ message:text
      if (client && ev.type === 'message' && ev.message.type === 'text') {
        const text = (ev.message.text || '').trim();
        const messages: Message[] = [];

        // 5.3.1 คำสั่งแบบหลวม
        const t = text.replace(/\s+/g, '').toLowerCase();
        const isCreateCmd =
          t === '!สร้างบิล' || t === 'สร้างบิล' ||
          t === '!bill' || t === 'bill' ||
          t.startsWith('!สร้างบิล') || t.startsWith('สร้างบิล');
        const isListCmd =
          t === '!ดูบิล' || t === 'ดูบิล' ||
          t === '!billlist' || t === 'billlist' ||
          t === '!bills' || t === 'bills';

        if (isCreateCmd) {
          messages.push(createBillButton());
        } else if (isListCmd) {
          const groupId = ev.source.type === 'group' ? ev.source.groupId : null;
          if (!groupId) {
            messages.push({ type: 'text', text: 'คำสั่งนี้ใช้ได้เฉพาะในกลุ่มเท่านั้นครับ' });
          } else {
            messages.push(await buildBillListMessage(groupId));
          }
        } else {
          // 5.3.2 ECHO debug — ช่วยตรวจสอบว่า reply ทำงาน
          messages.push({ type: 'text', text: `pong: ${text}` });
        }

        if (messages.length > 0) {
          try {
            await client.replyMessage({ replyToken: ev.replyToken, messages });
          } catch (e: any) {
            const detail = e?.originalError?.response?.data ?? e?.response?.data ?? e?.message ?? e;
            console.error('reply error:', detail);
          }
        }
      }
    } catch (e: any) {
      console.error('handle event error:', e?.message ?? e);
    }
  }

  // 6) ตอบ 200 เสมอ เพื่อให้ LINE ไม่ retry
  return new Response('OK', { status: 200 });
}
