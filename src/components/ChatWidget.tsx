import { useState, useEffect, useRef } from 'react';
import * as rrweb from 'rrweb';
import { MessageCircle, X, Send, Minimize2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { sendMessageToSW } from '../utils/registerSW';
import { TriggerEngine } from '../utils/triggerEngine';
import type { Message, ChatSettings, PreChatField, Trigger } from '../types/chat';

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showPreChat, setShowPreChat] = useState(false);
  const [preChatData, setPreChatData] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [visitorId, setVisitorId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const urlParams = new URLSearchParams(window.location.search);
  const targetDomain = urlParams.get('target_domain');
  const initialUrl = targetDomain ? `https://${targetDomain}` : window.location.href;

  const [currentPage, setCurrentPage] = useState<string>(initialUrl);
  const [visitedPages, setVisitedPages] = useState<string[]>([initialUrl]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [agentTyping, setAgentTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageCountRef = useRef(0);
  const notificationSoundRef = useRef<HTMLAudioElement | null>(null);
  const triggerEngineRef = useRef<TriggerEngine | null>(null);
  const autoWelcomeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasShownAutoWelcome = useRef(false);
  const hasTriggeredAction = useRef(false);
  const channelRef = useRef<any>(null);
  const rrwebBufferRef = useRef<any[]>([]);
  const rrwebStopFnRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadSettings();
    initVisitor();
    trackPageChanges();
    requestNotificationPermission();

    notificationSoundRef.current = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBjGJ0fPTgjMGHm7A7+OZSA0PVKzn7bNgGgU+ldz0zH4yBSF9y/DijkYIDFix5+6qWRUIQ5zg8sFuJAU1j9Tv1YU3Bhlsu+vjnUoLDlKq5O+1ZBkEPZPa88+CNAUie8nx4pFFBwxYr+ftrV0VCECa3vLBbyIFM43T8daINQYabrvv5JxKCw5Rq+Tvt2YbBD2T2vPPgjMFI3vJ8eKRRQcMWK/n7axdFQhAmN7ywW8iBTON0/HWiDUGGm678+ScSgsOUavk7rdmGwQ9k9rzz4IzBSN7yfHikUUHDFiv5+2sXRUIQJje8sFvIgUzjdPx1og1Bhpuu/PknEoLDlGr5O+3ZhsEPZPa88+CMwUje8nx4pFFBwxYr+ftrF0VCECY3vLBbyIFM43T8daINQYabrvz5JxKCw5Rq+Tvt2YbBD2T2vPPgjMFI3vJ8eKRRQcMWK/n7axdFQhAmN7ywW8iBTON0/HWiDUGGm678+ScSgsOUavk77dmGwQ9k9rzz4IzBSN7yfHikUUHDFiv5+2sXRUIQJje8sFvIgUzjdPx1og1Bhpuu/PknEoLDlGr5O+3ZhsEPZPa88+CMwUje8nx4pFFBwxYr+ftrF0VCECa3vLBbyIFM43T8daINQYabrvz5JxKCw5Rq+Tvt2YbBD2T2vPPgjMFI3vJ8eKRRQcMWK/n7axdFQ==');
  }, []);

  useEffect(() => {
    if (conversationId) {
      loadMessages();
      const cleanup = subscribeToMessages();
      return cleanup;
    }
  }, [conversationId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (conversationId && currentPage) {
      updateVisitedPages();
    }
  }, [currentPage]);

  useEffect(() => {
    if (!isOpen && unreadCount > 0) {
      document.title = `(${unreadCount}) New Messages`;
    } else {
      document.title = 'Chat';
    }
  }, [unreadCount, isOpen]);

  useEffect(() => {
    if (settings) {
      initializeTriggers();
      scheduleAutoWelcome();
    }

    return () => {
      if (autoWelcomeTimerRef.current) {
        clearTimeout(autoWelcomeTimerRef.current);
      }
    };
  }, [settings]);

  const requestNotificationPermission = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  };

  const showNotification = (message: string, sender: string) => {
    if ('Notification' in window && Notification.permission === 'granted' && !isOpen) {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        sendMessageToSW({
          type: 'PLAY_SOUND',
          title: sender,
          message: message
        });
      } else {
        new Notification(sender, {
          body: message,
          icon: '/icon.svg',
          badge: '/icon.svg',
          // @ts-ignore
          vibrate: [200, 100, 200]
        });
      }
    }
  };

  const playNotificationSound = () => {
    if (notificationSoundRef.current && !isOpen && settings?.notification_sound_enabled !== false) {
      notificationSoundRef.current.play().catch(() => {});
    }
  };

  const loadSettings = async () => {
    const { data } = await supabase
      .from('chat_settings')
      .select('*')
      .maybeSingle();

    if (data) {
      setSettings(data);
    }
  };

  const initVisitor = () => {
    let id = localStorage.getItem('chatbot_visitor_id');
    if (!id) {
      id = `visitor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('chatbot_visitor_id', id);
    }
    setVisitorId(id);
  };

  const trackPageChanges = () => {
    const observer = new MutationObserver(() => {
      if (window.location.href !== currentPage) {
        const newPage = window.location.href;
        setCurrentPage(newPage);
        setVisitedPages(prev => {
          if (!prev.includes(newPage)) {
            return [...prev, newPage];
          }
          return prev;
        });
      }
    });

    observer.observe(document, { subtree: true, childList: true });

    window.addEventListener('popstate', () => {
      const newPage = window.location.href;
      setCurrentPage(newPage);
      setVisitedPages(prev => {
        if (!prev.includes(newPage)) {
          return [...prev, newPage];
        }
        return prev;
      });
    });

    return () => observer.disconnect();
  };

  const updateVisitedPages = async () => {
    if (!conversationId) return;

    await supabase
      .from('conversations')
      .update({
        metadata: {
          current_page: currentPage,
          visited_pages: visitedPages,
          last_page_update: new Date().toISOString()
        }
      })
      .eq('id', conversationId);
  };

  const createConversation = async (preChatResponses?: Record<string, string>) => {
    const metadata: Record<string, any> = {
      user_agent: navigator.userAgent,
      language: navigator.language,
      referrer: document.referrer,
      current_page: currentPage,
      visited_pages: visitedPages,
      screen_resolution: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    if (preChatResponses) {
      metadata.pre_chat_responses = preChatResponses;
    }

    const conversationData: any = {
      visitor_id: visitorId,
      status: 'active',
      metadata
    };

    if (preChatResponses?.visitor_name) {
      conversationData.visitor_name = preChatResponses.visitor_name;
    }
    if (preChatResponses?.visitor_email) {
      conversationData.visitor_email = preChatResponses.visitor_email;
    }

    const { data, error } = await supabase
      .from('conversations')
      .insert(conversationData)
      .select()
      .single();

    if (error) {
      console.error('Error creating conversation:', error);
      return null;
    }

    try {
      await Promise.all([
        fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/track-visitor`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              conversation_id: data.id
            })
          }
        ),
        fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/discord-notify`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              conversation_id: data.id,
              type: 'new_chat'
            })
          }
        )
      ]);
    } catch (error) {
      console.error('Error in post-conversation hooks:', error);
    }

    return data.id;
  };

  const loadMessages = async () => {
    if (!conversationId) return;

    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (data) {
      setMessages(data);
      lastMessageCountRef.current = data.length;
    }
  };

  const subscribeToMessages = () => {
    if (!conversationId) return () => {};

    const channel = supabase
      .channel(`messages:${conversationId}`)
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

          if (newMessage.sender_type !== 'visitor') {
            setUnreadCount(prev => prev + 1);
            playNotificationSound();

          const sender = newMessage.sender_type === 'ai' ? 'AI Assistant' : 'Support Agent';
          showNotification(newMessage.content, sender);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        startMagicBrowseRecording(channel);
      }
    });

    channelRef.current = channel;

    return () => {
      if (rrwebStopFnRef.current) {
        rrwebStopFnRef.current();
        rrwebStopFnRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  };

  const startMagicBrowseRecording = (channel: any) => {
    if (rrwebStopFnRef.current) return;
    
    const stopRecording = rrweb.record({
      emit(event) {
        rrwebBufferRef.current.push(event);
      },
    });

    if (stopRecording) {
      rrwebStopFnRef.current = stopRecording;

      const flushInterval = setInterval(() => {
        if (rrwebBufferRef.current.length > 0) {
          channel.send({
            type: 'broadcast',
            event: 'magic-browse',
            payload: { events: rrwebBufferRef.current }
          }).catch(() => {
            // Sessizce hatayı yut (Eğer bağlantı koparsa)
          });
          rrwebBufferRef.current = [];
        }
      }, 1000);

      const originalStop = rrwebStopFnRef.current;
      rrwebStopFnRef.current = () => {
        if (originalStop) originalStop();
        clearInterval(flushInterval);
      };
    }
  };

  const handlePreChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!settings?.pre_chat_fields) return;

    const requiredFields = settings.pre_chat_fields.filter(f => f.required);
    const missingFields = requiredFields.filter(f => !preChatData[f.name]?.trim());

    if (missingFields.length > 0) {
      alert('Lütfen tüm gerekli alanları doldurun');
      return;
    }

    setShowPreChat(false);
    const convId = await createConversation(preChatData);
    if (convId) {
      setConversationId(convId);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const messageContent = inputValue.trim();
    setInputValue('');
    setIsLoading(true);

    try {
      let convId = conversationId;
      if (!convId) {
        convId = await createConversation();
        if (!convId) {
          throw new Error('Failed to create conversation');
        }
        setConversationId(convId);
      }

      const { data: messageData, error } = await supabase
        .from('messages')
        .insert({
          conversation_id: convId,
          content: messageContent,
          sender_type: 'visitor',
          sender_id: visitorId
        })
        .select()
        .single();

      if (error) throw error;

      try {
        await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/discord-notify`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              conversation_id: convId,
              message_id: messageData?.id,
              type: 'new_message'
            })
          }
        );
      } catch (discordError) {
        console.error('Error sending Discord notification:', discordError);
      }

      if (settings?.ai_enabled) {
        setAgentTyping(true);
        setTimeout(async () => {
          try {
            const response = await fetch(
              `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chatbot-ai`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  conversation_id: convId,
                  message: messageContent,
                  domain: targetDomain || new URL(window.location.href).hostname.replace('www.', '')
                })
              }
            );

            if (!response.ok) {
              console.error('AI response failed');
            }
          } catch (error) {
            console.error('Error getting AI response:', error);
          } finally {
            setAgentTyping(false);
          }
        }, 1000);
      }
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const initializeTriggers = async () => {
    try {
      const { data: triggersData } = await supabase
        .from('triggers')
        .select('*')
        .eq('is_active', true)
        .order('priority', { ascending: true });

      if (triggersData && triggersData.length > 0) {
        const triggersWithDetails = await Promise.all(
          triggersData.map(async (trigger) => {
            const [actionsRes, eventsRes, behaviorsRes, platformsRes] = await Promise.all([
              supabase.from('trigger_actions').select('*').eq('trigger_id', trigger.id).maybeSingle(),
              supabase.from('trigger_events').select('*').eq('trigger_id', trigger.id).maybeSingle(),
              supabase.from('trigger_behaviors').select('*').eq('trigger_id', trigger.id).maybeSingle(),
              supabase.from('trigger_platforms').select('*').eq('trigger_id', trigger.id).maybeSingle()
            ]);

            return {
              ...trigger,
              actions: actionsRes.data || undefined,
              events: eventsRes.data || undefined,
              behaviors: behaviorsRes.data || undefined,
              platforms: platformsRes.data || undefined
            };
          })
        );

        const engine = new TriggerEngine();
        engine.setTriggers(triggersWithDetails);
        triggerEngineRef.current = engine;

        const { data: agents } = await supabase
          .from('agents')
          .select('is_online')
          .eq('is_online', true);

        const isOnline = agents && agents.length > 0;

        const matchedTriggers = await engine.evaluateTriggers({
          isOnline: !!isOnline,
          currentUrl: window.location.href
        });

        engine.setupEventListeners({
          onLeaveIntent: (trigger) => executeTrigger(trigger),
          onClickLink: (trigger) => executeTrigger(trigger),
          onDelay: (trigger) => executeTrigger(trigger)
        });

        for (const trigger of matchedTriggers) {
          if (trigger.events?.after_delay && !trigger.events.on_leave_intent && !trigger.events.on_click_link) {
            continue;
          }
          executeTrigger(trigger);
        }
      }
    } catch (error) {
      console.error('Error initializing triggers:', error);
    }
  };

  const executeTrigger = async (trigger: Trigger) => {
    if (!trigger.actions) return;

    hasTriggeredAction.current = true;

    if (autoWelcomeTimerRef.current) {
      clearTimeout(autoWelcomeTimerRef.current);
    }

    const { actions } = trigger;

    if (actions.open_chatbox && !isOpen) {
      setIsOpen(true);
      setIsMinimized(false);
      setUnreadCount(0);
    }

    if (actions.show_message && actions.message_content) {
      if (!conversationId && !isOpen) {
        const newConvId = await createConversation();
        if (newConvId) {
          setConversationId(newConvId);
          await sendAutoMessage(newConvId, actions.message_content, trigger.behaviors?.show_as_website ? 'visitor' : 'ai');
        }
      } else if (conversationId) {
        await sendAutoMessage(conversationId, actions.message_content, trigger.behaviors?.show_as_website ? 'visitor' : 'ai');
      }
    }

    if (actions.play_sound) {
      playNotificationSound();
    }

    if (triggerEngineRef.current) {
      triggerEngineRef.current.markTriggerExecuted(trigger.id);
    }
  };

  const scheduleAutoWelcome = () => {
    if (
      !settings?.auto_welcome_enabled ||
      !settings?.auto_welcome_message ||
      hasShownAutoWelcome.current ||
      conversationId ||
      isOpen
    ) {
      return;
    }

    if (autoWelcomeTimerRef.current) {
      clearTimeout(autoWelcomeTimerRef.current);
    }

    autoWelcomeTimerRef.current = setTimeout(async () => {
      if (hasTriggeredAction.current) {
        return;
      }

      if (triggerEngineRef.current?.hasExecutedAnyTrigger()) {
        return;
      }

      hasShownAutoWelcome.current = true;

      const newConvId = await createConversation();
      if (newConvId) {
        setConversationId(newConvId);
        await sendAutoMessage(newConvId, settings.auto_welcome_message || '', 'ai');

        if (!isOpen) {
          setUnreadCount(1);
          playNotificationSound();
          showNotification(settings.auto_welcome_message || '', 'Chatbot');
        }
      }
    }, (settings?.auto_welcome_delay || 5) * 1000);
  };

  const sendAutoMessage = async (convId: string, content: string, senderType: 'visitor' | 'ai') => {
    try {
      await supabase
        .from('messages')
        .insert({
          conversation_id: convId,
          content,
          sender_type: senderType,
          sender_id: null,
          metadata: { auto_generated: true }
        });
    } catch (error) {
      console.error('Error sending auto message:', error);
    }
  };

  const handleOpen = () => {
    setIsOpen(true);
    setIsMinimized(false);
    setUnreadCount(0);

    if (settings?.pre_chat_enabled && !conversationId) {
      setShowPreChat(true);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setShowPreChat(false);
  };

  const handleMinimize = () => {
    setIsMinimized(!isMinimized);
  };

  const primaryColor = settings?.primary_color || '#3B82F6';
  const widgetPosition = settings?.widget_position || 'right';
  const positionClasses = widgetPosition === 'left' ? 'left-6' : 'right-6';

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className={`fixed bottom-6 ${positionClasses} w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white transition-transform hover:scale-110 z-50 relative`}
        style={{ backgroundColor: primaryColor }}
      >
        {settings?.widget_avatar_url ? (
          <img
            src={settings.widget_avatar_url}
            alt="Chat"
            className="w-full h-full rounded-full object-cover"
          />
        ) : (
          <MessageCircle className="w-6 h-6" />
        )}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center animate-pulse">
            {unreadCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className={`fixed bottom-6 ${positionClasses} z-50`}>
      <div
        className="bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden"
        style={{
          width: '380px',
          height: isMinimized ? '60px' : '600px',
          maxHeight: '90vh',
          transition: 'height 0.3s ease'
        }}
      >
        <div
          className="px-4 py-3 text-white flex items-center justify-between"
          style={{ backgroundColor: primaryColor }}
        >
          <div className="flex items-center gap-3">
            {settings?.widget_avatar_url && (
              <img
                src={settings.widget_avatar_url}
                alt="Avatar"
                className="w-8 h-8 rounded-full object-cover border-2 border-white"
              />
            )}
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
              <h3 className="font-semibold">{settings?.widget_title || 'Chat with us'}</h3>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleMinimize}
              className="hover:bg-white/20 p-1 rounded transition-colors"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleClose}
              className="hover:bg-white/20 p-1 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {!isMinimized && (
          <>
            {showPreChat ? (
              <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                <div className="bg-white p-6 rounded-lg shadow-sm">
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">
                    Başlamadan Önce
                  </h3>
                  <p className="text-sm text-gray-600 mb-6">
                    Size daha iyi yardımcı olabilmemiz için lütfen aşağıdaki bilgileri doldurun.
                  </p>

                  <form onSubmit={handlePreChatSubmit} className="space-y-4">
                    {settings?.pre_chat_fields?.map((field: PreChatField) => (
                      <div key={field.name}>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </label>
                        <input
                          type={field.type}
                          value={preChatData[field.name] || ''}
                          onChange={(e) => setPreChatData(prev => ({
                            ...prev,
                            [field.name]: e.target.value
                          }))}
                          placeholder={field.placeholder}
                          required={field.required}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        />
                      </div>
                    ))}

                    <button
                      type="submit"
                      className="w-full py-2 text-white rounded-lg font-medium transition-colors hover:opacity-90"
                      style={{ backgroundColor: primaryColor }}
                    >
                      Sohbete Başla
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowPreChat(false);
                        createConversation().then(id => {
                          if (id) setConversationId(id);
                        });
                      }}
                      className="w-full py-2 text-gray-600 rounded-lg font-medium transition-colors hover:bg-gray-100 text-sm"
                    >
                      Atla
                    </button>
                  </form>
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
                  {messages.length === 0 && (
                    <div className="bg-white p-4 rounded-lg shadow-sm">
                      <p className="text-gray-700">
                        {settings?.welcome_message || 'Hi! How can we help you today?'}
                      </p>
                    </div>
                  )}

                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${
                        message.sender_type === 'visitor' ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      <div
                        className={`max-w-[75%] rounded-lg px-4 py-2 ${
                          message.sender_type === 'visitor'
                            ? 'text-white'
                            : 'bg-white shadow-sm text-gray-800'
                        }`}
                        style={
                          message.sender_type === 'visitor'
                            ? { backgroundColor: primaryColor }
                            : {}
                        }
                      >
                        {message.sender_type === 'ai' && (
                          <div className="text-xs text-gray-500 mb-1">🤖 AI Assistant</div>
                        )}
                        {message.sender_type === 'agent' && (
                          <div className="text-xs text-gray-500 mb-1">👤 Agent</div>
                        )}
                        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                      </div>
                    </div>
                  ))}

                  {agentTyping && (
                    <div className="flex justify-start">
                      <div className="bg-white shadow-sm rounded-lg px-4 py-3">
                        <div className="flex gap-1">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                <form onSubmit={sendMessage} className="p-4 bg-white border-t">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder="Type your message..."
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      disabled={isLoading}
                    />
                    <button
                      type="submit"
                      disabled={!inputValue.trim() || isLoading}
                      className="px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ backgroundColor: primaryColor }}
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  </div>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
