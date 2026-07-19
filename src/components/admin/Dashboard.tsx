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
} from 'lucide-react';
import {
  listConversations,
  listAgents,
  getAiUsage,
  type AdminConversation,
  type AgentRow,
  type LiveVisitor,
} from '../../lib/adminApi';

export type ManageSection = 'agents' | 'kb' | 'canned' | 'triggers' | 'settings';

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
    <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${tones[tone]}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-gray-800 leading-tight tabular-nums">{value}</p>
        <p className="text-xs text-gray-500 truncate">{label}</p>
      </div>
    </div>
  );
}

const MANAGE_LINKS: { id: ManageSection; label: string; icon: React.ReactNode }[] = [
  { id: 'agents', label: 'Agents & users', icon: <Users2 className="w-4 h-4" /> },
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
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-gray-50">
      <div>
        <h1 className="text-xl font-bold text-gray-800">Welcome back, {agentName.split(' ')[0]}</h1>
        <p className="text-sm text-gray-500">Here's what's happening across your inbox.</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Inbox className="w-5 h-5" />} label="Open conversations" value={open} tone="blue" />
        <StatCard icon={<AlertTriangle className="w-5 h-5" />} label="Needs a human" value={needsHuman} tone="amber" />
        <StatCard icon={<Users className="w-5 h-5" />} label="Visitors online now" value={visitorsOnline} tone="green" />
        <StatCard icon={<CheckCircle2 className="w-5 h-5" />} label="Resolved" value={resolved} tone="gray" />
        <StatCard icon={<MessageSquare className="w-5 h-5" />} label="Pending" value={pending} tone="gray" />
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
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center px-4 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">Recent conversations</h2>
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
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="font-semibold text-gray-800">Manage</h2>
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
