import { useEffect, useState } from 'react';
import {
  Clock,
  Eye,
  Globe,
  Link2,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Smartphone,
  X,
} from 'lucide-react';
import {
  listVisitorIps,
  getVisitorPerson,
  visitorOrigin,
  type LiveVisitor,
  type PersonProfile,
  type VisitorIp,
} from '../../lib/adminApi';
import { VisitorAvatar } from './VisitorAvatar';
import {
  CrossSitePersonBlock,
  InfoRow,
  IpHistoryBlock,
  Metric,
  PageHistoryBlock,
  VerifiedContextCard,
  deviceLabel,
  duration,
} from './visitorInfo';


/**
 * Live Visitors detail drawer — the same visitor card the conversation sidebar
 * shows (verified context, geo/IP/device rows, IP history, cross-site identity,
 * page timeline), available for anyone on the site with no chat started. Live
 * view and proactive chat are one click away from here.
 */
export function VisitorDetail({
  visitor,
  magicBrowse,
  onWatch,
  onStartChat,
  onOpenConversation,
  onClose,
}: {
  visitor: LiveVisitor;
  magicBrowse: boolean;
  onWatch: (visitorId: string) => void;
  onStartChat: (visitor: LiveVisitor) => void;
  onOpenConversation?: (conversationId: string) => void;
  onClose: () => void;
}) {
  const [ips, setIps] = useState<VisitorIp[]>([]);
  const [person, setPerson] = useState<PersonProfile | null>(null);
  const [tab, setTab] = useState<'info' | 'activity'>('info');

  useEffect(() => {
    let cancelled = false;
    setIps([]);
    setPerson(null);
    listVisitorIps(visitor.visitorId)
      .then((r) => !cancelled && setIps(r))
      .catch(() => undefined);
    getVisitorPerson(visitor.visitorId)
      .then((p) => !cancelled && setPerson(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [visitor.visitorId]);

  const name = visitor.name || visitor.email || 'Anonymous visitor';
  const geoText = visitor.geo
    ? [visitor.geo.city, visitor.geo.region, visitor.geo.country].filter(Boolean).join(', ')
    : '';
  const src = visitorOrigin(visitor);
  const utm = Object.entries(visitor.utm ?? {});

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Visitor details">
      <div className="absolute inset-0 bg-stone-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative w-full sm:w-96 max-w-full bg-white shadow-2xl flex flex-col animate-pop-in">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <VisitorAvatar email={visitor.email} name={name} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-gray-800 truncate">{name}</span>
              <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold bg-gray-100 text-gray-600">
                {src}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
              {visitor.online ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Online now
                </>
              ) : (
                'Offline'
              )}
              · {visitor.returning ? 'returning' : 'new'} · {duration(visitor.timeOnSite)} on site
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Actions — live view + chat, no conversation required */}
        <div className="px-4 py-3 space-y-2 border-b border-gray-100">
          {magicBrowse ? (
            <button
              onClick={() => onWatch(visitor.visitorId)}
              disabled={!visitor.online}
              className={`w-full flex items-center gap-2.5 rounded-2xl px-4 py-3 text-left transition ${
                visitor.online
                  ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              <Eye className="w-5 h-5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Watch live session</span>
                <span className={`block text-[11px] ${visitor.online ? 'text-white/80' : 'text-gray-400'}`}>
                  {visitor.online ? 'See their screen in real time' : 'Available while the visitor is online'}
                </span>
              </span>
              {visitor.online && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />}
            </button>
          ) : (
            <p className="rounded-2xl bg-gray-50 px-4 py-3 text-[11px] text-gray-500">
              Live view is off. Enable “Live session replay” in Settings &amp; AI to watch visitor screens.
            </p>
          )}
          {visitor.conversationId ? (
            <button
              onClick={() => onOpenConversation?.(visitor.conversationId!)}
              disabled={!onOpenConversation}
              className="w-full flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition"
            >
              <MessageSquare className="w-4 h-4" /> Open conversation
            </button>
          ) : (
            <button
              onClick={() => onStartChat(visitor)}
              className="w-full flex items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-100 transition"
            >
              <MessageSquarePlus className="w-4 h-4" /> Start a chat
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 text-sm">
          {(['info', 'activity'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 font-medium capitalize ${
                tab === t ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 text-sm">
          {tab === 'info' && (
            <dl className="space-y-2.5">
              {visitor.context && <VerifiedContextCard context={visitor.context} />}
              <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="Location" value={geoText || 'Unknown'} />
              <InfoRow
                icon={<span className="font-mono text-[10px]">IP</span>}
                label="IP address"
                value={visitor.ip || 'Unknown'}
                mono
              />
              {visitor.geo?.isp && <InfoRow label="ISP" value={visitor.geo.isp} />}
              {visitor.email && <InfoRow label="Email" value={visitor.email} truncate />}
              <InfoRow
                icon={visitor.device === 'mobile' ? <Smartphone className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
                label="Device"
                value={visitor.userAgent ? deviceLabel(visitor.userAgent) : visitor.device}
              />
              {visitor.screen && <InfoRow label="Screen" value={`${visitor.screen.w}×${visitor.screen.h}`} />}
              {visitor.language && <InfoRow label="Language" value={visitor.language} />}
              {visitor.timezone && (
                <InfoRow icon={<Clock className="w-3.5 h-3.5" />} label="Timezone" value={visitor.timezone} />
              )}
              {visitor.referrer && <InfoRow label="Referrer" value={visitor.referrer} truncate />}
              <InfoRow
                icon={<Link2 className="w-3.5 h-3.5" />}
                label="Current page"
                value={visitor.url || 'Unknown'}
                truncate
              />
              {utm.length > 0 && (
                <>
                  <div className="pt-1 mt-1 border-t border-gray-100 text-[11px] font-bold tracking-wide text-gray-400">
                    CAMPAIGN
                  </div>
                  {utm.map(([k, v]) => (
                    <InfoRow key={k} label={k.replace(/^utm_/, '')} value={v} />
                  ))}
                </>
              )}
              <InfoRow label="Time on site" value={duration(visitor.timeOnSite)} />
              <InfoRow label="Pages viewed" value={String(visitor.pagesViewed)} />
              <InfoRow label="Visitor ID" value={visitor.visitorId} mono truncate />
              <IpHistoryBlock ips={ips} />
              <CrossSitePersonBlock person={person} onOpenConversation={onOpenConversation} />
            </dl>
          )}

          {tab === 'activity' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Status" value={visitor.online ? 'Online' : 'Offline'} good={visitor.online} />
                <Metric label="Time on site" value={duration(visitor.timeOnSite)} />
                <Metric label="Visitor" value={visitor.returning ? 'Returning' : 'New'} />
                <Metric label="Pages viewed" value={String(visitor.pagesViewed)} />
              </div>
              <PageHistoryBlock pages={visitor.pages} emptyText="No page history yet." />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
