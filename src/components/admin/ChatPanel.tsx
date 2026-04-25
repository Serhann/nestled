import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Send, CheckCircle, XCircle, ChevronDown, ChevronUp, MapPin, Globe, Monitor, Eye } from 'lucide-react';
import { MagicBrowse } from './MagicBrowse';
import type { Message, Conversation } from '../../types/chat';

interface ChatPanelProps {
  conversationId: string;
  agentId: string;
  agentName: string;
}

export function ChatPanel({ conversationId, agentId }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showVisitorInfo, setShowVisitorInfo] = useState(true);
  const [showMagicBrowse, setShowMagicBrowse] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConversation();
    loadMessages();
    const cleanup = subscribeToMessages();
    return cleanup;
  }, [conversationId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const loadConversation = async () => {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .maybeSingle();

    if (data) {
      setConversation(data);
    }
  };

  const loadMessages = async () => {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (data) {
      setMessages(data);
    }
  };

  const subscribeToMessages = () => {
    if (!conversationId) return () => {};

    const channel = supabase
      .channel(`admin-messages:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`
        },
        (payload) => {
          const newMessage = payload.new as Message;
          setMessages(prev => [...prev, newMessage]);

          if (newMessage.sender_type === 'visitor') {
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBjGJ0fPTgjMGHm7A7+OZSA0PVKzn7bNgGgU+ldz0zH4yBSF9y/DijkYIDFix5+6qWRUIQ5zg8sFuJAU1j9Tv1YU3Bhlsu+vjnUoLDlKq5O+1ZBkEPZPa88+CNAUie8nx4pFFBwxYr+ftrV0VCECa3vLBbyIFM43T8daINQYabrvv5JxKCw5Rq+Tvt2YbBD2T2vPPgjMFI3vJ8eKRRQcMWK/n7axdFQhAmN7ywW8iBTON0/HWiDUGGm678+ScSgsOUavk7rdmGwQ9k9rzz4IzBSN7yfHikUUHDFiv5+2sXRUIQJje8sFvIgUzjdPx1og1Bhpuu/PknEoLDlGr5O+3ZhsEPZPa88+CMwUje8nx4pFFBwxYr+ftrF0VCECY3vLBbyIFM43T8daINQYabrvz5JxKCw5Rq+Tvt2YbBD2T2vPPgjMFI3vJ8eKRRQcMWK/n7axdFQhAmN7ywW8iBTON0/HWiDUGGm678+ScSgsOUavk77dmGwQ9k9rzz4IzBSN7yfHikUUHDFiv5+2sXRUIQJje8sFvIgUzjdPx1og1Bhpuu/PknEoLDlGr5O+3ZhsEPZPa88+CMwUje8nx4pFFBwxYr+ftrF0VCECa3vLBbyIFM43T8daINQYabrvz5JxKCw5Rq+Tvt2YbBD2T2vPPgjMFI3vJ8eKRRQcMWK/n7axdFQ==');
            audio.play().catch(() => {});
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const messageContent = inputValue.trim();
    setInputValue('');
    setIsLoading(true);

    try {
      const { error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          content: messageContent,
          sender_type: 'agent',
          sender_id: agentId
        });

      if (error) throw error;
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateConversationStatus = async (status: 'active' | 'resolved') => {
    const { error } = await supabase
      .from('conversations')
      .update({ status })
      .eq('id', conversationId);

    if (!error) {
      setConversation(prev => prev ? { ...prev, status } : null);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading conversation...</p>
      </div>
    );
  }

  const metadata = conversation.metadata || {};
  const preChatResponses = metadata.pre_chat_responses || {};
  const location = metadata.location || null;
  const ipAddress = metadata.ip_address || null;
  const visitedPages = metadata.visited_pages || [];
  const currentPage = metadata.current_page || null;

  return (
    <div className="flex-1 flex bg-white">
      <div className="flex-1 flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">
                  {conversation.visitor_name || 'Anonymous Visitor'}
                </h2>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-sm text-gray-500">
                    {conversation.visitor_email || conversation.visitor_id.substring(0, 12)}
                  </span>
                  {currentPage && (
                    <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 font-semibold rounded text-xs border border-indigo-200 flex items-center gap-1 shadow-sm">
                      <Globe className="w-3 h-3" />
                      {new URL(currentPage).hostname.replace('www.', '')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowMagicBrowse(!showMagicBrowse)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${showMagicBrowse ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'}`}
              >
                <Eye className="w-4 h-4" />
                <span>Magic Browse</span>
              </button>
              {conversation.status !== 'resolved' && (
                <button
                  onClick={() => updateConversationStatus('resolved')}
                  className="flex items-center gap-2 px-4 py-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors"
                >
                  <CheckCircle className="w-4 h-4" />
                  <span>Resolve</span>
                </button>
              )}
              {conversation.status === 'resolved' && (
                <button
                  onClick={() => updateConversationStatus('active')}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors"
                >
                  <XCircle className="w-4 h-4" />
                  <span>Reopen</span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className={`${showMagicBrowse ? 'w-1/2 border-r border-gray-200' : 'flex-1'} flex flex-col overflow-hidden`}>
            <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.sender_type === 'agent' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[70%] ${
                      message.sender_type === 'agent'
                        ? 'bg-blue-600 text-white'
                        : message.sender_type === 'ai'
                        ? 'bg-emerald-100 text-emerald-900'
                        : 'bg-white text-gray-800 shadow-sm'
                    } rounded-lg px-4 py-3`}
                  >
                    {message.sender_type === 'ai' && (
                      <div className="text-xs mb-1 opacity-75">🤖 AI Response</div>
                    )}
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                    <p className="text-xs mt-2 opacity-75">{formatTime(message.created_at)}</p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={sendMessage} className="p-6 bg-white border-t border-gray-200 flex-shrink-0">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Type your message..."
                  className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isLoading}
                />
                <button
                  type="submit"
                  disabled={!inputValue.trim() || isLoading}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Send className="w-5 h-5" />
                  <span>Send</span>
                </button>
              </div>
            </form>
          </div>
          
          {showMagicBrowse && (
            <div className="w-1/2 bg-gray-100 p-4 border-r border-gray-200 overflow-hidden">
              <MagicBrowse conversationId={conversationId} />
            </div>
          )}
        </div>
      </div>

      <div className="w-80 border-l border-gray-200 bg-gray-50 overflow-y-auto">
        <div className="p-4">
          <button
            onClick={() => setShowVisitorInfo(!showVisitorInfo)}
            className="w-full flex items-center justify-between text-left font-semibold text-gray-800 mb-4"
          >
            <span>Visitor Information</span>
            {showVisitorInfo ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </button>

          {showVisitorInfo && (
            <div className="space-y-4">
              {Object.keys(preChatResponses).length > 0 && (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Pre-Chat Form</h3>
                  <div className="space-y-2">
                    {Object.entries(preChatResponses).map(([key, value]) => (
                      <div key={key}>
                        <p className="text-xs text-gray-500 capitalize">{key.replace(/_/g, ' ')}</p>
                        <p className="text-sm text-gray-800">{value as string}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {location && (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <MapPin className="w-4 h-4" />
                    Location
                  </h3>
                  <div className="space-y-2 text-sm">
                    {location.city && (
                      <p className="text-gray-800">
                        {location.city}, {location.region}
                      </p>
                    )}
                    {location.country && (
                      <p className="text-gray-600">{location.country}</p>
                    )}
                    {ipAddress && (
                      <div className="pt-2 border-t border-gray-100">
                        <p className="text-xs text-gray-500">IP Address</p>
                        <p className="text-gray-800 font-mono">{ipAddress}</p>
                      </div>
                    )}
                    {location.timezone && (
                      <div>
                        <p className="text-xs text-gray-500">Timezone</p>
                        <p className="text-gray-800">{location.timezone}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!location && ipAddress && (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">IP Address</h3>
                  <p className="text-sm text-gray-800 font-mono">{ipAddress}</p>
                </div>
              )}

              {currentPage && (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <Globe className="w-4 h-4" />
                    Current Page
                  </h3>
                  <a
                    href={currentPage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline break-all"
                  >
                    {currentPage}
                  </a>
                </div>
              )}

              {visitedPages.length > 0 && (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Page History</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {visitedPages.map((page: string, index: number) => (
                      <a
                        key={index}
                        href={page}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs text-blue-600 hover:underline break-all"
                      >
                        {page}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {metadata.user_agent && (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <Monitor className="w-4 h-4" />
                    Device Info
                  </h3>
                  <div className="space-y-2 text-sm">
                    {metadata.screen_resolution && (
                      <div>
                        <p className="text-xs text-gray-500">Screen</p>
                        <p className="text-gray-800">{metadata.screen_resolution}</p>
                      </div>
                    )}
                    {metadata.language && (
                      <div>
                        <p className="text-xs text-gray-500">Language</p>
                        <p className="text-gray-800">{metadata.language}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-gray-500">User Agent</p>
                      <p className="text-xs text-gray-600 break-all">{metadata.user_agent}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
