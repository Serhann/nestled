import type { ReactNode } from 'react';

export type Tone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

const tones: Record<Tone, string> = {
  gray: 'bg-gray-100 text-gray-600',
  blue: 'bg-blue-100 text-blue-700',
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-600',
  violet: 'bg-violet-100 text-violet-700',
};

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Conversation status → tone, in one place so the inbox and reports agree. */
export function statusTone(status: string): Tone {
  return status === 'open' ? 'blue' : status === 'pending' ? 'amber' : 'green';
}
