import { useWebsiteSettings } from './WebsiteLayout';
import { Section } from '../../../ui/Card';
import { Toggle } from '../../../ui/Toggle';
import { FormBuilder } from './FormBuilder';

/**
 * The pre-chat form.
 *
 * Worth a warning rather than a neutral toggle: every question here is a wall
 * between a visitor and asking for help. Two fields is usually the most a chat
 * widget can ask for without measurably fewer conversations starting.
 */
export default function Forms() {
  const { data, save } = useWebsiteSettings();
  const settings = data.settings;

  return (
    <div className="space-y-4">
      <Section
        title="Before the chat starts"
        description="Asking for a name and an email is normal. Asking for six things is a form, and people leave."
      >
        <Toggle
          checked={settings.pre_chat_enabled}
          onChange={(v) => save({ pre_chat_enabled: v })}
          label="Ask for details before the first message"
        />
      </Section>

      {settings.pre_chat_enabled && (
        <Section title="Questions" description="Drag to reorder.">
          <FormBuilder
            fields={settings.pre_chat_fields ?? []}
            onChange={(fields) => save({ pre_chat_fields: fields })}
          />
          {(settings.pre_chat_fields?.length ?? 0) > 3 && (
            <p className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2">
              That is a lot to ask before someone has said hello. You can always collect the rest
              during the conversation.
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
