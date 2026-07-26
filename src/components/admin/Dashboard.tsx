import { useEffect, useState } from 'react';
import {
  MessageSquare,
  Users,
  AlertTriangle,
  CheckCircle2,
  Bot,
  UserCheck,
  Inbox,
  ChevronRight,
  Users2,
  BookOpen,
  MessageSquareText,
  Zap,
  Settings,
  Globe2,
  MousePointerClick,
} from 'lucide-react';
import {
  listConversations,
  listAgents,
  getAiUsage,
  conversationOrigin,
  type AdminConversation,
  type AgentRow,
  type LiveVisitor,
} from '../../lib/adminApi';

export type ManageSection = 'agents' | 'sites' | 'quick-actions' | 'kb' | 'canned' | 'triggers' | 'settings';

interface Props {
  agentName: string;
  role: 'admin' | 'agent';
  presence: LiveVisitor[];
  reloadNonce: number;
  onOpenConversation: (id: string) => void;
  onNavigate: (s: 'chats' | 'visitors' | ManageSection) => void;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function StatCard({
  icon,
  label,
  value,
  tone = 'gray',
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone?: 'gray' | 'blue' | 'amber' | 'green' | 'violet';
}) {
  const tones: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-600',
    blue: 'bg-blue-100 text-blue-700',
    amber: 'bg-amber-100 text-amber-700',
    green: 'bg-green-100 text-green-700',
    violet: 'bg-violet-100 text-violet-700',
  };
  return (
    <div className="bg-white rounded-3xl p-4 shadow-sm border border-gray-100/80 flex items-center gap-3 hover:shadow-md hover:-translate-y-0.5 transition">
      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${tones[tone]}`}>{icon}</div>
      <div className="min-w-0">
        <p className="font-display text-3xl text-gray-800 leading-none tabular-nums">{value}</p>
        <p className="text-xs text-gray-500 truncate mt-1">{label}</p>
      </div>
    </div>
  );
}

const MANAGE_LINKS: { id: ManageSection; label: string; icon: React.ReactNode }[] = [
  { id: 'agents', label: 'Agents & users', icon: <Users2 className="w-4 h-4" /> },
  { id: 'sites', label: 'Sites', icon: <Globe2 className="w-4 h-4" /> },
  { id: 'quick-actions', label: 'Quick actions', icon: <MousePointerClick className="w-4 h-4" /> },
  { id: 'kb', label: 'Knowledge base', icon: <BookOpen className="w-4 h-4" /> },
  { id: 'canned', label: 'Canned responses', icon: <MessageSquareText className="w-4 h-4" /> },
  { id: 'triggers', label: 'Triggers', icon: <Zap className="w-4 h-4" /> },
  { id: 'settings', label: 'Settings & AI', icon: <Settings className="w-4 h-4" /> },
];

export function Dashboard({ agentName, role, presence, reloadNonce, onOpenConversation, onNavigate }: Props) {
  const [conversations, setConversations] = useState<AdminConversation[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [ai, setAi] = useState<{ replies: number; input_tokens: number; output_tokens: number } | null>(null);

  useEffect(() => {
    listConversations().then(setConversations).catch(() => undefined);
    if (role === 'admin') {
      listAgents().then(setAgents).catch(() => undefined);
      getAiUsage().then(setAi).catch(() => undefined);
    }
  }, [role, reloadNonce]);

  const open = conversations.filter((c) => c.status === 'open').length;
  const pending = conversations.filter((c) => c.status === 'pending').length;
  const resolved = conversations.filter((c) => c.status === 'resolved').length;
  const needsHuman = conversations.filter((c) => c.needs_human).length;
  const visitorsOnline = presence.filter((v) => v.online).length;
  const agentsOnline = agents.filter((a) => a.is_online).length;
  const recent = [...conversations]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6);

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-canvas">
      {/* Greeting hero */}
      <div
        className="relative overflow-hidden rounded-3xl p-6 sm:p-7 text-white shadow-md"
        style={{ background: 'linear-gradient(135deg, #c67139 0%, #b2622d 50%, #8c491a 100%)' }}
      >
        <div className="absolute -right-8 -top-10 w-44 h-44 rounded-full bg-white/10" />
        <div className="absolute -right-16 top-10 w-40 h-40 rounded-full bg-white/10" />
        <div className="relative">
          <h1 className="font-display text-3xl sm:text-4xl">
            Hey {agentName.split(' ')[0]} 👋
          </h1>
          <p className="text-white/85 text-sm mt-1">Here's what's happening across your inbox today.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-3 py-1 text-sm font-semibold">
              <Inbox className="w-4 h-4" /> {open} open
            </span>
            <span className="inline-flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-3 py-1 text-sm font-semibold">
              <Users className="w-4 h-4" /> {visitorsOnline} online now
            </span>
            {needsHuman > 0 && (
              <span className="inline-flex items-center gap-1.5 bg-amber-400/90 text-amber-950 rounded-full px-3 py-1 text-sm font-semibold">
                <AlertTriangle className="w-4 h-4" /> {needsHuman} need a human
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard icon={<MessageSquare className="w-5 h-5" />} label="Total conversations" value={conversations.length} tone="blue" />
        <StatCard icon={<Inbox className="w-5 h-5" />} label="Pending" value={pending} tone="amber" />
        <StatCard icon={<CheckCircle2 className="w-5 h-5" />} label="Resolved" value={resolved} tone="green" />
        {role === 'admin' && (
          <StatCard icon={<UserCheck className="w-5 h-5" />} label="Agents online" value={`${agentsOnline}/${agents.length}`} tone="green" />
        )}
        {role === 'admin' && (
          <StatCard icon={<Bot className="w-5 h-5" />} label="AI replies (month)" value={ai?.replies ?? 0} tone="violet" />
        )}
        {role === 'admin' && (
          <StatCard
            icon={<Bot className="w-5 h-5" />}
            label="AI tokens (month)"
            value={ai ? (ai.input_tokens + ai.output_tokens).toLocaleString() : 0}
            tone="violet"
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent conversations */}
        <div className="lg:col-span-2 bg-white rounded-3xl shadow-sm border border-gray-100/80 overflow-hidden">
          <div className="flex items-center px-5 py-3.5 border-b border-gray-100">
            <h2 className="font-bold text-gray-800">Recent conversations</h2>
            <button onClick={() => onNavigate('chats')} className="ml-auto text-sm text-blue-600 hover:underline">
              View all
            </button>
          </div>
          {recent.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-400">No conversations yet</p>
          ) : (
            <ul className="divide-y divide-gray-50">
              {recent.map((c) => {
                const name = c.visitor_name || c.visitor_email || 'Anonymous visitor';
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => onOpenConversation(c.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
                    >
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white flex items-center justify-center text-sm font-semibold shrink-0">
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-800 truncate">{name}</span>
                          {(() => {
                            const src = conversationOrigin(c.metadata);
                            if (!src) return null;
                            return <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0 bg-gray-100 text-gray-600">{src}</span>;
                          })()}
                          {c.needs_human && (
                            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 rounded">needs human</span>
                          )}
                          <span className="ml-auto text-xs text-gray-400 shrink-0">{timeAgo(c.updated_at)}</span>
                        </div>
                        <p className="text-sm text-gray-500 truncate">{c.last_message ?? 'No messages yet'}</p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Quick management (admin) */}
        {role === 'admin' && (
          <div className="bg-white rounded-3xl shadow-sm border border-gray-100/80 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100">
              <h2 className="font-bold text-gray-800">Manage</h2>
            </div>
            <ul className="divide-y divide-gray-50">
              {MANAGE_LINKS.map((l) => (
                <li key={l.id}>
                  <button
                    onClick={() => onNavigate(l.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
                  >
                    <span className="text-gray-500">{l.icon}</span>
                    <span className="flex-1 font-medium text-gray-800">{l.label}</span>
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
