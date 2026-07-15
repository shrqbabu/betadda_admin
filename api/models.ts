// api/models.ts
// Debug endpoint — GET /api/models returns the list of model IDs the
// configured NVIDIA_API_KEY can actually invoke. Gated by PUBLIC_API_KEY if set.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listNvidiaModels } from '../lib/nvidia';
import { applyCors, checkPublicApiKey } from '../lib/cors';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  if (!checkPublicApiKey(req)) {
    res.status(401).json({ ok: false, error: 'Missing or invalid x-api-key' });
    return;
  }
  const r = await listNvidiaModels();
  if (!r.ok) {
    res.status(502).json(r);
    return;
  }
  res.status(200).json({ ok: true, count: r.ids.length, ids: r.ids });
}
