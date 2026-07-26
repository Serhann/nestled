import type { Trigger } from '../types/chat';

/**
 * Proactive-message rules, evaluated in the browser.
 *
 * Framework-free on purpose: the matching rules are the part worth reading and
 * worth testing, and `state/useTriggers.ts` is only the React adapter that feeds
 * this engine and turns a match into a rendered nudge.
 *
 * Two behaviours are load-bearing:
 *  - a trigger fires AT MOST ONCE per visitor, persisted in localStorage, so a
 *    reload is not a second interruption;
 *  - a rule the engine cannot actually evaluate does not fire. Country
 *    restriction is the live case: the boot payload carries no resolved country,
 *    so a country-restricted trigger stays silent rather than firing everywhere.
 */

const VISITED_KEY = 'nestled_visited';
const EXECUTED_KEY = 'nestled_triggers_fired';

export interface TriggerContext {
  agentOnline: boolean;
  /** The HOST page URL, not the widget iframe's. */
  currentUrl: string;
}

export interface TriggerListeners {
  onLeaveIntent?(trigger: Trigger): void;
  onClickLink?(trigger: Trigger): void;
  onDelay?(trigger: Trigger): void;
}

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Glob match: `*` is the only metacharacter, everything else is literal. */
function matchesUrl(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(url);
}

function isMobile(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export class TriggerEngine {
  private triggers: Trigger[] = [];
  private executed: Set<string>;
  private readonly firstVisit: boolean;
  private teardown: Array<() => void> = [];

  constructor() {
    this.executed = readSet(EXECUTED_KEY);
    this.firstVisit = !localStorage.getItem(VISITED_KEY);
    try {
      localStorage.setItem(VISITED_KEY, '1');
    } catch {
      // Storage blocked: treat every load as a first visit rather than none.
    }
  }

  setTriggers(triggers: Trigger[]): void {
    // The boot payload is already ordered by priority; keep that order so two
    // eligible triggers resolve the same way the dashboard's list implies.
    this.triggers = triggers;
  }

  markExecuted(id: string): void {
    this.executed.add(id);
    try {
      localStorage.setItem(EXECUTED_KEY, JSON.stringify([...this.executed]));
    } catch {
      // Non-fatal: the trigger simply becomes repeatable for this visitor.
    }
  }

  hasFired(id: string): boolean {
    return this.executed.has(id);
  }

  /** Triggers whose non-event conditions hold right now. */
  evaluate(context: TriggerContext): Trigger[] {
    return this.triggers.filter((trigger) => {
      if (this.executed.has(trigger.id)) return false;

      const behaviors = trigger.behaviors ?? {};
      const platforms = trigger.platforms ?? {};
      const events = trigger.events ?? {};

      if (behaviors.execute_if_no_other_trigger && this.executed.size > 0) return false;
      if (behaviors.execute_if_online && !context.agentOnline) return false;
      if (behaviors.execute_on_first_visit && !this.firstVisit) return false;
      // Fail closed: without a resolved country we cannot honour the restriction.
      if (behaviors.country_restriction && behaviors.country_restriction.length > 0) return false;

      const mobile = isMobile();
      if (mobile && platforms.mobile_enabled === false) return false;
      if (!mobile && platforms.desktop_enabled === false) return false;

      if (events.on_pages && events.page_urls?.length) {
        if (!events.page_urls.some((p) => matchesUrl(p, context.currentUrl))) return false;
      }
      if (events.on_url_parameters && events.url_parameters) {
        const params = new URLSearchParams(context.currentUrl.split('?')[1] ?? '');
        for (const [key, value] of Object.entries(events.url_parameters)) {
          if (params.get(key) !== value) return false;
        }
      }
      return true;
    });
  }

  /** True when a trigger waits for an interaction rather than firing on load. */
  static isDeferred(trigger: Trigger): boolean {
    const e = trigger.events ?? {};
    return Boolean(e.after_delay || e.on_leave_intent || e.on_click_link);
  }

  /**
   * Arm the deferred triggers.
   *
   * Leave-intent and click listeners are bound to the WIDGET document, which is
   * an iframe — so they only see pointer events inside the panel. The host page
   * cannot be observed from here without granting the widget script access to
   * the customer's DOM, which is a trade we are not making; embed.js forwards
   * host-level leave intent instead when it is available.
   */
  arm(context: TriggerContext, listeners: TriggerListeners): () => void {
    const eligible = this.evaluate(context);

    const leave = eligible.filter((t) => t.events?.on_leave_intent);
    if (leave.length && listeners.onLeaveIntent) {
      const handler = (event: MouseEvent) => {
        if (event.clientY > 0) return;
        const next = leave.find((t) => !this.executed.has(t.id));
        if (!next) return;
        this.markExecuted(next.id);
        listeners.onLeaveIntent?.(next);
      };
      document.addEventListener('mouseout', handler);
      this.teardown.push(() => document.removeEventListener('mouseout', handler));
    }

    const clicks = eligible.filter((t) => t.events?.on_click_link && t.events.click_selectors?.length);
    if (clicks.length && listeners.onClickLink) {
      const handler = (event: MouseEvent) => {
        const target = event.target as Element | null;
        if (!target) return;
        for (const trigger of clicks) {
          if (this.executed.has(trigger.id)) continue;
          for (const selector of trigger.events?.click_selectors ?? []) {
            // A selector authored in the dashboard can be invalid; one bad rule
            // must not take out the others.
            try {
              if (!target.closest(selector)) continue;
            } catch {
              continue;
            }
            this.markExecuted(trigger.id);
            listeners.onClickLink?.(trigger);
            return;
          }
        }
      };
      document.addEventListener('click', handler);
      this.teardown.push(() => document.removeEventListener('click', handler));
    }

    for (const trigger of eligible) {
      const seconds = trigger.events?.after_delay ? (trigger.events.delay_seconds ?? 0) : 0;
      if (seconds <= 0 || !listeners.onDelay) continue;
      const timer = setTimeout(() => {
        if (this.executed.has(trigger.id)) return;
        this.markExecuted(trigger.id);
        listeners.onDelay?.(trigger);
      }, seconds * 1000);
      this.teardown.push(() => clearTimeout(timer));
    }

    return () => {
      for (const fn of this.teardown) fn();
      this.teardown = [];
    };
  }
}
