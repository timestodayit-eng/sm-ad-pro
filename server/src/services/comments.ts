import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { decryptConnectionToken } from '../meta/connections.js';
import { graph, MetaApiError } from '../meta/graph.js';
import { aiConfigured, chat } from '../ai/openai.js';

type User = Express.Request['user'] & {};

/**
 * Comments: the comments on your Pages' recent posts (ads included: an ad is a post on the Page), read live
 * from Meta, with reply and hide where the Page role and the login's permissions allow. Nothing is stored
 * except what the panel itself did (comment_actions). An AI draft is only a draft until a person presses Send.
 */
export const NEEDED_SCOPES = ['pages_read_user_content', 'pages_manage_engagement'];

async function pageAuth(orgId: number, pageId: string) {
  const p = await queryOne<any>(`SELECT p.page_id, p.name, p.tasks, c.token_ciphertext, c.scopes FROM meta_pages p JOIN meta_connections c ON c.id=p.connection_id WHERE p.org_id=? AND p.page_id=?`, [orgId, pageId]);
  if (!p) throw new AppError({ code: 'NOT_FOUND', message: 'Page was not found. Reconnect Meta if it is new.', status: 404, category: 'not_found' });
  const userToken = decryptConnectionToken(p);
  const scopes = String(p.scopes ?? '').split(',');
  const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s));
  // A Page token is needed to read and answer comments; it comes from the user token when the user has a Page role.
  const { data } = await graph<any>({ path: p.page_id, params: { fields: 'access_token,name' }, accessToken: userToken, operation: 'meta.comments.page_token' });
  if (!data.access_token) throw new AppError({ code: 'PAGE_TOKEN_MISSING', message: `Meta gave no Page token for ${p.name}. The Meta login needs a role on this Page.`, status: 409, category: 'external_meta', hint: 'Give the connected Meta user a role on the Page, then reconnect Meta.' });
  return { page: p, token: data.access_token as string, missingScopes: missing, canModerate: String(p.tasks ?? '').includes('MODERATE') };
}

export async function listPages(orgId: number) {
  const rows = await query<any>(`SELECT p.page_id, p.name, p.tasks, c.scopes, c.status FROM meta_pages p JOIN meta_connections c ON c.id=p.connection_id WHERE p.org_id=? ORDER BY p.name`, [orgId]);
  return rows.map((p) => {
    const scopes = String(p.scopes ?? '').split(',');
    return { id: p.page_id, name: p.name, canModerate: String(p.tasks ?? '').includes('MODERATE'), missingScopes: NEEDED_SCOPES.filter((s) => !scopes.includes(s)), connectionStatus: p.status };
  });
}

const mapComment = (c: any) => ({ id: c.id, message: c.message ?? '', from: c.from?.name ?? 'Someone', fromId: c.from?.id ?? null, createdAt: c.created_time, hidden: Boolean(c.is_hidden), replies: c.comment_count ?? 0, likes: c.like_count ?? 0, canReply: c.can_comment !== false, canHide: c.can_hide !== false });

/** Recent posts with their latest comments. Ads appear as posts; Meta decides what the token may see. */
export async function pageComments(orgId: number, pageId: string, limitPosts = 15) {
  const { page, token, missingScopes, canModerate } = await pageAuth(orgId, pageId);
  let posts: any[] = [];
  let warning: string | null = null;
  try {
    const { data } = await graph<any>({ path: `${page.page_id}/posts`, params: { fields: 'id,message,created_time,permalink_url,is_published,comments.limit(25).order(reverse_chronological){id,message,from,created_time,is_hidden,comment_count,like_count,can_comment,can_hide}', limit: limitPosts }, accessToken: token, operation: 'meta.comments.list' });
    posts = data.data ?? [];
  } catch (err) {
    if (err instanceof MetaApiError && (err.meta.class === 'permission' || err.meta.code === 10 || err.meta.code === 200)) warning = `Meta refused to list this Page's comments: ${err.message}`;
    else throw err;
  }
  const actions = await query<any>(`SELECT comment_id, action, created_at FROM comment_actions WHERE org_id=? AND page_id=? ORDER BY id DESC LIMIT 500`, [orgId, pageId]);
  return {
    page: { id: page.page_id, name: page.name, canModerate, missingScopes },
    warning,
    posts: posts.map((p) => ({ id: p.id, message: p.message ?? '', createdAt: p.created_time, url: p.permalink_url ?? null, comments: (p.comments?.data ?? []).map((c: any) => ({ ...mapComment(c), handled: actions.filter((a) => a.comment_id === c.id).map((a) => ({ action: a.action, at: a.created_at })) })) })),
  };
}

export const replyInput = z.object({ pageId: z.string().regex(/^\d+$/), commentId: z.string().min(1).max(64), message: z.string().trim().min(1, 'Write a reply.').max(2000) });
export const hideInput = z.object({ pageId: z.string().regex(/^\d+$/), commentId: z.string().min(1).max(64), hidden: z.boolean() });

export async function replyToComment(user: User, input: z.infer<typeof replyInput>) {
  const { token } = await pageAuth(user.orgId, input.pageId);
  const { data } = await graph<any>({ method: 'POST', path: `${input.commentId}/comments`, params: { message: input.message }, accessToken: token, operation: 'meta.comments.reply' });
  await execute(`INSERT INTO comment_actions (org_id, user_id, page_id, comment_id, action, text, result_id) VALUES (?,?,?,?,'reply',?,?)`, [user.orgId, user.id, input.pageId, input.commentId, input.message, data.id ?? null]);
  return { id: data.id ?? null };
}

export async function hideComment(user: User, input: z.infer<typeof hideInput>) {
  const { token } = await pageAuth(user.orgId, input.pageId);
  await graph<any>({ method: 'POST', path: input.commentId, params: { is_hidden: input.hidden }, accessToken: token, operation: 'meta.comments.hide' });
  await execute(`INSERT INTO comment_actions (org_id, user_id, page_id, comment_id, action) VALUES (?,?,?,?,?)`, [user.orgId, user.id, input.pageId, input.commentId, input.hidden ? 'hide' : 'unhide']);
  return { hidden: input.hidden };
}

export const suggestInput = z.object({ comment: z.string().trim().min(1).max(2000), post: z.string().trim().max(2000).default(''), pageName: z.string().trim().max(200).default(''), language: z.enum(['en', 'bn']).default('en'), tone: z.enum(['friendly', 'formal', 'short']).default('friendly') });

/** A draft reply from the assistant. It is shown in the box for a person to edit and send; it is never sent by itself. */
export async function suggestReply(input: z.infer<typeof suggestInput>, assistantName: string) {
  if (!aiConfigured()) return { text: null, configured: false };
  const res = await chat([
    { role: 'system', content: `You are ${assistantName}, answering comments on the Facebook Page "${input.pageName || 'our Page'}" for a business that runs ads. Write ONE reply in ${input.language === 'bn' ? 'Bengali' : 'English'}, ${input.tone === 'short' ? 'one short sentence' : input.tone === 'formal' ? 'polite and formal, at most two sentences' : 'warm and friendly, at most two sentences'}. Do not promise prices, delivery dates or anything not in the post. If the comment is abuse or spam, reply with exactly: [hide]. Output only the reply text.` },
    { role: 'user', content: `Post: ${input.post || '(no text)'}\n\nComment: ${input.comment}` },
  ], { maxTokens: 200, temperature: 0.5 });
  const text = (res.message.content ?? '').trim();
  return { text: text || null, configured: true, suggestHide: text === '[hide]' };
}

export async function recentActions(orgId: number, limit = 50) {
  const rows = await query<any>(`SELECT a.*, u.name AS user_name, p.name AS page_name FROM comment_actions a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN meta_pages p ON p.page_id=a.page_id AND p.org_id=a.org_id WHERE a.org_id=? ORDER BY a.id DESC LIMIT ?`, [orgId, limit]);
  return rows.map((r) => ({ id: Number(r.id), page: r.page_name ?? r.page_id, commentId: r.comment_id, action: r.action, text: r.text, by: r.user_name ?? null, at: r.created_at }));
}
