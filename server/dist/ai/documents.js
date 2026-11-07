import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import PDFDocument from 'pdfkit';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { accountSummaries, campaignSummaries, balanceSummaries } from './data.js';
import { findings as computeFindingsFor } from './findings.js';
import { aiConfigured, chat } from './openai.js';
const PERIOD_LABEL = { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '14d': 'Last 14 days', '30d': 'Last 30 days', this_month: 'This month', last_month: 'Last month' };
const money = (n, c) => (n == null ? '—' : `${c} ${n.toLocaleString('en', { maximumFractionDigits: 2 })}`);
export async function buildPerformanceSections(user, params, assistantName) {
    const accounts = await accountSummaries(user, params.period, params.group);
    const campaigns = await campaignSummaries(user, params.period, { groupId: params.group, onlyWithSpendOrActive: true });
    const balances = await balanceSummaries(user, params.group);
    const f = await computeFindingsFor(user, params.period, params.group);
    const groupName = params.group ? (await queryOne(`SELECT name FROM account_groups WHERE id=? AND org_id=?`, [params.group, user.orgId]))?.name : null;
    const synced = accounts.filter((a) => a.synced);
    const currencies = [...new Set(synced.map((a) => a.currency))];
    const range = accounts[0]?.range;
    const title = `${PERIOD_LABEL[params.period] ?? params.period} performance${groupName ? ` · ${groupName}` : ''}${range ? ` (${range.since} to ${range.until})` : ''}`;
    const totalsLines = currencies.map((c) => {
        const mine = synced.filter((a) => a.currency === c);
        const spend = mine.reduce((n, a) => n + a.spend, 0);
        const leads = mine.reduce((n, a) => n + a.leads, 0), calls = mine.reduce((n, a) => n + a.calls, 0), msgs = mine.reduce((n, a) => n + a.messages, 0);
        return `${mine.length} account${mine.length === 1 ? '' : 's'} in ${c}: spend ${money(spend, c)}, ${leads} leads, ${calls} calls, ${msgs} messages.`;
    });
    const sections = [
        { id: 'overview', title: 'Overview', body: [`${accounts.length} working account${accounts.length === 1 ? '' : 's'}${groupName ? ` in the group “${groupName}”` : ''}; ${synced.length} synced from Meta.`, ...totalsLines, accounts.length > synced.length ? `${accounts.length - synced.length} account(s) have no synced numbers yet and are not in the totals.` : ''].filter(Boolean).join('\n') },
        {
            id: 'accounts', title: 'Accounts', body: 'In your account order. Results are what the panel counts for each account’s campaigns.',
            table: { columns: ['#', 'Account', 'Spend', 'Impressions', 'Clicks', 'CTR %', 'Leads', 'Calls', 'Messages', 'Top result', 'Cost per result'], rows: accounts.map((a) => [a.position, a.name, a.synced ? money(a.spend, a.currency) : 'not synced', a.impressions, a.clicks, a.ctr ?? '—', a.leads, a.calls, a.messages, a.results[0] ? `${a.results[0].count} ${a.results[0].label.toLowerCase()}` : '—', a.results[0]?.costPer != null ? money(a.results[0].costPer, a.currency) : '—']) },
        },
        {
            id: 'campaigns', title: 'Campaigns with spend or running', body: `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}.`,
            table: { columns: ['Account', 'Campaign', 'Status', 'Budget', 'Spend', 'Clicks', 'Top result', 'Cost per result'], rows: campaigns.slice(0, 200).map((c) => [c.accountName, c.name, c.effectiveStatus ?? '—', c.budget ? `${money(c.budget.amount, c.currency)} ${c.budget.kind}` : '—', money(c.spend, c.currency), c.clicks, c.results[0] ? `${c.results[0].count} ${c.results[0].label.toLowerCase()}` : '—', c.results[0]?.costPer != null ? money(c.results[0].costPer, c.currency) : '—']) },
        },
        {
            id: 'balances', title: 'Money left', body: 'Days left = money left ÷ the average daily spend of the last 7 full days.',
            table: { columns: ['Account', 'Payment', 'Available', 'Limit left', 'Spend a day', 'Days left'], rows: balances.map((b) => [b.name, b.kind, b.available != null ? money(b.available, b.currency) : '—', b.capLeft != null ? money(b.capLeft, b.currency) : '—', b.avgDailySpend != null ? money(b.avgDailySpend, b.currency) : '—', b.daysLeft ?? '—']) },
        },
        {
            id: 'findings', title: 'Findings', body: f.findings.length ? f.findings.map((x) => `- [${x.severity}] ${x.title}: ${x.detail}${x.suggestion ? ` Suggestion: ${x.suggestion}` : ''}`).join('\n') : 'No findings for this period.',
        },
    ];
    if (aiConfigured()) {
        try {
            const res = await chat([
                { role: 'system', content: `You are ${assistantName}, writing two short sections of a report for the owner of these ad accounts, in ${params.language === 'bn' ? 'Bengali' : 'English'}. Use only the numbers given; do not invent any. Return JSON: {"summary": "...", "recommendations": "- ...\\n- ..."}. Summary: at most 120 words on what happened. Recommendations: 3 to 5 bullets, each tied to a number in the data.` },
                { role: 'user', content: JSON.stringify({ title, accounts: accounts.map((a) => ({ name: a.name, currency: a.currency, synced: a.synced, spend: a.spend, clicks: a.clicks, leads: a.leads, calls: a.calls, messages: a.messages, topResult: a.results[0] ?? null })), findings: f.findings.map((x) => ({ severity: x.severity, title: x.title, detail: x.detail })) }).slice(0, 40_000) },
            ], { json: true, maxTokens: 700 });
            const parsed = JSON.parse(res.message.content ?? '{}');
            if (parsed.summary)
                sections.unshift({ id: 'summary', title: 'Summary', body: String(parsed.summary).slice(0, 4000), ai: true });
            if (parsed.recommendations)
                sections.push({ id: 'recommendations', title: 'Recommendations', body: String(parsed.recommendations).slice(0, 4000), ai: true });
        }
        catch (err) {
            sections.push({ id: 'ai-note', title: 'Note', body: `The AI summary could not be written: ${String(err?.message ?? err).slice(0, 300)}. The tables above are complete.` });
        }
    }
    else {
        sections.push({ id: 'ai-note', title: 'Note', body: 'The AI summary and recommendations are added when OPENAI_API_KEY and OPENAI_MODEL are set on the server. The tables above are complete.' });
    }
    return { sections, title };
}
export async function createDocument(user, input, assistantName) {
    const built = await buildPerformanceSections(user, input.params, assistantName);
    const title = input.title?.trim() || built.title;
    const id = (await execute(`INSERT INTO ai_documents (org_id, user_id, title, kind, params) VALUES (?,?,?,?,?)`, [user.orgId, user.id, title.slice(0, 190), input.kind, JSON.stringify(input.params)])).insertId;
    await execute(`INSERT INTO ai_document_versions (document_id, version, sections, note, created_by) VALUES (?,1,?,?,?)`, [id, JSON.stringify(built.sections), 'Generated from synced data', user.id]);
    return id;
}
export async function listDocuments(user) {
    const rows = await query(`SELECT d.id, d.title, d.kind, d.params, d.current_version, d.created_at, d.updated_at, u.name AS user_name FROM ai_documents d LEFT JOIN users u ON u.id=d.user_id WHERE d.org_id=? ORDER BY d.updated_at DESC LIMIT 100`, [user.orgId]);
    return rows.map((r) => ({ id: Number(r.id), title: r.title, kind: r.kind, params: typeof r.params === 'string' ? JSON.parse(r.params) : r.params, version: Number(r.current_version), createdAt: r.created_at, updatedAt: r.updated_at, by: r.user_name }));
}
export async function getDocument(user, id, version) {
    const d = await queryOne(`SELECT * FROM ai_documents WHERE id=? AND org_id=?`, [id, user.orgId]);
    if (!d)
        throw new AppError({ code: 'NOT_FOUND', message: 'Document was not found.', status: 404, category: 'not_found' });
    const v = version ?? Number(d.current_version);
    const row = await queryOne(`SELECT * FROM ai_document_versions WHERE document_id=? AND version=?`, [id, v]);
    if (!row)
        throw new AppError({ code: 'NOT_FOUND', message: 'That version was not found.', status: 404, category: 'not_found' });
    const versions = await query(`SELECT v.version, v.note, v.created_at, u.name AS user_name FROM ai_document_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.document_id=? ORDER BY v.version DESC`, [id]);
    return {
        id, title: d.title, kind: d.kind, params: typeof d.params === 'string' ? JSON.parse(d.params) : d.params, currentVersion: Number(d.current_version), version: v,
        sections: (typeof row.sections === 'string' ? JSON.parse(row.sections) : row.sections),
        versions: versions.map((x) => ({ version: Number(x.version), note: x.note, at: x.created_at, by: x.user_name })),
    };
}
export async function saveVersion(user, id, input) {
    const d = await queryOne(`SELECT * FROM ai_documents WHERE id=? AND org_id=?`, [id, user.orgId]);
    if (!d)
        throw new AppError({ code: 'NOT_FOUND', message: 'Document was not found.', status: 404, category: 'not_found' });
    const next = Number(d.current_version) + 1;
    await execute(`INSERT INTO ai_document_versions (document_id, version, sections, note, created_by) VALUES (?,?,?,?,?)`, [id, next, JSON.stringify(input.sections), input.note?.slice(0, 255) ?? 'Edited', user.id]);
    await execute(`UPDATE ai_documents SET current_version=?, title=COALESCE(?, title) WHERE id=?`, [next, input.title?.trim() ? input.title.trim().slice(0, 190) : null, id]);
    return next;
}
export async function deleteDocument(user, id) {
    const res = await execute(`DELETE FROM ai_documents WHERE id=? AND org_id=?`, [id, user.orgId]);
    if (!res.affectedRows)
        throw new AppError({ code: 'NOT_FOUND', message: 'Document was not found.', status: 404, category: 'not_found' });
}
function paragraphs(body) {
    return body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}
export async function renderDocx(doc, footer) {
    const children = [new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }), new Paragraph({ children: [new TextRun({ text: footer, size: 18, color: '666666' })] })];
    for (const s of doc.sections) {
        children.push(new Paragraph({ text: s.title + (s.ai ? ' (written by the assistant from the numbers below)' : ''), heading: HeadingLevel.HEADING_1 }));
        for (const p of paragraphs(s.body)) {
            const lines = p.split('\n');
            for (const line of lines) {
                if (line.startsWith('- '))
                    children.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
                else
                    children.push(new Paragraph({ text: line }));
            }
        }
        if (s.table && s.table.rows.length) {
            const cell = (v, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: v == null ? '' : String(v), bold, size: 18 })] })] });
            children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: s.table.columns.map((c) => cell(c, true)) }), ...s.table.rows.map((r) => new TableRow({ children: r.map((v) => cell(v)) }))] }));
            children.push(new Paragraph({ text: '' }));
        }
    }
    const d = new Document({ creator: 'Ads Command Center', title: doc.title, sections: [{ children }] });
    return Packer.toBuffer(d);
}
export function renderPdf(doc, footer) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: 'A4', margin: 40, info: { Title: doc.title, Producer: 'Ads Command Center' } });
        const chunks = [];
        pdf.on('data', (c) => chunks.push(c));
        pdf.on('end', () => resolve(Buffer.concat(chunks)));
        pdf.on('error', reject);
        pdf.font('Helvetica-Bold').fontSize(18).text(doc.title);
        pdf.font('Helvetica').fontSize(9).fillColor('#666666').text(footer).fillColor('#000000').moveDown();
        const width = pdf.page.width - 80;
        for (const s of doc.sections) {
            pdf.moveDown(0.5).font('Helvetica-Bold').fontSize(13).text(s.title + (s.ai ? '  (written by the assistant)' : '')).moveDown(0.3);
            pdf.font('Helvetica').fontSize(10);
            for (const p of paragraphs(s.body))
                for (const line of p.split('\n'))
                    pdf.text(line.startsWith('- ') ? '•  ' + line.slice(2) : line, { width });
            if (s.table && s.table.rows.length) {
                const cols = s.table.columns.length;
                const colW = width / cols;
                const row = (vals, bold) => {
                    if (pdf.y > pdf.page.height - 80)
                        pdf.addPage();
                    const y = pdf.y;
                    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
                    let maxH = 0;
                    vals.forEach((v, i) => {
                        const text = v == null ? '' : String(v);
                        const h = pdf.heightOfString(text, { width: colW - 4 });
                        maxH = Math.max(maxH, h);
                        pdf.text(text, 40 + i * colW, y, { width: colW - 4, lineBreak: true });
                    });
                    pdf.y = y + maxH + 4;
                    pdf.x = 40;
                };
                pdf.moveDown(0.3);
                row(s.table.columns, true);
                for (const r of s.table.rows)
                    row(r, false);
                pdf.moveDown(0.5);
            }
        }
        pdf.end();
    });
}
//# sourceMappingURL=documents.js.map