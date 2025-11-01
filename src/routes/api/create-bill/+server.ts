// src/routes/api/create-bill/+server.ts
import { json, error as SvelteKitError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as line from '@line/bot-sdk';
import { supabaseAdmin } from '$lib/supabaseAdmin';

// -----------------
// 1. ตั้งค่า Clients
// -----------------
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
});

// -----------------
// 2. ฟังก์ชัน POST (รับจาก LIFF)
// -----------------
export async function POST({ request }) {
  const { title, amount, groupId, creatorName } = await request.json();
  const token = request.headers.get('Authorization')?.split(' ')[1];

  if (!token) throw SvelteKitError(401, 'No token provided');

  // 2.1 ‼️ ตรวจสอบ LIFF Token (ความปลอดภัย)
  let userId = '';
  try {
    const res = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${token}`);
    if (!res.ok) throw new Error('Invalid token response from LINE');
    
    const data = await res.json();
    if (data.client_id !== env.LINE_LIFF_CHANNEL_ID) {
      throw new Error('Invalid LIFF token (Client ID mismatch)');
    }
    userId = data.sub; // ได้ userId จริง
  } catch (err: any) {
    console.error("LIFF Token verification failed:", err.message);
    throw SvelteKitError(401, err.message);
  }

  // 2.2 ‼️ บันทึกลง DB (ใช้ Admin Client)
  try {
    // บันทึก User (ถ้ายังไม่มีก็สร้างใหม่)
    await supabaseAdmin.from('users').upsert({ user_id: userId, display_name: creatorName });
    
    // สร้างบิล
    const { data: billData, error: billError } = await supabaseAdmin
      .from('bills')
      .insert({ 
        group_id: groupId, 
        created_by: userId, 
        title: title, 
        total_amount: amount 
      })
      .select('bill_id')
      .single();

    if (billError) throw billError;

    // 2.3 ‼️ ส่ง Flex Message บิลจริงเข้ากลุ่ม
    await lineClient.pushMessage({
      to: groupId,
      messages: [createBillFlex(billData.bill_id, title, amount, creatorName)],
    });

    return json({ success: true, billId: billData.bill_id });

  } catch (err: any) {
    console.error("Error creating bill or pushing message:", err.message);
    throw SvelteKitError(500, err.message);
  }
}

// -----------------
// 3. Helper: สร้าง Flex Message (บิลจริง)
// -----------------
function createBillFlex(billId: string, title: string, amount: number, creator: string): line.FlexMessage {
  // นี่คือบิลเวอร์ชันแรก (ยังไม่มีคนหาร)
  return {
    type: 'flex',
    altText: `บิลใหม่: ${title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🧾 บิลใหม่!', weight: 'bold', color: '#1DB446', size: 'lg' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: title, size: 'xl', weight: 'bold', wrap: true },
          { type: 'text', text: `ยอดรวม ${amount.toFixed(2)} บาท`, size: 'lg' },
          { type: 'text', text: `สร้างโดย: ${creator}`, size: 'sm', color: '#888888', margin: 'md' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: 'คนที่ยังไม่จ่าย:', margin: 'lg', weight: 'bold' },
          { type: 'text', text: '(ยังไม่มีคนเข้าร่วมหาร)', color: '#888888', style: 'italic' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          // TODO: เพิ่มปุ่ม "Join" หรือ "จ่ายแล้ว"
          // นี่คือตัวอย่าง Postback ที่ line-webhook จะต้องรับไปจัดการ
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '✅ ฉันจ่ายแล้ว',
              data: `action=mark_paid&bill_id=${billId}`,
            },
            style: 'primary',
            height: 'sm',
          },
        ],
      },
    },
  };
}