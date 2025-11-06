import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import {
  authenticateLiffRequest,
  badRequest,
  createMessagingClient,
  serverError
} from '$lib/server/line';

export const prerender = false;

type ChatType = 'group' | 'room';

type CancelBillRequest = {
  billId?: unknown;
  groupId?: unknown;
  chatType?: unknown;
};

function validate(body: CancelBillRequest): { billId: string; groupId: string; chatType: ChatType } | Response {
  const billId = typeof body.billId === 'string' ? body.billId.trim() : '';
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  const chatType = body.chatType === 'group' || body.chatType === 'room' ? body.chatType : null;

  if (!billId) return badRequest('ไม่พบบิลที่ต้องการยกเลิก');
  if (!groupId) return badRequest('ไม่พบรหัสแชทจาก LINE');
  if (!chatType) return badRequest('ไม่พบประเภทแชทจาก LINE');

  const expectedPrefix = chatType === 'group' ? 'C' : 'R';
  if (!groupId.toUpperCase().startsWith(expectedPrefix)) {
    const message =
      chatType === 'group'
        ? 'ไม่สามารถอ่านรหัสกลุ่ม LINE ได้ กรุณาเปิด LIFF จากกลุ่มอีกครั้ง'
        : 'ไม่สามารถอ่านรหัสห้อง LINE ได้ กรุณาเปิด LIFF จากห้องสนทนาอีกครั้ง';
    return badRequest(message);
  }

  return { billId, groupId, chatType };
}

export async function POST({ request, fetch }) {
  let payload: CancelBillRequest | null = null;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Invalid JSON');
  }

  const validated = validate(payload ?? {});
  if (validated instanceof Response) return validated;

  const { billId, groupId, chatType } = validated;

  const auth = await authenticateLiffRequest(request, fetch);
  if (auth instanceof Response) return auth;

  const { data: bill, error: fetchError } = await supabaseAdmin
    .from('bills')
    .select('bill_id,group_id,title,status')
    .eq('bill_id', billId)
    .single();

  if (fetchError) {
    console.error('load bill error:', fetchError.message ?? fetchError);
    return serverError('ไม่พบบิลที่ต้องการยกเลิก');
  }

  if (!bill || bill.group_id !== groupId) {
    return badRequest('ไม่พบบิลในกลุ่มนี้');
  }

  if (bill.status === 'cancelled') {
    return json({ success: true, alreadyCancelled: true });
  }

  const { error: updateError } = await supabaseAdmin
    .from('bills')
    .update({ status: 'cancelled' })
    .eq('bill_id', billId)
    .eq('group_id', groupId);

  if (updateError) {
    console.error('cancel bill error:', updateError.message ?? updateError);
    return serverError('ยกเลิกบิลไม่สำเร็จ');
  }

  try {
    await supabaseAdmin
      .from('bill_participants')
      .update({ status: 'cancelled' })
      .eq('bill_id', billId);
  } catch (error: any) {
    console.warn('update participants status error:', error?.message ?? error);
  }

  const lineClient = createMessagingClient();
  if (lineClient && chatType === 'group') {
    try {
      await lineClient.pushMessage({
        to: groupId,
        messages: [
          {
            type: 'text',
            text: `บิล "${bill.title}" ถูกยกเลิกโดย ${auth.displayName ?? 'สมาชิกในกลุ่ม'}`
          }
        ]
      });
    } catch (error: any) {
      const detail = error?.originalError?.response?.data ?? error?.message ?? error;
      console.warn('push cancel message error:', detail);
    }
  }

  return json({ success: true });
}
