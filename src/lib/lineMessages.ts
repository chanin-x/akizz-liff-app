import type { FlexComponent, FlexMessage } from '@line/bot-sdk';

export type BillParticipantSummary = {
  displayName?: string | null;
  share: number;
  status?: string | null;
};

export type BillBankAccount = {
  accountNumber: string;
  accountName?: string | null;
  bankName?: string | null;
};

type BillFlexInput = {
  billId: string;
  title: string;
  amount: number;
  creatorName?: string | null;
  participants?: BillParticipantSummary[];
  bankAccount?: BillBankAccount | null;
  roundingNote?: string | null;
};

function formatMoney(amount: number) {
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function buildParticipantsSection(participants: BillParticipantSummary[]): FlexComponent {
  if (!participants.length) {
    return {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '(ยังไม่มีคนเข้าร่วมหาร)',
          color: '#888888',
          size: 'sm'
        }
      ]
    };
  }

  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: participants.slice(0, 12).map((participant) => ({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: participant.displayName && participant.displayName.trim().length > 0 ? participant.displayName : 'ไม่ทราบชื่อ',
          size: 'sm',
          color: '#1F1F1F',
          wrap: true,
          flex: 4
        },
        {
          type: 'text',
          text: `${formatMoney(participant.share)} บาท`,
          size: 'sm',
          color: '#4A4A4A',
          align: 'end',
          flex: 3
        }
      ]
    }))
  };
}

function buildBankAccountSection(account: BillBankAccount | null | undefined): FlexComponent[] {
  if (!account?.accountNumber) return [];
  const lines: string[] = [];
  if (account.bankName) lines.push(account.bankName);
  if (account.accountName) lines.push(`ชื่อบัญชี: ${account.accountName}`);
  lines.push(`เลขบัญชี: ${account.accountNumber}`);

  return [
    { type: 'separator', margin: 'md' },
    {
      type: 'text',
      text: 'บัญชีสำหรับโอน',
      weight: 'bold',
      size: 'sm',
      margin: 'md'
    },
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: lines.map((line) => ({ type: 'text', text: line, size: 'sm', color: '#1F1F1F', wrap: true }))
    }
  ];
}

export function createBillFlexMessage({
  billId,
  title,
  amount,
  creatorName,
  participants = [],
  bankAccount,
  roundingNote
}: BillFlexInput): FlexMessage {
  const components: FlexComponent[] = [
    { type: 'text', text: title, size: 'xl', weight: 'bold', wrap: true },
    { type: 'text', text: `ยอดรวม ${formatMoney(amount)} บาท`, size: 'lg' },
    {
      type: 'text',
      text: `สร้างโดย: ${creatorName && creatorName.trim() ? creatorName : '-'}`,
      size: 'sm',
      color: '#888888',
      margin: 'md'
    }
  ];

  if (roundingNote) {
    components.push({ type: 'text', text: roundingNote, size: 'xs', color: '#888888', wrap: true });
  }

  components.push(
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: 'คนที่ต้องหาร', margin: 'lg', weight: 'bold', size: 'sm' },
    buildParticipantsSection(participants)
  );

  components.push(...buildBankAccountSection(bankAccount));

  return {
    type: 'flex',
    altText: `บิลใหม่: ${title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '🧾 บิลใหม่!', weight: 'bold', color: '#1DB446', size: 'lg' }]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: components
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
