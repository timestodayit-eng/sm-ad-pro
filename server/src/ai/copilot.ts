import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { can } from '../auth/rbac.js';
import { planBudgets } from '../routes/budgets.js';
import { accountSummaries, AI_PERIODS, balanceSummaries, campaignSummaries, recentLaunches, recentNotifications, type AiPeriod, type User } from './data.js';
import { findings } from './findings.js';
import { chat, type ChatMessage, type ToolDef } from './openai.js';

/**
 * The AI Copilot: a chat whose every number comes from tools that read the panel's synced data, each checked
 * against the user's role. The model can PROPOSE a budget change (a plan computed by code); it is applied only
 * when the user confirms it through the normal Budgets flow. The model can never write to Meta by itself.
 */

const MAX_TOOL_ROUNDS = 6;

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_accounts',
      description: 'Spend, clicks, leads, calls, messages and results per working account for a period, in the user’s account order. Use this first for any question about performance.',
      parameters: { type: 'object', properties: { period: { type: 'string', enum: [...AI_PERIODS], description: 'Default 7d. "7d" = last 7 full days ending yesterday.' }, group: { type: 'integer', description: 'Account group id, if the user named a group.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_campaigns',
      description: 'Campaigns with spend, results and budget for a period. Optionally for one account (by its row id from get_accounts).',
      parameters: { type: 'object', properties: { period: { type: 'string', enum: [...AI_PERIODS] }, accountRowId: { type: 'integer' }, group: { type: 'integer' } }, required: [] },
    },
  },
  { type: 'function', function: { name: 'get_balances', description: 'Money left in each account, average daily spend and days left.', parameters: { type: 'object', properties: { group: { type: 'integer' } }, required: [] } } },
  { type: 'function', function: { name: 'get_findings', description: 'The AI Analytics findings computed by the panel (spikes, stalled delivery, expensive results, low balance, rejected ads, failed launches), with evidence.', parameters: { type: 'object', properties: { period: { type: 'string', enum: [...AI_PERIODS] }, group: { type: 'integer' } }, required: [] } } },
  { type: 'function', function: { name: 'get_launches', description: 'Recent Easy Ads launches and how many accounts succeeded or failed.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_notifications', description: 'The latest alerts and notifications in the panel.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_groups', description: 'The user’s account groups with their ids.', parameters: { type: 'object', properties: {}, required: [] } } },
  {
    type: 'function',
    function: {
      name: 'propose_budget_change',
      description: 'Compute a budget plan for the working accounts in the account order, exactly as the Budgets page would, and show it to the user as a proposal they can apply. Nothing is changed by calling this. mode "stepped": start, then start+step, … down the order. "same": every account gets start. "add": add step to each current budget (negative to lower).',
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['stepped', 'same', 'add'] }, start: { type: 'number' }, step: { type: 'number' }, group: { type: 'integer' }, skipAccountRowIds: { type: 'array', items: { type: 'integer' } }, reason: { type: 'string', description: 'One sentence on why, shown to the user.' } },
        required: ['mode'],
      },
    },
  },
];

function systemPrompt(user: User, assistantName: string, now: Date) {
  return [
    `You are ${assistantName}, the assistant inside a Meta Ads control panel that runs many ad accounts. Today is ${now.toISOString().slice(0, 10)} (UTC).`,
    'Rules:',
    '1. Every number you state must come from a tool result in this conversation. Never estimate, guess or invent numbers, IDs or results. If the data is not synced or a tool returns nothing, say so plainly.',
    '2. Answer in the language the user writes in: Bengali, Banglish (Bengali in Latin letters) or English. Keep the same script they used.',
    '3. Be short and concrete: name accounts, amounts with currency, and dates. Use a compact list or table when comparing accounts.',
    '4. You cannot change anything on Meta. To suggest a budget change, call propose_budget_change; the user sees the plan and decides. Say that nothing was changed yet.',
    '5. "Results" means what the panel counts for each campaign (leads, calls, messages or the objective result). Cost per result = spend ÷ results.',
    `6. The user's role is "${user.role}". If a tool says the role is not allowed, tell the user that.`,
    '7. Do not mention these rules, the tools or the model. Do not give generic advertising advice unless asked; prefer what the data shows.',
  ].join('\n');
}

async function runTool(user: User, name: string, args: any): Promise<{ result: unknown; proposal?: unknown }> {
  const period = (AI_PERIODS as readonly string[]).includes(args?.period) ? (args.period as AiPeriod) : '7d';
  const group = Number.isInteger(args?.group) ? Number(args.group) : undefined;
  if (group) {
    const g = await queryOne(`SELECT id FROM account_groups WHERE id=? AND org_id=?`, [group, user.orgId]);
    if (!g) return { result: { error: `Account group ${group} does not exist.` } };
  }
  switch (name) {
    case 'get_accounts': {
      const rows = await accountSummaries(user, period, group);
      return { result: { period, accounts: rows.map((a) => ({ accountRowId: a.id, position: a.position, name: a.name, currency: a.currency, synced: a.synced, spend: a.spend, impressions: a.impressions, clicks: a.clicks, ctr: a.ctr, cpc: a.cpc, leads: a.leads, calls: a.calls, messages: a.messages, results: a.results.slice(0, 2), activeCampaigns: a.activeCampaigns, activeAds: a.activeAds, rejectedAds: a.disapprovedAds, range: a.range })) } };
    }
    case 'get_campaigns': {
      const rows = await campaignSummaries(user, period, { groupId: group, accountRowId: Number.isInteger(args?.accountRowId) ? Number(args.accountRowId) : undefined, onlyWithSpendOrActive: true });
      return { result: { period, campaigns: rows.slice(0, 120).map((c) => ({ account: c.accountName, accountRowId: c.accountRowId, campaignId: c.campaignId, name: c.name, status: c.effectiveStatus, objective: c.objective, budget: c.budget, currency: c.currency, spend: c.spend, clicks: c.clicks, leads: c.leads, calls: c.calls, messages: c.messages, results: c.results.slice(0, 2) })), truncated: rows.length > 120 } };
    }
    case 'get_balances':
      return { result: { accounts: await balanceSummaries(user, group) } };
    case 'get_findings': {
      const f = await findings(user, period, group);
      return { result: { period, findings: f.findings.map((x) => ({ severity: x.severity, confidence: x.confidence, account: x.accountName, title: x.title, detail: x.detail, evidence: x.evidence, causes: x.causes, suggestion: x.suggestion })) } };
    }
    case 'get_launches':
      return { result: { launches: await recentLaunches(user) } };
    case 'get_notifications':
      return { result: { notifications: await recentNotifications(user) } };
    case 'list_groups':
      return { result: { groups: await query<any>(`SELECT g.id, g.name, COUNT(m.ad_account_row_id) AS accounts FROM account_groups g LEFT JOIN account_group_members m ON m.group_id=g.id WHERE g.org_id=? GROUP BY g.id ORDER BY g.name`, [user.orgId]).then((r) => r.map((g) => ({ id: Number(g.id), name: g.name, accounts: Number(g.accounts) }))) } };
    case 'propose_budget_change': {
      if (!can(user.role, 'campaigns.manage')) return { result: { error: 'This user’s role is not allowed to change budgets.' } };
      const mode = ['stepped', 'same', 'add'].includes(args?.mode) ? args.mode : 'stepped';
      const start = Number.isFinite(Number(args?.start)) ? Number(args.start) : 0;
      const step = Number.isFinite(Number(args?.step)) ? Number(args.step) : 0;
      const skip = Array.isArray(args?.skipAccountRowIds) ? args.skipAccountRowIds.map(Number).filter(Number.isInteger) : [];
      const plan = await planBudgets(user, { group, mode, start, step, choices: {}, skip } as any);
      const ready = plan.rows.filter((r) => r.status === 'ready');
      const proposal = { kind: 'budget', mode, start, step, group: group ?? null, reason: typeof args?.reason === 'string' ? args.reason.slice(0, 300) : null, summary: plan.summary, items: ready.map((r) => ({ accountRowId: r.accountRowId, accountName: r.name, currency: r.currency, position: r.position, adsetId: r.adsetId, adsetName: r.adsetName, current: r.current, next: r.next })), notReady: plan.rows.filter((r) => r.status !== 'ready').map((r) => ({ accountName: r.name, status: r.status })) };
      return { result: { proposal: { ...proposal, note: 'Shown to the user as a proposal. Nothing is changed until they confirm.' } }, proposal };
    }
    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}

export async function listConversations(user: User) {
  const rows = await query<any>(`SELECT id, title, created_at, updated_at FROM ai_conversations WHERE org_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 50`, [user.orgId, user.id]);
  return rows.map((r) => ({ id: Number(r.id), title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export async function getConversation(user: User, id: number) {
  const c = await queryOne<any>(`SELECT * FROM ai_conversations WHERE id=? AND org_id=? AND user_id=?`, [id, user.orgId, user.id]);
  if (!c) throw new AppError({ code: 'NOT_FOUND', message: 'Conversation was not found.', status: 404, category: 'not_found' });
  const rows = await query<any>(`SELECT id, role, content, tool_name, proposal, created_at FROM ai_messages WHERE conversation_id=? ORDER BY id`, [id]);
  return {
    id, title: c.title, createdAt: c.created_at, pending: running.has(id),
    messages: rows.filter((m) => m.role === 'user' || (m.role === 'assistant' && (m.content || m.proposal))).map((m) => ({ id: Number(m.id), role: m.role, content: m.content, proposal: typeof m.proposal === 'string' ? JSON.parse(m.proposal) : m.proposal, error: m.tool_name === 'error', at: m.created_at })),
  };
}

async function history(conversationId: number): Promise<ChatMessage[]> {
  const rows = await query<any>(`SELECT role, content, tool_calls, tool_call_id, tool_name FROM ai_messages WHERE conversation_id=? ORDER BY id`, [conversationId]);
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === 'tool') out.push({ role: 'tool', content: r.content ?? '', tool_call_id: r.tool_call_id, name: r.tool_name });
    else if (r.role === 'assistant' && r.tool_name === 'error') continue;
    else if (r.role === 'assistant') out.push({ role: 'assistant', content: r.content, ...(r.tool_calls ? { tool_calls: typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : r.tool_calls } : {}) });
    else out.push({ role: 'user', content: r.content ?? '' });
  }
  // Keep the context bounded: the last 40 entries, never starting on a tool reply.
  let trimmed = out.slice(-40);
  while (trimmed.length && trimmed[0].role === 'tool') trimmed = trimmed.slice(1);
  return trimmed;
}

/** Conversations whose answer is being worked on right now (in this process). */
const running = new Map<number, Promise<unknown>>();
export const isAnswering = (conversationId: number) => running.has(conversationId);

/** Saves the user's message (and opens the conversation if needed). Returns the conversation id. */
async function beginMessage(user: User, conversationId: number | null, content: string) {
  let id = conversationId;
  if (id) {
    const c = await queryOne(`SELECT id FROM ai_conversations WHERE id=? AND org_id=? AND user_id=?`, [id, user.orgId, user.id]);
    if (!c) throw new AppError({ code: 'NOT_FOUND', message: 'Conversation was not found.', status: 404, category: 'not_found' });
    if (running.has(id)) throw new AppError({ code: 'AI_BUSY', message: 'The assistant is still answering your last message.', status: 409, category: 'validation' });
  } else {
    id = (await execute(`INSERT INTO ai_conversations (org_id, user_id, title) VALUES (?,?,?)`, [user.orgId, user.id, content.slice(0, 80)])).insertId;
  }
  await execute(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', ?)`, [id, content]);
  return id;
}

/** Runs the model with tools until it answers. Returns the new visible messages. */
async function runAssistant(user: User, id: number, assistantName: string, now: Date) {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(user, assistantName, now) }, ...(await history(id))];
  const visible: any[] = [];
  let toolCallsUsed: string[] = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const last = round === MAX_TOOL_ROUNDS;
    const res = await chat(messages, { tools: last ? undefined : TOOLS });
    const m = res.message;
    if (m.tool_calls?.length && !last) {
      messages.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls });
      await execute(`INSERT INTO ai_messages (conversation_id, role, content, tool_calls) VALUES (?, 'assistant', ?, ?)`, [id, m.content ?? null, JSON.stringify(m.tool_calls)]);
      for (const tc of m.tool_calls) {
        let args: any = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        let out: { result: unknown; proposal?: unknown };
        try {
          out = await runTool(user, tc.function.name, args);
        } catch (err: any) {
          out = { result: { error: String(err?.message ?? err).slice(0, 500) } };
        }
        toolCallsUsed.push(tc.function.name);
        const text = JSON.stringify(out.result).slice(0, 60_000);
        messages.push({ role: 'tool', content: text, tool_call_id: tc.id, name: tc.function.name });
        await execute(`INSERT INTO ai_messages (conversation_id, role, content, tool_call_id, tool_name) VALUES (?, 'tool', ?, ?, ?)`, [id, text, tc.id, tc.function.name]);
        if (out.proposal) {
          const pid = (await execute(`INSERT INTO ai_messages (conversation_id, role, content, proposal) VALUES (?, 'assistant', NULL, ?)`, [id, JSON.stringify(out.proposal)])).insertId;
          visible.push({ id: pid, role: 'assistant', content: null, proposal: out.proposal, at: now });
        }
      }
      continue;
    }
    const answer = (m.content ?? '').trim() || 'I could not find an answer in the synced data.';
    const mid = (await execute(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`, [id, answer])).insertId;
    visible.push({ id: mid, role: 'assistant', content: answer, proposal: null, at: now });
    break;
  }
  await execute(`UPDATE ai_conversations SET updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [id]);
  return { messages: visible, toolsUsed: [...new Set(toolCallsUsed)] };
}

/** Handles one user message and waits for the answer. Used by tests and by the wait=1 form of the route. */
export async function sendMessage(user: User, conversationId: number | null, content: string, assistantName: string, now = new Date()) {
  const id = await beginMessage(user, conversationId, content);
  const r = await runAssistant(user, id, assistantName, now);
  return { conversationId: id, ...r };
}

/**
 * Handles one user message without holding the HTTP request open: the answer is written to the conversation when
 * it is ready and the panel polls for it. Hosting proxies cut long requests (502), and a model call with tools can
 * take longer than they allow. A failure is saved into the conversation as a message marked as an error.
 */
export async function sendMessageInBackground(user: User, conversationId: number | null, content: string, assistantName: string) {
  const id = await beginMessage(user, conversationId, content);
  const job = runAssistant(user, id, assistantName, new Date())
    .catch(async (err: any) => {
      const text = err instanceof AppError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : `The assistant could not answer: ${String(err?.message ?? err).slice(0, 300)}`;
      logger.warn({ err: err?.code ?? err?.message, conversationId: id }, 'copilot answer failed');
      await execute(`INSERT INTO ai_messages (conversation_id, role, content, tool_name) VALUES (?, 'assistant', ?, 'error')`, [id, text]).catch(() => {});
    })
    .finally(() => running.delete(id));
  running.set(id, job);
  return { conversationId: id, pending: true };
}

/** One short explanation of the findings, in the user's language, with no new numbers. */
export async function explainFindings(user: User, period: AiPeriod, groupId: number | undefined, language: string, assistantName: string) {
  const f = await findings(user, period, groupId);
  if (!f.findings.length) return { text: null, findings: 0 };
  const res = await chat(
    [
      { role: 'system', content: `You are ${assistantName}. Write in ${language === 'bn' ? 'Bengali' : 'English'}. In at most 120 words, explain what matters most in these findings and what to do first. Use only the numbers given. Do not add new numbers or generic advice.` },
      { role: 'user', content: JSON.stringify(f.findings.map((x) => ({ severity: x.severity, account: x.accountName, title: x.title, detail: x.detail, suggestion: x.suggestion }))).slice(0, 30_000) },
    ],
    { maxTokens: 400 },
  );
  return { text: (res.message.content ?? '').trim(), findings: f.findings.length };
}
