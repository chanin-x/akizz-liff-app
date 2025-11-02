import type { FlexMessage } from '@line/bot-sdk';

type BillFlexInput = {
  billId: string;
  title: string;
  amount: number;
  creatorName?: string | null;
};

export function createBillFlexMessage({
  billId,
  title,
  amount,
  creatorName
}: BillFlexInput): FlexMessage {
  return {
    type: 'flex',
    altText: `บิลใหม่: ${title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🧾 บิลใหม่!', weight: 'bold', color: '#1DB446', size: 'lg' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: title, size: 'xl', weight: 'bold', wrap: true },
          { type: 'text', text: `ยอดรวม ${amount.toFixed(2)} บาท`, size: 'lg' },
          {
            type: 'text',
            text: `สร้างโดย: ${creatorName && creatorName.trim() ? creatorName : '-'}`,
            size: 'sm',
            color: '#888888',
            margin: 'md'
          },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: 'คนที่ยังไม่จ่าย:', margin: 'lg', weight: 'bold' },
          { type: 'text', text: '(ยังไม่มีคนเข้าร่วมหาร)', color: '#888888' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            action: { type: 'postback', label: '✅ ฉันจ่ายแล้ว', data: `action=mark_paid&bill_id=${billId}` },
            style: 'primary',
            height: 'sm'
          }
        ]
      }
    }
  };
}
