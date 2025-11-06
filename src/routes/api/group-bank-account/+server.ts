import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import {
  authenticateLiffRequest,
  badRequest,
  serverError
} from '$lib/server/line';

export const prerender = false;

type ChatType = 'group' | 'room';

type UpdateBankAccountRequest = {
  accountNumber?: unknown;
  bankName?: unknown;
  accountName?: unknown;
  groupId?: unknown;
  chatType?: unknown;
};

function validate(body: UpdateBankAccountRequest) {
  const accountNumber = typeof body.accountNumber === 'string' ? body.accountNumber.trim() : '';
  const bankName = typeof body.bankName === 'string' ? body.bankName.trim() : '';
  const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  const chatType = body.chatType === 'group' || body.chatType === 'room' ? body.chatType : null;

  if (!groupId) return badRequest('ไม่พบรหัสแชทจาก LINE');
  if (!chatType) return badRequest('ไม่พบประเภทแชทจาก LINE');
  if (!accountNumber) return badRequest('กรุณากรอกเลขบัญชีธนาคาร');

  const expectedPrefix = chatType === 'group' ? 'C' : 'R';
  if (!groupId.toUpperCase().startsWith(expectedPrefix)) {
    const message =
      chatType === 'group'
        ? 'ไม่สามารถอ่านรหัสกลุ่ม LINE ได้ กรุณาเปิด LIFF จากกลุ่มอีกครั้ง'
        : 'ไม่สามารถอ่านรหัสห้อง LINE ได้ กรุณาเปิด LIFF จากห้องสนทนาอีกครั้ง';
    return badRequest(message);
  }

  if (!/^[0-9\- ]+$/.test(accountNumber)) {
    return badRequest('รูปแบบเลขบัญชีไม่ถูกต้อง');
  }

  return {
    accountNumber,
    bankName: bankName || null,
    accountName: accountName || null,
    groupId,
    chatType: chatType as ChatType
  };
}

export async function POST({ request, fetch }) {
  let payload: UpdateBankAccountRequest | null = null;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Invalid JSON');
  }

  const validated = validate(payload ?? {});
  if (validated instanceof Response) return validated;

  const { accountName, accountNumber, bankName, groupId } = validated;

  const auth = await authenticateLiffRequest(request, fetch);
  if (auth instanceof Response) return auth;

  try {
    const { error: groupError } = await supabaseAdmin.from('groups').upsert({ group_id: groupId });
    if (groupError) throw groupError;
  } catch (error: any) {
    console.error('Supabase upsert group error:', error?.message ?? error);
    return serverError('บันทึกเลขบัญชีไม่สำเร็จ');
  }

  try {
    const { error } = await supabaseAdmin.from('group_bank_accounts').upsert({
      group_id: groupId,
      account_number: accountNumber,
      bank_name: bankName,
      account_name: accountName
    });
    if (error) throw error;
  } catch (error: any) {
    console.error('Supabase upsert bank account error:', error?.message ?? error);
    return serverError('บันทึกเลขบัญชีไม่สำเร็จ');
  }

  return json({
    success: true,
    bankAccount: {
      accountNumber,
      bankName,
      accountName
    },
    updatedBy: { userId: auth.userId, displayName: auth.displayName }
  });
}
