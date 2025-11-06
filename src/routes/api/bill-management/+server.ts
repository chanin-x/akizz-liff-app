import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import {
  authenticateLiffRequest,
  badRequest,
  createMessagingClient,
  getChatMemberProfile,
  listChatMemberIds,
  serverError
} from '$lib/server/line';

export const prerender = false;

type ChatType = 'group' | 'room';

type Member = { userId: string; displayName: string | null };

function validateChatParams(chatId: string | null, chatType: string | null): { chatId: string; chatType: ChatType } | Response {
  if (!chatId) return badRequest('ไม่พบรหัสแชทจาก LINE');
  if (chatType !== 'group' && chatType !== 'room') {
    return badRequest('ไม่พบประเภทแชทจาก LINE');
  }

  const expectedPrefix = chatType === 'group' ? 'C' : 'R';
  if (!chatId.toUpperCase().startsWith(expectedPrefix)) {
    const message =
      chatType === 'group'
        ? 'ไม่สามารถอ่านรหัสกลุ่ม LINE ได้ กรุณาเปิด LIFF จากกลุ่มอีกครั้ง'
        : 'ไม่สามารถอ่านรหัสห้อง LINE ได้ กรุณาเปิด LIFF จากห้องสนทนาอีกครั้ง';
    return badRequest(message);
  }

  return { chatId, chatType };
}

async function loadBankAccount(chatId: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from('group_bank_accounts')
      .select('account_number,account_name,bank_name')
      .eq('group_id', chatId)
      .limit(1);
    if (error) throw error;
    if (data && data.length > 0) {
      const record = data[0];
      if (record?.account_number) {
        return {
          accountNumber: record.account_number as string,
          accountName: (record.account_name as string | null) ?? null,
          bankName: (record.bank_name as string | null) ?? null
        };
      }
    }
  } catch (error: any) {
    console.warn('loadBankAccount error:', error?.message ?? error);
  }
  return null;
}

async function loadBills(chatId: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from('bills')
      .select('bill_id,title,total_amount,status,created_at')
      .eq('group_id', chatId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data ?? [];
  } catch (error: any) {
    console.error('loadBills error:', error?.message ?? error);
    throw serverError('ไม่สามารถโหลดข้อมูลบิลได้');
  }
}

async function loadMembers(
  chatId: string,
  chatType: ChatType,
  lineClient: ReturnType<typeof createMessagingClient>
): Promise<Member[] | Response> {
  if (!lineClient) {
    return serverError('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN บนเซิร์ฟเวอร์');
  }

  const ids = await listChatMemberIds(lineClient, chatType, chatId);
  const uniqueIds = Array.from(new Set(ids));

  if (uniqueIds.length === 0) {
    return serverError('ไม่สามารถดึงรายชื่อสมาชิกจาก Messaging API ได้ กรุณาตรวจสอบว่าเชิญบอทเข้ากลุ่มแล้ว');
  }

  const limitedIds = uniqueIds.slice(0, 200);

  const results = await Promise.allSettled(
    limitedIds.map(async (userId) => {
      const profile = await getChatMemberProfile(lineClient, chatType, chatId, userId);
      return { userId, displayName: profile?.displayName ?? null } satisfies Member;
    })
  );

  const members: Member[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      members.push(result.value);
    }
  }

  if (members.length === 0) {
    return serverError('ไม่สามารถอ่านโปรไฟล์สมาชิกจาก Messaging API ได้');
  }

  return members;
}

export async function GET({ request, fetch, url }) {
  const chatIdParam = url.searchParams.get('chatId');
  const chatTypeParam = url.searchParams.get('chatType');

  const validated = validateChatParams(chatIdParam, chatTypeParam);
  if (validated instanceof Response) return validated;

  const { chatId, chatType } = validated;

  const auth = await authenticateLiffRequest(request, fetch);
  if (auth instanceof Response) return auth;

  const lineClient = createMessagingClient();

  const [bankAccount, bills] = await Promise.all([loadBankAccount(chatId), loadBills(chatId)]);

  const members: Member[] = [];
  const seenIds = new Set<string>();

  const lineMembers = await loadMembers(chatId, chatType, lineClient);
  if (lineMembers instanceof Response) return lineMembers;
  for (const member of lineMembers) {
    if (seenIds.has(member.userId)) continue;
    seenIds.add(member.userId);
    members.push(member);
  }

  if (!seenIds.has(auth.userId)) {
    members.push({ userId: auth.userId, displayName: auth.displayName });
  }

  return json({
    members,
    bills,
    bankAccount,
    me: { userId: auth.userId, displayName: auth.displayName },
    chatId,
    chatType
  });
}
