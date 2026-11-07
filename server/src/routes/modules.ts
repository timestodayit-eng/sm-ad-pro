import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/pool.js';
import { asyncHandler, parse } from '../lib/http.js';
import { requirePermission } from '../auth/sessions.js';
import { audit } from '../services/audit.js';
import { audienceInput, audienceProblems, audienceSpec, deleteAudience, deletePlacementSet, estimateAudience, listAudiences, listPlacementSets, placementSetInput, saveAudience, savePlacementSet } from '../services/audiences.js';
import { LEVELS, METRICS, buildReport, deleteTemplate, listTemplates, reportConfig, reportCsv, saveTemplate, templateInput } from '../services/reports.js';
import { addEntry, deleteEntry, deleteRate, entryInput, financeCsv, financeQuery, financeSummary, listRates, rateInput, saveRate } from '../services/finance.js';
import { ALL_KINDS, KIND_LABEL, connectionsStatus, getSettings, recentRuns, saveSettings, scanOrg, settingsInput, systemChecks } from '../services/monitoring.js';
import { NEEDED_SCOPES, hideComment, hideInput, listPages, pageComments, recentActions, replyInput, replyToComment, suggestInput, suggestReply } from '../services/comments.js';
import { findings } from '../ai/findings.js';
import { aiConfigured } from '../ai/openai.js';
import { PLACEMENTS, DEFAULT_PLACEMENTS } from '../services/launch.js';
import { managedAccounts } from './live.js';

export const modulesRouter = Router();
const idParam = z.coerce.number().int().positive();

// ---------------------------------------------------------------- Audience Manager
modulesRouter.get('/audiences', requirePermission('accounts.read'), asyncHandler(async (req, res) => res.json({ items: await listAudiences(req.user!.orgId) })));
modulesRouter.post('/audiences/check', requirePermission('accounts.read'), asyncHandler(async (req, res) => res.json({ problems: audienceProblems(parse(audienceInput, req.body ?? {})) })));
modulesRouter.post('/audiences', requirePermission('campaigns.draft'), asyncHandler(async (req, res) => {
  const input = parse(audienceInput, req.body ?? {});
  const id = await saveAudience(req.user!, input);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'audience.created', targetType: 'audience', targetId: String(id), details: { name: input.name }, ip: req.ip });
  res.status(201).json({ id });
}));
modulesRouter.put('/audiences/:id', requirePermission('campaigns.draft'), asyncHandler(async (req, res) => {
  const id = parse(idParam, req.params.id);
  await saveAudience(req.user!, parse(audienceInput, req.body ?? {}), id);
  res.json({ id });
}));
modulesRouter.delete('/audiences/:id', requirePermission('campaigns.draft'), asyncHandler(async (req, res) => {
  const id = parse(idParam, req.params.id);
  await deleteAudience(req.user!.orgId, id);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'audience.deleted', targetType: 'audience', targetId: String(id), ip: req.ip });
  res.json({ ok: true });
}));
/** Meta's reach estimate for an audience in the chosen working accounts (read live). */
modulesRouter.post('/audiences/estimate', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
  const { spec, specialCategory, accountRowIds, goal } = parse(z.object({ spec: audienceSpec, specialCategory: z.enum(['NONE', 'EMPLOYMENT']).default('NONE'), accountRowIds: z.array(z.number().int().positive()).min(1).max(20), goal: z.enum(['call', 'website']).default('call') }), req.body ?? {});
  const allowed = new Set((await managedAccounts(req.user!)).map((a) => Number(a.id)));
  const items = [];
  for (const id of accountRowIds.filter((x) => allowed.has(x))) {
    try {
      items.push({ ...(await estimateAudience(req.user!.orgId, id, spec, specialCategory, goal)), error: null });
    } catch (err: any) {
      items.push({ accountRowId: id, accountName: null, low: null, high: null, ready: null, error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  res.json({ items });
}));

// ---------------------------------------------------------------- Placements
modulesRouter.get('/placement-sets', requirePermission('accounts.read'), asyncHandler(async (req, res) => res.json({ items: await listPlacementSets(req.user!.orgId), placements: Object.entries(PLACEMENTS).map(([value, p]) => ({ value, label: p.label, platform: p.platform })), defaultPlacements: DEFAULT_PLACEMENTS })));
modulesRouter.post('/placement-sets', requirePermission('campaigns.draft'), asyncHandler(async (req, res) => res.status(201).json({ id: await savePlacementSet(req.user!, parse(placementSetInput, req.body ?? {})) })));
modulesRouter.put('/placement-sets/:id', requirePermission('campaigns.draft'), asyncHandler(async (req, res) => { const id = parse(idParam, req.params.id); await savePlacementSet(req.user!, parse(placementSetInput, req.body ?? {}), id); res.json({ id }); }));
modulesRouter.delete('/placement-sets/:id', requirePermission('campaigns.draft'), asyncHandler(async (req, res) => { await deletePlacementSet(req.user!.orgId, parse(idParam, req.params.id)); res.json({ ok: true }); }));

// ---------------------------------------------------------------- Custom Reports
modulesRouter.get('/reports/options', requirePermission('reports.read'), asyncHandler(async (req, res) => {
  const accounts = await managedAccounts(req.user!);
  res.json({ metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label, kind: m.kind })), levels: LEVELS, accounts: accounts.map((a, i) => ({ id: Number(a.id), name: a.name, currency: a.currency, position: i + 1 })), templates: await listTemplates(req.user!.orgId) });
}));
modulesRouter.post('/reports/run', requirePermission('reports.read'), asyncHandler(async (req, res) => res.json(await buildReport(req.user!, parse(reportConfig, req.body ?? {})))));
/** GET form for the browser's download link: the config travels base64-encoded in ?c=. */
modulesRouter.get('/reports/export.csv', requirePermission('reports.read'), asyncHandler(async (req, res) => {
  let raw: unknown = {};
  try { raw = JSON.parse(Buffer.from(String(req.query.c ?? ''), 'base64url').toString('utf8')); } catch { raw = {}; }
  const cfg = parse(reportConfig, raw);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${cfg.level}-${cfg.period}.csv"`);
  res.send(reportCsv(await buildReport(req.user!, cfg)));
}));
modulesRouter.post('/reports/export.csv', requirePermission('reports.read'), asyncHandler(async (req, res) => {
  const cfg = parse(reportConfig, req.body ?? {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${cfg.level}-${cfg.period}.csv"`);
  res.send(reportCsv(await buildReport(req.user!, cfg)));
}));
modulesRouter.post('/reports/templates', requirePermission('reports.manage'), asyncHandler(async (req, res) => res.status(201).json({ id: await saveTemplate(req.user!, parse(templateInput, req.body ?? {})) })));
modulesRouter.put('/reports/templates/:id', requirePermission('reports.manage'), asyncHandler(async (req, res) => { const id = parse(idParam, req.params.id); await saveTemplate(req.user!, parse(templateInput, req.body ?? {}), id); res.json({ id }); }));
modulesRouter.delete('/reports/templates/:id', requirePermission('reports.manage'), asyncHandler(async (req, res) => { await deleteTemplate(req.user!.orgId, parse(idParam, req.params.id)); res.json({ ok: true }); }));

// ---------------------------------------------------------------- Finance
modulesRouter.get('/finance', requirePermission('reports.read'), asyncHandler(async (req, res) => res.json(await financeSummary(req.user!, parse(financeQuery, req.query ?? {})))));
modulesRouter.get('/finance/export.csv', requirePermission('reports.read'), asyncHandler(async (req, res) => {
  const q = parse(financeQuery, req.query ?? {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="finance-${q.period}.csv"`);
  res.send(financeCsv(await financeSummary(req.user!, q)));
}));
modulesRouter.get('/finance/rates', requirePermission('reports.read'), asyncHandler(async (req, res) => res.json({ items: await listRates(req.user!.orgId) })));
modulesRouter.put('/finance/rates', requirePermission('reports.manage'), asyncHandler(async (req, res) => {
  const input = parse(rateInput, req.body ?? {});
  await saveRate(req.user!, input);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'finance.rate_set', targetType: 'currency', targetId: input.currency, details: input, ip: req.ip });
  res.json({ ok: true });
}));
modulesRouter.delete('/finance/rates/:currency', requirePermission('reports.manage'), asyncHandler(async (req, res) => { await deleteRate(req.user!.orgId, parse(z.string().regex(/^[A-Z]{3}$/), req.params.currency)); res.json({ ok: true }); }));
modulesRouter.post('/finance/entries', requirePermission('reports.manage'), asyncHandler(async (req, res) => {
  const input = parse(entryInput, req.body ?? {});
  const id = await addEntry(req.user!, input);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'finance.entry_added', targetType: 'finance_entry', targetId: String(id), details: input, ip: req.ip });
  res.status(201).json({ id });
}));
modulesRouter.delete('/finance/entries/:id', requirePermission('reports.manage'), asyncHandler(async (req, res) => { await deleteEntry(req.user!.orgId, parse(idParam, req.params.id)); res.json({ ok: true }); }));

// ---------------------------------------------------------------- Monitoring
modulesRouter.get('/monitoring', requirePermission('health.read'), asyncHandler(async (req, res) => {
  const orgId = req.user!.orgId;
  const settings = await getSettings(orgId);
  const f = await findings(req.user!, '7d');
  const system = await systemChecks(orgId, settings);
  const schedule = await queryOne<any>(`SELECT is_enabled, interval_seconds, last_enqueued_at FROM recurring_schedules WHERE name='monitor_scan'`);
  res.json({
    settings, kinds: ALL_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })), runs: await recentRuns(orgId), connections: await connectionsStatus(orgId),
    findings: [...f.findings, ...system], accounts: f.accounts,
    schedule: schedule ? { enabled: Boolean(schedule.is_enabled), intervalMinutes: Math.round(Number(schedule.interval_seconds) / 60), lastEnqueuedAt: schedule.last_enqueued_at } : null,
  });
}));
modulesRouter.put('/monitoring/settings', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const s = parse(settingsInput, req.body ?? {});
  await saveSettings(req.user!, s);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'monitoring.settings_changed', details: s, ip: req.ip });
  res.json(s);
}));
modulesRouter.post('/monitoring/scan', requirePermission('health.read'), asyncHandler(async (req, res) => {
  const r = await scanOrg(req.user!.orgId);
  res.json({ runId: r.runId, accounts: r.accounts, findings: r.findings.length, alerts: r.alerts });
}));

// ---------------------------------------------------------------- Comments
modulesRouter.get('/comments/pages', requirePermission('accounts.read'), asyncHandler(async (req, res) => res.json({ items: await listPages(req.user!.orgId), neededScopes: NEEDED_SCOPES, aiConfigured: aiConfigured(), actions: await recentActions(req.user!.orgId) })));
modulesRouter.get('/comments/pages/:pageId', requirePermission('accounts.read'), asyncHandler(async (req, res) => res.json(await pageComments(req.user!.orgId, parse(z.string().regex(/^\d+$/), req.params.pageId)))));
modulesRouter.post('/comments/reply', requirePermission('campaigns.manage', 'reply to comments'), asyncHandler(async (req, res) => {
  const input = parse(replyInput, req.body ?? {});
  const r = await replyToComment(req.user!, input);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'comment.replied', targetType: 'comment', targetId: input.commentId, details: { pageId: input.pageId, replyId: r.id }, ip: req.ip });
  res.json(r);
}));
modulesRouter.post('/comments/hide', requirePermission('campaigns.manage', 'hide comments'), asyncHandler(async (req, res) => {
  const input = parse(hideInput, req.body ?? {});
  const r = await hideComment(req.user!, input);
  await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: input.hidden ? 'comment.hidden' : 'comment.unhidden', targetType: 'comment', targetId: input.commentId, details: { pageId: input.pageId }, ip: req.ip });
  res.json(r);
}));
modulesRouter.post('/comments/suggest', requirePermission('ai.use'), asyncHandler(async (req, res) => {
  const b = await queryOne<any>(`SELECT ai_assistant_name FROM branding_settings WHERE org_id=? LIMIT 1`, [req.user!.orgId]).catch(() => null);
  res.json(await suggestReply(parse(suggestInput, req.body ?? {}), (b?.ai_assistant_name as string) || 'AI Ads Copilot'));
}));
