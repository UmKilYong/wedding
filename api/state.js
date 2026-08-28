const KEY = 'wedding-timeline:state';
const MAX_DOC_BYTES = 262144;

function cfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(c, cmd) {
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

async function current(c) {
  const raw = await redis(c, ['GET', KEY]);
  return raw ? JSON.parse(raw) : { rev: 0, doc: null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const c = cfg();
  if (!c) return res.status(503).json({ error: 'kv-not-configured' });
  try {
    if (req.method === 'GET') return res.status(200).json(await current(c));
    if (req.method === 'PUT') {
      const b = req.body;
      if (!b || typeof b.baseRev !== 'number' || !b.doc || typeof b.doc !== 'object' || !Array.isArray(b.doc.rows))
        return res.status(400).json({ error: 'bad-request' });
      const s = JSON.stringify(b.doc);
      if (Buffer.byteLength(s, 'utf8') > MAX_DOC_BYTES) return res.status(413).json({ error: 'too-large' });
      const cur = await current(c);
      if (cur.rev !== b.baseRev) return res.status(409).json(cur);
      const next = { rev: cur.rev + 1, doc: b.doc };
      await redis(c, ['SET', KEY, JSON.stringify(next)]);
      return res.status(200).json({ rev: next.rev });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    return res.status(502).json({ error: 'kv-error' });
  }
};
