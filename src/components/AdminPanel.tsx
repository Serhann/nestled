import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Users, User, ArrowLeft, LogOut, Bell, BellOff } from 'lucide-react';
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
import { Users2, MessageSquareText, Settings, Zap, BookOpen, ChevronRight } from 'lucide-react';
import {
  tokens,
  logout,
  openAgentWS,
  apiBase,
  type AdminAgent,
  type AdminMessage,
  type LiveVisitor,
  type AgentSocket,
} from '../lib/adminApi';
import { enablePush, disablePush, isPushSupported } from '../lib/push';

type Tab = 'chats' | 'visitors' | 'account';

export function AdminPanel() {
  const [agent, setAgent] = useState<AdminAgent | null>(() => tokens.agent());
  const [tab, setTab] = useState<Tab>('chats');
  const [manage, setManage] = useState<'agents' | 'canned' | 'settings' | 'triggers' | 'kb' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listNonce, setListNonce] = useState(0); // bump → conversations list refetches
  const [presence, setPresence] = useState<LiveVisitor[]>([]);
  const [liveMessage, setLiveMessage] = useState<{ conversationId: string; message: AdminMessage } | null>(null);
  const [typing, setTyping] = useState<{ conversationId: string; isTyping: boolean } | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [magicBrowse, setMagicBrowse] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const [replayFeed, setReplayFeed] = useState<ReplayFeed | null>(null);

  const socketRef = useRef<AgentSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const replayNonce = useRef(0);

  // Agent realtime socket (single connection for the whole panel).
  useEffect(() => {
    if (!agent) return;
    const sock = openAgentWS({
      onConversationNew: () => setListNonce((n) => n + 1),
      onConversationUpdated: () => setListNonce((n) => n + 1),
      onMessage: (conversationId, message) => {
        setListNonce((n) => n + 1);
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

  const startChatWith = (conversationId: string) => {
    setSelectedId(conversationId);
    setTab('chats');
    setListNonce((n) => n + 1);
  };

  if (!agent) return <LoginPanel onLogin={handleLogin} />;

  return (
    <div className="flex flex-col h-[100dvh] bg-gray-100">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 h-14 bg-white border-b border-gray-200 shrink-0">
        {selectedId && tab === 'chats' && (
          <button onClick={() => setSelectedId(null)} className="md:hidden -ml-1 p-1 text-gray-600" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <img src="/icon-192.png" alt="" className="w-8 h-8 rounded-lg" />
        <h1 className="font-bold text-gray-800">JetChat</h1>
        <span className="ml-auto text-sm text-gray-500 truncate max-w-[40%]">{agent.name}</span>
      </header>

      {/* Content */}
      <main className="flex-1 flex overflow-hidden">
        {tab === 'chats' && (
          <>
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
                  onChanged={() => setListNonce((n) => n + 1)}
                />
              ) : (
                <div className="hidden md:flex flex-1 items-center justify-center text-gray-400">
                  Select a conversation
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'visitors' && (
          <LiveVisitors
            visitors={presence}
            onStarted={startChatWith}
            magicBrowse={magicBrowse}
            onWatch={startWatch}
          />
        )}

        {tab === 'account' && manage === 'agents' && (
          <AgentsManager meId={agent.id} onBack={() => setManage(null)} />
        )}
        {tab === 'account' && manage === 'canned' && <CannedManager onBack={() => setManage(null)} />}
        {tab === 'account' && manage === 'settings' && <SettingsPanel onBack={() => setManage(null)} />}
        {tab === 'account' && manage === 'triggers' && <TriggersPanel onBack={() => setManage(null)} />}
        {tab === 'account' && manage === 'kb' && <KnowledgeBasePanel onBack={() => setManage(null)} />}
        {tab === 'account' && manage === null && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <p className="text-sm text-gray-500">Signed in as</p>
              <p className="font-medium text-gray-800">{agent.name}</p>
              <p className="text-sm text-gray-500">{agent.email} · {agent.role}</p>
            </div>

            {/* Admin-only management (role reflected in the UI). */}
            {agent.role === 'admin' && (
              <div className="bg-white rounded-xl shadow-sm divide-y divide-gray-50">
                <button onClick={() => setManage('agents')} className="w-full flex items-center gap-3 p-4 text-left">
                  <Users2 className="w-5 h-5 text-gray-500" />
                  <span className="flex-1 font-medium text-gray-800">Manage agents</span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
                <button onClick={() => setManage('kb')} className="w-full flex items-center gap-3 p-4 text-left">
                  <BookOpen className="w-5 h-5 text-gray-500" />
                  <span className="flex-1 font-medium text-gray-800">Knowledge base</span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
                <button onClick={() => setManage('canned')} className="w-full flex items-center gap-3 p-4 text-left">
                  <MessageSquareText className="w-5 h-5 text-gray-500" />
                  <span className="flex-1 font-medium text-gray-800">Canned responses</span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
                <button onClick={() => setManage('triggers')} className="w-full flex items-center gap-3 p-4 text-left">
                  <Zap className="w-5 h-5 text-gray-500" />
                  <span className="flex-1 font-medium text-gray-800">Triggers</span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
                <button onClick={() => setManage('settings')} className="w-full flex items-center gap-3 p-4 text-left">
                  <Settings className="w-5 h-5 text-gray-500" />
                  <span className="flex-1 font-medium text-gray-800">Settings &amp; AI</span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
              </div>
            )}
            <button
              onClick={togglePush}
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
            <button
              onClick={handleLogout}
              className="w-full bg-white rounded-xl p-4 shadow-sm flex items-center gap-3 text-red-600"
            >
              <LogOut className="w-5 h-5" />
              <span className="font-medium">Sign out</span>
            </button>
          </div>
        )}
      </main>

      {/* Live session replay overlay */}
      {watching && <MagicBrowse feed={replayFeed} onClose={stopWatch} />}

      {/* Bottom navigation (mobile-first; persistent) */}
      <nav className="flex shrink-0 bg-white border-t border-gray-200">
        {[
          { id: 'chats' as const, label: 'Chats', icon: MessageSquare },
          { id: 'visitors' as const, label: 'Visitors', icon: Users },
          { id: 'account' as const, label: 'Account', icon: User },
        ].map(({ id, label, icon: Icon }) => {
          const totalUnread = id === 'chats' ? Object.values(unread).reduce((a, b) => a + b, 0) : 0;
          return (
            <button
              key={id}
              onClick={() => {
                setTab(id);
                setManage(null);
                if (id !== 'chats') setSelectedId(null);
              }}
              className={`relative flex-1 flex flex-col items-center gap-0.5 py-2 text-xs ${
                tab === id ? 'text-blue-600' : 'text-gray-500'
              }`}
            >
              <Icon className="w-5 h-5" />
              {label}
              {totalUnread > 0 && (
                <span className="absolute top-1 right-1/2 translate-x-4 bg-red-500 text-white text-[10px] rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
                  {totalUnread}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
