import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { LoginPanel } from './admin/LoginPanel';
import { ConversationsList } from './admin/ConversationsList';
import { ChatPanel } from './admin/ChatPanel';
import { KnowledgeBasePanel } from './admin/KnowledgeBasePanel';
import { SettingsPanel } from './admin/SettingsPanel';
import { AgentsPanel } from './admin/AgentsPanel';
import { TriggersPanel } from './admin/TriggersPanel';
import { MessageSquare, BookOpen, Settings, Users, LogOut, Zap } from 'lucide-react';
import type { Agent } from '../types/chat';

export function AdminPanel() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState<'chats' | 'knowledge' | 'agents' | 'triggers' | 'settings'>('chats');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        setTimeout(() => checkAuth(), 500);
      } else if (event === 'SIGNED_OUT') {
        setIsAuthenticated(false);
        setAgent(null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const checkAuth = async () => {
    const { data: { session } } = await supabase.auth.getSession();

    if (session) {
      let { data: agentData } = await supabase
        .from('agents')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();

      // If no agent record exists, create one
      if (!agentData) {
        const userName = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Agent';

        const { data: newAgent, error: insertError } = await supabase
          .from('agents')
          .insert({
            id: session.user.id,
            name: userName,
            email: session.user.email,
            is_online: true
          })
          .select()
          .single();

        if (insertError) {
          console.error('Error creating agent:', insertError);
          return;
        }

        agentData = newAgent;
      }

      if (agentData) {
        setAgent(agentData);
        setIsAuthenticated(true);
        updateOnlineStatus(true);
      }
    }
  };

  const updateOnlineStatus = async (isOnline: boolean) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await supabase
      .from('agents')
      .update({ is_online: isOnline, last_seen: new Date().toISOString() })
      .eq('id', session.user.id);
  };

  const handleLogout = async () => {
    await updateOnlineStatus(false);
    await supabase.auth.signOut();
    setIsAuthenticated(false);
    setAgent(null);
  };

  if (!isAuthenticated) {
    return <LoginPanel onLogin={() => checkAuth()} />;
  }

  return (
    <div className="flex h-screen bg-gray-100">
      <div className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <h1 className="text-2xl font-bold text-gray-800">Chat Admin</h1>
          <p className="text-sm text-gray-600 mt-1">{agent?.name}</p>
        </div>

        <nav className="flex-1 p-4">
          <button
            onClick={() => setActiveTab('chats')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-colors ${
              activeTab === 'chats'
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <MessageSquare className="w-5 h-5" />
            <span className="font-medium">Conversations</span>
          </button>

          <button
            onClick={() => setActiveTab('knowledge')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-colors ${
              activeTab === 'knowledge'
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <BookOpen className="w-5 h-5" />
            <span className="font-medium">Knowledge Base</span>
          </button>

          <button
            onClick={() => setActiveTab('agents')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-colors ${
              activeTab === 'agents'
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Users className="w-5 h-5" />
            <span className="font-medium">Agents</span>
          </button>

          <button
            onClick={() => setActiveTab('triggers')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-colors ${
              activeTab === 'triggers'
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Zap className="w-5 h-5" />
            <span className="font-medium">Triggers</span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-colors ${
              activeTab === 'settings'
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Settings className="w-5 h-5" />
            <span className="font-medium">Settings</span>
          </button>
        </nav>

        <div className="p-4 border-t border-gray-200">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'chats' && (
          <>
            <ConversationsList
              selectedId={selectedConversationId}
              onSelect={setSelectedConversationId}
            />
            {selectedConversationId && (
              <ChatPanel
                conversationId={selectedConversationId}
                agentId={agent?.id || ''}
                agentName={agent?.name || ''}
              />
            )}
          </>
        )}

        {activeTab === 'knowledge' && <KnowledgeBasePanel />}
        {activeTab === 'agents' && <AgentsPanel />}
        {activeTab === 'triggers' && <TriggersPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  );
}
