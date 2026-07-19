import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { login, registerFirstAdmin, type AdminAgent } from '../../lib/adminApi';

interface LoginPanelProps {
  onLogin: (agent: AdminAgent) => void;
}

export function LoginPanel({ onLogin }: LoginPanelProps) {
  const [mode, setMode] = useState<'login' | 'bootstrap'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const agent =
        mode === 'bootstrap'
          ? await registerFirstAdmin(name, email, password)
          : await login(email, password);
      onLogin(agent);
    } catch (err) {
      setError((err as Error).message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-gray-800 placeholder:text-gray-400 focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400 outline-none transition';

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-blue-500 via-blue-600 to-cyan-500 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl w-full max-w-sm p-8 animate-pop-in">
        <div className="flex items-center justify-center mb-5">
          <img src="/icon-192.png" alt="JetChat" className="w-16 h-16 rounded-3xl shadow-md" />
        </div>
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-1">
          {mode === 'bootstrap' ? 'Create first admin' : 'Welcome back 👋'}
        </h2>
        <p className="text-center text-gray-500 text-sm mb-7">
          {mode === 'bootstrap'
            ? 'Set up the first administrator account.'
            : 'Sign in to handle chats and visitors.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'bootstrap' && (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              required
              className={inputClass}
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@jetfood.com"
            required
            className={inputClass}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            minLength={8}
            className={inputClass}
          />
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-2xl text-sm">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold hover:bg-blue-700 active:scale-[0.98] shadow-md shadow-blue-600/25 transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <LogIn className="w-4 h-4" />
            {loading ? 'Please wait…' : mode === 'bootstrap' ? 'Create admin' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => {
              setMode(mode === 'bootstrap' ? 'login' : 'bootstrap');
              setError('');
            }}
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            {mode === 'bootstrap' ? 'Back to sign in' : 'First time? Create the first admin'}
          </button>
        </div>
      </div>
    </div>
  );
}
