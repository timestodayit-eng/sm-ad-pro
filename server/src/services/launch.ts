import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { decryptConnectionToken } from '../meta/connections.js';
import { graph, MetaApiError } from '../meta/graph.js';
import { majorToMinor, minorToMajor } from '../meta/live.js';
import { presignGet } from './storage.js';
import { enqueue, type Job } from '../jobs/queue.js';
import { JobError, type JobContext } from '../jobs/scheduler.js';

/**
 * Easy Ads: one ad sent to several ad accounts, in the panel's account order. Each account gets one campaign,
 * one ad set (with its own daily budget, ABO) and one ad, all created PAUSED. Nothing is ever switched on here.
 *
 * The Meta settings for each goal live in GOALS so they can be checked and changed in one place.
 * They follow Meta's Marketing API (ODAX objectives) and are NOT yet verified against a live account.
 */

export const GOALS = {
  call: {
    calls: { objective: 'OUTCOME_ENGAGEMENT', destination_type: 'PHONE_CALL', optimization_goal: 'QUALITY_CALL', label: 'Calls' },
    clicks: { objective: 'OUTCOME_TRAFFIC', destination_type: 'PHONE_CALL', optimization_goal: 'LINK_CLICKS', label: 'Clicks on Call' },
  },
  website: {
    clicks: { objective: 'OUTCOME_TRAFFIC', destination_type: 'WEBSITE', optimization_goal: 'LINK_CLICKS', label: 'Link clicks' },
    landing_page_views: { objective: 'OUTCOME_TRAFFIC', destination_type: 'WEBSITE', optimization_goal: 'LANDING_PAGE_VIEWS', label: 'Landing page views' },
  },
} as const;

/** Placements the user can tick. Fixed placements only: Advantage+ placements are never sent. */
export const PLACEMENTS: Record<string, { label: string; platform: 'facebook' | 'instagram' | 'messenger' | 'audience_network'; position: string }> = {
  fb_feed: { label: 'Facebook feed', platform: 'facebook', position: 'feed' },
  fb_reels: { label: 'Facebook Reels', platform: 'facebook', position: 'facebook_reels' },
  fb_stories: { label: 'Facebook Stories', platform: 'facebook', position: 'story' },
  fb_video_feeds: { label: 'Facebook video feeds', platform: 'facebook', position: 'video_feeds' },
  fb_marketplace: { label: 'Facebook Marketplace', platform: 'facebook', position: 'marketplace' },
  ig_feed: { label: 'Instagram feed', platform: 'instagram', position: 'stream' },
  ig_reels: { label: 'Instagram Reels', platform: 'instagram', position: 'reels' },
  ig_stories: { label: 'Instagram Stories', platform: 'instagram', position: 'story' },
  ig_explore: { label: 'Instagram Explore', platform: 'instagram', position: 'explore' },
  messenger_inbox: { label: 'Messenger inbox', platform: 'messenger', position: 'messenger_home' },
};
export const DEFAULT_PLACEMENTS = ['fb_feed', 'fb_reels', 'ig_feed', 'ig_reels'];
const POSITION_FIELD = { facebook: 'facebook_positions', instagram: 'instagram_positions', messenger: 'messenger_positions', audience_network: 'audience_network_positions' } as const;

/** Meta's Advantage+ creative features, all switched off so the ad runs exactly as uploaded. */
export const CREATIVE_FEATURES_OFF = ['standard_enhancements', 'image_enhancement', 'image_brightness_and_contrast', 'image_templates', 'image_touchups', 'image_uncrop', 'text_optimizations', 'enhance_cta', 'video_auto_crop', 'inline_comment', 'product_extensions', 'site_extensions', 'add_text_overlay', 'adapt_to_placement', 'media_order', 'profile_card', 'text_generation', 'text_translation', 'video_filtering', 'image_animation', 'description_automation', 'media_type_automation'];

export const WEBSITE_CTAS = ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'GET_QUOTE', 'APPLY_NOW', 'ORDER_NOW'] as const;
const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

const money = z.number().finite().min(0).max(1_000_000);
const text = (max: number) => z.string().trim().max(max);

export const rowInput = z.object({
  accountRowId: z.number().int().positive(),
  pageId: z.string().regex(/^\d+$/).optional(),
  dailyBudget: money.optional(),
  mediaAssetId: z.number().int().positive().optional(),
  caption: text(2000).optional(),
  title: text(255).optional(),
  link: text(1024).optional(),
  ageMin: z.number().int().min(18).max(65).optional(),
  ageMax: z.number().int().min(18).max(65).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20.');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 07:00.');

export const launchInput = z.object({
  name: text(120).min(1, 'Give the launch a name.'),
  goal: z.enum(['call', 'website']),
  optimize: z.string().default('calls'),
  /** One Facebook Page for the whole launch. A sheet row can still name another Page for one account. */
  pageId: z.string().regex(/^\d+$/).optional(),
  mediaAssetId: z.number().int().positive().optional(),
  caption: text(2000).default(''),
  title: text(255).default(''),
  link: text(1024).default(''),
  cta: z.string().default('LEARN_MORE'),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1, 'Choose at least one country.').max(25),
  ageMin: z.number().int().min(18).max(65).default(18),
  ageMax: z.number().int().min(18).max(65).default(65),
  genders: z.enum(['all', 'male', 'female']).default('all'),
  advantageAudience: z.boolean().default(false),
  specialCategory: z.enum(['NONE', 'EMPLOYMENT']).default('NONE'),
  /** Required by Meta when the ad reaches the EU: who benefits from and who pays for the ad. */
  paidBy: text(120).default(''),
  budget: z.object({
    /** lifetime: one amount for the whole run between the dates. daily: per day. */
    kind: z.enum(['lifetime', 'daily']).default('lifetime'),
    mode: z.enum(['stepped', 'same', 'each']).default('stepped'),
    start: money.default(0),
    step: z.number().finite().min(-100_000).max(100_000).default(0),
  }),
  /** The run: dates are in each account's own time zone. */
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  /** Hours the ads may show, every day, in the account's time zone. Empty = all day. */
  hours: z.object({ from: hhmm, to: hhmm }).optional(),
  placements: z.array(z.string()).min(1, 'Tick at least one placement.').default(DEFAULT_PLACEMENTS),
  /** Accounts in this launch with anything that differs per account (from the table or an uploaded sheet). */
  rows: z.array(rowInput).min(1, 'Choose at least one account.').max(200),
});
export type LaunchInput = z.infer<typeof launchInput>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "+1 (555) 010-2000" -> "+15550102000"; null when it is not a full international number. */
export function normalizePhone(v: string): string | null {
  const s = v.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}
function validUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Pages each account can use: Pages imported for the same Meta login. */
export async function pagesFor(orgId: number) {
  return query<any>(`SELECT page_id, name, connection_id, tasks FROM meta_pages WHERE org_id=? ORDER BY name`, [orgId]);
}

export async function planLaunch(user: Express.Request['user'] & {}, input: LaunchInput, accounts: any[]) {
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));
  const goal = (GOALS as any)[input.goal]?.[input.optimize];
  const problems: string[] = [];
  if (!goal) problems.push('Choose what Meta should optimize for.');
  if (input.ageMin > input.ageMax) problems.push('The minimum age is above the maximum age.');
  if (input.goal === 'website' && !(WEBSITE_CTAS as readonly string[]).includes(input.cta)) problems.push('Choose a button for the website ad.');
  const reachesEu = input.countries.some((c) => EU.has(c));
  if (reachesEu && !input.paidBy) problems.push('Ads shown in the EU need a "Paid for by" name.');
  const badPlacement = input.placements.find((k) => !PLACEMENTS[k]);
  if (badPlacement) problems.push(`Unknown placement "${badPlacement}".`);
  const today = new Date().toISOString().slice(0, 10);
  if (!input.startDate) problems.push('Choose the start date.');
  else if (input.startDate < today) problems.push('The start date is in the past.');
  if (input.budget.kind === 'lifetime') {
    if (!input.endDate) problems.push('A lifetime budget needs an end date.');
    else if (input.startDate && input.endDate <= input.startDate) problems.push('The end date must be after the start date.');
  } else if (input.endDate && input.startDate && input.endDate <= input.startDate) problems.push('The end date must be after the start date.');
  if (input.hours) {
    if (input.budget.kind !== 'lifetime') problems.push('Meta only allows running hours with a lifetime budget.');
    if (toMinute(input.hours.to) <= toMinute(input.hours.from)) problems.push('The end hour must be after the start hour.');
  }

  const ids = input.rows.map((r) => r.accountRowId);
  const defaults = ids.length ? await query<any>(`SELECT * FROM account_defaults WHERE ad_account_row_id IN (?)`, [ids]) : [];
  const pages = await pagesFor(user.orgId);
  const mediaIds = [...new Set([input.mediaAssetId, ...input.rows.map((r) => r.mediaAssetId)].filter(Boolean))] as number[];
  const media = mediaIds.length
    ? await query<any>(`SELECT id, original_name, kind, status FROM media_assets WHERE org_id=? AND id IN (?)`, [user.orgId, mediaIds])
    : [];

  // Rows follow the panel's account order, whatever order they were sent in.
  const ordered = [...input.rows]
    .filter((r) => byId.has(r.accountRowId))
    .sort((a, b) => accounts.indexOf(byId.get(a.accountRowId)) - accounts.indexOf(byId.get(b.accountRowId)));
  const unknown = input.rows.filter((r) => !byId.has(r.accountRowId));
  if (unknown.length) problems.push(`${unknown.length} account(s) are not working accounts any more. Refresh the page.`);
  const seen = new Set<number>();

  const rows = ordered.map((r, i) => {
    const a = byId.get(r.accountRowId);
    const d = defaults.find((x) => Number(x.ad_account_row_id) === r.accountRowId);
    const position = i + 1;
    const issues: string[] = [];
    if (seen.has(r.accountRowId)) issues.push('This account is listed twice.');
    seen.add(r.accountRowId);

    const pageId = r.pageId ?? input.pageId ?? d?.page_id ?? null;
    const page = pages.find((p) => p.page_id === pageId);
    if (!pageId) issues.push('Choose a Facebook Page.');
    else if (!page) issues.push('This Page is not in the Pages imported from Meta.');

    let budget: number | null;
    if (r.dailyBudget != null) budget = r.dailyBudget;
    else if (input.budget.mode === 'stepped') budget = input.budget.start + input.budget.step * (position - 1);
    else if (input.budget.mode === 'same') budget = input.budget.start;
    else budget = null;
    budget = budget == null ? null : round2(budget);
    if (budget == null) issues.push(input.budget.kind === 'lifetime' ? 'Enter a lifetime budget.' : 'Enter a daily budget.');
    else if (budget <= 0) issues.push('The daily budget must be more than zero.');

    const mediaId = r.mediaAssetId ?? input.mediaAssetId ?? null;
    const m = media.find((x) => Number(x.id) === mediaId);
    if (!mediaId) issues.push('Choose a video.');
    else if (!m || m.kind !== 'video') issues.push('The video was not found in the media library.');
    else if (m.status !== 'ready') issues.push('The video has not finished uploading.');

    const employment = input.specialCategory === 'EMPLOYMENT';
    const ageMin = employment ? 18 : (r.ageMin ?? input.ageMin);
    const ageMax = employment ? 65 : (r.ageMax ?? input.ageMax);
    if (ageMin > ageMax) issues.push('The minimum age is above the maximum age.');

    const caption = r.caption || input.caption;
    const title = r.title || input.title;
    if (!caption) issues.push('Write the caption (primary text).');
    let link = r.link || input.link || (input.goal === 'call' ? d?.phone_number : d?.website_url) || '';
    if (input.goal === 'call') {
      const phone = normalizePhone(link);
      if (!phone) issues.push('Enter the phone number with country code, for example +1 555 010 2000.');
      else link = phone;
    } else if (!validUrl(link)) issues.push('Enter the website address, starting with https://');

    return {
      position, accountRowId: r.accountRowId, accountId: a.account_id, accountName: a.name, currency: a.currency,
      connectionOk: a.connection_status === 'active' || a.connection_status === 'error',
      pageId, pageName: page?.name ?? null, budget, budgetKind: input.budget.kind, dailyBudget: budget,
      mediaAssetId: mediaId, videoName: m?.original_name ?? null,
      caption, title, link, ageMin, ageMax, issues,
    };
  });

  const currencies = [...new Set(rows.map((r) => r.currency))];
  return {
    rows,
    problems,
    goal: goal ? { ...goal, goal: input.goal, optimize: input.optimize } : null,
    ready: problems.length === 0 && rows.length > 0 && rows.every((r) => r.issues.length === 0),
    budgetKind: input.budget.kind,
    days: input.startDate && input.endDate ? Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000) : null,
    totals: currencies.map((c) => ({ currency: c, total: round2(rows.filter((r) => r.currency === c).reduce((n, r) => n + (r.budget ?? 0), 0)) })),
  };
}

/** Creates the launch and one queued job per account. Call only after planLaunch said ready. */
export async function createLaunch(user: Express.Request['user'] & {}, input: LaunchInput, plan: Awaited<ReturnType<typeof planLaunch>>) {
  const settings = { ...input, rows: undefined };
  const res = await execute(`INSERT INTO launches (org_id, user_id, name, goal, settings) VALUES (?,?,?,?,?)`, [user.orgId, user.id, input.name, input.goal, JSON.stringify(settings)]);
  const launchId = res.insertId;
  for (const r of plan.rows) {
    const content = { caption: r.caption, title: r.title, link: r.link, ageMin: r.ageMin, ageMax: r.ageMax };
    const item = await execute(
      `INSERT INTO launch_items (launch_id, org_id, ad_account_row_id, position, page_id, currency, budget_kind, budget_minor, media_asset_id, content)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [launchId, user.orgId, r.accountRowId, r.position, r.pageId, r.currency, input.budget.kind, majorToMinor(r.budget!, r.currency), r.mediaAssetId, JSON.stringify(content)],
    );
    // Remember the Page and the phone or website for next time.
    const isCall = input.goal === 'call';
    await execute(
      `INSERT INTO account_defaults (ad_account_row_id, page_id, ${isCall ? 'phone_number' : 'website_url'}) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE page_id=VALUES(page_id), ${isCall ? 'phone_number=VALUES(phone_number)' : 'website_url=VALUES(website_url)'}`,
      [r.accountRowId, r.pageId, r.link],
    );
    const jobId = await enqueue({ queue: 'publishing', type: 'launch.item', payload: { itemId: item.insertId }, priority: 20 + r.position, maxAttempts: 5, dedupeKey: `launch-item:${item.insertId}:1` });
    await execute(`UPDATE launch_items SET job_id=? WHERE id=?`, [jobId, item.insertId]);
  }
  return launchId;
}

// ---------------------------------------------------------------- uploaded sheet (CSV)

export const SHEET_COLUMNS = ['account', 'budget', 'age_min', 'age_max', 'page', 'video', 'caption', 'title', 'phone_or_website'] as const;

/** Minimal RFC 4180 CSV: quoted fields, "" escapes, commas or semicolons, CRLF. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Turns an uploaded sheet into launch rows. Accounts match by ad account ID, exact name, or a short name such as
 * "DE 154" that appears in exactly one working account's name. Empty cells fall back to the builder's values.
 */
export function sheetToRows(csv: string, accounts: any[], pages: any[], media: any[]) {
  const table = parseCsv(csv);
  if (!table.length) return { rows: [], errors: ['The sheet is empty.'] };
  const header = table[0].map((h) => norm(h).replace(/[^a-z_ ]/g, '').replace(/ /g, '_'));
  const col = (name: string, ...alts: string[]) => [name, ...alts].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    account: col('account', 'ad_account', 'account_name'),
    page: col('page', 'facebook_page', 'page_name'),
    budget: col('budget', 'daily_budget', 'lifetime_budget'),
    video: col('video', 'video_file'),
    caption: col('caption', 'primary_text', 'text'),
    title: col('title', 'headline'),
    link: col('phone_or_website', 'phone', 'website', 'link', 'url'),
    ageMin: col('age_min', 'min_age', 'age_from'),
    ageMax: col('age_max', 'max_age', 'age_to'),
  };
  if (c.account < 0) return { rows: [], errors: ['The sheet needs an "account" column. Download the template to see the layout.'] };
  const errors: string[] = [];
  const rows: z.infer<typeof rowInput>[] = [];
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (k: number) => (k >= 0 ? (cells[k] ?? '').trim() : '');
    const acc = get(c.account);
    if (!acc) return;
    const digits = acc.replace(/^act_/i, '');
    let matches = accounts.filter((a) => a.account_id === digits || norm(a.name) === norm(acc));
    if (!matches.length) matches = accounts.filter((a) => norm(a.name).includes(norm(acc)) && new RegExp(`(^|[^0-9])${norm(acc).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`).test(norm(a.name)));
    if (matches.length !== 1) {
      errors.push(`Row ${line}: ${matches.length ? `"${acc}" matches ${matches.length} accounts (${matches.slice(0, 3).map((m) => m.name).join(', ')}). Use the full name or the account ID.` : `"${acc}" is not one of your working accounts.`}`);
      return;
    }
    const r: z.infer<typeof rowInput> = { accountRowId: Number(matches[0].id) };
    const pg = get(c.page);
    if (pg) {
      const p = pages.find((x) => x.page_id === pg) ?? pages.filter((x) => norm(x.name) === norm(pg)).at(0);
      if (p) r.pageId = p.page_id;
      else errors.push(`Row ${line}: Page "${pg}" was not found in the Pages imported from Meta.`);
    }
    const b = get(c.budget);
    if (b) {
      const n = Number(b.replace(/[^0-9.,-]/g, '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) r.dailyBudget = Math.round(n * 100) / 100;
      else errors.push(`Row ${line}: "${b}" is not a budget.`);
    }
    const v = get(c.video);
    if (v) {
      const m = media.find((x) => String(x.id) === v || norm(x.original_name) === norm(v) || norm(x.original_name).replace(/\.[a-z0-9]+$/, '') === norm(v));
      if (m) r.mediaAssetId = Number(m.id);
      else errors.push(`Row ${line}: video "${v}" is not in the media library.`);
    }
    for (const [k, idx] of [['ageMin', c.ageMin], ['ageMax', c.ageMax]] as const) {
      const v = get(idx);
      if (!v) continue;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 18 && n <= 65) (r as any)[k] = n;
      else errors.push(`Row ${line}: "${v}" is not an age between 18 and 65.`);
    }
    if (get(c.caption)) r.caption = get(c.caption);
    if (get(c.title)) r.title = get(c.title);
    if (get(c.link)) r.link = get(c.link);
    rows.push(r);
  });
  if (!rows.length && !errors.length) errors.push('No account rows were found in the sheet.');
  return { rows, errors };
}

/** The template: every working account in the panel's order, with the remembered Page and phone or website. */
export function sheetTemplate(accounts: any[], pages: any[], defaults: any[]) {
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [SHEET_COLUMNS.join(',')];
  for (const a of accounts) {
    const d = defaults.find((x) => Number(x.ad_account_row_id) === Number(a.id));
    const page = pages.find((p) => p.page_id === d?.page_id);
    lines.push([a.name, '', '', '', page?.name ?? '', '', '', '', d?.phone_number ?? d?.website_url ?? ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- the job that builds one account's ad

export const tagFor = (launchId: number, position: number) => `[L${launchId}-${position}]`;

export const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "2026-11-20" + "07:00" in a time zone -> ISO 8601 with that zone's offset, as Meta expects for start_time. */
export function localIso(date: string, time: string, tz: string | null | undefined): string {
  const zone = tz || 'UTC';
  const guess = new Date(`${date}T${time}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const part = (d: Date) => Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const q = part(guess);
  const asUtc = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute), Number(q.second));
  const offsetMin = Math.round((asUtc - guess.getTime()) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date}T${time}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function placementTargeting(keys: string[]) {
  const out: Record<string, string[]> = { publisher_platforms: [] };
  for (const k of keys) {
    const pl = PLACEMENTS[k];
    if (!pl) continue;
    if (!out.publisher_platforms.includes(pl.platform)) out.publisher_platforms.push(pl.platform);
    const f = POSITION_FIELD[pl.platform];
    (out[f] ??= []).push(pl.position);
  }
  if (out.publisher_platforms.includes('instagram') && !out.publisher_platforms.includes('facebook')) out.publisher_platforms.unshift('facebook'), (out.facebook_positions ??= []);
  return out;
}

/** Everything Meta needs, built from a launch and one of its items. Exported for tests. */
export function metaPayloads(launch: { id: number; name: string; settings: any }, item: any, account: { account_id: string; name: string; timezone_name?: string | null }) {
  const s = launch.settings;
  const g = (GOALS as any)[s.goal][s.optimize];
  const content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
  const tag = tagFor(launch.id, item.position);
  const lifetime = (item.budget_kind ?? s.budget?.kind) === 'lifetime';
  const budgetLabel = `${minorToMajor(item.budget_minor, item.currency)} ${item.currency}${lifetime ? '' : '/day'}`;
  const employment = s.specialCategory === 'EMPLOYMENT';
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: s.countries },
    age_min: employment ? 18 : (content.ageMin ?? s.ageMin),
    age_max: employment ? 65 : (content.ageMax ?? s.ageMax),
    targeting_automation: { advantage_audience: s.advantageAudience ? 1 : 0 },
    ...placementTargeting(s.placements ?? DEFAULT_PLACEMENTS),
  };
  if (!employment && s.genders !== 'all') targeting.genders = [s.genders === 'male' ? 1 : 2];
  const reachesEu = (s.countries as string[]).some((c) => EU.has(c));

  const campaign = {
    name: `${launch.name} · ${account.name} ${tag}`,
    objective: g.objective,
    status: 'PAUSED',
    buying_type: 'AUCTION',
    special_ad_categories: employment ? ['EMPLOYMENT'] : [],
    ...(employment ? { special_ad_category_country: s.countries } : {}),
    // Each ad set keeps its own budget (ABO); Meta asks for this flag on campaigns without a campaign budget.
    is_adset_budget_sharing_enabled: false,
  };
  const adset = {
    name: `${launch.name} · ${budgetLabel} ${tag}`,
    status: 'PAUSED',
    ...(lifetime ? { lifetime_budget: item.budget_minor } : { daily_budget: item.budget_minor }),
    ...(s.startDate ? { start_time: localIso(s.startDate, '00:00', account.timezone_name) } : {}),
    ...(s.endDate ? { end_time: localIso(s.endDate, '23:59', account.timezone_name) } : {}),
    ...(s.hours && lifetime
      ? { pacing_type: ['day_parting'], adset_schedule: [{ start_minute: toMinute(s.hours.from), end_minute: toMinute(s.hours.to), days: [0, 1, 2, 3, 4, 5, 6], timezone_type: 'ADVERTISER' }] }
      : {}),
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    optimization_goal: g.optimization_goal,
    destination_type: g.destination_type,
    ...(s.goal === 'call' ? { promoted_object: { page_id: item.page_id } } : {}),
    targeting,
    ...(reachesEu ? { dsa_beneficiary: s.paidBy, dsa_payor: s.paidBy } : {}),
  };
  const isCall = s.goal === 'call';
  const creative = (videoId: string, imageUrl: string | null) => ({
    name: `${launch.name} ${tag}`,
    // Every Advantage+ creative feature off: Meta shows the video, caption and headline exactly as given.
    degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(CREATIVE_FEATURES_OFF.map((f) => [f, { enroll_status: 'OPT_OUT' }])) },
    object_story_spec: {
      page_id: item.page_id,
      video_data: {
        video_id: videoId,
        ...(imageUrl ? { image_url: imageUrl } : {}),
        message: content.caption,
        ...(content.title ? { title: content.title } : {}),
        call_to_action: isCall ? { type: 'CALL_NOW', value: { link: `tel:${content.link}` } } : { type: s.cta, value: { link: content.link } },
      },
    },
  });
  const ad = { name: `${launch.name} ${tag}`, status: 'PAUSED' };
  return { campaign, adset, creative, ad, tag };
}

const STEP_BUDGET_MS = 40_000;
const PROCESSING_TIMEOUT_MS = 60 * 60_000;

export const STAGE_LABEL: Record<string, string> = {
  video: 'Uploading the video',
  processing: 'Meta is processing the video',
  campaign: 'Creating the campaign',
  adset: 'Creating the ad set',
  creative: 'Creating the ad creative',
  ad: 'Creating the ad',
  check: 'Checking the ad on Meta',
  done: 'Done',
};

function jobErrorFrom(err: unknown) {
  if (err instanceof JobError) return err;
  if (err instanceof MetaApiError) {
    const kind = err.retryable ? 'transient' : err.meta.class === 'ambiguous' ? 'ambiguous' : 'deterministic';
    return new JobError({ kind, code: err.code, message: err.message, hint: err.hint, details: err.details });
  }
  if (err instanceof AppError) return new JobError({ kind: err.retryable ? 'transient' : 'deterministic', code: err.code, message: err.message, hint: err.hint });
  return new JobError({ kind: 'transient', code: 'UNEXPECTED_ERROR', message: String((err as any)?.message ?? err).slice(0, 900) });
}

export async function runLaunchItem(job: Job, ctx: JobContext) {
  const itemId = Number(job.payload?.itemId);
  const item = await queryOne<any>(`SELECT * FROM launch_items WHERE id=?`, [itemId]);
  if (!item || item.status === 'done' || item.status === 'cancelled') return;
  const launchRow = await queryOne<any>(`SELECT * FROM launches WHERE id=?`, [item.launch_id]);
  const launch = { id: Number(launchRow.id), name: launchRow.name, settings: typeof launchRow.settings === 'string' ? JSON.parse(launchRow.settings) : launchRow.settings };
  const account = await queryOne<any>(
    `SELECT a.*, c.token_ciphertext, c.status AS connection_status FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id WHERE a.id=?`,
    [item.ad_account_row_id],
  );
  const token = decryptConnectionToken(account);
  const act = `act_${account.account_id}`;
  const p = metaPayloads(launch, item, account);
  // On a retry, look for objects an earlier attempt may have created before asking Meta to create new ones.
  const retrying = job.attempts > 1;
  const started = Date.now();
  const save = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    Object.assign(item, fields);
    return execute(`UPDATE launch_items SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map((k) => fields[k]), itemId]);
  };
  await save({ status: 'working', error_code: null, error_message: null, error_hint: null, started_at: item.started_at ?? new Date() });

  const findByName = async (path: string, name: string) => {
    const { data } = await graph<any>({ path, params: { fields: 'id,name', limit: 200, filtering: [{ field: 'name', operator: 'CONTAIN', value: p.tag }] }, accessToken: token, operation: 'meta.launch.find' });
    return (data.data ?? []).find((x: any) => x.name === name)?.id as string | undefined;
  };

  try {
    while (item.stage !== 'done') {
      if (Date.now() - started > STEP_BUDGET_MS) return ctx.rescheduleIn(1);
      switch (item.stage) {
        case 'video': {
          const cached = await queryOne<any>(`SELECT video_id FROM meta_video_uploads WHERE ad_account_row_id=? AND media_asset_id=?`, [item.ad_account_row_id, item.media_asset_id]);
          if (cached) {
            await save({ video_id: cached.video_id, stage: 'processing' });
            break;
          }
          const m = await queryOne<any>(`SELECT object_key, original_name, status FROM media_assets WHERE id=?`, [item.media_asset_id]);
          if (!m || m.status !== 'ready') throw new JobError({ kind: 'deterministic', code: 'VIDEO_MISSING', message: 'The video is no longer in the media library.' });
          const fileUrl = await presignGet(m.object_key, { expiresIn: 6 * 3600 });
          let videoId: string;
          try {
            ({ data: { id: videoId } } = await graph<any>({ method: 'POST', path: `${act}/advideos`, params: { file_url: fileUrl, name: m.original_name }, accessToken: token, operation: 'meta.launch.video', timeoutMs: 120_000 }));
          } catch (err) {
            // A second copy of a video in the account's library is harmless, so an unclear result is simply retried.
            if (err instanceof MetaApiError && err.meta.class === 'ambiguous') throw new JobError({ kind: 'transient', code: 'VIDEO_UPLOAD_UNCLEAR', message: 'Meta did not answer the video upload. Trying again.' });
            throw err;
          }
          await execute(`INSERT INTO meta_video_uploads (ad_account_row_id, media_asset_id, video_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE video_id=VALUES(video_id)`, [item.ad_account_row_id, item.media_asset_id, videoId]);
          await save({ video_id: videoId, stage: 'processing' });
          break;
        }
        case 'processing': {
          const { data: v } = await graph<any>({ path: item.video_id, params: { fields: 'status' }, accessToken: token, operation: 'meta.launch.video_status' });
          const st = v.status?.video_status;
          if (st === 'error') {
            await execute(`DELETE FROM meta_video_uploads WHERE ad_account_row_id=? AND media_asset_id=?`, [item.ad_account_row_id, item.media_asset_id]);
            await save({ stage: 'video', video_id: null });
            throw new JobError({ kind: 'deterministic', code: 'VIDEO_PROCESSING_FAILED', message: v.status?.processing_progress != null ? 'Meta could not process the video.' : 'Meta rejected the video file.', hint: 'Check the video format (MP4 or MOV) and try again.' });
          }
          if (st !== 'ready') {
            if (Date.now() - new Date(item.started_at).getTime() > PROCESSING_TIMEOUT_MS)
              throw new JobError({ kind: 'deterministic', code: 'VIDEO_PROCESSING_TIMEOUT', message: 'Meta has been processing the video for over an hour.', hint: 'Press Retry later to check again.' });
            return ctx.rescheduleIn(20);
          }
          const { data: th } = await graph<any>({ path: `${item.video_id}/thumbnails`, params: { fields: 'uri,is_preferred' }, accessToken: token, operation: 'meta.launch.thumbnail' });
          const list: any[] = th.data ?? [];
          const thumb = list.find((t) => t.is_preferred) ?? list[0];
          await save({ thumbnail_url: thumb?.uri ?? null, stage: 'campaign' });
          break;
        }
        case 'campaign': {
          let id = retrying ? await findByName(`${act}/campaigns`, p.campaign.name) : undefined;
          if (!id) ({ data: { id } } = await graph<any>({ method: 'POST', path: `${act}/campaigns`, params: p.campaign, accessToken: token, operation: 'meta.launch.campaign' }));
          await save({ campaign_id: id, stage: 'adset' });
          break;
        }
        case 'adset': {
          let id = retrying ? await findByName(`${item.campaign_id}/adsets`, p.adset.name) : undefined;
          if (!id) ({ data: { id } } = await graph<any>({ method: 'POST', path: `${act}/adsets`, params: { ...p.adset, campaign_id: item.campaign_id }, accessToken: token, operation: 'meta.launch.adset' }));
          await save({ adset_id: id, stage: 'creative' });
          break;
        }
        case 'creative': {
          // An unused creative is invisible, so a retry may safely create a new one.
          const { data } = await graph<any>({ method: 'POST', path: `${act}/adcreatives`, params: p.creative(item.video_id, item.thumbnail_url), accessToken: token, operation: 'meta.launch.creative' });
          await save({ creative_id: data.id, stage: 'ad' });
          break;
        }
        case 'ad': {
          let id = retrying ? await findByName(`${item.adset_id}/ads`, p.ad.name) : undefined;
          if (!id) ({ data: { id } } = await graph<any>({ method: 'POST', path: `${act}/ads`, params: { ...p.ad, adset_id: item.adset_id, creative: { creative_id: item.creative_id } }, accessToken: token, operation: 'meta.launch.ad' }));
          await save({ ad_id: id, stage: 'check' });
          break;
        }
        case 'check': {
          const { data } = await graph<any>({ path: item.ad_id, params: { fields: 'id,status,effective_status' }, accessToken: token, operation: 'meta.launch.check' });
          await save({ ad_status: data.effective_status ?? data.status ?? null, stage: 'done', status: 'done', finished_at: new Date() });
          break;
        }
        default:
          throw new JobError({ kind: 'deterministic', code: 'UNKNOWN_STAGE', message: `Unknown stage "${item.stage}".` });
      }
    }
  } catch (err) {
    const je = jobErrorFrom(err);
    const f = je.failure;
    const final = f.kind !== 'transient' || job.attempts >= job.max_attempts;
    await save({
      status: final ? (f.kind === 'ambiguous' ? 'needs_review' : 'failed') : 'working',
      error_code: String(f.code).slice(0, 64),
      error_message: (final ? f.message : `${f.message} Trying again automatically.`).slice(0, 1000),
      error_hint: f.kind === 'ambiguous' ? 'Meta did not answer, so it is unclear whether this step happened. Retry checks Meta first and does not create a duplicate.' : (f.hint ?? null)?.slice(0, 500) ?? null,
    });
    throw je;
  }
}

export async function retryItem(orgId: number, itemId: number) {
  const item = await queryOne<any>(`SELECT * FROM launch_items WHERE id=? AND org_id=?`, [itemId, orgId]);
  if (!item) throw new AppError({ code: 'NOT_FOUND', message: 'This launch row was not found.', status: 404, category: 'not_found' });
  if (!['failed', 'needs_review'].includes(item.status)) throw new AppError({ code: 'NOT_RETRYABLE', message: 'Only rows that stopped with an error can be retried.', status: 409, category: 'conflict' });
  const n = Number((await queryOne<any>(`SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key LIKE ?`, [`launch-item:${itemId}:%`]))?.n ?? 0) + 1;
  // attempts start above 1 so the job looks for objects an earlier attempt created before creating new ones
  const jobId = await enqueue({ queue: 'publishing', type: 'launch.item', payload: { itemId }, priority: 20 + Number(item.position), maxAttempts: 6, dedupeKey: `launch-item:${itemId}:${n}` });
  if (jobId) await execute(`UPDATE jobs SET attempts=1 WHERE id=?`, [jobId]);
  await execute(`UPDATE launch_items SET status='queued', job_id=?, error_code=NULL, error_message=NULL, error_hint=NULL, finished_at=NULL WHERE id=?`, [jobId, itemId]);
}

export async function cancelItem(orgId: number, itemId: number) {
  const item = await queryOne<any>(`SELECT * FROM launch_items WHERE id=? AND org_id=?`, [itemId, orgId]);
  if (!item) throw new AppError({ code: 'NOT_FOUND', message: 'This launch row was not found.', status: 404, category: 'not_found' });
  if (item.status === 'done' || item.status === 'cancelled') throw new AppError({ code: 'NOT_CANCELLABLE', message: 'This row is already finished.', status: 409, category: 'conflict' });
  if (item.status === 'working') throw new AppError({ code: 'BUSY', message: 'This row is being created right now. Wait for it to finish or stop.', status: 409, category: 'conflict', retryable: true });
  if (item.job_id) await execute(`UPDATE jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP(3) WHERE id=? AND status IN ('queued','failed','needs_review','dead')`, [item.job_id]);
  await execute(`UPDATE launch_items SET status='cancelled', finished_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [itemId]);
}
