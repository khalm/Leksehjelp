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
    // Hent en nettside/PDF for appen (nettlesere kan ikke hente andre sider direkte pga. CORS)
    if (url.pathname === '/fetch') {
      if (!ok) return Response.json({ error: { message: 'Ikke tillatt' } }, { status: 403, headers: cors });
      let t; try { t = new URL(url.searchParams.get('url') || ''); } catch { return Response.json({ error: { message: 'Ugyldig lenke' } }, { status: 400, headers: cors }); }
      const h = t.hostname.toLowerCase();
      const priv = /^(localhost|.*\.local|.*\.internal|.*\.lan)$/.test(h) || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(':') || h.startsWith('[');
      if (!/^https?:$/.test(t.protocol) || priv) return Response.json({ error: { message: 'Den lenken kan ikke hentes' } }, { status: 400, headers: cors });
      let r;
      try {
        r = await fetch(t.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36 Leksehjelp', 'Accept': 'text/html,application/xhtml+xml,application/pdf,image/*,text/plain;q=0.9,*/*;q=0.8', 'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.6' } });
      } catch { return Response.json({ error: { message: 'Fikk ikke kontakt med siden' } }, { status: 502, headers: cors }); }
      if (!r.ok) return Response.json({ error: { message: 'Siden svarte med feil ' + r.status + (r.status === 403 || r.status === 401 ? ' (krever kanskje innlogging)' : '') } }, { status: 502, headers: cors });
      const len = +(r.headers.get('content-length') || 0);
      if (len > 30e6) return Response.json({ error: { message: 'Filen er for stor (over 30 MB)' } }, { status: 413, headers: cors });
      return new Response(r.body, { headers: { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'X-Final-Url': r.url, 'Access-Control-Expose-Headers': 'X-Final-Url' } });
    }
    // Live-samtale: videresend WebSocket til Gemini Live API med nøkkelen lagt til her
    if (url.pathname === '/live') {
      if (!ok) return new Response('Ikke tillatt', { status: 403 });
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Forventet WebSocket', { status: 426 });
      if (!env.GEMINI_API_KEY) return new Response('Nøkkelen mangler i workeren', { status: 500 });
      const up = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(env.GEMINI_API_KEY);
      return fetch(up, req);
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
