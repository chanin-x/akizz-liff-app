<script lang="ts">
  import { onMount } from 'svelte';
  import liff from '@line/liff';
  import { env } from '$env/dynamic/public'; // ‼️ Import Key สาธารณะ

  // ‼️ ดึง LIFF ID จาก Environment
  const MY_LIFF_ID = env.VITE_LIFF_ID;

  // --- States ---
  let isLoading = true;
  let isSubmitting = false;
  let error: string | null = null;

  // --- LIFF Data ---
  let groupId = '';
  let displayName = '';
  let liffAccessToken = ''; // Token สำหรับยืนยันตัวตนกับ Backend

  // --- Form Data ---
  let billTitle = '';
  let totalAmount: number | null = null;
  
  onMount(async () => {
    if (!MY_LIFF_ID) {
      error = "VITE_LIFF_ID is not configured.";
      isLoading = false;
      return;
    }
    try {
      await liff.init({ liffId: MY_LIFF_ID });
      if (!liff.isInClient()) throw new Error('กรุณาเปิดในแอป LINE');

      const profile = await liff.getProfile();
      const context = liff.getContext();
      const token = liff.getAccessToken();

      if (context?.type !== 'group') throw new Error('ต้องใช้ในกลุ่มเท่านั้น');
      if (!token) throw new Error('ไม่สามารถดึงข้อมูล Token ได้');

      groupId = context.groupId;
      displayName = profile.displayName;
      liffAccessToken = token;

    } catch (e: any) {
      error = e.message;
    } finally {
      isLoading = false;
    }
  });

  // --- ฟังก์ชันส่งข้อมูล ---
  async function handleSubmit() {
    if (!billTitle || !totalAmount || totalAmount <= 0) {
      alert("กรุณากรอกข้อมูลให้ครบถ้วน");
      return;
    }

    isSubmitting = true;
    error = null;

    try {
      // ‼️ ยิง API ไปยัง Backend (ในโปรเจกต์เดียวกัน)
      const response = await fetch('/api/create-bill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ‼️ ส่ง LIFF Token ไปยืนยันตัวตน
          'Authorization': `Bearer ${liffAccessToken}`
        },
        body: JSON.stringify({
          title: billTitle,
          amount: totalAmount,
          groupId: groupId,
          creatorName: displayName
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'ไม่สามารถสร้างบิลได้');
      }

      // ถ้าสำเร็จ...
      liff.closeWindow(); // ปิดหน้าต่าง LIFF

    } catch (e: any) {
      error = e.message;
      isSubmitting = false;
    }
  }
</script>

<div class="flex items-center justify-center min-h-screen bg-gray-100">
  <div class="p-6 m-4 bg-white rounded-lg shadow-md w-full max-w-md">

    {#if isLoading}
      <p class="text-center text-lg font-semibold">กำลังโหลดข้อมูล AKizz...</p>
    
    {:else if error}
      <div class="text-center text-red-600">
        <h2 class="text-xl font-bold">เกิดข้อผิดพลาด</h2>
        <p>{error}</p>
      </div>

    {:else}
      <h1 class="text-2xl font-bold text-center mb-4 text-gray-800">
        สร้างบิลใหม่ (AKizz)
      </h1>
      <p class="text-sm text-gray-600 mb-4 text-center">
        สร้างโดย: <strong>{displayName}</strong>
      </p>
      
      <form class="space-y-4" on:submit|preventDefault={handleSubmit}>
        <div>
          <label for="title" class="block text-sm font-medium text-gray-700">
            ชื่อบิล
          </label>
          <input 
            type="text" id="title" bind:value={billTitle} required
            class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            placeholder="เช่น ค่าอาหารเย็น"
          >
        </div>
        <div>
          <label for="amount" class="block text-sm font-medium text-gray-700">
            ยอดรวม (บาท)
          </label>
          <input 
            type="number" id="amount" bind:value={totalAmount} required
            class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            placeholder="1000"
          >
        </div>

        <button 
          type="submit"
          disabled={isSubmitting}
          class="w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white
                 {isSubmitting ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'}"
        >
          {isSubmitting ? 'กำลังสร้าง...' : '✅ สร้างบิลและส่งเข้ากลุ่ม'}
        </button>
      </form>
    {/if}
  </div>
</div>