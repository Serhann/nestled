import { useEffect, useRef, useState } from 'react';
import * as rrweb from 'rrweb';
import { supabase } from '../../lib/supabase';
import { Eye, Loader2 } from 'lucide-react';
import 'rrweb/dist/rrweb.min.css';

interface MagicBrowseProps {
  conversationId: string;
}

export function MagicBrowse({ conversationId }: MagicBrowseProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<any>(null);
  const [hasEvents, setHasEvents] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'listening'>('connecting');

  useEffect(() => {
    if (!conversationId) return;

    setStatus('connecting');
    const channel = supabase.channel(`messages:${conversationId}`);

    channel.on('broadcast', { event: 'magic-browse' }, (payload) => {
      const newEvents = payload.payload?.events || [];
      if (newEvents.length === 0) return;

      setStatus('listening');
      if (!hasEvents) setHasEvents(true);

      if (!replayerRef.current && containerRef.current) {
        replayerRef.current = new rrweb.Replayer(newEvents, {
          root: containerRef.current,
          liveMode: true,
        });
        replayerRef.current.startLive();
      } else {
        newEvents.forEach((event: any) => {
          replayerRef.current?.addEvent(event);
        });
      }
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setStatus('listening');
      }
    });

    return () => {
      channel.unsubscribe();
      if (replayerRef.current) {
        replayerRef.current.pause();
      }
    };
  }, [conversationId, hasEvents]);

  return (
    <div className="flex flex-col h-full bg-white rounded-lg overflow-hidden border border-gray-200">
      <div className="bg-white px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eye className="w-5 h-5 text-indigo-600" />
          <h3 className="font-semibold text-gray-800">Magic Browse</h3>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              {status === 'listening' ? (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                </>
              ) : (
                <span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500"></span>
              )}
            </span>
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">
              {status === 'connecting' ? 'Bağlanıyor...' : 'Canlı İzleme'}
            </span>
          </div>
        </div>
      </div>
      
      <div className="flex-1 bg-gray-50 relative overflow-auto p-2">
        {!hasEvents && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-50/90 z-10">
            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-4" />
            <p className="text-gray-600 font-medium">Sinyal bekleniyor...</p>
            <p className="text-gray-400 text-sm text-center max-w-xs mt-2">Kullanıcı fareyi hareket ettirdiğinde izleme başlayacak.</p>
          </div>
        )}
        <div 
          ref={containerRef} 
          className="bg-white shadow-sm overflow-hidden border border-gray-200 w-full h-full rrweb-container"
        />
      </div>
    </div>
  );
}
