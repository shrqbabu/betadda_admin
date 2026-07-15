// lib/http.ts
// Thin fetch wrapper with timeout + JSON helpers (Node 18+ global fetch).

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse<T> {
  ok: boolean;
  status: number;
  data: T;
  raw: string;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export async function httpRequest<T = unknown>(
  url: string,
  opts: HttpRequestOptions = {}
): Promise<HttpResponse<T>> {
  const method    = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(opts.headers || {}),
  };

  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === 'string') {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const raw = await res.text();
    let data: T;
    try {
      data = raw ? (JSON.parse(raw) as T) : (undefined as unknown as T);
    } catch {
      data = raw as unknown as T;
    }

    if (!res.ok) {
      throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`, raw);
    }
    return { ok: res.ok, status: res.status, data, raw };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new HttpError(0, `Request timeout after ${timeoutMs}ms`, '');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
