import { useEffect, useRef, useState } from 'react';
import type { BootPayload, Trigger } from '../../types/chat';
import { TriggerEngine } from '../../utils/triggerEngine';
import type { WidgetApi } from '../api';
import type { EmbedParams } from '../boot';

/**
 * React adapter over TriggerEngine.
 *
 * A fired trigger produces a LOCAL nudge — a bubble drawn in the panel — and
 * nothing else. No conversation is created until the visitor answers it, so a
 * proactive message that everyone ignores costs the customer neither a
 * conversation against their plan quota nor a row in their inbox.
 */

export interface TriggerNudge {
  triggerId: string;
  message: string;
}

interface Options {
  boot: BootPayload;
  params: EmbedParams;
  api: WidgetApi;
  agentOnline: boolean;
  /** Set by the trigger that produced the chat, for attribution. */
  onAttribute(triggerId: string): void;
  onOpen(): void;
  onSound(): void;
}

export function useTriggers(opts: Options): TriggerNudge | null {
  const [nudge, setNudge] = useState<TriggerNudge | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  // Triggers evaluate once per page load. `agentOnline` changing later must not
  // re-arm them, or a visitor watching an agent come online gets the same nudge
  // twice.
  const armed = useRef(false);

  useEffect(() => {
    if (armed.current) return;
    const triggers = latest.current.boot.triggers ?? [];
    if (triggers.length === 0) return;
    armed.current = true;

    const engine = new TriggerEngine();
    engine.setTriggers(triggers);

    const fire = (trigger: Trigger) => {
      const actions = trigger.actions;
      if (!actions) return;
      const o = latest.current;
      o.api.fireTrigger(trigger.id);
      o.onAttribute(trigger.id);
      if (actions.open_chatbox) o.onOpen();
      if (actions.show_message && actions.message_content) {
        setNudge({ triggerId: trigger.id, message: actions.message_content });
      }
      if (actions.play_sound) o.onSound();
      engine.markExecuted(trigger.id);
    };

    const context = {
      agentOnline: latest.current.agentOnline,
      currentUrl: latest.current.params.href,
    };

    const disarm = engine.arm(context, {
      onLeaveIntent: fire,
      onClickLink: fire,
      onDelay: fire,
    });

    // Immediate triggers: everything eligible that is not waiting for a delay,
    // an exit or a click.
    for (const trigger of engine.evaluate(context)) {
      if (TriggerEngine.isDeferred(trigger)) continue;
      fire(trigger);
    }

    return disarm;
  }, []);

  return nudge;
}
