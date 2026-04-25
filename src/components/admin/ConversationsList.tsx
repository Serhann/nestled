import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Clock, User } from 'lucide-react';
import type { Conversation, Message } from '../../types/chat';

interface ConversationsListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface ConversationWithLastMessage extends Conversation {
  lastMessage?: Message;
  unreadCount?: number;
}

export function ConversationsList({ selectedId, onSelect }: ConversationsListProps) {
  const [conversations, setConversations] = useState<ConversationWithLastMessage[]>([]);
  const [filter, setFilter] = useState<'active' | 'resolved' | 'all'>('active');

  useEffect(() => {
    loadConversations();
    const cleanup1 = subscribeToConversations();
    const cleanup2 = subscribeToMessages();

    return () => {
      cleanup1();
      cleanup2();
    };
  }, [filter]);

  const loadConversations = async () => {
    let query = supabase
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false });

    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data } = await query;

    if (data) {
      const conversationsWithMessages = await Promise.all(
        data.map(async (conv) => {
          const { data: messages } = await supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: false })
            .limit(1);

          return {
            ...conv,
            lastMessage: messages?.[0],
            unreadCount: 0
          };
        })
      );

      setConversations(conversationsWithMessages);
    }
  };

  const subscribeToConversations = () => {
    const channel = supabase
      .channel('conversations-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations'
        },
        () => {
          loadConversations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const subscribeToMessages = () => {
    const channel = supabase
      .channel('all-messages-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages'
        },
        (payload) => {
          const newMessage = payload.new as Message;

          setConversations(prev => prev.map(conv => {
            if (conv.id === newMessage.conversation_id) {
              const isUnread = newMessage.sender_type === 'visitor' && conv.id !== selectedId;
              return {
                ...conv,
                lastMessage: newMessage,
                updated_at: newMessage.created_at,
                unreadCount: isUnread ? (conv.unreadCount || 0) + 1 : conv.unreadCount
              };
            }
            return conv;
          }).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  useEffect(() => {
    if (selectedId) {
      setConversations(prev => prev.map(conv =>
        conv.id === selectedId ? { ...conv, unreadCount: 0 } : conv
      ));
    }
  }, [selectedId]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Conversations</h2>

        <div className="flex gap-2">
          <button
            onClick={() => setFilter('active')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
              filter === 'active'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setFilter('resolved')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
              filter === 'resolved'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Resolved
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
              filter === 'all'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            All
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <User className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No conversations yet</p>
          </div>
        ) : (
          conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`w-full p-4 border-b border-gray-200 hover:bg-gray-50 transition-colors text-left relative ${
                selectedId === conv.id ? 'bg-blue-50' : ''
              }`}
            >
              {conv.unreadCount && conv.unreadCount > 0 && (
                <span className="absolute top-2 right-2 bg-red-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">
                  {conv.unreadCount}
                </span>
              )}

              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center text-white font-semibold">
                    {conv.visitor_name?.[0]?.toUpperCase() || 'V'}
                  </div>
                  <div>
                    <h3 className={`font-medium text-gray-900 ${conv.unreadCount ? 'font-bold' : ''}`}>
                      {conv.visitor_name || 'Anonymous Visitor'}
                    </h3>
                    <p className="text-xs text-gray-500">{conv.visitor_email || conv.visitor_id}</p>
                  </div>
                </div>
                <span
                  className={`px-2 py-1 text-xs rounded-full ${
                    conv.status === 'active'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {conv.status}
                </span>
              </div>

              {conv.lastMessage && (
                <p className={`text-sm text-gray-600 truncate mb-2 ${conv.unreadCount ? 'font-semibold' : ''}`}>
                  {conv.lastMessage.sender_type === 'visitor' ? '👤 ' : conv.lastMessage.sender_type === 'ai' ? '🤖 ' : '👨‍💼 '}
                  {conv.lastMessage.content}
                </p>
              )}

              <div className="flex items-center gap-1 text-xs text-gray-500">
                <Clock className="w-3 h-3" />
                <span>{formatDate(conv.updated_at)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
