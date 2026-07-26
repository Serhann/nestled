import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db/prisma.js';
import { requireVisitor, requireAgent } from '../plugins/auth.js';
import { verifyAccessToken, tokenMatchesHash } from '../auth/tokens.js';
import { insertMessage } from '../lib/messages.js';
import { notifyNewMessage } from '../services/discord.js';
import { pushVisitorMessage } from '../services/push.js';

// Conservative allowlist — images + common documents. Everything else is 415.
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);

function kindOf(mime: string): 'image' | 'file' {
  return mime.startsWith('image/') ? 'image' : 'file';
}

/**
 * Read a multipart upload, validate size/type, persist to disk, record the
 * attachment, and create a message that references it. Shared by the visitor
 * and agent upload routes; `sender` differs.
 */
async function handleUpload(
  conversationId: string,
  file: { filename: string; mimetype: string; buffer: Buffer },
  sender: { type: 'visitor' | 'agent'; id: string | null; agent?: { name: string; avatar_url: string | null } },
) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return { error: 'unsupported_type' as const };
  }
  const ext = extname(file.filename).slice(0, 12) || '';
  const id = crypto.randomUUID();
  const storagePath = join(env.UPLOAD_DIR, conversationId, `${id}${ext}`);
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, file.buffer);

  const attachment = await prisma.attachments.create({
    data: {
      id,
      conversation_id: conversationId,
      filename: file.filename,
      mime: file.mimetype,
      size_bytes: file.buffer.length,
      storage_path: storagePath,
    },
  });
  if (!attachment) return { error: 'store_failed' as const };

  const meta: Record<string, unknown> = {
    attachment: {
      id,
      filename: file.filename,
      mime: file.mimetype,
      size: file.buffer.length,
      kind: kindOf(file.mimetype),
      url: `/api/attachments/${id}`,
    },
  };
  if (sender.type === 'agent' && sender.agent) meta.agent = sender.agent;
  const message = await insertMessage({
    conversationId,
    content: file.filename,
    senderType: sender.type,
    senderId: sender.id,
    metadata: meta,
  });
  if (message) {
    await prisma.attachments.update({ where: { id }, data: { message_id: message.id } });
  }
  return { message };
}

async function readFilePart(req: {
  file: () => Promise<
    { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined
  >;
}): Promise<{ filename: string; mimetype: string; buffer: Buffer } | null> {
  const part = await req.file();
  if (!part) return null;
  const buffer = await part.toBuffer();
  return { filename: part.filename, mimetype: part.mimetype, buffer };
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  // Visitor upload (scoped to their conversation via token).
  app.post('/api/conversations/:id/attachments', {
    preHandler: requireVisitor('id'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = await readFilePart(req);
    if (!file) return reply.code(400).send({ error: 'No file' });

    const result = await handleUpload(id, file, { type: 'visitor', id: null });
    if ('error' in result) {
      return reply.code(result.error === 'unsupported_type' ? 415 : 500).send({ error: result.error });
    }
    void notifyNewMessage(id, `[attachment] ${file.filename}`, 'visitor');
    void (async () => {
      const conv = await prisma.conversations.findUnique({
        where: { id },
        select: { visitor_name: true },
      });
      await pushVisitorMessage(id, conv?.visitor_name ?? null, `📎 ${file.filename}`);
    })();
    return reply.code(201).send({ message: result.message });
  });

  // Agent upload.
  app.post('/api/agent/conversations/:id/attachments', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.conversations.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'Conversation not found' });

    const file = await readFilePart(req);
    if (!file) return reply.code(400).send({ error: 'No file' });

    const me = await prisma.agents.findUnique({
      where: { id: req.agent!.id },
      select: { name: true, avatar_url: true },
    });
    const result = await handleUpload(id, file, {
      type: 'agent',
      id: req.agent!.id,
      agent: { name: me?.name ?? 'Agent', avatar_url: me?.avatar_url ?? null },
    });
    if ('error' in result) {
      return reply.code(result.error === 'unsupported_type' ? 415 : 500).send({ error: result.error });
    }
    return reply.code(201).send({ message: result.message });
  });

  // Authenticated serve. Images can't send an Authorization header from <img>,
  // so a visitor passes ?token=<visitor token>; agents use the header or ?jwt=.
  app.get('/api/attachments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { token?: string; jwt?: string };

    const att = await prisma.attachments.findUnique({
      where: { id },
      include: { conversation: { select: { visitor_token_hash: true } } },
    });
    if (!att) return reply.code(404).send({ error: 'Not found' });

    let authorized = false;
    if (q.token && tokenMatchesHash(q.token, att.conversation.visitor_token_hash)) {
      authorized = true;
    } else {
      const header = req.headers.authorization;
      const jwt = q.jwt ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
      if (jwt) {
        try {
          verifyAccessToken(jwt);
          authorized = true;
        } catch {
          /* fall through to 401 */
        }
      }
    }
    if (!authorized) return reply.code(401).send({ error: 'Unauthorized' });

    reply.header('Content-Type', att.mime);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(att.filename)}"`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(createReadStream(att.storage_path));
  });
}
