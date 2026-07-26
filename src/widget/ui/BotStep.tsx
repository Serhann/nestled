import type { BotStep as BotStepPayload, MessageMetadata } from '../../types/chat';
import { FormRenderer } from './FormRenderer';

/**
 * The interactive part of a bot turn.
 *
 * Flows execute on the SERVER (see the bot_flow_runs table). The widget never
 * holds a flow, never decides what comes next, and never branches: it receives
 * ordinary messages, and a message may carry a hint describing the one thing to
 * draw underneath it. Answering posts a normal visitor message and the server
 * advances the run.
 *
 * That runtime is being built in parallel, so everything here is defensive. An
 * absent hint, an unknown shape, choices with no labels — all of them render
 * nothing rather than throwing, because a half-finished bot must degrade into a
 * plain chat, not into a broken widget.
 */

export function readBotStep(metadata: MessageMetadata | undefined): BotStepPayload | null {
  const raw = metadata?.bot_step ?? metadata?.['bot:step'];
  if (!raw || typeof raw !== 'object') return null;
  const step = raw as BotStepPayload;
  const hasChoices = Array.isArray(step.choices) && step.choices.length > 0;
  const hasFields = Array.isArray(step.fields) && step.fields.length > 0;
  return hasChoices || hasFields ? step : null;
}

export function BotStep({
  step,
  busy,
  onAnswer,
}: {
  step: BotStepPayload;
  busy: boolean;
  onAnswer(text: string): void;
}) {
  const choices = (step.choices ?? []).filter((c) => c && typeof c.label === 'string' && c.label);

  if (choices.length > 0) {
    return (
      <div className="n-chips">
        {choices.map((choice) => (
          <button
            key={choice.value ?? choice.label}
            className="n-chip"
            disabled={busy}
            // The LABEL is sent, not the value: it is what the visitor believes
            // they said, and it is what has to read sensibly in the transcript
            // an agent picks the conversation up from.
            onClick={() => onAnswer(choice.label)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <FormRenderer
      fields={step.fields ?? []}
      submitLabel={step.submit_label || 'Continue'}
      busy={busy}
      onSubmit={(values) =>
        onAnswer(
          Object.entries(values)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n'),
        )
      }
    />
  );
}
