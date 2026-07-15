// lib/email.ts
// EmailJS REST API client (server-side).
// Docs: https://www.emailjs.com/docs/rest-api/send/

import { httpRequest } from './http';
import { logger } from './logger';

function opt(name: string): string {
  return (process.env[name] || '').trim();
}

export interface EmailJsPayload {
  toEmail: string;
  toName?: string;
  subject?: string;
  templateParams: Record<string, unknown>;
}

export const emailService = {
  isConfigured(): boolean {
    // PRIVATE_KEY is required for server-side (non-browser) sends — without it
    // EmailJS strict mode returns 403/404. Include it in the config check so
    // callers fail fast with a clear error instead of a mystery 404.
    return !!(
      opt('EMAILJS_SERVICE_ID') &&
      opt('EMAILJS_TEMPLATE_ID') &&
      opt('EMAILJS_PUBLIC_KEY') &&
      opt('EMAILJS_PRIVATE_KEY')
    );
  },

  async send(payload: EmailJsPayload): Promise<{ ok: true } | { ok: false; error: string }> {
    const serviceId  = opt('EMAILJS_SERVICE_ID');
    const templateId = opt('EMAILJS_TEMPLATE_ID');
    const publicKey  = opt('EMAILJS_PUBLIC_KEY');
    const privateKey = opt('EMAILJS_PRIVATE_KEY'); // for server-side accessToken

    if (!serviceId || !templateId || !publicKey) {
      return { ok: false, error: 'EmailJS not configured (missing env vars)' };
    }

    const body: Record<string, unknown> = {
      service_id:  serviceId,
      template_id: templateId,
      user_id:     publicKey,
      template_params: {
        to_email: payload.toEmail,
        to_name:  payload.toName || payload.toEmail,
        subject:  payload.subject || 'Notification',
        ...payload.templateParams,
      },
    };
    if (privateKey) body.accessToken = privateKey;

    // EmailJS requires PRIVATE_KEY for server-side (non-browser) calls.
    // Without it, the API returns 403/404 in strict mode.
    if (!privateKey) {
      const msg = 'EMAILJS_PRIVATE_KEY missing — required for server-side calls (EmailJS strict mode)';
      logger.error('email.send.failed', { error: msg, to: payload.toEmail });
      return { ok: false, error: msg };
    }

    try {
      const result = await httpRequest<unknown>('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'origin': 'https://api.emailjs.com' },
        body,
        timeoutMs: 15_000,
      });
      logger.info('email.sent', { to: payload.toEmail, template: templateId, status: result.status });
      return { ok: true };
    } catch (err) {
      // Surface EmailJS's own error body — it usually says exactly what's wrong
      // (invalid service_id, template_id not found, non-browser calls disabled, etc.)
      const anyErr = err as { status?: number; body?: string; message?: string };
      const status = anyErr.status ?? 0;
      const body   = anyErr.body ?? '';
      const msg    = `EmailJS ${status}: ${body || anyErr.message || 'unknown error'}`;
      logger.error('email.send.failed', {
        error: msg,
        status,
        body: body.slice(0, 300),
        to: payload.toEmail,
        serviceId,
        templateId,
      });
      return { ok: false, error: msg };
    }
  },
};
