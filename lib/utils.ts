// lib/utils.ts
// Small pure helpers used across modules.

import { randomBytes } from 'crypto';

/** Generate an idempotency key: telegram_timestamp_random */
export function makeIdempotencyKey(telegramId: number | string): string {
  const ts   = Date.now();
  const rand = randomBytes(6).toString('hex');
  return `${telegramId}_${ts}_${rand}`;
}

export function nowMs(): number {
  return Date.now();
}

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function toMoney(n: number): string {
  if (!isFiniteNumber(n)) return '0.00';
  return n.toFixed(2);
}

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function safeParseJson<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

/** Runs promises with a concurrency cap (order preserved). */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
