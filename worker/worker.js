// Leksehjelp AI-proxy: holder Gemini-nøkkelen hemmelig og videresender kall fra appen.
const ALLOWED = ['https://khalm.github.io'];
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = { 'Access-Control-Allow-Origin': ok ? origin : ALLOWED[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, key: !!env.GEMINI_API_KEY }, { headers: cors });
    if (url.pathname === '/models' && ok) {
      if (!env.GEMINI_API_KEY) return Response.json({ error: { message: 'Nøkkelen mangler i workeren' } }, { status: 500, headers: cors });
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } });
    }
    const m = url.pathname.match(/^\/gemini\/([\w.\-]+)$/);
    if (!ok || req.method !== 'POST' || !m) return Response.json({ error: { message: 'Ikke tillatt' } }, { status: 403, headers: cors });
    if (!env.GEMINI_API_KEY) return Response.json({ error: { message: 'Nøkkelen mangler i workeren' } }, { status: 500, headers: cors });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m[1]}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: req.body,
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
