<script lang="ts">
  import { onMount } from 'svelte';
  import liff from '@line/liff';
  import { PUBLIC_LIFF_ID } from '$env/static/public';

  let isLoading = true;
  let isSubmitting = false;
  let error: string | null = null;

  let groupId = '';
  let displayName = '';
  let liffAccessToken = '';

  let billTitle = '';
  let totalAmount = '';

  type CreateBillResponse = {
    success: boolean;
    billId?: string;
    pushSent?: boolean;
    warning?: string;
    message?: {
      type: 'flex';
      altText: string;
      contents: Record<string, unknown>;
    };
  };

  onMount(async () => {
    if (!PUBLIC_LIFF_ID) {
      error = 'PUBLIC_LIFF_ID is not configured.';
      isLoading = false;
      return;
    }

    try {
      await liff.init({ liffId: PUBLIC_LIFF_ID });

      if (!liff.isInClient()) throw new Error('กรุณาเปิดในแอป LINE');

      const profile = await liff.getProfile();
      const context = liff.getContext();
      const token = liff.getAccessToken();

      if (context?.type !== 'group') throw new Error('ต้องใช้ในกลุ่มเท่านั้น');
      if (!token) throw new Error('ไม่สามารถดึง Token ได้');

      groupId = context.groupId!;
      displayName = profile.displayName;
      liffAccessToken = token;
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
    } finally {
      isLoading = false;
    }
  });

  async function handleSubmit() {
    const amountValue = Number(totalAmount);

    if (!billTitle || !Number.isFinite(amountValue) || amountValue <= 0) {
      alert('กรุณากรอกข้อมูลให้ครบถ้วน');
      return;
    }
    if (!liffAccessToken) {
      error = 'ไม่พบ LIFF Token (ต้องเปิดผ่านแอป LINE)';
      return;
    }

    isSubmitting = true;
    error = null;

    try {
      const res = await fetch('/api/create-bill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${liffAccessToken}`
        },
        body: JSON.stringify({
          title: billTitle,
          amount: amountValue,
          groupId,
          creatorName: displayName
        })
      });

      if (!res.ok) {
        let errMsg = 'ไม่สามารถสร้างบิลได้';
        try {
          errMsg = (await res.json()).error ?? errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      const payload: CreateBillResponse = await res.json();

      if (!payload?.pushSent && payload?.message) {
        try {
          await liff.sendMessages([payload.message]);
        } catch (e: any) {
          console.error('LIFF sendMessages error:', e?.message ?? e);
          const fallbackText = `🧾 บิลใหม่จาก ${displayName}\n${billTitle}\nยอดรวม ${amountValue.toFixed(2)} บาท`; // eslint-disable-line quotes
          try {
            await liff.sendMessages([{ type: 'text', text: fallbackText }]);
            alert('ส่งบิลในรูปแบบข้อความธรรมดาแทน เนื่องจากส่ง Flex ไม่สำเร็จ');
          } catch (fallbackErr: any) {
            console.error('LIFF fallback send error:', fallbackErr?.message ?? fallbackErr);
            throw new Error('สร้างบิลแล้วแต่ส่งข้อความเข้าแชทไม่สำเร็จ ลองใหม่อีกครั้งครับ');
          }
        }
      }

      if (payload?.warning) {
        alert(payload.warning);
      }

      liff.closeWindow();
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
      isSubmitting = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-gray-100">
  <div class="m-4 w-full max-w-md rounded-lg bg-white p-6 shadow-md">
    {#if isLoading}
      <p class="text-center text-lg font-semibold">กำลังโหลดข้อมูล AKizz...</p>
    {:else if error}
      <div class="text-center text-red-600">
        <h2 class="text-xl font-bold">เกิดข้อผิดพลาด</h2>
        <p>{error}</p>
      </div>
    {:else}
      <h1 class="mb-4 text-center text-2xl font-bold text-gray-800">สร้างบิลใหม่ (AKizz)</h1>
      <p class="mb-4 text-center text-sm text-gray-600">
        สร้างโดย: <strong>{displayName}</strong>
      </p>

      <form class="space-y-4" on:submit|preventDefault={handleSubmit}>
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

        <button
          type="submit"
          class={`w-full rounded-md border border-transparent px-4 py-2 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
            isSubmitting ? 'cursor-not-allowed bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'
          }`}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'กำลังสร้าง...' : '✅ สร้างบิลและส่งเข้ากลุ่ม'}
        </button>
      </form>
    {/if}
  </div>
</div>
