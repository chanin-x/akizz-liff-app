<script lang="ts">
  import { onMount } from 'svelte';
  import liff from '@line/liff';
  import { PUBLIC_LIFF_ID } from '$env/static/public'; // ✅ ใช้ PUBLIC_

  let isLoading = true;
  let isSubmitting = false;
  let error: string | null = null;

  let groupId = '';
  let displayName = '';
  let liffAccessToken = '';

  let billTitle = '';
  let totalAmount: number | null = null;

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
    if (!billTitle || !totalAmount || totalAmount <= 0) {
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
          'Authorization': `Bearer ${liffAccessToken}`
        },
        body: JSON.stringify({
          title: billTitle,
          amount: totalAmount,
          groupId,
          creatorName: displayName
        })
      });

      if (!res.ok) {
        // กันกรณี 500 ที่ body ไม่ใช่ JSON
        let errMsg = 'ไม่สามารถสร้างบิลได้';
        try { errMsg = (await res.json()).error ?? errMsg; } catch {}
        throw new Error(errMsg);
      }

      liff.closeWindow();
    } catch (e: any) {
      error = e?.message ?? 'เกิดข้อผิดพลาด';
      isSubmitting = false;
    }
  }
</script>
