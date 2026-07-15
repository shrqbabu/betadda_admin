// lib/config.ts
// Centralized, validated environment configuration.

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function opt(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function parseAdminIds(): number[] {
  const primary = req('ADMIN_TELEGRAM_ID');
  const extra   = opt('ADMIN_TELEGRAM_IDS');
  const list    = [primary, ...extra.split(',')]
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => Number(s))
    .filter(n => Number.isFinite(n) && n > 0);
  return Array.from(new Set(list));
}

function normalizePrivateKey(raw: string): string {
  // Vercel stores env vars as single-line; we accept escaped \n.
  if (raw.includes('\\n')) return raw.replace(/\\n/g, '\n');
  return raw;
}

export const config = {
  telegram: {
    botToken:       req('TELEGRAM_BOT_TOKEN'),
    webhookSecret:  opt('TELEGRAM_WEBHOOK_SECRET'),
    adminIds:       parseAdminIds(),
    apiBase:        'https://api.telegram.org',
  },
  admin: {
    secret: req('ADMIN_SECRET'),
  },
  firebase: {
    projectId:   req('FIREBASE_PROJECT_ID'),
    clientEmail: req('FIREBASE_CLIENT_EMAIL'),
    privateKey:  normalizePrivateKey(req('FIREBASE_PRIVATE_KEY')),
  },
  openrouter: {
    apiKey:  opt('OPENROUTER_API_KEY'),
    model:   opt('OPENROUTER_MODEL', 'google/gemini-2.5-flash-lite'),
    siteUrl: opt('OPENROUTER_SITE_URL', 'https://vercel.app'),
    siteName:opt('OPENROUTER_SITE_NAME', 'Telegram Admin Backend'),
    apiBase: 'https://openrouter.ai/api/v1',
  },
  nvidia: {
    apiKey:    opt('NVIDIA_API_KEY'),
    model:     opt('NVIDIA_MODEL', 'meta/llama-3.3-70b-instruct'),
    // Comma-separated list of fallback models tried in order on failure.
    fallbacks: opt('NVIDIA_FALLBACK_MODELS',
      'nvidia/llama-3.1-nemotron-70b-instruct,openai/gpt-oss-120b,meta/llama-3.1-70b-instruct'),
    apiBase:   'https://integrate.api.nvidia.com/v1',
  },
  ai: {
    // Which provider handles admin chat modes (chat/code/logs/debug).
    // Agent mode always uses OpenRouter (tool-calling).
    provider: opt('AI_PROVIDER', 'openrouter') as 'openrouter' | 'nvidia',
  },
  cors: {
    // Comma-separated list. Use "*" for public.
    allowedOrigins: opt('CORS_ALLOWED_ORIGINS', '*'),
    // Optional shared secret for /api/chat. If set, clients must send `x-api-key`.
    publicApiKey:   opt('PUBLIC_API_KEY'),
  },
  runtime: {
    nodeEnv: opt('NODE_ENV', 'production'),
    logLevel: opt('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
  },
} as const;

export type AppConfig = typeof config;
