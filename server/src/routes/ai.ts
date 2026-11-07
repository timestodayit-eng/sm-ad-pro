import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/pool.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { requirePermission } from '../auth/sessions.js';
import { audit } from '../services/audit.js';
import { AI_PERIODS } from '../ai/data.js';
import { explainFindings, getConversation, listConversations, sendMessage } from '../ai/copilot.js';
import { findings } from '../ai/findings.js';
import { createDocument, deleteDocument, getDocument, listDocuments, renderDocx, renderPdf, saveVersion } from '../ai/documents.js';
import { aiConfigured } from '../ai/openai.js';

export const aiRouter = Router();

async function assistantName(orgId: number) {
  const b = await queryOne<any>(`SELECT ai_assistant_name FROM branding_settings WHERE org_id=? LIMIT 1`, [orgId]).catch(() => null);
  return (b?.ai_assistant_name as string) || 'AI Ads Copilot';
}
const periodQ = z.object({ period: z.enum(AI_PERIODS).default('7d'), group: z.coerce.number().int().positive().optional(), lang: z.enum(['en', 'bn']).default('en') });

aiRouter.get('/ai/status', requirePermission('ai.use'), asyncHandler(async (req, res) => res.json({ configured: aiConfigured(), assistantName: await assistantName(req.user!.orgId) })));

// ---- Copilot
aiRouter.get('/ai/conversations', requirePermission('ai.use'), asyncHandler(async (req, res) => res.json({ items: await listConversations(req.user!) })));
aiRouter.get('/ai/conversations/:id', requirePermission('ai.use'), asyncHandler(async (req, res) => res.json(await getConversation(req.user!, parse(idParam, req.params.id)))));
aiRouter.post(
  '/ai/conversations/:id/messages',
  requirePermission('ai.use'),
  asyncHandler(async (req, res) => {
    const { content } = parse(z.object({ content: z.string().trim().min(1, 'Write a message.').max(4000) }), req.body ?? {});
    const idRaw = req.params.id;
    const id = idRaw === 'new' ? null : parse(idParam, idRaw);
    res.json(await sendMessage(req.user!, id, content, await assistantName(req.user!.orgId)));
  }),
);

// ---- Analytics
aiRouter.get(
  '/ai/findings',
  requirePermission('ai.use'),
  asyncHandler(async (req, res) => {
    const q = parse(periodQ, req.query);
    res.json({ ...(await findings(req.user!, q.period, q.group)), configured: aiConfigured() });
  }),
);
aiRouter.post(
  '/ai/findings/explain',
  requirePermission('ai.use'),
  asyncHandler(async (req, res) => {
    const q = parse(periodQ, req.body ?? {});
    res.json(await explainFindings(req.user!, q.period, q.group, q.lang, await assistantName(req.user!.orgId)));
  }),
);

// ---- Documents
aiRouter.get('/ai/documents', requirePermission('reports.read'), asyncHandler(async (req, res) => res.json({ items: await listDocuments(req.user!) })));
aiRouter.post(
  '/ai/documents',
  requirePermission('reports.manage', 'create documents'),
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ kind: z.literal('performance').default('performance'), title: z.string().trim().max(190).optional(), period: z.enum(AI_PERIODS).default('7d'), group: z.number().int().positive().optional(), language: z.enum(['en', 'bn']).default('en') }), req.body ?? {});
    if (input.group && !(await queryOne(`SELECT id FROM account_groups WHERE id=? AND org_id=?`, [input.group, req.user!.orgId])))
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account group was not found.' } });
    const id = await createDocument(req.user!, { kind: input.kind, title: input.title, params: { period: input.period, group: input.group, language: input.language } }, await assistantName(req.user!.orgId));
    await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'ai_document.created', targetType: 'ai_document', targetId: String(id), details: { period: input.period, group: input.group ?? null }, ip: req.ip });
    res.status(201).json({ id });
  }),
);
aiRouter.get('/ai/documents/:id', requirePermission('reports.read'), asyncHandler(async (req, res) => res.json(await getDocument(req.user!, parse(idParam, req.params.id), req.query.version ? Number(req.query.version) : undefined))));
aiRouter.put(
  '/ai/documents/:id',
  requirePermission('reports.manage', 'edit documents'),
  asyncHandler(async (req, res) => {
    const section = z.object({ id: z.string().max(40), title: z.string().trim().max(190), body: z.string().max(20_000), table: z.object({ columns: z.array(z.string().max(100)).max(20), rows: z.array(z.array(z.union([z.string().max(500), z.number(), z.null()])).max(20)).max(1000) }).nullable().optional(), ai: z.boolean().optional() });
    const input = parse(z.object({ title: z.string().trim().max(190).optional(), note: z.string().max(255).optional(), sections: z.array(section).min(1).max(40) }), req.body ?? {});
    res.json({ version: await saveVersion(req.user!, parse(idParam, req.params.id), input) });
  }),
);
aiRouter.delete('/ai/documents/:id', requirePermission('reports.manage', 'delete documents'), asyncHandler(async (req, res) => { await deleteDocument(req.user!, parse(idParam, req.params.id)); res.json({ ok: true }); }));
aiRouter.get(
  '/ai/documents/:id/export.:format',
  requirePermission('reports.read'),
  asyncHandler(async (req, res) => {
    const d = await getDocument(req.user!, parse(idParam, req.params.id), req.query.version ? Number(req.query.version) : undefined);
    const footer = `Ads Command Center · version ${d.version} · exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · numbers from the panel's synced Meta data`;
    const safe = d.title.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'report';
    if (req.params.format === 'docx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.docx"`);
      return res.send(await renderDocx(d, footer));
    }
    if (req.params.format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
      return res.send(await renderPdf(d, footer));
    }
    res.status(400).json({ error: { code: 'BAD_FORMAT', message: 'Use export.pdf or export.docx.' } });
  }),
);
