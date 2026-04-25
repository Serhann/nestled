import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { UserPlus, Edit2, Trash2, Save, X } from 'lucide-react';
import type { Agent } from '../../types/chat';

export function AgentsPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [message, setMessage] = useState('');
  const [newAgent, setNewAgent] = useState({
    email: '',
    password: '',
    name: '',
    avatar_url: ''
  });

  useEffect(() => {
    loadAgents();
    const subscription = subscribeToAgents();
    return () => {
      if (subscription) supabase.removeChannel(subscription);
    };
  }, []);

  const loadAgents = async () => {
    const { data } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false });

    if (data) {
      setAgents(data);
    }
  };

  const subscribeToAgents = () => {
    const channel = supabase
      .channel('agents-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agents'
        },
        () => {
          loadAgents();
        }
      )
      .subscribe();

    return channel;
  };

  const handleAddAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('');

    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: newAgent.email,
        password: newAgent.password,
        options: {
          data: {
            name: newAgent.name
          }
        }
      });

      if (authError) throw authError;

      if (authData.user) {
        const { error: agentError } = await supabase
          .from('agents')
          .insert({
            id: authData.user.id,
            name: newAgent.name,
            email: newAgent.email,
            avatar_url: newAgent.avatar_url || null,
            is_online: false
          });

        if (agentError) throw agentError;

        setMessage('Agent added successfully!');
        setNewAgent({ email: '', password: '', name: '', avatar_url: '' });
        setShowAddForm(false);
        loadAgents();
      }
    } catch (error: any) {
      setMessage(`Error: ${error.message}`);
    }
  };

  const handleUpdateAgent = async (agent: Agent) => {
    try {
      const { error } = await supabase
        .from('agents')
        .update({
          name: agent.name,
          avatar_url: agent.avatar_url || null
        })
        .eq('id', agent.id);

      if (error) throw error;

      setMessage('Agent updated successfully!');
      setEditingAgent(null);
      loadAgents();
    } catch (error: any) {
      setMessage(`Error: ${error.message}`);
    }
  };

  const handleDeleteAgent = async (agentId: string) => {
    if (!confirm('Are you sure you want to delete this agent? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase.auth.admin.deleteUser(agentId);
      if (error) throw error;

      setMessage('Agent deleted successfully!');
      loadAgents();
    } catch (error: any) {
      setMessage(`Error: ${error.message}`);
    }
  };

  return (
    <div className="flex-1 bg-gray-50 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-800">Agent Management</h2>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <UserPlus className="w-5 h-5" />
            <span>Add Agent</span>
          </button>
        </div>

        {message && (
          <div className={`mb-6 p-4 rounded-lg ${
            message.includes('Error')
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}>
            {message}
          </div>
        )}

        {showAddForm && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Add New Agent</h3>
            <form onSubmit={handleAddAgent} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Name
                  </label>
                  <input
                    type="text"
                    value={newAgent.name}
                    onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    value={newAgent.email}
                    onChange={(e) => setNewAgent({ ...newAgent, email: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Password
                  </label>
                  <input
                    type="password"
                    value={newAgent.password}
                    onChange={(e) => setNewAgent({ ...newAgent, password: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                    minLength={6}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Avatar URL (optional)
                  </label>
                  <input
                    type="url"
                    value={newAgent.avatar_url}
                    onChange={(e) => setNewAgent({ ...newAgent, avatar_url: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="https://example.com/avatar.jpg"
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Create Agent
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setNewAgent({ email: '', password: '', name: '', avatar_url: '' });
                  }}
                  className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Agent
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {editingAgent?.id === agent.id ? (
                      <div className="flex items-center gap-3">
                        <input
                          type="url"
                          value={editingAgent.avatar_url || ''}
                          onChange={(e) => setEditingAgent({ ...editingAgent, avatar_url: e.target.value })}
                          className="w-24 px-2 py-1 text-xs border border-gray-300 rounded"
                          placeholder="Avatar URL"
                        />
                        <input
                          type="text"
                          value={editingAgent.name}
                          onChange={(e) => setEditingAgent({ ...editingAgent, name: e.target.value })}
                          className="px-2 py-1 border border-gray-300 rounded"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        {agent.avatar_url ? (
                          <img
                            src={agent.avatar_url}
                            alt={agent.name}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-semibold">
                            {agent.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span className="font-medium text-gray-900">{agent.name}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {agent.email}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                      agent.is_online
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      <span className={`w-2 h-2 rounded-full ${agent.is_online ? 'bg-green-500' : 'bg-gray-400'}`} />
                      {agent.is_online ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    {editingAgent?.id === agent.id ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleUpdateAgent(editingAgent)}
                          className="text-green-600 hover:text-green-900"
                        >
                          <Save className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => setEditingAgent(null)}
                          className="text-gray-600 hover:text-gray-900"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEditingAgent(agent)}
                          className="text-blue-600 hover:text-blue-900"
                        >
                          <Edit2 className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => handleDeleteAgent(agent.id)}
                          className="text-red-600 hover:text-red-900"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {agents.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No agents found. Add your first agent to get started.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
