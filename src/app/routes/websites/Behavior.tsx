import { useWebsiteSettings } from './WebsiteLayout';
import { Section } from '../../../ui/Card';
import { Field, Select, TextArea, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { Locked } from '../../../ui/Locked';

/** How the widget behaves: AI, welcome message, uploads, sound, replay. */
export default function Behavior() {
  const { data, save } = useWebsiteSettings();
  const settings = data.settings;

  return (
    <div className="space-y-4">
      <Section
        title="AI replies"
        description="Nestled's AI answers from your knowledge base. It hands over to a person when it does not know."
      >
        <div className="space-y-4">
          <Toggle
            checked={settings.ai_enabled}
            onChange={(v) => save({ ai_enabled: v })}
            label="Let the AI reply"
          />
          {settings.ai_enabled && (
            <>
              <Field label="When should it answer?">
                {(a) => (
                  <Select
                    {...a}
                    value={settings.ai_response_mode}
                    onChange={(e) =>
                      save({ ai_response_mode: e.target.value as typeof settings.ai_response_mode })
                    }
                  >
                    <option value="first_message">Only the first message</option>
                    <option value="when_no_agent_online">Whenever nobody is online</option>
                    <option value="always">Always, until it hands over</option>
                    <option value="off">Never</option>
                  </Select>
                )}
              </Field>
              <Field
                label="Who is it?"
                hint="Tell it what your business does and what it should not talk about."
              >
                {(a) => (
                  <TextArea
                    {...a}
                    rows={4}
                    value={settings.system_prompt ?? ''}
                    onChange={(e) => save({ system_prompt: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="House rules"
                hint="Extra instructions. These never override the rules that stop it inventing account details or refusing to hand over."
              >
                {(a) => (
                  <TextArea
                    {...a}
                    rows={3}
                    value={settings.ai_extra_rules ?? ''}
                    onChange={(e) => save({ ai_extra_rules: e.target.value })}
                  />
                )}
              </Field>
            </>
          )}
        </div>
      </Section>

      <Section title="Opening message">
        <div className="space-y-4">
          <Toggle
            checked={settings.auto_welcome_enabled}
            onChange={(v) => save({ auto_welcome_enabled: v })}
            label="Say hello automatically"
            description="Sent once, after a delay, if the visitor has not opened the chat."
          />
          {settings.auto_welcome_enabled && (
            <>
              <Field label="Message">
                {(a) => (
                  <TextInput
                    {...a}
                    value={settings.auto_welcome_message ?? ''}
                    onChange={(e) => save({ auto_welcome_message: e.target.value })}
                    placeholder="Hi! Anything we can help with?"
                  />
                )}
              </Field>
              <Field label="After how many seconds?">
                {(a) => (
                  <TextInput
                    {...a}
                    type="number"
                    min={0}
                    max={300}
                    value={settings.auto_welcome_delay}
                    onChange={(e) => save({ auto_welcome_delay: Number(e.target.value) })}
                  />
                )}
              </Field>
            </>
          )}
        </div>
      </Section>

      <Section title="In the chat">
        <div className="space-y-1">
          <Toggle
            checked={settings.file_upload_enabled}
            onChange={(v) => save({ file_upload_enabled: v })}
            label="Let visitors attach files"
          />
          <Toggle
            checked={settings.sound_enabled}
            onChange={(v) => save({ sound_enabled: v })}
            label="Play a sound on a new message"
          />
          <Toggle
            checked={settings.starters_enabled}
            onChange={(v) => save({ starters_enabled: v })}
            label="Show conversation starters"
          />
          <Toggle
            checked={settings.reset_after_resolve}
            onChange={(v) => save({ reset_after_resolve: v })}
            label="Start fresh after a chat is resolved"
            description="Off, and the visitor keeps seeing the old transcript when they come back."
          />
          <Toggle
            checked={settings.transcript_email_enabled}
            onChange={(v) => save({ transcript_email_enabled: v })}
            label="Email the transcript when a chat ends"
          />
        </div>
      </Section>

      <Section
        title="Live view"
        description="Watch a visitor's screen while you help them. Recording only happens while you are actually watching."
      >
        {data.plan_features.live_view ? (
          <Toggle
            checked={settings.live_view_enabled}
            onChange={(v) => save({ live_view_enabled: v })}
            label="Enable live view"
          />
        ) : (
          <Locked feature="Live view">
            <Toggle checked={false} onChange={() => undefined} label="Enable live view" />
          </Locked>
        )}
      </Section>
    </div>
  );
}
