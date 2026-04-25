import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Trash2, Save, Zap, ChevronRight } from 'lucide-react';
import type { Trigger, TriggerAction, TriggerEvent, TriggerBehavior, TriggerPlatform } from '../../types/chat';

export function TriggersPanel() {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [formData, setFormData] = useState<{
    name: string;
    is_active: boolean;
    priority: number;
    actions: Partial<TriggerAction>;
    events: Partial<TriggerEvent>;
    behaviors: Partial<TriggerBehavior>;
    platforms: Partial<TriggerPlatform>;
  }>({
    name: '',
    is_active: true,
    priority: 0,
    actions: {
      show_message: false,
      message_content: '',
      localized_messages: {},
      open_chatbox: false,
      play_sound: false
    },
    events: {
      on_leave_intent: false,
      on_click_link: false,
      click_selectors: [],
      on_pages: false,
      page_urls: [],
      on_url_parameters: false,
      url_parameters: {},
      on_user_event: false,
      user_event_name: '',
      on_user_data: false,
      user_data_conditions: {},
      after_delay: false,
      delay_seconds: 5
    },
    behaviors: {
      show_as_website: false,
      execute_if_online: false,
      execute_on_first_visit: false,
      execute_if_no_other_trigger: false,
      country_restriction: []
    },
    platforms: {
      desktop_enabled: true,
      mobile_enabled: true
    }
  });

  useEffect(() => {
    loadTriggers();
  }, []);

  const loadTriggers = async () => {
    const { data: triggersData } = await supabase
      .from('triggers')
      .select('*')
      .order('priority', { ascending: true });

    if (triggersData) {
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
      setTriggers(triggersWithDetails);
    }
  };

  const handleCreateNew = () => {
    setSelectedTrigger(null);
    setIsCreating(true);
    setFormData({
      name: '',
      is_active: true,
      priority: 0,
      actions: {
        show_message: false,
        message_content: '',
        localized_messages: {},
        open_chatbox: false,
        play_sound: false
      },
      events: {
        on_leave_intent: false,
        on_click_link: false,
        click_selectors: [],
        on_pages: false,
        page_urls: [],
        on_url_parameters: false,
        url_parameters: {},
        on_user_event: false,
        user_event_name: '',
        on_user_data: false,
        user_data_conditions: {},
        after_delay: false,
        delay_seconds: 5
      },
      behaviors: {
        show_as_website: false,
        execute_if_online: false,
        execute_on_first_visit: false,
        execute_if_no_other_trigger: false,
        country_restriction: []
      },
      platforms: {
        desktop_enabled: true,
        mobile_enabled: true
      }
    });
  };

  const handleSelectTrigger = (trigger: Trigger) => {
    setSelectedTrigger(trigger);
    setIsCreating(false);
    setFormData({
      name: trigger.name,
      is_active: trigger.is_active,
      priority: trigger.priority,
      actions: trigger.actions || formData.actions,
      events: trigger.events || formData.events,
      behaviors: trigger.behaviors || formData.behaviors,
      platforms: trigger.platforms || formData.platforms
    });
  };

  const generateIdentifier = (name: string): string => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setMessage('Please enter a trigger name');
      return;
    }

    setIsSaving(true);
    setMessage('');

    try {
      if (isCreating) {
        const identifier = generateIdentifier(formData.name);

        const { data: triggerData, error: triggerError } = await supabase
          .from('triggers')
          .insert({
            name: formData.name,
            identifier,
            is_active: formData.is_active,
            priority: formData.priority
          })
          .select()
          .single();

        if (triggerError) throw triggerError;

        await Promise.all([
          supabase.from('trigger_actions').insert({ trigger_id: triggerData.id, ...formData.actions }),
          supabase.from('trigger_events').insert({ trigger_id: triggerData.id, ...formData.events }),
          supabase.from('trigger_behaviors').insert({ trigger_id: triggerData.id, ...formData.behaviors }),
          supabase.from('trigger_platforms').insert({ trigger_id: triggerData.id, ...formData.platforms })
        ]);

        setMessage('Trigger created successfully!');
        setIsCreating(false);
      } else if (selectedTrigger) {
        await supabase
          .from('triggers')
          .update({
            name: formData.name,
            identifier: generateIdentifier(formData.name),
            is_active: formData.is_active,
            priority: formData.priority
          })
          .eq('id', selectedTrigger.id);

        await Promise.all([
          supabase.from('trigger_actions').update(formData.actions).eq('trigger_id', selectedTrigger.id),
          supabase.from('trigger_events').update(formData.events).eq('trigger_id', selectedTrigger.id),
          supabase.from('trigger_behaviors').update(formData.behaviors).eq('trigger_id', selectedTrigger.id),
          supabase.from('trigger_platforms').update(formData.platforms).eq('trigger_id', selectedTrigger.id)
        ]);

        setMessage('Trigger updated successfully!');
      }

      await loadTriggers();
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error saving trigger:', error);
      setMessage('Error saving trigger');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this trigger?')) return;

    try {
      await supabase.from('triggers').delete().eq('id', id);
      setMessage('Trigger deleted successfully!');
      setSelectedTrigger(null);
      setIsCreating(false);
      await loadTriggers();
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error deleting trigger:', error);
      setMessage('Error deleting trigger');
    }
  };

  const toggleTriggerActive = async (trigger: Trigger) => {
    try {
      await supabase
        .from('triggers')
        .update({ is_active: !trigger.is_active })
        .eq('id', trigger.id);
      await loadTriggers();
    } catch (error) {
      console.error('Error toggling trigger:', error);
    }
  };

  const addToArray = (field: 'click_selectors' | 'page_urls' | 'country_restriction') => {
    const value = prompt(`Enter value for ${field}:`);
    if (value) {
      const currentArray = field === 'country_restriction'
        ? (formData.behaviors[field] || [])
        : (formData.events[field] || []);

      if (field === 'country_restriction') {
        setFormData({
          ...formData,
          behaviors: {
            ...formData.behaviors,
            [field]: [...currentArray, value]
          }
        });
      } else {
        setFormData({
          ...formData,
          events: {
            ...formData.events,
            [field]: [...currentArray, value]
          }
        });
      }
    }
  };

  const removeFromArray = (field: 'click_selectors' | 'page_urls' | 'country_restriction', index: number) => {
    if (field === 'country_restriction') {
      const newArray = [...(formData.behaviors[field] || [])];
      newArray.splice(index, 1);
      setFormData({
        ...formData,
        behaviors: {
          ...formData.behaviors,
          [field]: newArray
        }
      });
    } else {
      const newArray = [...(formData.events[field] || [])];
      newArray.splice(index, 1);
      setFormData({
        ...formData,
        events: {
          ...formData.events,
          [field]: newArray
        }
      });
    }
  };

  return (
    <div className="flex h-full bg-gray-50">
      <div className="w-80 bg-white border-r border-gray-200 overflow-y-auto">
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={handleCreateNew}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Trigger
          </button>
        </div>

        <div className="divide-y divide-gray-200">
          {triggers.map((trigger) => (
            <div
              key={trigger.id}
              className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                selectedTrigger?.id === trigger.id ? 'bg-blue-50' : ''
              }`}
              onClick={() => handleSelectTrigger(trigger)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-blue-600" />
                  <span className="font-medium text-gray-900">{trigger.name}</span>
                </div>
                <label className="relative inline-flex items-center cursor-pointer" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={trigger.is_active}
                    onChange={() => toggleTriggerActive(trigger)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              <div className="text-xs text-gray-500">Priority: {trigger.priority}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {(selectedTrigger || isCreating) ? (
          <div className="max-w-4xl mx-auto">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-200">
                <h2 className="text-2xl font-bold text-gray-900 mb-4">
                  {isCreating ? 'Create New Trigger' : 'Edit Trigger'}
                </h2>

                {message && (
                  <div className={`p-3 rounded-lg mb-4 ${
                    message.includes('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                  }`}>
                    {message}
                  </div>
                )}

                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Trigger Name
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter trigger name"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Priority
                      </label>
                      <input
                        type="number"
                        value={formData.priority}
                        onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      <p className="text-xs text-gray-500 mt-1">Lower values = higher priority</p>
                    </div>
                    <div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.is_active}
                          onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Active</span>
                      </label>
                    </div>
                  </div>

                  <div className="border-t border-gray-200 pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <ChevronRight className="w-5 h-5" />
                      Actions
                    </h3>

                    <div className="space-y-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.actions.show_message}
                          onChange={(e) => setFormData({
                            ...formData,
                            actions: { ...formData.actions, show_message: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Show Message</span>
                      </label>

                      {formData.actions.show_message && (
                        <textarea
                          value={formData.actions.message_content || ''}
                          onChange={(e) => setFormData({
                            ...formData,
                            actions: { ...formData.actions, message_content: e.target.value }
                          })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          rows={3}
                          placeholder="Enter message content"
                        />
                      )}

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.actions.open_chatbox}
                          onChange={(e) => setFormData({
                            ...formData,
                            actions: { ...formData.actions, open_chatbox: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Open Chatbox</span>
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.actions.play_sound}
                          onChange={(e) => setFormData({
                            ...formData,
                            actions: { ...formData.actions, play_sound: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Play Sound</span>
                      </label>
                    </div>
                  </div>

                  <div className="border-t border-gray-200 pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <ChevronRight className="w-5 h-5" />
                      Events
                    </h3>

                    <div className="space-y-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.events.on_leave_intent}
                          onChange={(e) => setFormData({
                            ...formData,
                            events: { ...formData.events, on_leave_intent: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">On Leave Intent</span>
                      </label>

                      <div>
                        <label className="flex items-center gap-2 cursor-pointer mb-2">
                          <input
                            type="checkbox"
                            checked={formData.events.on_click_link}
                            onChange={(e) => setFormData({
                              ...formData,
                              events: { ...formData.events, on_click_link: e.target.checked }
                            })}
                            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                          />
                          <span className="text-sm font-medium text-gray-700">On Click Link</span>
                        </label>
                        {formData.events.on_click_link && (
                          <div className="ml-6 space-y-2">
                            <button
                              onClick={() => addToArray('click_selectors')}
                              className="text-sm text-blue-600 hover:text-blue-700"
                            >
                              + Add CSS Selector
                            </button>
                            {(formData.events.click_selectors || []).map((selector, idx) => (
                              <div key={idx} className="flex items-center gap-2">
                                <span className="text-sm text-gray-600">{selector}</span>
                                <button
                                  onClick={() => removeFromArray('click_selectors', idx)}
                                  className="text-red-600 hover:text-red-700"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="flex items-center gap-2 cursor-pointer mb-2">
                          <input
                            type="checkbox"
                            checked={formData.events.on_pages}
                            onChange={(e) => setFormData({
                              ...formData,
                              events: { ...formData.events, on_pages: e.target.checked }
                            })}
                            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                          />
                          <span className="text-sm font-medium text-gray-700">On Specific Pages</span>
                        </label>
                        {formData.events.on_pages && (
                          <div className="ml-6 space-y-2">
                            <button
                              onClick={() => addToArray('page_urls')}
                              className="text-sm text-blue-600 hover:text-blue-700"
                            >
                              + Add URL Pattern
                            </button>
                            {(formData.events.page_urls || []).map((url, idx) => (
                              <div key={idx} className="flex items-center gap-2">
                                <span className="text-sm text-gray-600">{url}</span>
                                <button
                                  onClick={() => removeFromArray('page_urls', idx)}
                                  className="text-red-600 hover:text-red-700"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="flex items-center gap-2 cursor-pointer mb-2">
                          <input
                            type="checkbox"
                            checked={formData.events.after_delay}
                            onChange={(e) => setFormData({
                              ...formData,
                              events: { ...formData.events, after_delay: e.target.checked }
                            })}
                            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                          />
                          <span className="text-sm font-medium text-gray-700">After Delay</span>
                        </label>
                        {formData.events.after_delay && (
                          <div className="ml-6">
                            <input
                              type="number"
                              value={formData.events.delay_seconds}
                              onChange={(e) => setFormData({
                                ...formData,
                                events: { ...formData.events, delay_seconds: parseInt(e.target.value) || 0 }
                              })}
                              className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            />
                            <span className="ml-2 text-sm text-gray-600">seconds</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-gray-200 pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <ChevronRight className="w-5 h-5" />
                      Behaviors
                    </h3>

                    <div className="space-y-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.behaviors.show_as_website}
                          onChange={(e) => setFormData({
                            ...formData,
                            behaviors: { ...formData.behaviors, show_as_website: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Show as Website Message</span>
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.behaviors.execute_if_online}
                          onChange={(e) => setFormData({
                            ...formData,
                            behaviors: { ...formData.behaviors, execute_if_online: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Execute Only if Agents Online</span>
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.behaviors.execute_on_first_visit}
                          onChange={(e) => setFormData({
                            ...formData,
                            behaviors: { ...formData.behaviors, execute_on_first_visit: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Execute Only on First Visit</span>
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.behaviors.execute_if_no_other_trigger}
                          onChange={(e) => setFormData({
                            ...formData,
                            behaviors: { ...formData.behaviors, execute_if_no_other_trigger: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Execute Only if No Other Trigger Fired</span>
                      </label>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Country Restrictions
                        </label>
                        <button
                          onClick={() => addToArray('country_restriction')}
                          className="text-sm text-blue-600 hover:text-blue-700 mb-2"
                        >
                          + Add Country Code
                        </button>
                        <div className="space-y-2">
                          {(formData.behaviors.country_restriction || []).map((country, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <span className="text-sm text-gray-600">{country}</span>
                              <button
                                onClick={() => removeFromArray('country_restriction', idx)}
                                className="text-red-600 hover:text-red-700"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-gray-200 pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <ChevronRight className="w-5 h-5" />
                      Platforms
                    </h3>

                    <div className="space-y-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.platforms.desktop_enabled}
                          onChange={(e) => setFormData({
                            ...formData,
                            platforms: { ...formData.platforms, desktop_enabled: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Desktop Devices</span>
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.platforms.mobile_enabled}
                          onChange={(e) => setFormData({
                            ...formData,
                            platforms: { ...formData.platforms, mobile_enabled: e.target.checked }
                          })}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700">Mobile Devices</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-gray-50 border-t border-gray-200 flex justify-between">
                {!isCreating && selectedTrigger && (
                  <button
                    onClick={() => handleDelete(selectedTrigger.id)}
                    className="flex items-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                )}
                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={() => {
                      setSelectedTrigger(null);
                      setIsCreating(false);
                    }}
                    className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" />
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-500">
              <Zap className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg">Select a trigger to edit or create a new one</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
