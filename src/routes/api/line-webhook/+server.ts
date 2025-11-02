// src/routes/api/line-webhook/+server.ts
import { json, error as SvelteKitError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as line from '@line/bot-sdk';
import { supabaseAdmin } from '$lib/supabaseAdmin';

// -----------------
// 1. ตั้งค่า Clients
// -----------------
const channelSecret = env.LINE_CHANNEL_SECRET;
const channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN;

if (!channelSecret || !channelAccessToken) {
  throw new Error('LINE channel credentials are missing from the environment configuration');
}

const lineConfig = {
  channelSecret,
  channelAccessToken,
};
const lineClient = new line.messagingApi.MessagingApiClient(lineConfig);
const LIFF_URL = `line://app/${env.LINE_LIFF_CHANNEL_ID}`;

export const GET = async () => {
  // นี่คือฟังก์ชันสำหรับให้ LINE กด "Verify"
  // ตอบกลับเป็นข้อความธรรมดา "OK" (200)
  return new Response('OK', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
};

// -----------------
// 2. ฟังก์ชัน POST (สำหรับ LINE Webhook)
// -----------------
export const POST = async ({ request }) => {
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';

  // 2.1 ตรวจสอบ Signature
  if (!line.webhook.validateSignature(body, lineConfig.channelSecret, signature)) {
    throw SvelteKitError(400, 'Invalid signature');
  }

  const events: line.webhook.WebhookEvent[] = JSON.parse(body).events;

  // 2.2 จัดการ Events (ทำแบบ Promise.all เพื่อความเร็ว)
  try {
    const eventHandlers = events.map(async (event) => {
      
      if ((event.type === 'join' || event.type === 'follow') && event.source.type === 'group') {
        // บอทเข้ากลุ่ม -> บันทึก Group ID
        await supabaseAdmin.from('groups').upsert({ group_id: event.source.groupId });
      
      } else if (event.type === 'message' && event.message.type === 'text') {
        // มีคนพิมพ์
        if (event.message.text === '!สร้างบิล') {
          // ถ้าพิมพ์ "!สร้างบิล" -> ส่งปุ่ม LIFF
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [createBillButton()],
          });
        }
      }
      // TODO: เพิ่มการจัดการ Postback event (เช่น กด "จ่ายแล้ว") ที่นี่
      // else if (event.type === 'postback') { ... }
    });
    
    await Promise.all(eventHandlers);

  } catch (err: any) {
    console.error("Error handling events:", err.message);
    throw SvelteKitError(500, 'Error handling events');
  }

  return json({ status: 'ok' });
};

// -----------------
// 3. Helper: สร้าง Flex Message (ปุ่มเปิด LIFF)
// -----------------
function createBillButton(): line.FlexMessage {
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
          { type: 'text', text: 'กดปุ่มด้านล่างเพื่อเปิดฟอร์มสำหรับสร้างบิลและหารบิลในกลุ่มครับ', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '📝 สร้างบิลใหม่',
              uri: LIFF_URL, // ‼️ ลิงก์ไป LIFF App
            },
            style: 'primary',
            height: 'sm',
          },
        ],
      },
    },
  };
}