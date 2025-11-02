// src/routes/api/line-webhook/+server.ts
import { json, error as svelteError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as line from '@line/bot-sdk';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const prerender = false;

// ❗️อย่าสร้าง client ไว้ top-level (เสี่ยง 500 ถ้า ENV หาย)
// สร้างเมื่อจำเป็นเท่านั้น
function createLineClient() {
  const channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelAccessToken) {
    // ไม่มี token ก็ไม่ต้องสร้าง client (โดยเฉพาะตอน Verify)
    return null;
  }
  return new line.messagingApi.MessagingApiClient({
    channelAccessToken
  });
}

function hasSignature(headers: Headers) {
  return !!(headers.get('x-line-signature') || headers.get('X-Line-Signature'));
}

async function verifySignatureIfPossible(req: Request, raw: string): Promise<boolean> {
  const signature = req.headers.get('x-line-signature') || req.headers.get('X-Line-Signature') || '';
  const secret = env.LINE_CHANNEL_SECRET;

  // ถ้าไม่มี secret หรือไม่มี signature ให้ถือว่า "ข้ามการ verify" (แต่ยังตอบ 200 ได้สำหรับ Verify)
  if (!secret || !signature) return true;

  // ใช้ helper ของ SDK ได้ แต่ควบคุมเองจะชัวร์กว่า
  try {
    const ok = line.webhook.validateSignature(raw, secret, signature);
    return ok;
  } catch {
    return false;
  }
}

// GET ไม่ได้ใช้โดย LINE Verify แต่คงไว้เป็น health check ก็ได้
export async function GET() {
  return json({ status: 'ok' });
}

export async function POST({ request }) {
  // 1) อ่าน RAW BODY ก่อนเสมอ
  const raw = await request.text();

  // 2) ถ้า verify ได้ก็ทำ — ถ้าขาด header/secret เราจะ "ยอมผ่าน" เพื่อไม่ให้ 500 ตอน Verify
  const sigOK = await verifySignatureIfPossible(request, raw);
  if (!sigOK) {
    // เสี่ยงเป็น request ปลอม — แต่ให้ตอบ 200 ตอน Verify ก็ได้
    // ถ้าต้องเข้มงวด ให้เปลี่ยนเป็น: return new Response('Invalid signature', { status: 401 });
    return new Response('OK', { status: 200 });
  }

  // 3) ถ้า body ว่าง/ไม่ใช่ JSON/ไม่มี events ⇒ น่าจะเป็น Verify → ตอบ 200 ทันที
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // ไม่ใช่ JSON ก็ไม่ต้องพัง
  }
  const events: line.webhook.WebhookEvent[] = payload?.events || [];
  if (!Array.isArray(events) || events.length === 0) {
    return new Response('OK', { status: 200 });
  }

  // 4) สร้าง client เฉพาะตอนต้องใช้ (และมี token)
  const lineClient = createLineClient();

  // 5) จัดการ events แบบไม่พัง endpoint — ห้าม throw ออกนอก
  try {
    await Promise.all(
      events.map(async (event) => {
        // ตัวอย่าง: บันทึก group id เมื่อ join group
        if ((event.type === 'join') && event.source.type === 'group') {
          try {
            await supabaseAdmin.from('groups').upsert({ group_id: event.source.groupId });
          } catch (e) {
            console.error('Supabase upsert error:', e);
          }
          return;
        }

        // follow มักเป็น user ไม่ใช่ group — อย่าบันทึกผิด type
        if (event.type === 'follow' && event.source.type === 'user') {
          // ทำอย่างอื่นถ้าต้องการ
          return;
        }

        // ตอบข้อความเฉพาะเมื่อมี client (มี token) และเป็น message event
        if (lineClient && event.type === 'message' && event.message.type === 'text') {
          if (event.message.text?.trim() === '!สร้างบิล') {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [createBillButton()]
            });
          }
        }
      })
    );
  } catch (err) {
    // กัน 500: log แล้วตอบ 200 ไปก่อน
    console.error('Error handling events:', err);
  }

  // 6) ตอบกลับทันที (อย่ารองานหนัก)
  return new Response('OK', { status: 200 });
}

function createBillButton(): line.FlexMessage {
  const LIFF_URL = env.LINE_LIFF_CHANNEL_ID ? `line://app/${env.LINE_LIFF_CHANNEL_ID}` : 'https://line.me';
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
