<script lang="ts">
  import { onMount } from 'svelte';
  import liff from '@line/liff';
  import { env as publicEnv } from '$env/dynamic/public';
  import { createBillFlexMessage } from '$lib/lineMessages';
  import { splitAmount } from '$lib/splitAmount';

  type ChatType = 'group' | 'room' | '';
  type Member = { userId: string; displayName: string | null };
  type Bill = { bill_id: string; title: string; total_amount: number; status: string; created_at: string };
  type BankAccount = { accountNumber: string; bankName: string | null; accountName: string | null } | null;

  let isLoading = true;
  let error: string | null = null;

  let chatId = '';
  let chatType: ChatType = '';
  let displayName = '';
  let liffAccessToken = '';

  let members: Member[] = [];
  let bills: Bill[] = [];
  let bankAccount: BankAccount = null;

  let billTitle = '';
  let totalAmount = '';
  let roundingStep = '';
  let isSubmittingBill = false;
  let billSuccessMessage: string | null = null;

  let selectedParticipantIds = new Set<string>();

  let isSavingBank = false;
  let bankAccountNumber = '';
  let bankAccountName = '';
  let bankName = '';
  let bankSuccessMessage: string | null = null;

  let cancellingBillId: string | null = null;
  let cancelSuccessMessage: string | null = null;

  const PUBLIC_LIFF_ID = publicEnv.PUBLIC_LIFF_ID ?? '';

  type CreateBillResponse = {
    success: boolean;
    billId?: string;
    pushSent?: boolean;
    warning?: string;
    message?: unknown;
  };

  async function initLiff() {
    if (!PUBLIC_LIFF_ID) {
      throw new Error('PUBLIC_LIFF_ID is not configured.');
    }

    await liff.init({ liffId: PUBLIC_LIFF_ID });

    if (!liff.isInClient()) throw new Error('กรุณาเปิดในแอป LINE');

    const profile = await liff.getProfile();
    const context = liff.getContext();
    const token = liff.getAccessToken();
    const params = new URL(window.location.href).searchParams;

    if (!token) throw new Error('ไม่สามารถดึง Token ได้');

    const paramChatType = params.get('chatType')?.trim();
    const paramChatId = params.get('chatId')?.trim() ?? '';

    if (paramChatType === 'group' || paramChatType === 'room') {
      chatType = paramChatType;
    } else if (context?.type === 'group' || context?.type === 'room') {
      chatType = context.type;
    } else {
      throw new Error('ลิงก์นี้ไม่ระบุประเภทห้องสนทนา กรุณากดปุ่มสร้างบิลจากในกลุ่มอีกครั้ง');
    }

    chatId = paramChatId;
    if (!chatId) {
      throw new Error('ลิงก์นี้ไม่ระบุรหัสแชท กรุณากดปุ่มสร้างบิลจากในกลุ่มอีกครั้ง');
    }

    if (context?.type && chatType && context.type !== chatType) {
      console.warn('LIFF context type mismatch with query parameter:', {
        contextType: context.type,
        chatType
      });
    }

    displayName = profile.displayName;
    liffAccessToken = token;
  }

  async function fetchManagementData() {
    const params = new URLSearchParams({ chatId, chatType });
    const res = await fetch(`/api/bill-management?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${liffAccessToken}`
      }
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'โหลดข้อมูลไม่สำเร็จ');
    }

    const payload = await res.json();
    members = (payload.members ?? []) as Member[];
    bills = (payload.bills ?? []) as Bill[];
    bankAccount = payload.bankAccount ?? null;

    if (bankAccount) {
      bankAccountNumber = bankAccount.accountNumber ?? '';
      bankAccountName = bankAccount.accountName ?? '';
      bankName = bankAccount.bankName ?? '';
    }

    selectedParticipantIds = new Set((members ?? []).map((member) => member.userId));
  }

  onMount(async () => {
    try {
      await initLiff();
      await fetchManagementData();
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
    } finally {
      isLoading = false;
    }
  });

  $: selectedParticipants = members.filter((member) => selectedParticipantIds.has(member.userId));

  $: sharePreview = (() => {
    const amountValue = Number(totalAmount);
    const stepValue = Number(roundingStep);
    if (!Number.isFinite(amountValue) || amountValue <= 0 || selectedParticipants.length === 0) {
      return [] as { member: Member; share: number }[];
    }

    const shares = splitAmount({
      total: amountValue,
      participantCount: selectedParticipants.length,
      roundingStep: Number.isFinite(stepValue) && stepValue > 0 ? stepValue : null
    });

    return selectedParticipants.map((member, index) => ({ member, share: shares[index] ?? 0 }));
  })();

  function updateParticipant(id: string, checked: boolean) {
    const next = new Set(selectedParticipantIds);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    selectedParticipantIds = next;
  }

  function selectAllParticipants() {
    selectedParticipantIds = new Set(members.map((member) => member.userId));
  }

  function clearParticipants() {
    selectedParticipantIds = new Set();
  }

  async function handleSubmitBill() {
    billSuccessMessage = null;
    cancelSuccessMessage = null;

    const amountValue = Number(totalAmount);
    const stepValue = Number(roundingStep);

    if (!billTitle || !Number.isFinite(amountValue) || amountValue <= 0) {
      alert('กรุณากรอกข้อมูลบิลให้ครบถ้วน');
      return;
    }

    if (selectedParticipants.length === 0) {
      alert('กรุณาเลือกรายชื่อคนหารอย่างน้อย 1 คน');
      return;
    }

    if (!liffAccessToken) {
      error = 'ไม่พบ LIFF Token (ต้องเปิดผ่านแอป LINE)';
      return;
    }

    if (!chatType) {
      error = 'ไม่พบข้อมูลห้องสนทนาจาก LINE';
      return;
    }

    const expectedPrefix = chatType === 'group' ? 'C' : 'R';
    if (!chatId || !chatId.toUpperCase().startsWith(expectedPrefix)) {
      error =
        chatType === 'group'
          ? 'ไม่สามารถอ่านรหัสกลุ่ม LINE ได้ กรุณาเปิด LIFF จากกลุ่มอีกครั้ง'
          : 'ไม่สามารถอ่านรหัสห้อง LINE ได้ กรุณาเปิด LIFF จากห้องสนทนาอีกครั้ง';
      return;
    }

    isSubmittingBill = true;
    error = null;

    try {
      const body = {
        title: billTitle,
        amount: amountValue,
        groupId: chatId,
        chatType,
        participants: selectedParticipants.map((member) => ({
          userId: member.userId,
          displayName: member.displayName ?? null
        })),
        roundingStep: Number.isFinite(stepValue) && stepValue > 0 ? stepValue : null
      };

      const res = await fetch('/api/create-bill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${liffAccessToken}`
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? 'ไม่สามารถสร้างบิลได้';
        throw new Error(message);
      }

      const payload: CreateBillResponse = await res.json();
      billSuccessMessage = 'สร้างบิลสำเร็จแล้ว';
      if (payload.warning) {
        billSuccessMessage = `${billSuccessMessage} (${payload.warning})`;
      }

      if (!payload.pushSent && payload?.message) {
        try {
          await liff.sendMessages([payload.message as any]);
        } catch (sendError: any) {
          console.error('LIFF sendMessages error:', sendError?.message ?? sendError);
          const fallbackText = `🧾 บิลใหม่จาก ${displayName}\n${billTitle}\nยอดรวม ${amountValue.toFixed(2)} บาท`;
          try {
            await liff.sendMessages([{ type: 'text', text: fallbackText }]);
            alert('ส่งบิลในรูปแบบข้อความธรรมดาแทน เนื่องจากส่ง Flex ไม่สำเร็จ');
          } catch (fallbackErr: any) {
            console.error('LIFF fallback send error:', fallbackErr?.message ?? fallbackErr);
            throw new Error('สร้างบิลแล้วแต่ส่งข้อความเข้าแชทไม่สำเร็จ ลองใหม่อีกครั้งครับ');
          }
        }
      } else if (!payload.pushSent && !payload?.message) {
        const fallbackMessage = createBillFlexMessage({
          billId: payload.billId ?? 'temp',
          title: billTitle,
          amount: amountValue,
          creatorName: displayName,
          participants: sharePreview.map(({ member, share }) => ({
            displayName: member.displayName,
            share,
            status: 'pending'
          })),
          bankAccount,
          roundingNote:
            Number.isFinite(stepValue) && stepValue > 0
              ? `ปัดเศษค่าส่วนหารขั้นละ ${stepValue.toFixed(2)} บาท`
              : null
        });
        try {
          await liff.sendMessages([fallbackMessage as any]);
        } catch (sendError: any) {
          console.error('LIFF sendMessages error:', sendError?.message ?? sendError);
        }
      }

      totalAmount = '';
      billTitle = '';
      roundingStep = '';

      await fetchManagementData();
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
    } finally {
      isSubmittingBill = false;
    }
  }

  async function handleSaveBankAccount() {
    bankSuccessMessage = null;
    error = null;

    if (!liffAccessToken) {
      error = 'ไม่พบ LIFF Token (ต้องเปิดผ่านแอป LINE)';
      return;
    }

    if (!chatType) {
      error = 'ไม่พบข้อมูลห้องสนทนาจาก LINE';
      return;
    }

    isSavingBank = true;

    try {
      const res = await fetch('/api/group-bank-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${liffAccessToken}`
        },
        body: JSON.stringify({
          groupId: chatId,
          chatType,
          accountNumber: bankAccountNumber,
          bankName,
          accountName: bankAccountName
        })
      });

      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? 'บันทึกเลขบัญชีไม่สำเร็จ';
        throw new Error(message);
      }

      const payload = await res.json();
      bankAccount = {
        accountNumber: payload?.bankAccount?.accountNumber ?? bankAccountNumber,
        bankName: payload?.bankAccount?.bankName ?? bankName,
        accountName: payload?.bankAccount?.accountName ?? bankAccountName
      };
      bankSuccessMessage = 'บันทึกข้อมูลบัญชีเรียบร้อยแล้ว';
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
    } finally {
      isSavingBank = false;
    }
  }

  async function handleCancelBill(bill: Bill) {
    cancelSuccessMessage = null;

    if (!confirm(`ยืนยันการยกเลิกบิล "${bill.title}" หรือไม่?`)) return;

    cancellingBillId = bill.bill_id;
    try {
      const res = await fetch('/api/cancel-bill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${liffAccessToken}`
        },
        body: JSON.stringify({
          billId: bill.bill_id,
          groupId: chatId,
          chatType
        })
      });

      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? 'ยกเลิกบิลไม่สำเร็จ';
        throw new Error(message);
      }

      const payload = await res.json();
      if (payload?.alreadyCancelled) {
        cancelSuccessMessage = 'บิลถูกยกเลิกไว้ก่อนหน้านี้แล้ว';
      } else {
        cancelSuccessMessage = 'ยกเลิกบิลสำเร็จ';
      }

      await fetchManagementData();
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
    } finally {
      cancellingBillId = null;
    }
  }
</script>

<div class="min-h-screen bg-gray-100 py-6">
  <div class="mx-auto w-full max-w-3xl px-4">
    <div class="rounded-lg bg-white p-6 shadow-md">
      {#if isLoading}
        <p class="text-center text-lg font-semibold">กำลังโหลดข้อมูล AKizz...</p>
      {:else if error}
        <div class="text-center text-red-600">
          <h2 class="text-xl font-bold">เกิดข้อผิดพลาด</h2>
          <p>{error}</p>
        </div>
      {:else}
        <header class="mb-6 text-center">
          <h1 class="text-2xl font-bold text-gray-800">จัดการบิลในกลุ่ม</h1>
          <p class="text-sm text-gray-600">เปิดโดย: <strong>{displayName}</strong></p>
        </header>

        {#if billSuccessMessage}
          <div class="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">{billSuccessMessage}</div>
        {/if}
        {#if bankSuccessMessage}
          <div class="mb-4 rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-800">{bankSuccessMessage}</div>
        {/if}
        {#if cancelSuccessMessage}
          <div class="mb-4 rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">{cancelSuccessMessage}</div>
        {/if}

        <section class="mb-8">
          <h2 class="mb-4 text-xl font-semibold text-gray-800">1. สร้างบิลใหม่</h2>
          <form class="space-y-4" on:submit|preventDefault={handleSubmitBill}>
            <div>
              <label for="title" class="block text-sm font-medium text-gray-700">ชื่อบิล</label>
              <input
                id="title"
                type="text"
                bind:value={billTitle}
                required
                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base shadow-sm focus:border-indigo-500 focus:outline-none focus:ring focus:ring-indigo-200"
                placeholder="เช่น ค่าอาหารเย็น"
              />
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="amount" class="block text-sm font-medium text-gray-700">ยอดรวม (บาท)</label>
                <input
                  id="amount"
                  type="number"
                  bind:value={totalAmount}
                  min="0"
                  step="0.01"
                  required
                  class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base shadow-sm focus:border-indigo-500 focus:outline-none focus:ring focus:ring-indigo-200"
                  placeholder="1000"
                />
              </div>

              <div>
                <label for="rounding" class="block text-sm font-medium text-gray-700">ปัดเศษต่อคน (บาท)</label>
                <input
                  id="rounding"
                  type="number"
                  bind:value={roundingStep}
                  min="0"
                  step="0.01"
                  class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base shadow-sm focus:border-indigo-500 focus:outline-none focus:ring focus:ring-indigo-200"
                  placeholder="เช่น 1 หรือ 5"
                />
                <p class="mt-1 text-xs text-gray-500">ปล่อยว่างหากไม่ต้องการปัดเศษ</p>
              </div>
            </div>

            <div>
              <div class="mb-2 flex items-center justify-between">
                <span class="block text-sm font-medium text-gray-700">เลือกรายชื่อคนหาร</span>
                <div class="space-x-2 text-xs">
                  <button type="button" class="text-indigo-600 hover:underline" on:click={selectAllParticipants}>เลือกทั้งหมด</button>
                  <button type="button" class="text-indigo-600 hover:underline" on:click={clearParticipants}>ล้าง</button>
                </div>
              </div>
              <div class="max-h-48 space-y-2 overflow-y-auto rounded border border-gray-200 p-3">
                {#if members.length === 0}
                  <p class="text-sm text-gray-500">ไม่สามารถดึงรายชื่อสมาชิกในกลุ่มได้ กรุณาตรวจสอบสิทธิ์ของบอท</p>
                {:else}
                  {#each members as member}
                    <label class="flex items-center justify-between rounded border border-transparent px-2 py-1 text-sm hover:border-indigo-200">
                      <span class="flex-1 truncate">{member.displayName ?? member.userId}</span>
                      <input
                        type="checkbox"
                        class="ml-3 h-4 w-4"
                        checked={selectedParticipantIds.has(member.userId)}
                        on:change={(event) => updateParticipant(member.userId, event.currentTarget.checked)}
                      />
                    </label>
                  {/each}
                {/if}
              </div>
            </div>

            {#if sharePreview.length > 0}
              <div class="rounded border border-gray-200 bg-gray-50 p-3">
                <h3 class="mb-2 text-sm font-semibold text-gray-700">สรุปยอดหาร</h3>
                <ul class="space-y-1 text-sm text-gray-700">
                  {#each sharePreview as item}
                    <li class="flex justify-between">
                      <span>{item.member.displayName ?? item.member.userId}</span>
                      <span>{item.share.toFixed(2)} บาท</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}

            <button
              type="submit"
              class={`w-full rounded-md border border-transparent px-4 py-2 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                isSubmittingBill ? 'cursor-not-allowed bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
              disabled={isSubmittingBill}
            >
              {isSubmittingBill ? 'กำลังสร้าง...' : '✅ สร้างบิลและส่งเข้ากลุ่ม'}
            </button>
          </form>
        </section>

        <section class="mb-8">
          <h2 class="mb-4 text-xl font-semibold text-gray-800">2. ยกเลิกบิล</h2>
          {#if bills.length === 0}
            <p class="text-sm text-gray-600">ยังไม่มีบิลในกลุ่มนี้</p>
          {:else}
            <ul class="space-y-3">
              {#each bills as bill}
                <li class="rounded border border-gray-200 p-3">
                  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p class="font-semibold text-gray-800">{bill.title}</p>
                      <p class="text-sm text-gray-600">ยอดรวม {Number(bill.total_amount).toFixed(2)} บาท</p>
                      <p class="text-xs text-gray-500">สถานะ: {bill.status}</p>
                    </div>
                    <button
                      class={`mt-2 rounded border px-3 py-1 text-sm font-medium sm:mt-0 ${
                        bill.status === 'cancelled'
                          ? 'border-gray-200 text-gray-400'
                          : 'border-red-400 text-red-600 hover:bg-red-50'
                      }`}
                      on:click={() => handleCancelBill(bill)}
                      disabled={bill.status === 'cancelled' || cancellingBillId === bill.bill_id}
                    >
                      {bill.status === 'cancelled'
                        ? 'ยกเลิกแล้ว'
                        : cancellingBillId === bill.bill_id
                        ? 'กำลังยกเลิก...'
                        : 'ยกเลิกบิล'}
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section>
          <h2 class="mb-4 text-xl font-semibold text-gray-800">3. เพิ่มเลขบัญชีธนาคาร</h2>
          <form class="space-y-4" on:submit|preventDefault={handleSaveBankAccount}>
            <div>
              <label for="bank-name" class="block text-sm font-medium text-gray-700">ธนาคาร</label>
              <input
                id="bank-name"
                type="text"
                bind:value={bankName}
                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base shadow-sm focus:border-indigo-500 focus:outline-none focus:ring focus:ring-indigo-200"
                placeholder="เช่น กสิกรไทย"
              />
            </div>
            <div>
              <label for="bank-account-name" class="block text-sm font-medium text-gray-700">ชื่อบัญชี</label>
              <input
                id="bank-account-name"
                type="text"
                bind:value={bankAccountName}
                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base shadow-sm focus:border-indigo-500 focus:outline-none focus:ring focus:ring-indigo-200"
                placeholder="เช่น นายเอ กก"
              />
            </div>
            <div>
              <label for="bank-account-number" class="block text-sm font-medium text-gray-700">เลขบัญชี</label>
              <input
                id="bank-account-number"
                type="text"
                bind:value={bankAccountNumber}
                required
                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base shadow-sm focus:border-indigo-500 focus:outline-none focus:ring focus:ring-indigo-200"
                placeholder="เช่น 123-456-7890"
              />
            </div>

            <button
              type="submit"
              class={`w-full rounded-md border border-transparent px-4 py-2 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                isSavingBank ? 'cursor-not-allowed bg-gray-400' : 'bg-green-600 hover:bg-green-700'
              }`}
              disabled={isSavingBank}
            >
              {isSavingBank ? 'กำลังบันทึก...' : '💳 บันทึกข้อมูลบัญชี'}
            </button>
          </form>
        </section>
      {/if}
    </div>
  </div>
</div>
