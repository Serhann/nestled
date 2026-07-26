import type { BootPayload, Starter } from '../../types/chat';
import type { Copy } from '../copy';
import type { Availability } from '../state/useAgentAvailability';
import type { ConversationState } from '../state/useConversation';
import { FormRenderer } from './FormRenderer';
import { Home } from './Home';
import { OfflineForm } from './OfflineForm';
import { RatingForm } from './RatingForm';
import { Thread } from './Thread';

/**
 * Which of the six screens the panel body is showing.
 *
 * One place decides, and it decides from state alone — no screen reaches out to
 * open another. The pre-tenant widget interleaved these as eight nested ternaries
 * inside a 1,700-line component, and the result was combinations nobody had
 * considered: a rating form over a live thread, a pre-chat form that reappeared
 * after the agent had already replied.
 */

export type View = 'auto' | 'prechat' | 'intake' | 'rating';

export interface ScreenProps {
  view: View;
  boot: BootPayload;
  copy: Copy;
  chat: ConversationState;
  availability: Availability;
  starters: Starter[];
  intake: Starter | null;
  nudge: string | null;
  ratingSent: boolean;
  /** Nobody is around, and no AI will answer: collect an email instead. */
  offline: boolean;
  atHome: boolean;
  onPreChat(values: Record<string, string>): void;
  onIntakeSubmit(starter: Starter, values: Record<string, string>): void;
  onIntakeCancel(): void;
  onStarter(starter: Starter): void;
  onPlainChat(): void;
  onOfflineSubmit(email: string, message: string): Promise<boolean>;
  onRate(value: { stars: number; tags: string[]; comment: string }): void;
  onRatingDone(): void;
}

export function Screen(props: ScreenProps) {
  const { view, boot, copy, chat, availability, intake } = props;

  if (view === 'rating') {
    return (
      <RatingForm
        copy={copy}
        tags={boot.behavior?.rating_tags ?? []}
        busy={chat.sending}
        sent={props.ratingSent}
        onSubmit={props.onRate}
        onDone={props.onRatingDone}
      />
    );
  }

  if (view === 'prechat') {
    return (
      <div className="n-body">
        <FormRenderer
          heading={copy.preChatHeading}
          fields={boot.behavior?.pre_chat_fields ?? []}
          submitLabel={copy.preChatSubmit}
          busy={chat.sending}
          onSubmit={props.onPreChat}
        />
      </div>
    );
  }

  if (view === 'intake' && intake) {
    return (
      <div className="n-body">
        <FormRenderer
          heading={intake.label}
          fields={intake.fields}
          submitLabel={copy.preChatSubmit}
          busy={chat.sending}
          onSubmit={(values) => props.onIntakeSubmit(intake, values)}
          onCancel={props.onIntakeCancel}
        />
      </div>
    );
  }

  if (props.offline) return <OfflineForm copy={copy} onSubmit={props.onOfflineSubmit} />;

  if (props.atHome) {
    return (
      <Home
        copy={copy}
        online={availability.online}
        starters={props.starters}
        busy={chat.sending}
        onStarter={props.onStarter}
        onPlainChat={props.onPlainChat}
      />
    );
  }

  return (
    <Thread
      messages={chat.messages}
      nudge={props.nudge}
      contextCard={chat.contextCard}
      agentTyping={chat.agentTyping}
      busy={chat.sending}
      botStepsEnabled={!chat.escalated}
      onBotAnswer={(text) => void chat.send(text)}
    />
  );
}
