/**
 * The fanout seam.
 *
 * Every realtime publish goes through here, so swapping the in-process
 * implementation for Redis pub/sub in Phase 14 is one new file plus a config flag
 * rather than a rewrite of every call site.
 *
 * v1 is explicitly SINGLE-REPLICA. Not "probably fine" — architecturally
 * required: agent sockets, the presence board and the rrweb replay buffers all
 * live in this process's memory, so an agent connected to replica 1 would never
 * see an event published by replica 2. Deploy exactly one API container and scale
 * it vertically. `@fastify/rate-limit`'s in-process store shares the constraint.
 */

export type Topic = `ws:${string}` | `conv:${string}` | `site:${string}`;

export interface Bus {
  publish(topic: Topic, payload: unknown): void;
  subscribe(topic: Topic, fn: (payload: unknown) => void): () => void;
}

function createInProcessBus(): Bus {
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    publish(topic, payload) {
      const set = subscribers.get(topic);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch {
          // A broken subscriber must not stop delivery to the others.
        }
      }
    },
    subscribe(topic, fn) {
      let set = subscribers.get(topic);
      if (!set) {
        set = new Set();
        subscribers.set(topic, set);
      }
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (set!.size === 0) subscribers.delete(topic);
      };
    },
  };
}

export const bus: Bus = createInProcessBus();

export const workspaceTopic = (workspaceId: string): Topic => `ws:${workspaceId}`;
export const conversationTopic = (conversationId: string): Topic => `conv:${conversationId}`;
export const websiteTopic = (websiteId: string): Topic => `site:${websiteId}`;
