import { execute, query, queryOne } from '../db/pool.js';
import { decryptConnectionToken } from './connections.js';
import { graph, graphPaged, MetaApiError } from './graph.js';
import { logger } from '../lib/logger.js';
import { evaluateCostAlerts } from '../services/costAlerts.js';

/**
 * Live data for the accounts the panel manages: campaigns, ad sets, ads (with creative thumbnails) and daily
 * insights. Everything stored here is exactly what Meta returned; nothing is estimated or filled in.
 */

const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES'];
const ADSET_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'];
const AD_STATUSES = [
  'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED',
  'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES',
];

/** Currencies Meta stores without minor units (offset 1). Everything else uses offset 100. */
const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
export function majorToMinor(major: number, currency: string): number {
  return Math.round(major * (OFFSET_ONE.has(currency) ? 1 : 100));
}

export function minorToMajor(minor: number | string | null | undefined, currency: string): number | null {
  if (minor == null || minor === '') return null;
  return Number(minor) / (OFFSET_ONE.has(currency) ? 1 : 100);
}

/** Which action counts as a "result" for each objective, in order of preference (new ODAX names and legacy names). */
const RESULT_ACTIONS: Record<string, string[]> = {
  OUTCOME_ENGAGEMENT: ['onsite_conversion.messaging_conversation_started_7d', 'click_to_call_native_call_placed', 'post_engagement'],
  MESSAGES: ['onsite_conversion.messaging_conversation_started_7d'],
  OUTCOME_LEADS: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'click_to_call_native_call_placed', 'onsite_conversion.messaging_conversation_started_7d'],
  LEAD_GENERATION: ['lead', 'onsite_conversion.lead_grouped'],
  OUTCOME_SALES: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.messaging_conversation_started_7d'],
  CONVERSIONS: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
  OUTCOME_TRAFFIC: ['link_click'],
  LINK_CLICKS: ['link_click'],
  POST_ENGAGEMENT: ['post_engagement'],
  VIDEO_VIEWS: ['video_view'],
  OUTCOME_APP_PROMOTION: ['mobile_app_install', 'app_install'],
  APP_INSTALLS: ['mobile_app_install', 'app_install'],
  PAGE_LIKES: ['like'],
};

export const RESULT_LABELS: Record<string, string> = {
  'onsite_conversion.messaging_conversation_started_7d': 'Messaging conversations',
  click_to_call_native_call_placed: 'Calls placed',
  click_to_call_call_confirm: 'Call clicks',
  post_engagement: 'Post engagements',
  lead: 'Leads',
  'onsite_conversion.lead_grouped': 'Leads',
  'offsite_conversion.fb_pixel_lead': 'Website leads',
  omni_purchase: 'Purchases',
  purchase: 'Purchases',
  'offsite_conversion.fb_pixel_purchase': 'Website purchases',
  link_click: 'Link clicks',
  video_view: 'Video views',
  mobile_app_install: 'App installs',
  app_install: 'App installs',
  like: 'Page likes',
};

type Action = { action_type: string; value: string };

/** The result for one insights row, or null when the objective has no countable result (for example Awareness). */
export function primaryResult(objective: string | null | undefined, actions: Action[] | null | undefined): { type: string; count: number } | null {
  const prefs = objective ? RESULT_ACTIONS[objective] : undefined;
  if (!prefs) return null;
  const list = actions ?? [];
  for (const type of prefs) {
    const hit = list.find((a) => a.action_type === type);
    if (hit) return { type, count: Math.round(Number(hit.value) || 0) };
  }
  // The objective has a result type but nothing happened yet: zero results, not unknown.
  return { type: prefs[0], count: 0 };
}

const actionCount = (list: Action[], type: string) => {
  const hit = list.find((a) => a.action_type === type);
  return hit ? Math.round(Number(hit.value) || 0) : null;
};

/**
 * Leads, calls and messaging conversations, counted for every row whatever the campaign objective.
 * "lead" is Meta's total of form and website leads; the parts are only added up when the total is missing,
 * so nothing is counted twice. Calls are calls placed from call ads, or call-button confirmations when Meta
 * reports only those.
 */
export function contactCounts(actions: Action[] | null | undefined): { leads: number; calls: number; messages: number } {
  const list = actions ?? [];
  const leads = actionCount(list, 'lead') ?? (actionCount(list, 'onsite_conversion.lead_grouped') ?? 0) + (actionCount(list, 'offsite_conversion.fb_pixel_lead') ?? 0);
  const calls = actionCount(list, 'click_to_call_native_call_placed') ?? actionCount(list, 'click_to_call_call_confirm') ?? 0;
  const messages = actionCount(list, 'onsite_conversion.messaging_conversation_started_7d') ?? 0;
  return { leads, calls, messages };
}

/** Today's date in the ad account's own time zone, which is how Meta buckets insights. */
export function accountToday(timezone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Balance, amount owed, spending limit and payment method. A permission or validation problem here is recorded on
 * the account and does not stop the rest of the sync; an expired token or rate limit does.
 */
async function syncAccountFunds(rowId: number, act: string, currency: string, token: string) {
  try {
    const { data: a } = await graph<any>({
      path: act,
      params: { fields: 'balance,amount_spent,spend_cap,is_prepay_account,funding_source_details' },
      accessToken: token,
      operation: 'meta.live.funds',
    });
    const fsd = a.funding_source_details ?? {};
    const { parseFundsDisplay } = await import('../services/funds.js');
    const prepay = a.is_prepay_account == null ? null : a.is_prepay_account ? 1 : 0;
    await execute(
      `UPDATE meta_ad_accounts SET balance_minor=?, amount_spent_minor=COALESCE(?, amount_spent_minor), spend_cap_minor=?, is_prepay=?, funding_type=?,
              funding_display=?, prepaid_funds_minor=?, funds_checked_at=NOW(3), funds_error=NULL WHERE id=?`,
      [
        a.balance != null ? Number(a.balance) : null,
        a.amount_spent != null ? Number(a.amount_spent) : null,
        a.spend_cap != null && a.spend_cap !== '0' ? Number(a.spend_cap) : null,
        prepay,
        fsd.type != null ? Number(fsd.type) : null,
        fsd.display_string ? String(fsd.display_string).slice(0, 255) : null,
        prepay ? parseFundsDisplay(fsd.display_string, currency) : null,
        rowId,
      ],
    );
  } catch (err) {
    if (err instanceof MetaApiError && (err.meta.class === 'auth' || err.meta.class === 'rate_limited')) throw err;
    await execute(`UPDATE meta_ad_accounts SET funds_error=?, funds_checked_at=NOW(3) WHERE id=?`, [String((err as Error).message).slice(0, 500), rowId]);
  }
}

async function bulkUpsert(sqlHead: string, sqlTail: string, rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 500) await execute(`${sqlHead} VALUES ? ${sqlTail}`, [rows.slice(i, i + 500)]);
}

const FULL_SYNC_EVERY_MS = 20 * 3600 * 1000;
/** Days of daily insights kept fresh: enough for "Last month" and custom ranges up to three months back. */
export const LIVE_HISTORY_DAYS = 90;

export interface LiveSyncResult {
  campaigns: number;
  adsets: number;
  ads: number;
  insightRows: number;
  since: string;
  until: string;
}

/** Syncs one managed ad account. Throws MetaApiError on Meta failures after recording the error on the account. */
export async function syncAccountLive(rowId: number, opts: { full?: boolean; now?: Date } = {}): Promise<LiveSyncResult> {
  const acc = await queryOne(
    `SELECT a.*, c.token_ciphertext, c.status AS connection_status
       FROM meta_ad_accounts a JOIN meta_connections c ON c.id = a.connection_id WHERE a.id=?`,
    [rowId],
  );
  if (!acc) throw new Error(`Ad account row ${rowId} not found`);
  const token = decryptConnectionToken(acc);
  const act = `act_${acc.account_id}`;
  const started = new Date();
  try {
    await syncAccountFunds(rowId, act, acc.currency, token);
    const campaigns = await graphPaged<any>({
      path: `${act}/campaigns`,
      params: { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', effective_status: CAMPAIGN_STATUSES },
      accessToken: token,
      operation: 'meta.live.campaigns',
    });
    await bulkUpsert(
      `INSERT INTO meta_campaigns (ad_account_row_id, campaign_id, name, status, effective_status, objective, daily_budget_minor, lifetime_budget_minor, synced_at)`,
      `ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), effective_status=VALUES(effective_status), objective=VALUES(objective),
         daily_budget_minor=VALUES(daily_budget_minor), lifetime_budget_minor=VALUES(lifetime_budget_minor), synced_at=VALUES(synced_at)`,
      campaigns.map((c) => [rowId, c.id, String(c.name ?? '').slice(0, 512), c.status ?? null, c.effective_status ?? null, c.objective ?? null, c.daily_budget ?? null, c.lifetime_budget ?? null, started]),
    );

    const adsets = await graphPaged<any>({
      path: `${act}/adsets`,
      params: { fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal', effective_status: ADSET_STATUSES },
      accessToken: token,
      operation: 'meta.live.adsets',
    });
    await bulkUpsert(
      `INSERT INTO meta_adsets (ad_account_row_id, adset_id, campaign_id, name, status, effective_status, daily_budget_minor, lifetime_budget_minor, optimization_goal, synced_at)`,
      `ON DUPLICATE KEY UPDATE campaign_id=VALUES(campaign_id), name=VALUES(name), status=VALUES(status), effective_status=VALUES(effective_status),
         daily_budget_minor=VALUES(daily_budget_minor), lifetime_budget_minor=VALUES(lifetime_budget_minor), optimization_goal=VALUES(optimization_goal), synced_at=VALUES(synced_at)`,
      adsets.map((s) => [rowId, s.id, s.campaign_id, String(s.name ?? '').slice(0, 512), s.status ?? null, s.effective_status ?? null, s.daily_budget ?? null, s.lifetime_budget ?? null, s.optimization_goal ?? null, started]),
    );

    const ads = await graphPaged<any>({
      path: `${act}/ads`,
      params: { fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,thumbnail_url,image_url,title,body}', effective_status: AD_STATUSES },
      accessToken: token,
      operation: 'meta.live.ads',
    });
    await bulkUpsert(
      `INSERT INTO meta_ads (ad_account_row_id, ad_id, adset_id, campaign_id, name, status, effective_status, creative_id, thumbnail_url, title, body, synced_at)`,
      `ON DUPLICATE KEY UPDATE adset_id=VALUES(adset_id), campaign_id=VALUES(campaign_id), name=VALUES(name), status=VALUES(status),
         effective_status=VALUES(effective_status), creative_id=VALUES(creative_id), thumbnail_url=VALUES(thumbnail_url), title=VALUES(title), body=VALUES(body), synced_at=VALUES(synced_at)`,
      ads.map((a) => [
        rowId, a.id, a.adset_id, a.campaign_id, String(a.name ?? '').slice(0, 512), a.status ?? null, a.effective_status ?? null,
        a.creative?.id ?? null, (a.creative?.image_url || a.creative?.thumbnail_url || null)?.slice(0, 2048) ?? null,
        a.creative?.title ? String(a.creative.title).slice(0, 512) : null, a.creative?.body ?? null, started,
      ]),
    );

    // Archived or deleted on Meta since the last sync: no longer listed, so drop them (their past spend stays in insights).
    for (const t of ['meta_campaigns', 'meta_adsets', 'meta_ads']) await execute(`DELETE FROM ${t} WHERE ad_account_row_id=? AND synced_at < ?`, [rowId, started]);

    const until = accountToday(acc.timezone_name, opts.now);
    const full = opts.full || !acc.live_full_synced_at || started.getTime() - new Date(acc.live_full_synced_at).getTime() > FULL_SYNC_EVERY_MS;
    const since = addDays(until, full ? -(LIVE_HISTORY_DAYS - 1) : -2);
    let insightRows = 0;
    for (const level of ['campaign', 'ad'] as const) {
      const rows = await graphPaged<any>({
        path: `${act}/insights`,
        params: {
          level,
          time_increment: 1,
          time_range: { since, until },
          use_unified_attribution_setting: true,
          fields: `${level}_id,objective,spend,impressions,clicks,inline_link_clicks,actions,date_start`,
          limit: 500,
        },
        accessToken: token,
        operation: `meta.live.insights_${level}`,
        timeoutMs: 60_000,
      });
      insightRows += rows.length;
      await bulkUpsert(
        `INSERT INTO meta_insights_daily (ad_account_row_id, level, object_id, date, objective, spend, impressions, clicks, link_clicks, result_type, results, leads, calls, messages, actions, synced_at)`,
        `ON DUPLICATE KEY UPDATE ad_account_row_id=VALUES(ad_account_row_id), objective=VALUES(objective), spend=VALUES(spend), impressions=VALUES(impressions),
           clicks=VALUES(clicks), link_clicks=VALUES(link_clicks), result_type=VALUES(result_type), results=VALUES(results),
           leads=VALUES(leads), calls=VALUES(calls), messages=VALUES(messages), actions=VALUES(actions), synced_at=VALUES(synced_at)`,
        rows.map((r) => {
          const res = primaryResult(r.objective, r.actions);
          const cc = contactCounts(r.actions);
          return [
            rowId, level, r[`${level}_id`], r.date_start, r.objective ?? null, Number(r.spend ?? 0), Number(r.impressions ?? 0), Number(r.clicks ?? 0),
            Number(r.inline_link_clicks ?? 0), res?.type ?? null, res?.count ?? null, cc.leads, cc.calls, cc.messages, r.actions ? JSON.stringify(r.actions) : null, started,
          ];
        }),
      );
    }

    await execute(
      `UPDATE meta_ad_accounts SET live_synced_at=?, live_sync_error=NULL ${full ? ', live_full_synced_at=?' : ''} WHERE id=?`,
      full ? [started, started, rowId] : [started, rowId],
    );
    // Alerts must never break a sync; a failure here is logged and the numbers stay saved.
    await evaluateCostAlerts(rowId).catch((err) => logger.error({ err, rowId }, 'cost alert check failed'));
    return { campaigns: campaigns.length, adsets: adsets.length, ads: ads.length, insightRows, since, until };
  } catch (err) {
    const msg = err instanceof MetaApiError ? `${err.message}${err.meta.code ? ` (Meta code ${err.meta.code})` : ''}` : (err as Error).message;
    await execute(`UPDATE meta_ad_accounts SET live_sync_error=? WHERE id=?`, [String(msg).slice(0, 1024), rowId]);
    throw err;
  }
}

/** Syncs managed accounts one by one. Stops early when Meta rate-limits or the token is dead, so we back off as a whole. */
export async function syncManagedAccounts(accountIds?: number[]): Promise<{ synced: number; failed: { id: number; error: string }[]; stoppedBy?: MetaApiError }> {
  const rows = accountIds?.length
    ? await query<{ id: number }>(
        `SELECT a.id FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id
          WHERE a.id IN (?) AND a.is_managed=1 AND c.status IN ('active','error') ORDER BY a.live_synced_at IS NULL DESC, a.live_synced_at`,
        [accountIds],
      )
    : await query<{ id: number }>(
        `SELECT a.id FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id
          WHERE a.is_managed=1 AND a.is_enabled=1 AND c.status IN ('active','error') ORDER BY a.live_synced_at IS NULL DESC, a.live_synced_at`,
      );
  const failed: { id: number; error: string }[] = [];
  let synced = 0;
  for (const r of rows) {
    try {
      await syncAccountLive(Number(r.id));
      synced++;
    } catch (err) {
      failed.push({ id: Number(r.id), error: (err as Error).message });
      if (err instanceof MetaApiError && (err.meta.class === 'rate_limited' || err.meta.class === 'auth')) return { synced, failed, stoppedBy: err };
    }
  }
  return { synced, failed };
}

/** Meta's own rendering of an ad. Returns only the iframe URL, and only if it points at facebook.com. */
export async function adPreviewUrl(adRowAccountId: number, adId: string, format: string): Promise<string | null> {
  const acc = await queryOne(
    `SELECT c.token_ciphertext FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id WHERE a.id=?`,
    [adRowAccountId],
  );
  if (!acc) return null;
  const { data } = await graph<{ data: { body: string }[] }>({
    path: `${adId}/previews`,
    params: { ad_format: format },
    accessToken: decryptConnectionToken(acc),
    operation: 'meta.live.ad_preview',
  });
  return extractPreviewSrc(data.data?.[0]?.body ?? '');
}

export function extractPreviewSrc(html: string): string | null {
  const m = /<iframe[^>]+src=["']([^"']+)["']/i.exec(html);
  if (!m) return null;
  const src = m[1].replace(/&amp;/g, '&');
  try {
    const u = new URL(src);
    if (u.protocol !== 'https:' || !/^(www|business|m)\.facebook\.com$/.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}
