import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Edit2, Trash2, Save, X } from 'lucide-react';
import type { KnowledgeBaseItem } from '../../types/chat';

export function KnowledgeBasePanel() {
  const [items, setItems] = useState<KnowledgeBaseItem[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [editingItem, setEditingItem] = useState<Partial<KnowledgeBaseItem> | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    loadItems();
  }, []);

  const loadItems = async () => {
    const { data } = await supabase
      .from('knowledge_base')
      .select('*')
      .order('priority', { ascending: false });

    if (data) {
      setItems(data);
      const uniqueCategories = [...new Set(data.map(item => item.category))];
      setCategories(uniqueCategories);
    }
  };

  const handleSave = async () => {
    if (!editingItem?.question || !editingItem?.answer) return;

    try {
      if (editingItem.id) {
        const { error } = await supabase
          .from('knowledge_base')
          .update({
            question: editingItem.question,
            answer: editingItem.answer,
            category: editingItem.category || 'general',
            keywords: editingItem.keywords || [],
            priority: editingItem.priority || 0,
            is_active: editingItem.is_active ?? true,
            updated_at: new Date().toISOString()
          })
          .eq('id', editingItem.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('knowledge_base')
          .insert({
            question: editingItem.question,
            answer: editingItem.answer,
            category: editingItem.category || 'general',
            keywords: editingItem.keywords || [],
            priority: editingItem.priority || 0,
            is_active: editingItem.is_active ?? true
          });

        if (error) throw error;
      }

      setIsEditing(false);
      setEditingItem(null);
      loadItems();
    } catch (error) {
      console.error('Error saving item:', error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this item?')) return;

    const { error } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', id);

    if (!error) {
      loadItems();
    }
  };

  const handleEdit = (item: KnowledgeBaseItem) => {
    setEditingItem(item);
    setIsEditing(true);
  };

  const handleNew = () => {
    setEditingItem({
      question: '',
      answer: '',
      category: 'general',
      keywords: [],
      priority: 0,
      is_active: true
    });
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditingItem(null);
  };

  const filteredItems = filter === 'all'
    ? items
    : items.filter(item => item.category === filter);

  return (
    <div className="flex-1 flex flex-col bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-gray-800">Knowledge Base</h2>
          <button
            onClick={handleNew}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-5 h-5" />
            <span>Add New</span>
          </button>
        </div>

        <div className="flex gap-2 overflow-x-auto">
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === 'all'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            All
          </button>
          {categories.map(category => (
            <button
              key={category}
              onClick={() => setFilter(category)}
              className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                filter === category
                  ? 'bg-blue-100 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid gap-4">
          {filteredItems.map(item => (
            <div
              key={item.id}
              className="bg-white rounded-lg shadow-sm p-6 border border-gray-200"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">
                      {item.category}
                    </span>
                    {!item.is_active && (
                      <span className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                        Inactive
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">
                    {item.question}
                  </h3>
                  <p className="text-gray-600 whitespace-pre-wrap">{item.answer}</p>
                  {item.keywords && item.keywords.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.keywords.map((keyword, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded"
                        >
                          {keyword}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 ml-4">
                  <button
                    onClick={() => handleEdit(item)}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    <Edit2 className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {isEditing && editingItem && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-gray-800">
                  {editingItem.id ? 'Edit Item' : 'New Item'}
                </h3>
                <button
                  onClick={handleCancel}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Question
                  </label>
                  <input
                    type="text"
                    value={editingItem.question || ''}
                    onChange={(e) => setEditingItem({ ...editingItem, question: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="How do I...?"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Answer
                  </label>
                  <textarea
                    value={editingItem.answer || ''}
                    onChange={(e) => setEditingItem({ ...editingItem, answer: e.target.value })}
                    rows={6}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="You can..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Category
                  </label>
                  <input
                    type="text"
                    value={editingItem.category || ''}
                    onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="general"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Keywords (comma separated)
                  </label>
                  <input
                    type="text"
                    value={editingItem.keywords?.join(', ') || ''}
                    onChange={(e) => setEditingItem({
                      ...editingItem,
                      keywords: e.target.value.split(',').map(k => k.trim()).filter(Boolean)
                    })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="help, support, tutorial"
                  />
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Priority
                    </label>
                    <input
                      type="number"
                      value={editingItem.priority || 0}
                      onChange={(e) => setEditingItem({ ...editingItem, priority: parseInt(e.target.value) })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="is_active"
                      checked={editingItem.is_active ?? true}
                      onChange={(e) => setEditingItem({ ...editingItem, is_active: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <label htmlFor="is_active" className="text-sm font-medium text-gray-700">
                      Active
                    </label>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={handleSave}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <Save className="w-5 h-5" />
                  <span>Save</span>
                </button>
                <button
                  onClick={handleCancel}
                  className="px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
