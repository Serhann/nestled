import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { platformCan, platformRead } from './guards.js';
import { actionCatalog, validatePreamble } from '../../services/ai/actions.js';
import { DEFAULT_PREAMBLE, resolvePreamble } from '../../services/ai/preamble.js';
import { previewSystemPrompt } from '../../services/ai/prompt.js';
import { settings } from '../../services/platform/settings.js';

/**
 * The assistant's instructions for one website.
 *
 * This is the answer to a specific complaint: a customer could change what their assistant
 * KNOWS (their prompt, their knowledge base) but nobody could change what it DOES — above
 * all, when it stops trying and fetches a human. That behaviour lived in string constants
 * in the server, so "hand off sooner for this customer" was a code change.
 *
 * Three things this endpoint has to get right, or the feature is a footgun:
 *
 *   - **Show the fallback.** An empty field means "use the install's, or ours". Rendering
 *     that as a blank box invites somebody to paste a whole new prompt when they meant to
 *     adjust one sentence, so the GET returns every tier and which one is in force.
 *   - **Reject typos.** `{{handof}}` stores fine, ships literal braces to the model, and
 *     silently stops handing off. The check runs here, while a human is looking.
 *   - **Show the assembly.** The preamble is one of six blocks, and the two fixed ones sit
 *     UNDER everything an operator writes. Somebody rewriting the handoff policy should be
 *     able to see that the syntax contract is still there.
 */

export async function platformAiPromptRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Readable with plain panel access. It is our own instructions, not customer content:
   * the audience for "why did the assistant hand this off" is wider than the set of people
   * who may rewrite it.
   */
  app.get(
    '/platform/workspaces/:id/websites/:websiteId/prompt',
    { preHandler: platformRead },
    async (req, reply) => {
      const { id, websiteId } = req.params as { id: string; websiteId: string };
      const site = await load(id, websiteId);
      if (!site) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ prompt: describe(site) });
    },
  );

  /**
   * Needs `ai:prompt`. No second factor: unlike the install-wide settings this touches one
   * customer, is visible in their own audit log, and is undone by clearing the field.
   */
  app.patch(
    '/platform/workspaces/:id/websites/:websiteId/prompt',
    { preHandler: platformCan('ai:prompt') },
    async (req, reply) => {
      const { id, websiteId } = req.params as { id: string; websiteId: string };
      // '' clears the override — the same gesture as everywhere else in the panel, and the
      // only way back to a default that improves in later releases.
      const body = parseBody(
        z.object({ ai_preamble: z.string().max(8000) }),
        req.body,
        reply,
      );
      if (!body) return;

      const site = await load(id, websiteId);
      if (!site) return reply.code(404).send({ error: 'Not found' });

      const value = body.ai_preamble.trim();
      if (value) {
        const problem = validatePreamble(value);
        if (problem) {
          return reply
            .code(400)
            .send({ error: problem.message, code: 'preamble_invalid', field: 'ai_preamble' });
        }
      }

      // upsert, not update: a website whose settings row was never written has no row to
      // update, and "the customer has not opened the behaviour page yet" must not be the
      // reason support cannot tune their assistant.
      await unscopedPrisma.website_settings.upsert({
        where: { website_id: websiteId },
        create: { website_id: websiteId, workspace_id: id, ai_preamble: value || null },
        update: { ai_preamble: value || null },
      });

      /**
       * Written into the CUSTOMER's audit log, and the text goes in the details.
       *
       * Their assistant now says something we told it to say. If that turns into "your bot
       * refused to escalate my complaint", the only useful record is the exact wording that
       * was in force and who put it there — a row saying `fields: [ai_preamble]` would send
       * somebody digging through a diff that does not exist.
       */
      await audit(req, {
        action: 'platform.ai_prompt_updated',
        workspaceId: id,
        targetType: 'website',
        targetId: websiteId,
        details: { cleared: value === '', preamble: value || null },
      });

      const fresh = await load(id, websiteId);
      return reply.send({ prompt: fresh ? describe(fresh) : null });
    },
  );
}

interface SiteRow {
  name: string;
  settings: { ai_preamble: string | null; system_prompt: string | null; ai_extra_rules: string | null } | null;
}

/** Scoped to the workspace in the path, so a mistyped id cannot edit another customer. */
async function load(workspaceId: string, websiteId: string): Promise<SiteRow | null> {
  return unscopedPrisma.websites.findFirst({
    where: { id: websiteId, workspace_id: workspaceId },
    select: {
      name: true,
      settings: { select: { ai_preamble: true, system_prompt: true, ai_extra_rules: true } },
    },
  });
}

function describe(site: SiteRow) {
  const install = settings().ai.preamble;
  const resolved = resolvePreamble(site.settings?.ai_preamble, install);

  return {
    website_name: site.name,
    /** Which tier is in force. */
    source: resolved.source,
    /** The stored overrides, placeholders intact — what an editor is seeded with. */
    website: site.settings?.ai_preamble ?? null,
    install: install ?? null,
    default: DEFAULT_PREAMBLE,
    effective_template: resolved.template,
    actions: {
      catalog: actionCatalog(),
      /** Enabled for THIS website, which for anything but handoff means "referenced". */
      enabled: [...resolved.actions.keys()],
      values: Object.fromEntries([...resolved.actions].map(([name, values]) => [name, values])),
    },
    /** The whole system prompt as the model receives it. */
    assembled: previewSystemPrompt({
      preamble: resolved.text,
      systemPrompt: site.settings?.system_prompt?.trim() || '',
      extraRules: site.settings?.ai_extra_rules,
      actions: resolved.actions,
    }),
  };
}
