// lib/logger.ts
// Structured, level-aware logger. No external deps.

import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function enabled(level: Level): boolean {
  return ORDER[level] >= ORDER[config.runtime.logLevel];
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta || {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error')      console.error(line);
  else if (level === 'warn')  console.warn(line);
  else                        console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  child(bindings: Record<string, unknown>) {
    return {
      debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, { ...bindings, ...meta }),
      info:  (m: string, meta?: Record<string, unknown>) => emit('info',  m, { ...bindings, ...meta }),
      warn:  (m: string, meta?: Record<string, unknown>) => emit('warn',  m, { ...bindings, ...meta }),
      error: (m: string, meta?: Record<string, unknown>) => emit('error', m, { ...bindings, ...meta }),
    };
  },
};

export type Logger = typeof logger;
