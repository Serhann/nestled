import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MessageSquare,
  Users,
  User,
  ArrowLeft,
  LogOut,
  Bell,
  BellOff,
  Volume2,
  VolumeX,
  LayoutDashboard,
  Users2,
  MessageSquareText,
  Settings,
  Zap,
  BookOpen,
  ChevronRight,
  Globe2,
  MousePointerClick,
  KeyRound,
} from 'lucide-react';
import { LoginPanel } from './admin/LoginPanel';
import { ConversationsList } from './admin/ConversationsList';
import { ChatPanel } from './admin/ChatPanel';
import { LiveVisitors } from './admin/LiveVisitors';
import { AgentsManager } from './admin/AgentsManager';
import { CannedManager } from './admin/CannedManager';
import { SettingsPanel } from './admin/SettingsPanel';
import { TriggersPanel } from './admin/TriggersPanel';
import { MagicBrowse, type ReplayFeed } from './admin/MagicBrowse';
import { KnowledgeBasePanel } from './admin/KnowledgeBasePanel';
import { SitesManager } from './admin/SitesManager';
import { QuickActionsManager } from './admin/QuickActionsManager';
import { Dashboard } from './admin/Dashboard';
import {
  tokens,
  logout,
  changePassword,
  openAgentWS,
  getPresence,
  apiBase,
  type AdminAgent,
  type AdminMessage,
  type LiveVisitor,
  type AgentSocket,
} from '../lib/adminApi';
import { enablePush, disablePush, isPushSupported } from '../lib/push';
import { playChime } from '../lib/sound';

type Section =
  | 'dashboard'
  | 'chats'
  | 'visitors'
  | 'agents'
  | 'sites'
  | 'quick-actions'
  | 'kb'
  | 'canned'
  | 'triggers'
  | 'settings'
  | 'account';

interface NavItem {
  id: Section;
  label: string;
  icon: typeof MessageSquare;
  adminOnly?: boolean;
  group: 'main' | 'manage';
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'main' },
  { id: 'chats', label: 'Chats', icon: MessageSquare, group: 'main' },
  { id: 'visitors', label: 'Live visitors', icon: Users, group: 'main' },
  { id: 'agents', label: 'Agents & users', icon: Users2, adminOnly: true, group: 'manage' },
  { id: 'sites', label: 'Sites', icon: Globe2, adminOnly: true, group: 'manage' },
  { id: 'quick-actions', label: 'Quick actions', icon: MousePointerClick, adminOnly: true, group: 'manage' },
  { id: 'kb', label: 'Knowledge base', icon: BookOpen, adminOnly: true, group: 'manage' },
  { id: 'canned', label: 'Canned responses', icon: MessageSquareText, adminOnly: true, group: 'manage' },
  { id: 'triggers', label: 'Triggers', icon: Zap, adminOnly: true, group: 'manage' },
  { id: 'settings', label: 'Settings & AI', icon: Settings, adminOnly: true, group: 'manage' },
];

export function AdminPanel() {
  const [agent, setAgent] = useState<AdminAgent | null>(() => tokens.agent());
  const [section, setSection] = useState<Section>('dashboard');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listNonce, setListNonce] = useState(0); // bump → lists refetch
  const [chatRefresh, setChatRefresh] = useState(0); // bump → open ChatPanel refetches
  const [presence, setPresence] = useState<LiveVisitor[]>([]);
  const [liveMessage, setLiveMessage] = useState<{ conversationId: string; message: AdminMessage } | null>(null);
  const [typing, setTyping] = useState<{ conversationId: string; isTyping: boolean } | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [magicBrowse, setMagicBrowse] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const [replayFeed, setReplayFeed] = useState<ReplayFeed | null>(null);

  const [sound, setSound] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem('jetchat_admin_sound') !== '0');
  const socketRef = useRef<AgentSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const replayNonce = useRef(0);

  // Agent realtime socket (single connection for the whole panel).
  useEffect(() => {
    if (!agent) return;
    const sock = openAgentWS({
      onConversationNew: () => setListNonce((n) => n + 1),
      onConversationUpdated: (conversationId) => {
        setListNonce((n) => n + 1);
        // If the updated conversation is the one open in ChatPanel, nudge it to
        // refetch (e.g. live order-status / verified-context change).
        if (conversationId && conversationId === selectedRef.current) {
          setChatRefresh((n) => n + 1);
        }
      },
      onMessage: (conversationId, message) => {
        setListNonce((n) => n + 1);
        // Audible ding on any incoming visitor message (respects the mute rail).
        if (message.sender_type === 'visitor' && soundRef.current) playChime();
        if (conversationId === selectedRef.current) {
          setLiveMessage({ conversationId, message });
        } else if (message.sender_type === 'visitor') {
          setUnread((u) => ({ ...u, [conversationId]: (u[conversationId] ?? 0) + 1 }));
        }
      },
      onTyping: (conversationId, isTyping) => setTyping({ conversationId, isTyping }),
      onPresence: (visitors) => setPresence(visitors),
      onReplay: (visitorId, events, reset) => {
        replayNonce.current += 1;
        setReplayFeed({ visitorId, events, reset, nonce: replayNonce.current });
      },
    });
    socketRef.current = sock;
    return () => sock.close();
  }, [agent]);

  // Seed + refresh the live-visitor board. The agent WS only pushes
  // presence:list when presence *changes*, so a fresh login (or a visitor who
  // arrived before we connected) would otherwise show an empty board. A REST
  // snapshot on mount + a light poll keeps it reliable; WS still gives instant
  // updates in between.
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    const load = () => getPresence().then((v) => !cancelled && setPresence(v)).catch(() => undefined);
    load();
    const interval = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agent]);

  // Is live session replay enabled for this site?
  useEffect(() => {
    if (!agent) return;
    fetch(`${apiBase()}/api/widget-config`)
      .then((r) => r.json())
      .then((d) => setMagicBrowse(Boolean(d?.settings?.magic_browse_enabled)))
      .catch(() => undefined);
  }, [agent]);

  const startWatch = (visitorId: string) => {
    setWatching(visitorId);
    setReplayFeed(null);
    socketRef.current?.watch(visitorId);
  };
  const stopWatch = () => {
    socketRef.current?.watch(null);
    setWatching(null);
    setReplayFeed(null);
  };

  // Tell the server which conversation we're viewing (suppresses its push).
  useEffect(() => {
    socketRef.current?.view(selectedId);
    if (selectedId) setUnread((u) => ({ ...u, [selectedId]: 0 }));
  }, [selectedId]);

  useEffect(() => {
    if (isPushSupported() && Notification.permission === 'granted') setPushState('on');
    else setPushState('off');
  }, []);

  const handleLogin = (a: AdminAgent) => setAgent(a);
  const handleLogout = useCallback(async () => {
    await disablePush({ apiBase: apiBase(), getAccessToken: tokens.access }).catch(() => undefined);
    await logout();
    setAgent(null);
    setSelectedId(null);
  }, []);

  const toggleSound = () => {
    setSound((s) => {
      const next = !s;
      localStorage.setItem('jetchat_admin_sound', next ? '1' : '0');
      if (next) playChime(); // confirm + unlock the audio context on enable
      return next;
    });
  };

  const togglePush = async () => {
    if (pushState === 'on') {
      await disablePush({ apiBase: apiBase(), getAccessToken: tokens.access });
      setPushState('off');
      return;
    }
    const result = await enablePush({ apiBase: apiBase(), getAccessToken: tokens.access });
    setPushState(result.ok ? 'on' : 'off');
    if (!result.ok && result.reason === 'denied') {
      alert('Notifications are blocked. Enable them in your browser settings.');
    }
  };

  const go = (s: Section) => {
    setSection(s);
    if (s !== 'chats') setSelectedId(null);
  };

  const startChatWith = (conversationId: string) => {
    setSelectedId(conversationId);
    setSection('chats');
    setListNonce((n) => n + 1);
  };

  if (!agent) return <LoginPanel onLogin={handleLogin} />;

  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
  const visibleNav = NAV.filter((n) => !n.adminOnly || agent.role === 'admin');
  const current = NAV.find((n) => n.id === section);
  const sectionTitle = section === 'account' ? 'Account' : current?.label ?? 'Dashboard';

  const renderContent = () => {
    switch (section) {
      case 'dashboard':
        return (
          <Dashboard
            agentName={agent.name}
            role={agent.role}
            presence={presence}
            reloadNonce={listNonce}
            onOpenConversation={startChatWith}
            onNavigate={(s) => go(s as Section)}
          />
        );
      case 'chats':
        return (
          <div className="flex-1 flex overflow-hidden">
            <div className={`${selectedId ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 md:border-r border-gray-200 bg-white`}>
              <ConversationsList
                selectedId={selectedId}
                onSelect={setSelectedId}
                reloadNonce={listNonce}
                unread={unread}
                presence={presence}
              />
            </div>
            <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-white min-w-0`}>
              {selectedId ? (
                <ChatPanel
                  key={selectedId}
                  conversationId={selectedId}
                  meId={agent.id}
                  liveMessage={liveMessage}
                  typing={typing}
                  presence={presence}
                  magicBrowse={magicBrowse}
                  onWatch={startWatch}
                  onOpenConversation={setSelectedId}
                  refreshSignal={chatRefresh}
                  onChanged={() => setListNonce((n) => n + 1)}
                />
              ) : (
                <div className="hidden md:flex flex-1 items-center justify-center text-gray-400">
                  Select a conversation
                </div>
              )}
            </div>
          </div>
        );
      case 'visitors':
        return <LiveVisitors visitors={presence} onStarted={startChatWith} magicBrowse={magicBrowse} onWatch={startWatch} />;
      case 'agents':
        return <AgentsManager meId={agent.id} onBack={() => go('dashboard')} />;
      case 'sites':
        return <SitesManager onBack={() => go('dashboard')} />;
      case 'quick-actions':
        return <QuickActionsManager onBack={() => go('dashboard')} />;
      case 'canned':
        return <CannedManager onBack={() => go('dashboard')} />;
      case 'settings':
        return <SettingsPanel onBack={() => go('dashboard')} />;
      case 'triggers':
        return <TriggersPanel onBack={() => go('dashboard')} />;
      case 'kb':
        return <KnowledgeBasePanel onBack={() => go('dashboard')} />;
      case 'account':
        return (
          <AccountView
            agent={agent}
            pushState={pushState}
            onTogglePush={togglePush}
            onLogout={handleLogout}
            onNavigate={go}
          />
        );
    }
  };

  const showMobileHeader = !(section === 'chats' && selectedId);

  return (
    <div className="flex h-[100dvh] bg-canvas">
      {/* ── Desktop icon rail (Organic design) ──────────────────────────── */}
      <aside className="hidden md:flex md:flex-col items-center w-[70px] bg-gray-900 shrink-0 py-3 gap-1">
        <div className="w-10 h-10 rounded-2xl bg-blue-600 flex items-center justify-center mb-3 shadow-md" title="JetChat">
          <MessageSquare className="w-5 h-5 text-white" />
        </div>
        {visibleNav
          .filter((n) => n.group === 'main')
          .map((n) => (
            <RailButton key={n.id} item={n} active={section === n.id} onGo={go} badge={n.id === 'chats' ? totalUnread : 0} />
          ))}
        {visibleNav.some((n) => n.group === 'manage') && <div className="w-8 h-px bg-white/10 my-2" />}
        {visibleNav
          .filter((n) => n.group === 'manage')
          .map((n) => (
            <RailButton key={n.id} item={n} active={section === n.id} onGo={go} badge={0} />
          ))}
        <div className="flex-1" />
        <button
          onClick={toggleSound}
          title={sound ? 'Sound on — new messages ding' : 'Sound off'}
          className="w-11 h-11 rounded-2xl flex items-center justify-center text-white/50 hover:bg-white/10 hover:text-white/80 transition"
        >
          {sound ? <Volume2 className="w-5 h-5 text-blue-400" /> : <VolumeX className="w-5 h-5" />}
        </button>
        <button
          onClick={togglePush}
          disabled={!isPushSupported()}
          title={pushState === 'on' ? 'Notifications on' : 'Enable notifications'}
          className="w-11 h-11 rounded-2xl flex items-center justify-center text-white/50 hover:bg-white/10 hover:text-white/80 disabled:opacity-40 transition"
        >
          {pushState === 'on' ? <Bell className="w-5 h-5 text-blue-400" /> : <BellOff className="w-5 h-5" />}
        </button>
        <button
          onClick={handleLogout}
          title="Sign out"
          className="w-11 h-11 rounded-2xl flex items-center justify-center text-white/50 hover:bg-white/10 hover:text-red-300 transition"
        >
          <LogOut className="w-5 h-5" />
        </button>
        <button onClick={() => go('account')} title={`${agent.name} · ${agent.role}`} className="relative mt-1">
          <span
            className={`w-10 h-10 rounded-full bg-green-200 text-green-800 flex items-center justify-center text-sm font-bold ${section === 'account' ? 'ring-2 ring-white' : ''}`}
          >
            {agent.name.charAt(0).toUpperCase()}
          </span>
          <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-500 border-2 border-gray-900" />
        </button>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        {showMobileHeader && (
          <header className="md:hidden flex items-center gap-3 px-4 h-14 bg-white border-b border-gray-200 shrink-0">
            <img src="/icon-192.png" alt="" className="w-8 h-8 rounded-xl shadow-sm" />
            <h1 className="font-bold text-gray-800">{sectionTitle}</h1>
            <span className="ml-auto text-sm text-gray-500 truncate max-w-[40%]">{agent.name}</span>
          </header>
        )}
        {/* Desktop content top bar (with mobile back button for chats) */}
        {section === 'chats' && selectedId && (
          <header className="md:hidden flex items-center gap-3 px-4 h-14 bg-white border-b border-gray-200 shrink-0">
            <button onClick={() => setSelectedId(null)} className="-ml-1 p-1 text-gray-600" aria-label="Back">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="font-bold text-gray-800">Conversation</h1>
          </header>
        )}

        <main className="flex-1 flex flex-col overflow-hidden">{renderContent()}</main>

        {/* Mobile bottom navigation */}
        <nav className="md:hidden flex shrink-0 bg-white border-t border-gray-200/70 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
          {(
            [
              { id: 'dashboard', label: 'Home', icon: LayoutDashboard },
              { id: 'chats', label: 'Chats', icon: MessageSquare },
              { id: 'visitors', label: 'Visitors', icon: Users },
              { id: 'account', label: 'Account', icon: User },
            ] as const
          ).map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => go(id)}
                className="relative flex-1 flex flex-col items-center gap-1 py-1 text-[11px] font-medium"
              >
                <span
                  className={`relative flex items-center justify-center w-12 h-7 rounded-full transition ${
                    active ? 'bg-blue-100 text-blue-600' : 'text-gray-400'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {id === 'chats' && totalUnread > 0 && (
                    <span className="absolute -top-0.5 right-1.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
                      {totalUnread}
                    </span>
                  )}
                </span>
                <span className={active ? 'text-blue-600 font-semibold' : 'text-gray-500'}>{label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Live session replay overlay */}
      {watching && (
        <MagicBrowse
          feed={replayFeed}
          onClose={stopWatch}
          visitor={presence.find((v) => v.visitorId === watching) ?? null}
          agentName={agent.name}
          onAssist={(payload) => socketRef.current?.assist(watching, payload)}
        />
      )}
    </div>
  );
}

function RailButton({
  item,
  active,
  onGo,
  badge,
}: {
  item: NavItem;
  active: boolean;
  onGo: (s: Section) => void;
  badge: number;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={() => onGo(item.id)}
      title={item.label}
      aria-label={item.label}
      className={`relative w-11 h-11 rounded-2xl flex items-center justify-center transition ${
        active ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/10 hover:text-white/80'
      }`}
    >
      <Icon className="w-5 h-5" />
      {badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 bg-blue-500 text-white text-[10px] font-bold rounded-full min-w-[17px] h-[17px] px-1 flex items-center justify-center border-2 border-gray-900">
          {badge}
        </span>
      )}
    </button>
  );
}

function AccountView({
  agent,
  pushState,
  onTogglePush,
  onLogout,
  onNavigate,
}: {
  agent: AdminAgent;
  pushState: 'unknown' | 'on' | 'off';
  onTogglePush: () => void;
  onLogout: () => void;
  onNavigate: (s: Section) => void;
}) {
  const manage: { id: Section; label: string; icon: typeof Users2 }[] = [
    { id: 'agents', label: 'Agents & users', icon: Users2 },
    { id: 'sites', label: 'Sites', icon: Globe2 },
    { id: 'quick-actions', label: 'Quick actions', icon: MousePointerClick },
    { id: 'kb', label: 'Knowledge base', icon: BookOpen },
    { id: 'canned', label: 'Canned responses', icon: MessageSquareText },
    { id: 'triggers', label: 'Triggers', icon: Zap },
    { id: 'settings', label: 'Settings & AI', icon: Settings },
  ];
  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-gray-50">
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <p className="text-sm text-gray-500">Signed in as</p>
        <p className="font-medium text-gray-800">{agent.name}</p>
        <p className="text-sm text-gray-500">
          {agent.email} · {agent.role}
        </p>
      </div>

      {/* Management links — mobile only (desktop has these in the sidebar). */}
      {agent.role === 'admin' && (
        <div className="md:hidden bg-white rounded-xl shadow-sm divide-y divide-gray-50">
          {manage.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => onNavigate(id)} className="w-full flex items-center gap-3 p-4 text-left">
              <Icon className="w-5 h-5 text-gray-500" />
              <span className="flex-1 font-medium text-gray-800">{label}</span>
              <ChevronRight className="w-4 h-4 text-gray-400" />
            </button>
          ))}
        </div>
      )}

      <button
        onClick={onTogglePush}
        disabled={!isPushSupported()}
        className="w-full bg-white rounded-xl p-4 shadow-sm flex items-center gap-3 text-left disabled:opacity-60"
      >
        {pushState === 'on' ? <Bell className="w-5 h-5 text-blue-600" /> : <BellOff className="w-5 h-5 text-gray-500" />}
        <div>
          <p className="font-medium text-gray-800">
            {pushState === 'on' ? 'Push notifications on' : 'Enable push notifications'}
          </p>
          <p className="text-sm text-gray-500">
            {isPushSupported() ? 'Get alerted on new chats even when the app is closed.' : 'Not supported on this device.'}
          </p>
        </div>
      </button>
      <ChangePasswordCard />

      <button onClick={onLogout} className="w-full bg-white rounded-xl p-4 shadow-sm flex items-center gap-3 text-red-600">
        <LogOut className="w-5 h-5" />
        <span className="font-medium">Sign out</span>
      </button>
    </div>
  );
}

function ChangePasswordCard() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('New password must be at least 8 characters.');
    if (next !== confirm) return setError('New passwords do not match.');
    if (next === current) return setError('New password must be different from the current one.');
    setSaving(true);
    try {
      await changePassword(current, next);
      setDone(true);
      reset();
      setOpen(false);
      setTimeout(() => setDone(false), 4000);
    } catch (err) {
      setError((err as Error).message || 'Could not change password');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-800 placeholder:text-gray-400 focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400 outline-none transition text-sm';

  if (!open) {
    return (
      <button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="w-full bg-white rounded-xl p-4 shadow-sm flex items-center gap-3 text-left"
      >
        <KeyRound className="w-5 h-5 text-gray-500" />
        <div className="flex-1">
          <p className="font-medium text-gray-800">Change password</p>
          <p className="text-sm text-gray-500">
            {done ? 'Password updated ✓' : 'Update your account password.'}
          </p>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-400" />
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <div className="flex items-center gap-3">
        <KeyRound className="w-5 h-5 text-gray-500" />
        <p className="font-medium text-gray-800">Change password</p>
      </div>
      <input
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        placeholder="Current password"
        autoComplete="current-password"
        required
        className={inputClass}
      />
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="New password (min 8 characters)"
        autoComplete="new-password"
        required
        minLength={8}
        className={inputClass}
      />
      <input
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Confirm new password"
        autoComplete="new-password"
        required
        minLength={8}
        className={inputClass}
      />
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-xl text-sm">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl font-semibold hover:bg-blue-700 active:scale-[0.98] transition disabled:opacity-50 text-sm"
        >
          {saving ? 'Saving…' : 'Update password'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="px-4 py-2.5 rounded-xl font-semibold text-gray-600 hover:bg-gray-100 transition text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
