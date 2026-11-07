import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { decryptConnectionToken } from '../meta/connections.js';
import { graph } from '../meta/graph.js';
import { advancedInput, advancedProblems, geoLocations, GOALS, PLACEMENTS, placementTargeting } from './launch.js';
/**
 * Audience Manager: audiences saved once and loaded into Easy Ads or Advanced Ads. A saved audience is the
 * targeting half of a launch (countries, ages, genders, places, interests, languages, devices), so the same
 * zod rules and Employment checks apply. Custom audiences are per ad account and stay on the launch rows.
 */
export const audienceSpec = z.object({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1, 'Choose at least one country.').max(25),
    ageMin: z.number().int().min(18).max(65).default(18),
    ageMax: z.number().int().min(18).max(65).default(65),
    genders: z.enum(['all', 'male', 'female']).default('all'),
    advantageAudience: z.boolean().default(false),
    advanced: advancedInput.pick({ locations: true, interests: true, behaviors: true, excludedInterests: true, locales: true, devicePlatforms: true, userOs: true }).default(() => advancedInput.pick({ locations: true, interests: true, behaviors: true, excludedInterests: true, locales: true, devicePlatforms: true, userOs: true }).parse({})),
});
export const audienceInput = z.object({
    name: z.string().trim().min(1, 'Give the audience a name.').max(120),
    description: z.string().trim().max(500).default(''),
    specialCategory: z.enum(['NONE', 'EMPLOYMENT']).default('NONE'),
    spec: audienceSpec,
});
/** What Meta would refuse, using the same checks as a launch. */
export function audienceProblems(input) {
    const out = [];
    if (input.spec.ageMin > input.spec.ageMax)
        out.push('The minimum age is above the maximum age.');
    if (input.specialCategory === 'EMPLOYMENT' && (input.spec.ageMin !== 18 || input.spec.ageMax !== 65 || input.spec.genders !== 'all'))
        out.push('Job ads must target ages 18–65 and all genders (Meta special ad category rule).');
    const fake = { specialCategory: input.specialCategory, advanced: { ...advancedInput.parse({}), ...input.spec.advanced } };
    out.push(...advancedProblems(fake));
    return out;
}
const pub = (r) => ({ id: Number(r.id), name: r.name, description: r.description ?? '', specialCategory: r.special_category, spec: typeof r.spec === 'string' ? JSON.parse(r.spec) : r.spec, by: r.user_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
export async function listAudiences(orgId) {
    const rows = await query(`SELECT s.*, u.name AS user_name FROM saved_audiences s LEFT JOIN users u ON u.id=s.created_by WHERE s.org_id=? ORDER BY s.name`, [orgId]);
    return rows.map(pub);
}
export async function saveAudience(user, input, id) {
    const problems = audienceProblems(input);
    if (problems.length)
        throw new AppError({ code: 'AUDIENCE_INVALID', message: problems[0], status: 400, category: 'validation', details: { problems } });
    const dup = await queryOne(`SELECT id FROM saved_audiences WHERE org_id=? AND name=? ${id ? 'AND id<>?' : ''}`, id ? [user.orgId, input.name, id] : [user.orgId, input.name]);
    if (dup)
        throw new AppError({ code: 'AUDIENCE_NAME_TAKEN', message: 'An audience with this name already exists.', status: 409, category: 'validation' });
    if (id) {
        const r = await execute(`UPDATE saved_audiences SET name=?, description=?, special_category=?, spec=? WHERE id=? AND org_id=?`, [input.name, input.description || null, input.specialCategory, JSON.stringify(input.spec), id, user.orgId]);
        if (!r.affectedRows)
            throw new AppError({ code: 'NOT_FOUND', message: 'Audience was not found.', status: 404, category: 'not_found' });
        return id;
    }
    return (await execute(`INSERT INTO saved_audiences (org_id, name, description, special_category, spec, created_by) VALUES (?,?,?,?,?,?)`, [user.orgId, input.name, input.description || null, input.specialCategory, JSON.stringify(input.spec), user.id])).insertId;
}
export async function deleteAudience(orgId, id) {
    const r = await execute(`DELETE FROM saved_audiences WHERE id=? AND org_id=?`, [id, orgId]);
    if (!r.affectedRows)
        throw new AppError({ code: 'NOT_FOUND', message: 'Audience was not found.', status: 404, category: 'not_found' });
}
/** Meta's targeting block for a saved audience, the same shape a launch sends. */
export function audienceTargeting(spec, specialCategory, placements = []) {
    const employment = specialCategory === 'EMPLOYMENT';
    const a = spec.advanced;
    const t = {
        geo_locations: geoLocations(spec.countries, a.locations?.include ?? [], a.locations?.types),
        age_min: employment ? 18 : spec.ageMin,
        age_max: employment ? 65 : spec.ageMax,
        targeting_automation: { advantage_audience: spec.advantageAudience ? 1 : 0 },
        ...(placements.length ? placementTargeting(placements) : {}),
    };
    if (!employment && spec.genders !== 'all')
        t.genders = [spec.genders === 'male' ? 1 : 2];
    if (a.locations?.exclude?.length)
        t.excluded_geo_locations = geoLocations([], a.locations.exclude);
    const flex = {};
    if (a.interests?.length)
        flex.interests = a.interests.map((x) => ({ id: x.key, name: x.name }));
    if (a.behaviors?.length)
        flex.behaviors = a.behaviors.map((x) => ({ id: x.key, name: x.name }));
    if (Object.keys(flex).length)
        t.flexible_spec = [flex];
    if (a.excludedInterests?.length)
        t.exclusions = { interests: a.excludedInterests.map((x) => ({ id: x.key, name: x.name })) };
    if (a.locales?.length)
        t.locales = a.locales.map((x) => Number(x.key));
    if (a.devicePlatforms?.length && a.devicePlatforms.length < 2)
        t.device_platforms = a.devicePlatforms;
    if (a.userOs?.length)
        t.user_os = a.userOs;
    return t;
}
/** Meta's own reach estimate for an audience in one account (people reachable per month). Read live, never guessed. */
export async function estimateAudience(orgId, accountRowId, spec, specialCategory, goal = 'call') {
    const account = await queryOne(`SELECT a.account_id, a.name, c.token_ciphertext FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id WHERE a.id=? AND a.org_id=?`, [accountRowId, orgId]);
    if (!account)
        throw new AppError({ code: 'NOT_FOUND', message: 'Account was not found.', status: 404, category: 'not_found' });
    const g = goal === 'call' ? GOALS.call.calls : GOALS.website.clicks;
    const { data } = await graph({ path: `act_${account.account_id}/delivery_estimate`, params: { targeting_spec: audienceTargeting(spec, specialCategory), optimization_goal: g.optimization_goal }, accessToken: decryptConnectionToken(account), operation: 'meta.audience.estimate' });
    const e = data.data?.[0] ?? {};
    return { accountRowId, accountName: account.name, low: e.estimate_mau_lower_bound ?? e.estimate_mau ?? null, high: e.estimate_mau_upper_bound ?? null, ready: e.estimate_ready ?? null };
}
// ---------------------------------------------------------------- saved placement sets
export const placementSetInput = z.object({
    name: z.string().trim().min(1, 'Give the placement set a name.').max(120),
    placements: z.array(z.string()).min(1, 'Tick at least one placement.').refine((xs) => xs.every((k) => PLACEMENTS[k]), 'Unknown placement.'),
});
export async function listPlacementSets(orgId) {
    const rows = await query(`SELECT s.*, u.name AS user_name FROM saved_placements s LEFT JOIN users u ON u.id=s.created_by WHERE s.org_id=? ORDER BY s.name`, [orgId]);
    return rows.map((r) => ({ id: Number(r.id), name: r.name, placements: typeof r.placements === 'string' ? JSON.parse(r.placements) : r.placements, by: r.user_name ?? null, updatedAt: r.updated_at }));
}
export async function savePlacementSet(user, input, id) {
    const dup = await queryOne(`SELECT id FROM saved_placements WHERE org_id=? AND name=? ${id ? 'AND id<>?' : ''}`, id ? [user.orgId, input.name, id] : [user.orgId, input.name]);
    if (dup)
        throw new AppError({ code: 'PLACEMENTS_NAME_TAKEN', message: 'A placement set with this name already exists.', status: 409, category: 'validation' });
    if (id) {
        const r = await execute(`UPDATE saved_placements SET name=?, placements=? WHERE id=? AND org_id=?`, [input.name, JSON.stringify(input.placements), id, user.orgId]);
        if (!r.affectedRows)
            throw new AppError({ code: 'NOT_FOUND', message: 'Placement set was not found.', status: 404, category: 'not_found' });
        return id;
    }
    return (await execute(`INSERT INTO saved_placements (org_id, name, placements, created_by) VALUES (?,?,?,?)`, [user.orgId, input.name, JSON.stringify(input.placements), user.id])).insertId;
}
export async function deletePlacementSet(orgId, id) {
    const r = await execute(`DELETE FROM saved_placements WHERE id=? AND org_id=?`, [id, orgId]);
    if (!r.affectedRows)
        throw new AppError({ code: 'NOT_FOUND', message: 'Placement set was not found.', status: 404, category: 'not_found' });
}
//# sourceMappingURL=audiences.js.map