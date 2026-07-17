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

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-slate-900 to-slate-700 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-7">
        <div className="flex items-center justify-center mb-6">
          <img src="/icon-192.png" alt="JetChat" className="w-14 h-14 rounded-2xl" />
        </div>
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-1">
          {mode === 'bootstrap' ? 'Create first admin' : 'JetChat Admin'}
        </h2>
        <p className="text-center text-gray-500 text-sm mb-6">
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
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@jetfood.com"
            required
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            minLength={8}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-lg text-sm">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <LogIn className="w-4 h-4" />
            {loading ? 'Please wait…' : mode === 'bootstrap' ? 'Create admin' : 'Sign in'}
          </button>
        </form>

        <div className="mt-5 text-center">
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
