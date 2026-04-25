import { useState, useEffect } from 'react';
import { ChatWidget } from './components/ChatWidget';
import { AdminPanel } from './components/AdminPanel';
import { MessageSquare, Settings, Sparkles } from 'lucide-react';

function App() {
  const [view, setView] = useState<'home' | 'demo' | 'admin' | 'widget'>('home');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    if (viewParam === 'admin') {
      setView('admin');
    } else if (viewParam === 'demo') {
      setView('demo');
    } else if (viewParam === 'widget') {
      setView('widget');
    }
  }, []);

  if (view === 'widget') {
    return <ChatWidget />;
  }

  if (view === 'admin') {
    return <AdminPanel />;
  }

  if (view === 'demo') {
    return (
      <>
        <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-cyan-50">
          <div className="container mx-auto px-4 py-16">
            <div className="text-center mb-12">
              <h1 className="text-5xl font-bold text-gray-800 mb-4">
                Chat Widget Demo
              </h1>
              <p className="text-xl text-gray-600 mb-8">
                Try our intelligent chatbot! It uses AI and a knowledge base to answer your questions.
              </p>
              <button
                onClick={() => setView('home')}
                className="text-blue-600 hover:text-blue-700 font-medium"
              >
                ← Back to Home
              </button>
            </div>

            <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-8">
              <div className="bg-white rounded-2xl shadow-lg p-8">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Features</h2>
                <ul className="space-y-4">
                  <li className="flex items-start gap-3">
                    <div className="w-6 h-6 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                      <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-800">AI-Powered Responses</h3>
                      <p className="text-gray-600 text-sm">Automatically answers based on your knowledge base</p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                      <div className="w-2 h-2 bg-blue-600 rounded-full"></div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-800">Real-time Chat</h3>
                      <p className="text-gray-600 text-sm">Instant messaging with live updates</p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-6 h-6 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                      <div className="w-2 h-2 bg-amber-600 rounded-full"></div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-800">Agent Takeover</h3>
                      <p className="text-gray-600 text-sm">Seamlessly switch to human agents</p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-6 h-6 bg-orange-100 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                      <div className="w-2 h-2 bg-orange-600 rounded-full"></div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-800">Fully Customizable</h3>
                      <p className="text-gray-600 text-sm">Customize colors, messages, and behavior</p>
                    </div>
                  </li>
                </ul>
              </div>

              <div className="bg-white rounded-2xl shadow-lg p-8">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Try It Now</h2>
                <p className="text-gray-600 mb-6">
                  Click the chat button in the bottom-right corner to start a conversation!
                </p>
                <div className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-xl p-6 border-2 border-dashed border-blue-200">
                  <div className="flex items-center justify-center mb-4">
                    <MessageSquare className="w-12 h-12 text-blue-600" />
                  </div>
                  <p className="text-center text-gray-700 font-medium">
                    Look for the chat button →
                  </p>
                  <p className="text-center text-gray-500 text-sm mt-2">
                    It appears in the bottom-right corner of your screen
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <ChatWidget />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-600 via-cyan-600 to-teal-500">
      <div className="min-h-screen bg-black/20 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-16">
          <div className="text-center mb-16">
            <div className="flex items-center justify-center mb-6">
              <div className="bg-white/20 backdrop-blur-md p-4 rounded-2xl">
                <Sparkles className="w-16 h-16 text-white" />
              </div>
            </div>
            <h1 className="text-6xl font-bold text-white mb-6">
              AI-Powered Chatbot
            </h1>
            <p className="text-2xl text-white/90 mb-8 max-w-2xl mx-auto">
              Crisp benzeri profesyonel chatbot sistemi. AI destekli otomatik cevaplar, wiki entegrasyonu ve canlı destek.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            <button
              onClick={() => setView('demo')}
              className="bg-white rounded-2xl shadow-2xl p-8 hover:scale-105 transition-transform duration-300 text-left group"
            >
              <div className="bg-gradient-to-br from-blue-500 to-blue-600 w-16 h-16 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <MessageSquare className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-3xl font-bold text-gray-800 mb-4">
                Chat Widget Demo
              </h2>
              <p className="text-gray-600 text-lg mb-4">
                Widget'ı test edin ve AI destekli cevapları görün.
              </p>
              <ul className="space-y-2 text-gray-600">
                <li className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-blue-600 rounded-full"></div>
                  <span>AI otomatik cevaplar</span>
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-blue-600 rounded-full"></div>
                  <span>Gerçek zamanlı mesajlaşma</span>
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-blue-600 rounded-full"></div>
                  <span>Mobil uyumlu tasarım</span>
                </li>
              </ul>
              <div className="mt-6 text-blue-600 font-semibold flex items-center gap-2 group-hover:gap-4 transition-all">
                <span>Demo'yu Dene</span>
                <span>→</span>
              </div>
            </button>

            <button
              onClick={() => setView('admin')}
              className="bg-white rounded-2xl shadow-2xl p-8 hover:scale-105 transition-transform duration-300 text-left group"
            >
              <div className="bg-gradient-to-br from-emerald-500 to-teal-600 w-16 h-16 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <Settings className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-3xl font-bold text-gray-800 mb-4">
                Admin Panel
              </h2>
              <p className="text-gray-600 text-lg mb-4">
                Chatları yönetin, FAQ ekleyin ve ayarları düzenleyin.
              </p>
              <ul className="space-y-2 text-gray-600">
                <li className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-emerald-600 rounded-full"></div>
                  <span>Canlı chat yönetimi</span>
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-emerald-600 rounded-full"></div>
                  <span>Knowledge base düzenleme</span>
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-emerald-600 rounded-full"></div>
                  <span>Widget özelleştirme</span>
                </li>
              </ul>
              <div className="mt-6 text-emerald-600 font-semibold flex items-center gap-2 group-hover:gap-4 transition-all">
                <span>Admin Paneli Aç</span>
                <span>→</span>
              </div>
            </button>
          </div>

          <div className="mt-16 text-center">
            <div className="inline-block bg-white/10 backdrop-blur-md rounded-2xl px-8 py-4">
              <p className="text-white text-lg">
                <span className="font-semibold">Özellikler:</span> AI Cevaplar • Gerçek Zamanlı Chat • FAQ Yönetimi • Özelleştirilebilir Widget
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
