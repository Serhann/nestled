import type { Trigger } from '../types/chat';

export class TriggerEngine {
  private triggers: Trigger[] = [];
  private executedTriggers: Set<string> = new Set();
  private isFirstVisit: boolean = false;
  private userCountry: string | null = null;

  constructor() {
    this.isFirstVisit = !localStorage.getItem('chatbot_visited');
    if (this.isFirstVisit) {
      localStorage.setItem('chatbot_visited', 'true');
    }

    this.loadExecutedTriggers();
  }

  /**
   * Country is resolved server-side (GeoLite2) and injected by the widget via
   * GET /api/geo — no client-side ipapi.co call (which leaked IPs and blew the
   * free tier at one request per pageload).
   */
  setCountry(countryCode: string | null) {
    this.userCountry = countryCode;
  }

  private loadExecutedTriggers() {
    const stored = localStorage.getItem('chatbot_executed_triggers');
    if (stored) {
      try {
        const triggers = JSON.parse(stored);
        this.executedTriggers = new Set(triggers);
      } catch (e) {
        console.error('Failed to load executed triggers:', e);
      }
    }
  }

  private saveExecutedTrigger(triggerId: string) {
    this.executedTriggers.add(triggerId);
    localStorage.setItem(
      'chatbot_executed_triggers',
      JSON.stringify(Array.from(this.executedTriggers))
    );
  }

  setTriggers(triggers: Trigger[]) {
    this.triggers = triggers.sort((a, b) => a.priority - b.priority);
  }

  private isMobileDevice(): boolean {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );
  }

  private matchesUrlPattern(pattern: string, url: string): boolean {
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(url);
  }

  private checkUrlParameters(params: Record<string, string>): boolean {
    const urlParams = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(params)) {
      if (urlParams.get(key) !== value) {
        return false;
      }
    }
    return true;
  }

  async evaluateTriggers(context: {
    isOnline: boolean;
    currentUrl: string;
  }): Promise<Trigger[]> {
    const matchedTriggers: Trigger[] = [];

    for (const trigger of this.triggers) {
      if (!trigger.is_active) continue;

      const { events, behaviors, platforms } = trigger;
      if (!events || !behaviors || !platforms) continue;

      if (behaviors.execute_if_no_other_trigger && this.executedTriggers.size > 0) {
        continue;
      }

      if (behaviors.execute_if_online && !context.isOnline) {
        continue;
      }

      if (behaviors.execute_on_first_visit && !this.isFirstVisit) {
        continue;
      }

      if (behaviors.country_restriction.length > 0) {
        if (!this.userCountry || !behaviors.country_restriction.includes(this.userCountry)) {
          continue;
        }
      }

      const isMobile = this.isMobileDevice();
      if (isMobile && !platforms.mobile_enabled) continue;
      if (!isMobile && !platforms.desktop_enabled) continue;

      if (events.on_pages && events.page_urls.length > 0) {
        const urlMatches = events.page_urls.some(pattern =>
          this.matchesUrlPattern(pattern, context.currentUrl)
        );
        if (!urlMatches) continue;
      }

      if (events.on_url_parameters && Object.keys(events.url_parameters).length > 0) {
        if (!this.checkUrlParameters(events.url_parameters)) continue;
      }

      matchedTriggers.push(trigger);
    }

    return matchedTriggers;
  }

  setupEventListeners(callbacks: {
    onLeaveIntent?: (trigger: Trigger) => void;
    onClickLink?: (trigger: Trigger) => void;
    onDelay?: (trigger: Trigger) => void;
  }) {
    const exitIntentTriggers = this.triggers.filter(
      t => t.is_active && t.events?.on_leave_intent
    );

    if (exitIntentTriggers.length > 0 && callbacks.onLeaveIntent) {
      let hasShownExitIntent = false;

      const handleMouseLeave = (e: MouseEvent) => {
        if (hasShownExitIntent) return;
        if (e.clientY <= 0) {
          hasShownExitIntent = true;
          for (const trigger of exitIntentTriggers) {
            if (!this.executedTriggers.has(trigger.id)) {
              callbacks.onLeaveIntent?.(trigger);
              this.saveExecutedTrigger(trigger.id);
              break;
            }
          }
        }
      };

      document.addEventListener('mouseout', handleMouseLeave);
    }

    const clickLinkTriggers = this.triggers.filter(
      t => t.is_active && t.events?.on_click_link && t.events.click_selectors.length > 0
    );

    if (clickLinkTriggers.length > 0 && callbacks.onClickLink) {
      const handleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;

        for (const trigger of clickLinkTriggers) {
          if (!trigger.events || this.executedTriggers.has(trigger.id)) continue;

          for (const selector of trigger.events.click_selectors) {
            if (target.matches(selector) || target.closest(selector)) {
              callbacks.onClickLink?.(trigger);
              this.saveExecutedTrigger(trigger.id);
              return;
            }
          }
        }
      };

      document.addEventListener('click', handleClick);
    }

    const delayTriggers = this.triggers.filter(
      t => t.is_active && t.events?.after_delay && t.events.delay_seconds > 0
    );

    if (delayTriggers.length > 0 && callbacks.onDelay) {
      for (const trigger of delayTriggers) {
        if (this.executedTriggers.has(trigger.id)) continue;
        if (!trigger.events) continue;

        setTimeout(() => {
          if (!this.executedTriggers.has(trigger.id)) {
            callbacks.onDelay?.(trigger);
            this.saveExecutedTrigger(trigger.id);
          }
        }, trigger.events.delay_seconds * 1000);
      }
    }
  }

  markTriggerExecuted(triggerId: string) {
    this.saveExecutedTrigger(triggerId);
  }

  hasExecutedAnyTrigger(): boolean {
    return this.executedTriggers.size > 0;
  }
}
