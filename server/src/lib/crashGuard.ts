import { recordUnhandledRejection } from '../services/platform/metrics.js';

/**
 * Why this file exists, in one incident.
 *
 * A visitor sent the first message in a conversation and got a 502. The widget said
 * "something went wrong". Nothing in the request handler was wrong:
 *
 *   Error: Vapid private key should be 32 bytes long when decoded.
 *       at validatePrivateKey (web-push/src/vapid-helper.js:132)
 *       at ensureConfigured (dist/services/push.js:29)
 *       at pushVisitorMessage (dist/services/push.js:105)
 *   Node.js v22.23.2
 *
 * A malformed VAPID key had been saved in the ops panel. `pushVisitorMessage` is called
 * as `void pushVisitorMessage(…)` — deliberately, because whether an agent's phone buzzes
 * is not part of whether a visitor's message was accepted. But an unhandled rejection
 * terminates the process by default in Node ≥15, so that one bad settings value did not
 * merely skip a notification: it killed the container mid-request, dropping the message
 * being written AND every other request in flight for every other customer.
 *
 * ── What this changes ──────────────────────────────────────────────────────────
 *
 * An unhandled rejection is now logged, counted, and survived. That is the correct trade
 * for THIS process: it serves many customers at once, and its notification paths are
 * fire-and-forget by design, so the blast radius of exiting is every visitor on the
 * install while the cause is one webhook, one key, one phone.
 *
 * The objection to swallowing them is real — a process in an unknown state should not
 * keep serving. It applies to `uncaughtException`, where the stack was interrupted
 * somewhere unknowable, and that one is therefore still fatal: logged, then re-thrown to
 * the default handler so the container restarts and Coolify notices. A rejected promise
 * is a different animal. It has a value, it has a stack, and nothing else was interrupted.
 *
 * ── Why the counter matters more than the log line ─────────────────────────────
 *
 * Surviving a crash silently is how a broken notification path lives for months. The
 * count is on ops → Health next to the retention sweep, for the same reason: the failure
 * mode of this file is that nobody ever looks.
 */
export function installCrashGuard(): void {
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    recordUnhandledRejection(err.message);
    // eslint-disable-next-line no-console
    console.error(
      '[crash-guard] an unhandled promise rejection was contained. This is a BUG in a ' +
        'fire-and-forget call — find it and make it catch its own failures.',
      err,
    );
  });

  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[crash-guard] uncaught exception — exiting', err);
    // Deliberately fatal. The stack was interrupted at an unknown point, so the process
    // cannot be trusted to keep serving; restarting is the safe move and the orchestrator
    // is what makes it a blip rather than an outage.
    throw err;
  });
}
