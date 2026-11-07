import { env, features } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
let fetchImpl = (...a) => fetch(...a);
export function setAiFetchForTests(f) {
    fetchImpl = f;
}
export function aiConfigured() {
    return features().openai;
}
export function requireAi() {
    if (!aiConfigured())
        throw new AppError({ code: 'AI_NOT_CONFIGURED', message: 'The AI assistant is not configured on this server.', status: 503, category: 'configuration', hint: 'Set OPENAI_API_KEY and OPENAI_MODEL in the hosting settings, then restart the app.' });
}
export async function chat(messages, opts = {}) {
    requireAi();
    const e = env();
    const body = { model: e.OPENAI_MODEL, messages, temperature: opts.temperature ?? 0.2, max_completion_tokens: opts.maxTokens ?? 1500 };
    if (opts.tools?.length)
        body.tools = opts.tools, (body.tool_choice = 'auto');
    if (opts.json)
        body.response_format = { type: 'json_object' };
    let res;
    try {
        res = await fetchImpl(`${(e.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${e.OPENAI_API_KEY}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90_000),
        });
    }
    catch (err) {
        throw new AppError({ code: 'AI_NETWORK', message: `Could not reach OpenAI: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? err}`, status: 502, category: 'external_ai', retryable: true });
    }
    const text = await res.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    }
    catch {
        /* non-JSON handled below */
    }
    if (!res.ok) {
        const msg = String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 500);
        logger.warn({ status: res.status, msg }, 'openai error');
        const code = res.status === 401 ? 'AI_AUTH' : res.status === 429 ? 'AI_RATE_LIMITED' : res.status === 404 ? 'AI_MODEL' : 'AI_ERROR';
        throw new AppError({
            code,
            message: res.status === 401 ? 'OpenAI rejected the API key.' : res.status === 429 ? 'OpenAI is rate-limiting or the account is out of credit.' : res.status === 404 ? `OpenAI does not know the model "${e.OPENAI_MODEL}".` : `OpenAI error: ${msg}`,
            status: 502,
            category: 'external_ai',
            retryable: res.status === 429 || res.status >= 500,
            hint: res.status === 401 ? 'Check OPENAI_API_KEY in the hosting settings.' : res.status === 404 ? 'Check OPENAI_MODEL in the hosting settings.' : undefined,
            details: { status: res.status, message: msg },
        });
    }
    const choice = data.choices?.[0];
    if (!choice?.message)
        throw new AppError({ code: 'AI_BAD_RESPONSE', message: 'OpenAI returned an unexpected response.', status: 502, category: 'external_ai', retryable: true });
    return { message: choice.message, finishReason: choice.finish_reason ?? 'stop', usage: data.usage };
}
//# sourceMappingURL=openai.js.map