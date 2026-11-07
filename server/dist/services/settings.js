import { z } from 'zod';
import { execute, queryOne, transaction } from '../db/pool.js';
import { audit } from './audit.js';
export const brandingSchema = z.object({
    panelName: z.string().trim().min(2).max(120),
    logoUrl: z.string().url().max(1024).nullable().optional(),
    faviconUrl: z.string().url().max(1024).nullable().optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like #4f46e5'),
    sidebarStyle: z.enum(['default', 'compact']),
    defaultTheme: z.enum(['light', 'dark', 'system']),
    defaultCurrency: z.string().regex(/^[A-Z]{3}$/),
    timezone: z.string().min(1).max(64).refine((tz) => {
        try {
            new Intl.DateTimeFormat('en', { timeZone: tz });
            return true;
        }
        catch {
            return false;
        }
    }, 'unknown time zone'),
    defaultLanguage: z.enum(['bn', 'en']),
    aiAssistantName: z.string().trim().min(2).max(80),
});
export const DEFAULT_BRANDING = {
    panelName: 'Ads Command Center',
    logoUrl: null,
    faviconUrl: null,
    primaryColor: '#4f46e5',
    sidebarStyle: 'default',
    defaultTheme: 'system',
    defaultCurrency: 'USD',
    timezone: 'Asia/Dhaka',
    defaultLanguage: 'bn',
    aiAssistantName: 'AI Ads Copilot',
};
function fromRow(r) {
    return {
        panelName: r.panel_name,
        logoUrl: r.logo_url,
        faviconUrl: r.favicon_url,
        primaryColor: r.primary_color,
        sidebarStyle: r.sidebar_style,
        defaultTheme: r.default_theme,
        defaultCurrency: r.default_currency,
        timezone: r.timezone,
        defaultLanguage: r.default_language,
        aiAssistantName: r.ai_assistant_name,
    };
}
/** Public branding (login page needs it before sign-in). Single-org installs read the first org. */
export async function getBranding(orgId) {
    const row = orgId
        ? await queryOne(`SELECT * FROM branding_settings WHERE org_id=?`, [orgId])
        : await queryOne(`SELECT * FROM branding_settings ORDER BY org_id LIMIT 1`);
    return row ? fromRow(row) : DEFAULT_BRANDING;
}
export async function updateBranding(orgId, userId, input, ip) {
    const before = await getBranding(orgId);
    await transaction(async (conn) => {
        await execute(`INSERT INTO branding_settings (org_id, panel_name, logo_url, favicon_url, primary_color, sidebar_style, default_theme, default_currency, timezone, default_language, ai_assistant_name, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE panel_name=VALUES(panel_name), logo_url=VALUES(logo_url), favicon_url=VALUES(favicon_url), primary_color=VALUES(primary_color),
         sidebar_style=VALUES(sidebar_style), default_theme=VALUES(default_theme), default_currency=VALUES(default_currency), timezone=VALUES(timezone),
         default_language=VALUES(default_language), ai_assistant_name=VALUES(ai_assistant_name), updated_by=VALUES(updated_by)`, [orgId, input.panelName, input.logoUrl ?? null, input.faviconUrl ?? null, input.primaryColor, input.sidebarStyle, input.defaultTheme, input.defaultCurrency, input.timezone, input.defaultLanguage, input.aiAssistantName, userId], conn);
        await audit({ orgId, actorUserId: userId, action: 'settings.branding_updated', targetType: 'branding', targetId: orgId, details: { before, after: input }, ip }, conn);
    });
    return getBranding(orgId);
}
//# sourceMappingURL=settings.js.map