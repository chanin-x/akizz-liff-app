import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { createBillFlexMessage } from '$lib/lineMessages';
import { splitAmount } from '$lib/splitAmount';
import {
  authenticateLiffRequest,
  badRequest,
  createMessagingClient,
  getChatMemberProfile,
  serverError
} from '$lib/server/line';

export const prerender = false;

type ChatType = 'group' | 'room';

type ParticipantPayload = { userId: unknown; displayName?: unknown };

type CreateBillRequest = {
  title?: unknown;
  amount?: unknown;
  groupId?: unknown;
  chatType?: unknown;
  roundingStep?: unknown;
  participants?: unknown;
};

type ValidatedRequest = {
  title: string;
  amount: number;
  chatType: ChatType;
  chatId: string;
  roundingStep: number | null;
  participants: { userId: string; displayName: string | null }[];
};

function parseParticipants(participants: unknown): { userId: string; displayName: string | null }[] | Response {
  if (!Array.isArray(participants) || participants.length === 0) {
    return badRequest('ต้องเลือกรายชื่อคนหารอย่างน้อย 1 คน');
  }

  const seen = new Set<string>();
  const parsed: { userId: string; displayName: string | null }[] = [];

  for (const entry of participants as ParticipantPayload[]) {
    if (!entry || typeof entry.userId !== 'string') {
      return badRequest('ข้อมูลรายชื่อคนหารไม่ถูกต้อง');
    }
    const userId = entry.userId.trim();
    if (!userId) return badRequest('ข้อมูลรายชื่อคนหารไม่ถูกต้อง');
    if (seen.has(userId)) continue;
    seen.add(userId);
    const displayName =
      typeof entry.displayName === 'string' && entry.displayName.trim().length > 0
        ? entry.displayName.trim()
        : null;
    parsed.push({ userId, displayName });
  }

  if (parsed.length === 0) {
    return badRequest('ต้องเลือกรายชื่อคนหารอย่างน้อย 1 คน');
  }

  return parsed;
}

function parseAndValidate(body: CreateBillRequest): ValidatedRequest | Response {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const amountNum = Number(body.amount);
  const chatType = body.chatType === 'group' || body.chatType === 'room' ? body.chatType : null;
  const chatId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  const rounding = body.roundingStep == null ? null : Number(body.roundingStep);

  if (!title) return badRequest('ต้องระบุชื่อบิล');
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return badRequest('ยอดรวมต้องเป็นตัวเลขที่มากกว่า 0');
  }
  if (!chatType) return badRequest('ไม่พบประเภทแชทจาก LINE');
  if (!chatId) return badRequest('ไม่พบรหัสแชทจาก LINE');

  const expectedPrefix = chatType === 'group' ? 'C' : 'R';
  if (!chatId.toUpperCase().startsWith(expectedPrefix)) {
    const message =
      chatType === 'group'
        ? 'ไม่สามารถอ่านรหัสกลุ่ม LINE ได้ กรุณาเปิด LIFF จากกลุ่มอีกครั้ง'
        : 'ไม่สามารถอ่านรหัสห้อง LINE ได้ กรุณาเปิด LIFF จากห้องสนทนาอีกครั้ง';
    return badRequest(message);
  }

  const parsedParticipants = parseParticipants(body.participants);
  if (parsedParticipants instanceof Response) return parsedParticipants;

  let roundingStep: number | null = null;
  if (rounding != null && Number.isFinite(rounding) && rounding > 0) {
    roundingStep = Math.round(Number(rounding) * 100) / 100;
  }

  return {
    title,
    amount: Math.round(amountNum * 100) / 100,
    chatType,
    chatId,
    roundingStep,
    participants: parsedParticipants
  };
}

export async function POST({ request, fetch }) {
  const lineClient = createMessagingClient();
  let payload: CreateBillRequest | null = null;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Invalid JSON');
  }

  const validated = parseAndValidate(payload ?? {});
  if (validated instanceof Response) return validated;

  const { amount, chatId, chatType, participants, roundingStep, title } = validated;

  const auth = await authenticateLiffRequest(request, fetch);
  if (auth instanceof Response) return auth;

  let resolvedCreatorName = auth.displayName;

  if (lineClient) {
    const profile = await getChatMemberProfile(lineClient, chatType, chatId, auth.userId);
    if (profile?.displayName) {
      resolvedCreatorName = profile.displayName;
    }
  }

  try {
    const { error: groupError } = await supabaseAdmin.from('groups').upsert({ group_id: chatId });
    if (groupError) throw groupError;
  } catch (error: any) {
    console.error('Supabase upsert group error:', error?.message ?? error);
    return serverError('Failed to sync group metadata');
  }

  const userRecords = new Map<string, { display_name: string | null }>();
  userRecords.set(auth.userId, { display_name: resolvedCreatorName ?? auth.displayName ?? null });

  for (const participant of participants) {
    if (!userRecords.has(participant.userId)) {
      userRecords.set(participant.userId, { display_name: participant.displayName ?? null });
    } else if (participant.displayName && participant.displayName.trim().length > 0) {
      userRecords.set(participant.userId, { display_name: participant.displayName.trim() });
    }
  }

  try {
    const userPayload = Array.from(userRecords.entries()).map(([user_id, value]) => ({
      user_id,
      display_name: value.display_name
    }));
    if (userPayload.length > 0) {
      const { error: userError } = await supabaseAdmin.from('users').upsert(userPayload);
      if (userError) throw userError;
    }
  } catch (error: any) {
    console.error('Supabase upsert user error:', error?.message ?? error);
  }

  const shares = splitAmount({ total: amount, participantCount: participants.length, roundingStep });
  if (shares.length !== participants.length) {
    return serverError('Failed to split bill amount');
  }

  let billId: string | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('bills')
      .insert({
        group_id: chatId,
        created_by: auth.userId,
        title,
        total_amount: amount,
        status: 'pending'
      })
      .select('bill_id')
      .single();
    if (error) throw error;
    billId = data.bill_id;
  } catch (error: any) {
    console.error('Insert bill error:', error?.message ?? error);
    return serverError('Failed to create bill');
  }

  try {
    const participantRows = participants.map((participant, index) => ({
      bill_id: billId!,
      user_id: participant.userId,
      share_amount: shares[index],
      status: 'pending'
    }));
    if (participantRows.length > 0) {
      const { error: participantError } = await supabaseAdmin.from('bill_participants').insert(participantRows);
      if (participantError) throw participantError;
    }
  } catch (error: any) {
    console.error('Insert bill participants error:', error?.message ?? error);
  }

  let bankAccount: {
    accountNumber: string;
    accountName: string | null;
    bankName: string | null;
  } | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('group_bank_accounts')
      .select('account_number,account_name,bank_name')
      .eq('group_id', chatId)
      .limit(1);
    if (error) throw error;
    if (data && data.length > 0) {
      const record = data[0];
      bankAccount = {
        accountNumber: record.account_number ?? '',
        accountName: record.account_name ?? null,
        bankName: record.bank_name ?? null
      };
    }
  } catch (error: any) {
    console.warn('Fetch bank account error:', error?.message ?? error);
  }

  const participantSummaries = participants.map((participant, index) => ({
    displayName: participant.displayName,
    share: shares[index],
    status: 'pending'
  }));

  let roundingNote: string | null = null;
  if (roundingStep && roundingStep > 0) {
    const diff = Number(participantSummaries.reduce((sum, current) => sum + current.share, 0) - amount);
    if (Math.abs(diff) >= 0.01) {
      const prefix = diff > 0 ? '+' : '';
      roundingNote = `ปัดเศษส่วนต่าง ${prefix}${diff.toFixed(2)} บาท`;
    } else {
      roundingNote = `ปัดเศษค่าส่วนหารขั้นละ ${roundingStep.toFixed(2)} บาท`;
    }
  }

  const flexMessage = createBillFlexMessage({
    billId: billId!,
    title,
    amount,
    creatorName: resolvedCreatorName ?? auth.displayName ?? null,
    participants: participantSummaries,
    bankAccount,
    roundingNote
  });

  const isRoomChat = chatType === 'room';

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
      messages: [flexMessage as any]
    });

    return json({ success: true, billId, pushSent: true, message: flexMessage });
  } catch (error: any) {
    const detail = error?.originalError?.response?.data ?? error?.response?.data;
    if (detail) {
      console.error('pushMessage error detail:', JSON.stringify(detail));
    }
    console.error('pushMessage error:', error?.message ?? error);
    return json({
      success: true,
      billId,
      pushSent: false,
      warning: 'สร้างบิลสำเร็จ แต่ส่งข้อความผ่านบอทไม่สำเร็จ จะพยายามส่งจาก LIFF แทน',
      message: flexMessage
    });
  }
}
