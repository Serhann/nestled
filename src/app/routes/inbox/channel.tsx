import { Globe, Instagram, Mail, MessageCircle, MessageSquare } from 'lucide-react';
import type { Channel } from '../../../lib/api/types';

/**
 * How a channel looks and what it is called, in one place.
 *
 * The badge appears on conversation rows, in the thread header and next to the
 * composer, and those three have to agree — an agent scanning a mixed inbox is using
 * the icon to decide how to read what follows. A reply that will be an SMS costs
 * money per segment and cannot be taken back; one that will be an email will be read
 * in an hour, not a second. Same words, different job.
 */

const META: Record<Channel, { label: string; icon: typeof Mail; tone: string }> = {
  widget: { label: 'Website', icon: Globe, tone: 'bg-blue-50 text-blue-700' },
  email: { label: 'Email', icon: Mail, tone: 'bg-amber-50 text-amber-800' },
  sms: { label: 'SMS', icon: MessageSquare, tone: 'bg-green-50 text-green-800' },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, tone: 'bg-emerald-50 text-emerald-800' },
  instagram: { label: 'Instagram', icon: Instagram, tone: 'bg-pink-50 text-pink-800' },
};

export function channelLabel(channel: Channel): string {
  return META[channel]?.label ?? channel;
}

export function ChannelBadge({
  channel,
  address,
  size = 'sm',
}: {
  channel: Channel;
  /** Shown alongside the label where there is room — it is who the agent is talking to. */
  address?: string | null;
  size?: 'xs' | 'sm';
}) {
  // The widget is the overwhelming majority of conversations, so badging it would be
  // noise on almost every row. It gets a badge only where the address line makes the
  // set explicit — see the thread header.
  const meta = META[channel] ?? META.widget;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${meta.tone} ${
        size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      }`}
      title={address ? `${meta.label} · ${address}` : meta.label}
    >
      <Icon className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden />
      {meta.label}
      {address && size === 'sm' && (
        <span className="font-normal opacity-70 max-w-[14rem] truncate">· {address}</span>
      )}
    </span>
  );
}
