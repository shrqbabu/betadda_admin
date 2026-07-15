// lib/response.ts
// Uniform HTTP response helpers for the single admin.ts function.

import type { VercelResponse } from '@vercel/node';

export function ok(res: VercelResponse, body: unknown = { ok: true }): void {
  res.status(200).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

export function created(res: VercelResponse, body: unknown = { ok: true }): void {
  res.status(201).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

export function noContent(res: VercelResponse): void {
  res.status(204).end();
}

export function badRequest(res: VercelResponse, message = 'Bad request'): void {
  res.status(400).setHeader('Content-Type', 'application/json').send(JSON.stringify({ ok: false, error: message }));
}

export function unauthorized(res: VercelResponse, message = 'Unauthorized'): void {
  res.status(401).setHeader('Content-Type', 'application/json').send(JSON.stringify({ ok: false, error: message }));
}

export function forbidden(res: VercelResponse, message = 'Forbidden'): void {
  res.status(403).setHeader('Content-Type', 'application/json').send(JSON.stringify({ ok: false, error: message }));
}

export function serverError(res: VercelResponse, message = 'Internal server error'): void {
  res.status(500).setHeader('Content-Type', 'application/json').send(JSON.stringify({ ok: false, error: message }));
}
