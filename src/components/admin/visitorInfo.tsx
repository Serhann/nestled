import { Globe, History, ShieldCheck } from 'lucide-react';
import {
  conversationSource,
  type PersonProfile,
  type VerifiedContext,
  type VisitorIp,
} from '../../lib/adminApi';
import { Badge } from './ui';

/**
 * Shared visitor-detail building blocks. The conversation sidebar (ChatPanel)
 * and the Live Visitors detail drawer show the same person card, so the rows,
 * the verified-context block, IP history, the cross-site identity block and the
 * page timeline all live here and are rendered by both.
 */

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Best-effort human label for a user-agent string (browser · OS). */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone|iPad|iOS/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return [browser, os].filter(Boolean).join(' · ');
}

export function InfoRow({
  icon,
  label,
  value,
  mono,
  truncate,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="flex items-center gap-1 text-gray-400 shrink-0 w-24">
        {icon}
        {label}
      </span>
      <span
        className={`text-gray-800 min-w-0 ${mono ? 'font-mono text-xs' : ''} ${truncate ? 'truncate' : 'break-words'}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2">
      <p className={`text-sm font-semibold ${good ? 'text-green-600' : 'text-gray-800'}`}>{value}</p>
      <p className="text-[11px] text-gray-500">{label}</p>
    </div>
  );
}

/** Trusted (HMAC-verified) customer + order context from the host site. */
export function VerifiedContextCard({ context }: { context: VerifiedContext }) {
  const cust = context.customer;
  const ord = context.current_order;
  const money = (t?: string | number, c?: string) => (t == null ? null : `${t}${c ? ' ' + c : ''}`);
  return (
    <div className="mb-1 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
        <p className="text-[11px] font-bold tracking-wide text-emerald-700">VERIFIED CONTEXT</p>
      </div>
      {cust && (
        <div className="mb-2 text-xs text-gray-700 space-y-0.5">
          {cust.name && <p className="font-semibold text-gray-800">{cust.name}</p>}
          {cust.email && <p className="truncate">{cust.email}</p>}
          {cust.phone && <p>{cust.phone}</p>}
          {typeof cust.orders_count === 'number' && (
            <p className="text-gray-500">{cust.orders_count} orders total</p>
          )}
        </div>
      )}
      {ord && (
        <div className="rounded-xl bg-white border border-emerald-100 p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-800">{ord.id ? `Order #${ord.id}` : 'Current order'}</span>
            {ord.status && <Badge tone="green">{ord.status}</Badge>}
          </div>
          <div className="mt-1 text-gray-600 space-y-0.5">
            {ord.restaurant && <p>{ord.restaurant}</p>}
            {ord.eta && <p>ETA {ord.eta}</p>}
            {money(ord.total, ord.currency) && <p>{money(ord.total, ord.currency)}</p>}
          </div>
        </div>
      )}
      {context.recent_orders && context.recent_orders.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-emerald-700 font-medium">
            Recent orders ({context.recent_orders.length})
          </summary>
          <ul className="mt-1 space-y-1">
            {context.recent_orders.slice(0, 10).map((o, i) => (
              <li key={o.id ?? i} className="flex items-baseline gap-2 text-gray-600">
                <span className="font-mono truncate">{o.id ? `#${o.id}` : '—'}</span>
                {o.status && <span className="text-gray-400">{o.status}</span>}
                {o.date && <span className="ml-auto text-gray-400 shrink-0">{o.date}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Every IP this visitor has connected from (across sessions / IP changes). */
export function IpHistoryBlock({ ips }: { ips: VisitorIp[] }) {
  if (ips.length === 0) return null;
  return (
    <div className="pt-1 mt-1 border-t border-gray-100">
      <p className="text-[11px] font-bold tracking-wide text-gray-400 mb-1">
        IP HISTORY{ips.length > 1 ? ` (${ips.length})` : ''}
      </p>
      <ul className="space-y-1">
        {ips.map((r) => (
          <li key={r.id} className="flex items-baseline gap-2 text-xs">
            <span className="font-mono text-gray-700 truncate">{r.ip}</span>
            <span className="text-gray-400 shrink-0 ml-auto">{new Date(r.last_seen).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The unified cross-site person behind this visitor (device fingerprint + email)
 * with their other conversations. Renders nothing unless there is more than one
 * session / site / conversation to show.
 */
export function CrossSitePersonBlock({
  person,
  excludeConversationId,
  onOpenConversation,
}: {
  person: PersonProfile | null;
  excludeConversationId?: string | null;
  onOpenConversation?: (conversationId: string) => void;
}) {
  if (!person) return null;
  const worthShowing =
    person.sites.length > 1 || person.visitor_ids.length > 1 || person.conversations.length > 1;
  if (!worthShowing) return null;
  return (
    <div className="pt-1 mt-1 border-t border-gray-100">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Globe className="w-3.5 h-3.5 text-blue-600" />
        <p className="text-[11px] font-bold tracking-wide text-blue-600">SAME PERSON — CROSS-SITE</p>
      </div>
      {person.sites.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {person.sites.map((s) => (
            <Badge key={s} tone={s === 'saas' ? 'violet' : 'amber'}>
              {conversationSource({ widget_mode: s }).label}
            </Badge>
          ))}
        </div>
      )}
      <p className="text-[11px] text-gray-400 mb-1.5">
        Matched by device fingerprint
        {person.emails.length > 0 ? ' + email' : ''} across {person.visitor_ids.length} session
        {person.visitor_ids.length === 1 ? '' : 's'}.
      </p>
      <ul className="space-y-1">
        {person.conversations
          .filter((c) => c.id !== excludeConversationId)
          .slice(0, 8)
          .map((c) => (
            <li key={c.id}>
              <button
                onClick={() => onOpenConversation?.(c.id)}
                disabled={!onOpenConversation}
                className="w-full flex items-center gap-2 text-left text-xs rounded-lg px-2 py-1.5 hover:bg-gray-50 disabled:hover:bg-transparent transition"
              >
                <Badge tone={c.mode === 'saas' ? 'violet' : 'amber'}>
                  {conversationSource({ widget_mode: c.mode ?? undefined }).label}
                </Badge>
                <span className="truncate text-gray-700 flex-1">
                  {c.visitor_name || 'Visitor'} · {c.message_count} msg
                </span>
                <span className="text-gray-400 shrink-0">{new Date(c.updated_at).toLocaleDateString()}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Live page-visit timeline, most recent first. */
export function PageHistoryBlock({
  pages,
  emptyText,
}: {
  pages: { url: string; at: number }[] | undefined;
  emptyText: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        <History className="w-3.5 h-3.5" /> Visited pages
      </p>
      {pages && pages.length > 0 ? (
        <ol className="space-y-1.5">
          {pages
            .slice()
            .reverse()
            .map((p, i) => (
              <li key={`${p.at}-${i}`} className="flex items-start gap-2 text-xs">
                <span className="text-gray-400 shrink-0 tabular-nums">{clockTime(p.at)}</span>
                <span className={`min-w-0 break-all ${i === 0 ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>
                  {p.url}
                </span>
              </li>
            ))}
        </ol>
      ) : (
        <p className="text-xs text-gray-400">{emptyText}</p>
      )}
    </div>
  );
}
