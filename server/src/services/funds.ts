import { minorToMajor } from '../meta/live.js';

/**
 * Money left in an ad account. Meta reports three different things and we keep them apart:
 * - prepaid funds: for prepaid accounts, only shown inside the payment method's text ("Available balance …");
 * - amount owed (`balance`): what postpaid accounts will be billed next;
 * - spending limit left: `spend_cap - amount_spent`, when an account spending limit is set.
 */

const MONEY_WORDS = /balance|funds|available|prepaid|remaining/i;

/** Reads the amount from Meta's payment-method text, only when that text is about a balance (never card digits). */
export function parseFundsDisplay(display: string | null | undefined, currency: string): number | null {
  if (!display || !MONEY_WORDS.test(display)) return null;
  const m = display.replace(/ /g, ' ').match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/);
  if (!m) return null;
  const major = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(major)) return null;
  return Math.round(major * (minorToMajor(1, currency) === 1 ? 1 : 100));
}

export interface FundsRow {
  currency: string;
  is_prepay: number | null;
  prepaid_funds_minor: number | string | null;
  balance_minor: number | string | null;
  spend_cap_minor: number | string | null;
  amount_spent_minor: number | string | null;
}

export function fundsInfo(a: FundsRow, avgDailySpend: number | null) {
  const cur = a.currency;
  const prepaid = a.is_prepay == null ? null : !!Number(a.is_prepay);
  const available = prepaid ? minorToMajor(a.prepaid_funds_minor, cur) : null;
  const owed = prepaid === false ? minorToMajor(a.balance_minor, cur) : null;
  const cap = minorToMajor(a.spend_cap_minor, cur);
  const spent = minorToMajor(a.amount_spent_minor, cur);
  const capLeft = cap != null && cap > 0 && spent != null ? Math.max(0, Math.round((cap - spent) * 100) / 100) : null;
  const candidates = [available, capLeft].filter((v): v is number => v != null);
  const remaining = candidates.length ? Math.min(...candidates) : null;
  const daysLeft = remaining != null && avgDailySpend != null && avgDailySpend > 0 ? Math.round((remaining / avgDailySpend) * 10) / 10 : null;
  return {
    kind: prepaid == null ? 'unknown' : prepaid ? 'prepaid' : 'postpaid',
    available, owed, spendCap: cap && cap > 0 ? cap : null, amountSpent: spent, capLeft, remaining,
    limitedBy: remaining == null ? null : remaining === available ? 'funds' : 'spend_cap',
    avgDailySpend, daysLeft,
  } as const;
}
