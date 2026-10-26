/* Leksehjelp – studer og pugg et tema basert på ditt eget stoff */
'use strict';
const VERSION = '1.1.0';
const DEFAULT_MODEL = 'gemini-flash-latest';
const FALLBACK_MODEL = 'gemini-2.5-flash';
const MAX_DOC_CHARS = 400000;

/* ---------- små hjelpere ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function toast(msg, ms = 3000) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
function segVal(name) { const b = $(`.seg[data-name="${name}"] button.on`); return b ? b.dataset.v : null; }

/* ---------- lagring (IndexedDB, med localStorage som reserve) ---------- */
const store = (() => {
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('leksehjelp', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function get(k) {
    try { const d = await db(); return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
    catch { try { return JSON.parse(localStorage.getItem('lh_' + k)); } catch { return undefined; } }
  }
  async function set(k, v) {
    try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
    catch { try { localStorage.setItem('lh_' + k, JSON.stringify(v)); } catch { toast('Klarte ikke å lagre – lite plass?'); } }
  }
  return { get, set };
})();

const settings = { apiKey: '', model: '', voice: '', lang: 'no' };
let topics = [];
let cur = null; // gjeldende tema
const PROXY = (window.LEKSEHJELP_PROXY || '').replace(/\/$/, '');
const hasKey = () => !!settings.apiKey || !!PROXY;

async function loadAll() {
  Object.assign(settings, (await store.get('settings')) || {});
  topics = (await store.get('topics')) || [];
}
const saveSettings = () => store.set('settings', { ...settings });
const saveTopics = () => store.set('topics', topics);

/* ---------- språk ---------- */
const LANG = {
  no: { label: '🇳🇴 NO', sr: 'nb-NO', voice: ['nb', 'no', 'nn'], name: 'norsk bokmål' },
  en: { label: '🇬🇧 EN', sr: 'en-US', voice: ['en'], name: 'engelsk (English)' },
};
function setLang(l, announce) {
  settings.lang = l; saveSettings();
  $('#langBtn').textContent = LANG[l].label;
  if (announce) toast(l === 'en' ? 'Switched to English 🇬🇧' : 'Byttet til norsk 🇳🇴');
}

/* ---------- Gemini ---------- */
async function gemini(parts, { system = '', json = false, temp = 0.4, history = null } = {}) {
  if (!hasKey()) throw new Error('NOKEY');
  const contents = history ? history : [{ role: 'user', parts: Array.isArray(parts) ? parts : [{ text: parts }] }];
  const body = { contents, generationConfig: { temperature: temp } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const models = [settings.model || DEFAULT_MODEL];
  if (!settings.model) models.push(FALLBACK_MODEL);
  let lastErr;
  for (const m of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const direct = !!settings.apiKey;
      const r = await fetch(direct ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent` : `${PROXY}/gemini/${encodeURIComponent(m)}`, {
        method: 'POST', headers: direct ? { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey } : { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(e => ({ ok: false, status: 0, _e: e }));
      if (r.ok) {
        const d = await r.json();
        const txt = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        if (!txt) throw new Error(d.promptFeedback?.blockReason ? 'Svaret ble blokkert av Google sitt filter.' : 'Tomt svar fra AI.');
        if (!json) return txt;
        return parseJSON(txt);
      }
      let msg = ''; try { msg = (await r.json()).error?.message || ''; } catch { }
      if (r.status === 404) { lastErr = new Error('Modellen finnes ikke: ' + m); break; }
      if (r.status === 400 && /API key/i.test(msg)) throw new Error(settings.apiKey ? 'API-nøkkelen er ugyldig. Sjekk den under ⚙.' : 'Den innebygde AI-nøkkelen virker ikke. Sjekk LEKSEHJELP_GEMINI_API_KEY.');
      if (r.status === 403) throw new Error(msg || 'Ingen tilgang til AI-en.');
      if (r.status === 429 || r.status === 503 || r.status === 500 || r.status === 0) {
        lastErr = new Error(r.status === 429 ? 'Gratiskvoten er brukt opp akkurat nå. Vent litt og prøv igjen.' : r.status === 0 ? 'Ingen nettforbindelse.' : 'Google er opptatt akkurat nå. Prøv igjen.');
        await sleep(1500 * (attempt + 1)); continue;
      }
      throw new Error(msg || ('Feil fra AI (' + r.status + ')'));
    }
  }
  throw lastErr || new Error('Ukjent feil');
}
function parseJSON(t) {
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { }
  const s = Math.min(...['{', '['].map(c => t.indexOf(c)).filter(i => i >= 0));
  const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  return JSON.parse(t.slice(s, e + 1));
}
function docText(t = cur) {
  const s = t.sources.map((x, i) => `### Kilde ${i + 1}: ${x.name}\n${x.text}`).join('\n\n');
  return s.length > MAX_DOC_CHARS ? s.slice(0, MAX_DOC_CHARS) + '\n[…stoffet er forkortet…]' : s;
}
function langRule() {
  return settings.lang === 'en'
    ? 'Write and speak in ENGLISH, even though the study material may be in Norwegian. Translate terms correctly.'
    : 'Skriv på norsk bokmål.';
}
function groundRules() {
  return `Du er Leksehjelp, en tålmodig og vennlig studiehjelper for elever.
VIKTIGE REGLER:
- Bruk KUN fakta som står i STUDIESTOFFET under. Ikke legg til fakta, tall, navn eller årstall som ikke står der.
- Hvis noe ikke står i stoffet, si tydelig at det ikke står i stoffet (du kan si at eleven kan spørre læreren eller slå det opp).
- Gjengi fakta slik de står i stoffet, selv om du tror noe annet er riktig. Hvis du mener stoffet tar feil, kan du kort nevne at eleven kan bruke «Sjekk»-fanen.
- ${langRule()}
STUDIESTOFF (tema: ${cur.name || 'uten navn'}):
"""
${docText()}
"""`;
}

/* ---------- tale: gjenkjenning ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
function listen() {
  return new Promise((resolve, reject) => {
    if (!SR) { reject(new Error(isIOS ? 'Talegjenkjenning støttes ikke her. Bruk mikrofonen på tastaturet i stedet.' : 'Nettleseren støtter ikke talegjenkjenning. Bruk Chrome eller mikrofonen på tastaturet.')); return; }
    stopSpeaking();
    try { recog?.abort(); } catch { }
    recog = new SR();
    recog.lang = LANG[settings.lang].sr;
    recog.interimResults = true; recog.continuous = false; recog.maxAlternatives = 1;
    let final = '', interim = '';
    recog.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      listen.onInterim?.(final + interim);
    };
    recog.onerror = e => { if (e.error === 'no-speech' || e.error === 'aborted') resolve(''); else reject(new Error(e.error === 'not-allowed' ? 'Mikrofonen er blokkert. Gi appen tilgang til mikrofonen i innstillingene.' : 'Talefeil: ' + e.error)); };
    recog.onend = () => resolve((final || interim).trim());
    try { recog.start(); } catch (e) { reject(e); }
  });
}
function stopListening() { try { recog?.stop(); } catch { } }

/* ---------- tale: opplesning ---------- */
let voices = [];
function loadVoices() { voices = speechSynthesis?.getVoices?.() || []; fillVoiceSelect(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice(lang) {
  const pref = LANG[lang].voice;
  const cand = voices.filter(v => pref.some(p => v.lang.toLowerCase().startsWith(p)));
  if (lang === 'no' && settings.voice) { const v = cand.find(v => v.voiceURI === settings.voice); if (v) return v; }
  return cand.find(v => /premium|enhanced|natural|neural/i.test(v.name)) || cand.find(v => v.localService) || cand[0] || null;
}
function splitSentences(t) {
  return (t.match(/[^.!?…\n]+[.!?…]*["»”)]*\s*|\n+/g) || [t]).map(s => s.trim()).filter(Boolean);
}
function chunkForSpeech(t) {
  const out = []; let buf = '';
  for (const s of splitSentences(t)) { if ((buf + ' ' + s).length > 220 && buf) { out.push(buf); buf = s; } else buf = buf ? buf + ' ' + s : s; }
  if (buf) out.push(buf); return out;
}
let speakToken = 0;
function stopSpeaking() { speakToken++; try { speechSynthesis.cancel(); } catch { } }
function speak(text, { rate } = {}) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window) || !text) return resolve(false);
    const my = ++speakToken; try { speechSynthesis.cancel(); } catch { }
    const chunks = chunkForSpeech(text.replace(/[*#_`]/g, ''));
    const voice = pickVoice(settings.lang);
    let i = 0;
    const next = () => {
      if (my !== speakToken) return resolve(false);
      if (i >= chunks.length) return resolve(true);
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.lang = voice?.lang || LANG[settings.lang].sr; if (voice) u.voice = voice;
      u.rate = rate || +$('#pRate').value || 1;
      u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    };
    next();
  });
}

/* ---------- opplesning med spiller (foredrag/sammendrag) ---------- */
const player = { items: [], idx: 0, playing: false, token: 0 };
async function playFrom(i) {
  const my = ++player.token; player.idx = i; player.playing = true;
  $('#player').hidden = false; $('#pPlay').textContent = '⏸';
  while (player.idx < player.items.length && my === player.token) {
    const el = player.items[player.idx];
    $$('.speaking').forEach(x => x.classList.remove('speaking'));
    el.classList.add('speaking'); el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const done = await speak(el.textContent);
    if (my !== player.token) return;
    if (!done && !player.playing) return;
    player.idx++;
  }
  if (my === player.token) { player.playing = false; $('#pPlay').textContent = '▶'; $$('.speaking').forEach(x => x.classList.remove('speaking')); }
}
function startReading(container) { player.items = $$('h3,p,li', container); if (player.items.length) playFrom(0); }
function stopPlayer() { player.token++; player.playing = false; stopSpeaking(); $('#player').hidden = true; $$('.speaking').forEach(x => x.classList.remove('speaking')); }
$('#pPlay').onclick = () => { if (player.playing) { player.token++; player.playing = false; stopSpeaking(); $('#pPlay').textContent = '▶'; } else playFrom(player.idx); };
$('#pNext').onclick = () => playFrom(Math.min(player.idx + 1, player.items.length - 1));
$('#pPrev').onclick = () => playFrom(Math.max(player.idx - 1, 0));
$('#pStop').onclick = stopPlayer;
$('#pRate').onchange = () => { if (player.playing) playFrom(player.idx); };

/* ---------- enkel markdown ---------- */
function md(t) {
  const lines = String(t).replace(/\r/g, '').split('\n'); let html = '', inList = false;
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>');
  for (let l of lines) {
    l = l.trim();
    if (/^[-*•]\s+/.test(l) || /^\d+[.)]\s+/.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(l.replace(/^([-*•]|\d+[.)])\s+/, '')) + '</li>'; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (!l) continue;
    if (/^#{1,6}\s/.test(l)) html += '<h3>' + inline(l.replace(/^#+\s*/, '')) + '</h3>';
    else html += '<p>' + inline(l) + '</p>';
  }
  if (inList) html += '</ul>';
  return html;
}

/* ---------- reserve uten AI-nøkkel ---------- */
const STOP = new Set(('og i jeg det at en et den til er som på de med han av ikke der så var meg seg men ble har for om vi kan hun ut også når fra da ved du skal alle vil hadde dem eller etter hvor mot noen over kom hva enn under skulle mange år blir blitt mer sin sitt sine slik hans hennes deres man nå bare ingen andre selv før være vært the of and to a in is was for on that with as by it are be this from at or an which').split(' '));
const words = s => (s.toLowerCase().match(/[a-zæøåäöüé0-9]+/g) || []);
function keySentences(text, n) {
  const sents = splitSentences(text).filter(s => s.length > 25 && s.length < 400);
  const freq = {}; words(text).forEach(w => { if (!STOP.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1; });
  const scored = sents.map((s, i) => { const ws = words(s).filter(w => !STOP.has(w)); return { s, i, sc: ws.reduce((a, w) => a + (freq[w] || 0), 0) / Math.sqrt(ws.length + 1) }; });
  return scored.sort((a, b) => b.sc - a.sc).slice(0, n).sort((a, b) => a.i - b.i).map(x => x.s);
}
function searchSentences(q, text, n = 3) {
  const qw = words(q).filter(w => !STOP.has(w) && w.length > 2);
  const sents = splitSentences(text).filter(s => s.length > 15);
  return sents.map(s => { const sw = words(s); return { s, sc: qw.reduce((a, w) => a + (sw.some(x => x.startsWith(w.slice(0, Math.max(4, w.length - 2)))) ? 1 : 0), 0) }; })
    .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, n).map(x => x.s);
}
function clozeQuiz(text, count) {
  const freq = {}; words(text).forEach(w => { if (!STOP.has(w) && w.length > 4) freq[w] = (freq[w] || 0) + 1; });
  const pool = Object.keys(freq);
  const sents = keySentences(text, count * 3);
  const qs = [];
  for (const s of sents) {
    const cands = words(s).filter(w => freq[w] && w.length > 4).sort((a, b) => b.length - a.length);
    const target = cands[0]; if (!target) continue;
    const re = new RegExp('\\b' + target + '\\b', 'i'); if (!re.test(s)) continue;
    const distract = pool.filter(w => w !== target && Math.abs(w.length - target.length) < 4).sort(() => Math.random() - .5).slice(0, 3);
    if (distract.length < 3) continue;
    const shown = s.match(re)[0];
    const opts = [shown, ...distract].sort(() => Math.random() - .5);
    qs.push({ type: 'mc', question: 'Fyll inn: ' + s.replace(re, '_____'), options: opts, correct: opts.indexOf(shown), answer: shown, explanation: '', quote: s });
    if (qs.length >= count) break;
  }
  return qs;
}

/* ---------- import ---------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
function setStatus(html) { const s = $('#importStatus'); if (!html) { s.hidden = true; return; } s.hidden = false; s.innerHTML = html; }
const fileToB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function shrinkImage(file, max = 2000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
  } finally { URL.revokeObjectURL(url); }
}
let tessP = null;
function loadTesseract() {
  if (!tessP) tessP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = () => res(window.Tesseract); s.onerror = () => rej(new Error('Klarte ikke å laste tekstgjenkjenning (krever nett).')); document.head.appendChild(s); });
  return tessP;
}
async function ocrLocal(imgBlob, label) {
  const T = await loadTesseract();
  const r = await T.recognize(imgBlob, 'nor+eng', { logger: m => { if (m.status === 'recognizing text') setStatus(`<span class="spin"></span>Leser tekst i ${esc(label)} … ${Math.round(m.progress * 100)} %`); } });
  return r.data.text.trim();
}
const TRANSCRIBE = 'Skriv av ALL tekst i dette dokumentet nøyaktig slik den står, i riktig leserekkefølge. Behold overskrifter (med # foran) og avsnitt. Beskriv kort viktige figurer/tabeller i [hakeparentes]. Ikke legg til noe eget, ikke oversett.';
async function readImage(file) {
  const small = await shrinkImage(file);
  if (hasKey()) {
    setStatus(`<span class="spin"></span>Leser teksten i bildet med AI …`);
    try { return await gemini([{ text: TRANSCRIBE }, { inlineData: { mimeType: 'image/jpeg', data: await fileToB64(small) } }], { temp: 0 }); }
    catch (e) { toast('AI-lesing feilet, bruker lokal tekstgjenkjenning: ' + e.message, 4000); }
  }
  return ocrLocal(small, file.name || 'bildet');
}
async function readPdf(file) {
  if (!window.pdfjsLib) throw new Error('PDF-leseren lastet ikke (krever nett første gang).');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    setStatus(`<span class="spin"></span>Leser PDF side ${p} av ${pdf.numPages} …`);
    const page = await pdf.getPage(p); const tc = await page.getTextContent();
    let line = '', lastY = null;
    for (const it of tc.items) { const y = it.transform[5]; if (lastY !== null && Math.abs(y - lastY) > 2) { text += line.trim() + '\n'; line = ''; } line += it.str + (it.hasEOL ? '\n' : ''); lastY = y; }
    text += line.trim() + '\n\n';
  }
  if (text.replace(/\s/g, '').length / pdf.numPages > 80) return text.trim();
  // Skannet PDF – må lese bildene
  if (hasKey() && file.size < 18e6) {
    setStatus(`<span class="spin"></span>PDF-en er skannet – leser den med AI …`);
    try { return await gemini([{ text: TRANSCRIBE }, { inlineData: { mimeType: 'application/pdf', data: await fileToB64(file) } }], { temp: 0 }); }
    catch (e) { toast('AI-lesing feilet, prøver lokal tekstgjenkjenning', 3000); }
  }
  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p); const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    out += await ocrLocal(blob, `side ${p}/${pdf.numPages}`) + '\n\n';
  }
  return out.trim();
}
async function importFiles(files) {
  for (const f of files) {
    try {
      let text;
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) text = await readPdf(f);
      else if (f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) text = await readImage(f);
      else text = await f.text();
      text = (text || '').trim();
      if (!text) { toast(`Fant ingen tekst i ${f.name}`); continue; }
      const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : 'Bilde ' + new Date().toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' });
      cur.sources.push({ id: uid(), name, text });
      if (!cur.name) { cur.name = guessName(text); $('#topicName').value = cur.name; $('#title').textContent = cur.name; }
      touch(); renderSources(); toast('La til ' + name);
    } catch (e) { toast(`Feil med ${f.name}: ${e.message}`, 5000); }
  }
  setStatus('');
}
function guessName(t) { const l = t.split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(s => s.length > 3 && s.length < 60); return l || 'Nytt tema'; }
function touch() { cur.updated = Date.now(); cur.cache = {}; saveTopics(); }

/* ---------- navigasjon ---------- */
function showHome() {
  stopPlayer(); stopListening(); cur = null;
  $('#home').hidden = false; $('#topic').hidden = true; $('#backBtn').hidden = true; $('#title').textContent = 'Leksehjelp';
  renderTopics();
}
function openTopic(t, tab = 'material') {
  cur = t; cur.cache ||= {}; cur.chat ||= [];
  $('#home').hidden = true; $('#topic').hidden = false; $('#backBtn').hidden = false;
  $('#title').textContent = t.name || 'Nytt tema'; $('#topicName').value = t.name || '';
  renderSources(); renderChat(); resetQuiz();
  $('#lectureOut').innerHTML = cur.cache.lecture ? md(cur.cache.lecture) : '';
  $('#summaryOut').innerHTML = cur.cache.summary ? md(cur.cache.summary) : '';
  $('#checkOut').innerHTML = cur.cache.check || '';
  switchTab(tab); scrollTo(0, 0);
}
function switchTab(name) {
  stopPlayer(); stopListening();
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(p => p.hidden = p.dataset.pane !== name);
  if (name !== 'material' && !cur.sources.length) { $$('.tab')[0].hidden = false; $$('.tab').forEach(p => { if (p.dataset.pane !== 'material') p.hidden = true; }); $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'material')); toast('Legg inn stoff først 📄'); }
  if (name === 'quiz') $('#quizHint').textContent = hasKey() ? '' : 'Uten AI-nøkkel lages enkle «fyll inn ordet»-spørsmål.';
}
function renderTopics() {
  const ul = $('#topicList');
  ul.innerHTML = topics.length ? '' : '<li class="empty">Ingen temaer ennå. Trykk «Nytt tema» for å begynne.</li>';
  [...topics].sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach(t => {
    const li = document.createElement('li');
    const wc = words(t.sources.map(s => s.text).join(' ')).length;
    li.innerHTML = `<div class="t"><b>${esc(t.name || 'Uten navn')}</b><small>${t.sources.length} kilde${t.sources.length === 1 ? '' : 'r'} · ${wc} ord</small></div><button class="iconbtn" aria-label="Slett">🗑</button>`;
    li.onclick = e => { if (e.target.closest('button')) { if (confirm(`Slette «${t.name}»?`)) { topics = topics.filter(x => x !== t); saveTopics(); renderTopics(); } return; } openTopic(t, t.sources.length ? 'chat' : 'material'); };
    ul.appendChild(li);
  });
  $('#keyNotice').hidden = hasKey();
}
function renderSources() {
  const ul = $('#sourceList'); ul.innerHTML = cur.sources.length ? '' : '<li class="empty">Ingen kilder ennå. Ta bilde av sidene, last opp PDF eller lim inn tekst.</li>';
  cur.sources.forEach(s => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="h"><b>${esc(s.name)}</b><button class="iconbtn" data-a="edit" aria-label="Rediger">✏</button><button class="iconbtn" data-a="del" aria-label="Slett">🗑</button></div><pre>${esc(s.text.slice(0, 1500))}${s.text.length > 1500 ? ' …' : ''}</pre>`;
    li.querySelector('[data-a=del]').onclick = () => { if (confirm('Fjerne denne kilden?')) { cur.sources = cur.sources.filter(x => x !== s); touch(); renderSources(); } };
    li.querySelector('[data-a=edit]').onclick = () => {
      const pre = li.querySelector('pre'); if (!pre) return;
      const ta = document.createElement('textarea'); ta.rows = 12; ta.value = s.text; pre.replaceWith(ta);
      const sv = document.createElement('button'); sv.className = 'btn primary'; sv.textContent = 'Lagre endring';
      sv.onclick = () => { s.text = ta.value; touch(); renderSources(); toast('Lagret'); };
      li.appendChild(sv); ta.focus();
    };
    ul.appendChild(li);
  });
  const wc = words(cur.sources.map(s => s.text).join(' ')).length;
  $('#wordCount').textContent = cur.sources.length ? `Totalt ${wc} ord. Tips: trykk ✏ for å rette opp feil i teksten fra bilder.` : '';
}

/* ---------- samtale ---------- */
function addMsg(role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text; $('#chatLog').appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' }); return d; }
function renderChat() {
  $('#chatLog').innerHTML = '';
  if (!cur.chat.length) addMsg('sys', hasKey() ? 'Still et spørsmål om temaet – skriv, eller trykk 🎤 og snakk. Si «snakk engelsk» for å bytte språk.' : 'Uten AI-nøkkel finner appen setningene i stoffet som passer best til spørsmålet ditt.');
  cur.chat.forEach(m => addMsg(m.role === 'user' ? 'user' : 'bot', m.text));
}
function detectLangSwitch(t) {
  const s = t.toLowerCase();
  if (/(engelsk|english)/.test(s) && /(snakk|bytt|svar|skriv|på|in|speak|switch|talk|kan vi|can we)/.test(s)) return 'en';
  if (/(norsk|norwegian)/.test(s) && /(snakk|bytt|svar|skriv|på|in|speak|switch|talk|kan vi|can we|tilbake)/.test(s)) return 'no';
  return null;
}
let chatBusy = false;
async function sendChat(text) {
  text = text.trim(); if (!text || chatBusy) return;
  chatBusy = true; $('#chatInput').value = '';
  const sw = detectLangSwitch(text); if (sw && sw !== settings.lang) setLang(sw, true);
  addMsg('user', text); cur.chat.push({ role: 'user', text });
  const pending = addMsg('bot', '…');
  let reply;
  try {
    if (hasKey()) {
      const hist = cur.chat.slice(-20).map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
      reply = await gemini(null, {
        history: hist, temp: 0.5,
        system: groundRules() + `\nDette er en samtale (ofte muntlig). Svar kort og naturlig (2–5 setninger), som en god lærer. Still gjerne et lite oppfølgingsspørsmål for å sjekke forståelsen. Ikke bruk markdown, lister eller emojier – teksten leses høyt.\nHvis eleven ber deg bytte til engelsk, start svaret med [[EN]] og svar på engelsk. Ber eleven om norsk, start med [[NO]] og svar på norsk.`,
      });
      const m = reply.match(/^\s*\[\[(EN|NO)\]\]\s*/i);
      if (m) { reply = reply.slice(m[0].length); const l = m[1].toLowerCase() === 'en' ? 'en' : 'no'; if (l !== settings.lang) setLang(l, true); }
    } else {
      const hits = searchSentences(text, docText(), 3);
      reply = hits.length ? 'Fra stoffet ditt:\n' + hits.join('\n') : 'Jeg fant ikke noe om det i stoffet ditt.';
    }
  } catch (e) { reply = '⚠ ' + e.message; }
  pending.textContent = reply; cur.chat.push({ role: 'model', text: reply }); saveTopics();
  chatBusy = false;
  if ($('#speakReplies').checked && !reply.startsWith('⚠')) {
    const done = await speak(reply);
    if (done && $('#conversationMode').checked && !$('[data-pane=chat]').hidden) micChat();
  }
}
async function micChat() {
  const btn = $('#micBtn');
  if (btn.classList.contains('listening')) { stopListening(); return; }
  btn.classList.add('listening');
  listen.onInterim = t => $('#chatInput').value = t;
  try { const t = await listen(); btn.classList.remove('listening'); if (t) sendChat(t); }
  catch (e) { btn.classList.remove('listening'); toast(e.message, 5000); }
  finally { listen.onInterim = null; }
}

/* ---------- quiz ---------- */
let quiz = null;
function resetQuiz() { quiz = null; $('#quizSetup').hidden = false; $('#quizRun').hidden = true; $('#quizRun').innerHTML = ''; }
async function startQuiz(focus = null) {
  const mode = segVal('quizMode'), type = segVal('quizType'), count = +segVal('quizCount'), level = segVal('quizLevel');
  $('#quizSetup').hidden = true; const run = $('#quizRun'); run.hidden = false;
  run.innerHTML = '<p><span class="spin"></span>Lager quiz …</p>';
  let qs;
  try {
    if (hasKey()) {
      const typeTxt = type === 'mc' ? 'Bare flervalg (4 alternativer).' : type === 'open' ? 'Bare åpne spørsmål (kort svar).' : 'Bland flervalg (4 alternativer) og åpne spørsmål omtrent likt.';
      const res = await gemini(`Lag en quiz med ${count} spørsmål om studiestoffet. Nivå: ${level}. ${typeTxt}
${mode === 'oral' ? 'Quizen tas MUNTLIG: spørsmålene skal være lette å forstå når de leses høyt, korte alternativer.' : ''}
${focus ? 'Eleven bommet på disse – lag NYE spørsmål som øver på akkurat de samme faktaene fra en annen vinkel:\n' + focus.map(q => '- ' + q.question + ' (riktig: ' + q.answer + ')').join('\n') : 'Dekk de viktigste faktaene i hele stoffet, ikke bare starten.'}
Alle svar SKAL kunne finnes i stoffet. Feil alternativer skal være troverdige men tydelig feil ifølge stoffet.
Svar som JSON: {"questions":[{"type":"mc"|"open","question":"…","options":["…","…","…","…"],"correct":0,"answer":"riktig svar formulert kort","explanation":"kort forklaring","quote":"kort sitat fra stoffet som viser svaret"}]}  (options og correct bare for mc).`, { system: groundRules(), json: true, temp: 0.7 });
      qs = (res.questions || res).filter(q => q.question);
      qs.forEach(q => { if (q.type === 'mc' && (!Array.isArray(q.options) || q.options.length < 2)) q.type = 'open'; if (q.type === 'mc') { q.correct = Math.max(0, Math.min(q.options.length - 1, +q.correct || 0)); q.answer ||= q.options[q.correct]; } });
    } else qs = clozeQuiz(docText(), count);
    if (!qs.length) throw new Error('Fikk ikke laget spørsmål – er det nok tekst i stoffet?');
  } catch (e) { run.innerHTML = `<p class="fb bad">⚠ ${esc(e.message)}</p><button class="btn wide" onclick="resetQuiz()">Tilbake</button>`; return; }
  quiz = { qs, i: 0, mode, results: [] };
  showQuestion();
}
const LETTERS = 'ABCDEFG';
function showQuestion() {
  const q = quiz.qs[quiz.i], run = $('#quizRun');
  run.innerHTML = `<div class="progress"><i style="width:${(quiz.i / quiz.qs.length) * 100}%"></i></div>
  <div class="qcard"><div class="num">Spørsmål ${quiz.i + 1} av ${quiz.qs.length}</div><div class="q">${esc(q.question)}</div>
  ${q.type === 'mc' ? `<div class="opts">${q.options.map((o, k) => `<button data-k="${k}">${LETTERS[k]}: ${esc(o)}</button>`).join('')}</div>`
      : `<textarea id="openAns" rows="3" placeholder="Skriv svaret ditt"></textarea>`}
  ${quiz.mode === 'oral' || q.type === 'open' ? `<div class="row" style="margin-top:10px">${quiz.mode === 'oral' ? '<button class="btn" id="qMic">🎤 Svar muntlig</button><button class="btn ghost" id="qRepeat">🔁 Les opp igjen</button>' : ''}${q.type === 'open' ? '<button class="btn primary" id="qSubmit">Svar</button>' : ''}</div>` : ''}
  <div id="qFb"></div></div>
  <div class="row" style="margin-top:12px"><button class="btn ghost" id="qQuit">Avslutt</button><span style="flex:1"></span><button class="btn" id="qSkip">Hopp over</button></div>`;
  $$('.opts button', run).forEach(b => b.onclick = () => answerMC(+b.dataset.k));
  $('#qSubmit') && ($('#qSubmit').onclick = () => answerOpen($('#openAns').value));
  $('#qQuit').onclick = finishQuiz;
  $('#qSkip').onclick = () => { stopSpeaking(); stopListening(); record(false, '(hoppet over)'); nextQ(); };
  if (quiz.mode === 'oral') {
    const readQ = () => speak(q.question + (q.type === 'mc' ? '. ' + q.options.map((o, k) => `${LETTERS[k]}: ${o}.`).join(' ') : ''));
    $('#qRepeat').onclick = readQ;
    $('#qMic').onclick = () => oralAnswer();
    readQ().then(done => { if (done && quiz && quiz.qs[quiz.i] === q && !q.done) oralAnswer(); });
  }
}
async function oralAnswer() {
  const q = quiz.qs[quiz.i], btn = $('#qMic'); if (!btn || q.done) return;
  btn.textContent = '🔴 Lytter …'; btn.classList.add('listening');
  if ($('#openAns')) listen.onInterim = t => $('#openAns').value = t;
  try {
    const t = await listen(); btn.textContent = '🎤 Svar muntlig'; btn.classList.remove('listening');
    if (!t || q.done) return;
    if (q.type === 'mc') {
      const s = t.toLowerCase().trim();
      let k = q.options.findIndex(o => s.includes(o.toLowerCase().trim()));
      if (k < 0) { const m = s.match(/(?:^|\b(?:svar|alternativ|answer|option)\s*)([a-d])\b/i) || s.match(/^\s*([a-d])\b/i); if (m) k = LETTERS.indexOf(m[1].toUpperCase()); }
      if (k < 0 && hasKey()) {
        try { const r = await gemini(`Eleven svarte muntlig: "${t}". Alternativene: ${q.options.map((o, i) => i + ': ' + o).join(' | ')}. Hvilket alternativ mente eleven? Svar JSON {"index": tall eller -1}`, { json: true, temp: 0 }); k = +r.index; } catch { }
      }
      if (k >= 0 && k < q.options.length) answerMC(k); else { toast('Fikk ikke med meg svaret – prøv igjen'); speak(settings.lang === 'en' ? 'Sorry, I did not catch that. Try again.' : 'Det fikk jeg ikke med meg. Prøv igjen.'); }
    } else answerOpen(t);
  } catch (e) { btn.textContent = '🎤 Svar muntlig'; btn.classList.remove('listening'); toast(e.message, 5000); }
  finally { listen.onInterim = null; }
}
function record(ok, given, partial = false) { const q = quiz.qs[quiz.i]; q.done = true; quiz.results.push({ q, ok, partial, given }); }
function answerMC(k) {
  const q = quiz.qs[quiz.i]; if (q.done) return;
  const ok = k === q.correct; record(ok, q.options[k]);
  $$('.opts button').forEach((b, i) => { b.disabled = true; if (i === q.correct) b.classList.add('right'); else if (i === k) b.classList.add('wrong'); });
  feedback(ok ? 'ok' : 'bad', ok ? 'Riktig! 🎉' : `Feil. Riktig svar er ${LETTERS[q.correct]}: ${q.options[q.correct]}.`, q);
}
async function answerOpen(given) {
  const q = quiz.qs[quiz.i]; given = (given || '').trim(); if (q.done || !given) return;
  $('#qSubmit') && ($('#qSubmit').disabled = true);
  $('#qFb').innerHTML = '<p><span class="spin"></span>Vurderer svaret …</p>';
  let verdict = 'bad', comment = '';
  try {
    if (hasKey()) {
      const r = await gemini(`Spørsmål: ${q.question}\nRiktig svar ifølge stoffet: ${q.answer}\nElevens svar: ${given}\nVurder om eleven har forstått det riktige. Vær raus med stavefeil, synonymer og andre ord for det samme (og ord som er feilhørt av talegjenkjenning). JSON: {"verdict":"riktig"|"delvis"|"feil","comment":"én kort, oppmuntrende setning til eleven"}`, { system: groundRules(), json: true, temp: 0 });
      verdict = r.verdict === 'riktig' ? 'ok' : r.verdict === 'delvis' ? 'part' : 'bad'; comment = r.comment || '';
    } else {
      const aw = words(q.answer).filter(w => !STOP.has(w)), gw = words(given);
      const hit = aw.filter(w => gw.some(g => g.startsWith(w.slice(0, 5)))).length / Math.max(1, aw.length);
      verdict = hit > .7 ? 'ok' : hit > .3 ? 'part' : 'bad';
    }
  } catch (e) { $('#qFb').innerHTML = `<p class="fb bad">⚠ ${esc(e.message)}</p>`; $('#qSubmit') && ($('#qSubmit').disabled = false); return; }
  record(verdict === 'ok', given, verdict === 'part');
  const head = verdict === 'ok' ? 'Riktig! 🎉' : verdict === 'part' ? 'Delvis riktig.' : 'Ikke helt.';
  feedback(verdict, `${head} ${comment}${verdict !== 'ok' ? ' Riktig svar: ' + q.answer : ''}`, q);
}
function feedback(cls, text, q) {
  $('#qFb').innerHTML = `<div class="fb ${cls}">${esc(text)}${q.explanation ? '<br>' + esc(q.explanation) : ''}${q.quote ? `<span class="quote">«${esc(q.quote)}»</span>` : ''}</div>
    <button class="btn primary wide" id="qNext">${quiz.i + 1 < quiz.qs.length ? 'Neste spørsmål →' : 'Se resultat'}</button>`;
  $('#qNext').onclick = () => { stopSpeaking(); nextQ(); };
  if (quiz.mode === 'oral') { const my = quiz.i; speak(text).then(done => { if (done && quiz && quiz.i === my) nextQ(); }); }
}
function nextQ() { stopListening(); quiz.i++; if (quiz.i >= quiz.qs.length) finishQuiz(); else showQuestion(); }
function finishQuiz() {
  stopSpeaking(); stopListening(); if (!quiz) return resetQuiz();
  const n = quiz.results.length, pts = quiz.results.reduce((a, r) => a + (r.ok ? 1 : r.partial ? .5 : 0), 0);
  const missed = quiz.results.filter(r => !r.ok);
  const pct = n ? Math.round(pts / n * 100) : 0;
  $('#quizRun').innerHTML = `<div class="qcard"><div class="score">${pts} / ${n}</div><p style="text-align:center">${pct >= 90 ? 'Strålende! 🌟' : pct >= 70 ? 'Godt jobbet! 👍' : pct >= 40 ? 'Bra start – øv litt til 💪' : 'Dette temaet trenger mer øving 📚'}</p>
    ${missed.length ? '<h3>Dette bør du øve mer på</h3>' + missed.map(r => `<div class="fb bad"><b>${esc(r.q.question)}</b><br>Ditt svar: ${esc(r.given)}<br>Riktig: ${esc(r.q.answer)}</div>`).join('') : ''}
    ${missed.length ? '<button class="btn primary wide" id="qRetry">Øv på det jeg bommet på</button>' : ''}
    <button class="btn wide" id="qNew">Ny quiz</button></div>`;
  if (quiz.mode === 'oral') speak(settings.lang === 'en' ? `You got ${pts} out of ${n}.` : `Du fikk ${String(pts).replace('.', ',')} av ${n} poeng.`);
  const focus = missed.map(r => r.q);
  $('#qRetry') && ($('#qRetry').onclick = () => startQuiz(focus));
  $('#qNew').onclick = resetQuiz;
}

/* ---------- foredrag og sammendrag ---------- */
async function makeLecture() {
  const out = $('#lectureOut'), len = segVal('lectureLen');
  const wordsN = { kort: 300, middels: 700, lang: 1400 }[len];
  stopPlayer(); out.innerHTML = '<p><span class="spin"></span>Skriver foredraget …</p>';
  try {
    let t;
    if (hasKey()) t = await gemini(`Hold et engasjerende foredrag for en elev om studiestoffet, ca. ${wordsN} ord. Det skal leses høyt.
Struktur: en kort innledning som sier hva foredraget handler om, deretter 3–6 deler med overskrift (# Overskrift) og korte avsnitt, og til slutt en oppsummering av de viktigste punktene å huske.
Forklar sammenhenger og gjenta nøkkelbegreper så de fester seg. Bruk bare fakta fra stoffet. Ingen lister, bare avsnitt.`, { system: groundRules(), temp: 0.6 });
    else t = '# Viktige punkter fra stoffet\n' + keySentences(docText(), Math.round(wordsN / 22)).join('\n\n');
    cur.cache.lecture = t; saveTopics();
    out.innerHTML = '<div class="row"><button class="btn" id="lPlay">▶ Les opp</button></div>' + md(t);
    $('#lPlay').onclick = () => startReading(out);
    startReading(out);
  } catch (e) { out.innerHTML = `<p class="fb bad">⚠ ${esc(e.message)}</p>`; }
}
async function makeSummary() {
  const out = $('#summaryOut'), len = segVal('summaryLen');
  stopPlayer(); out.innerHTML = '<p><span class="spin"></span>Lager sammendrag …</p>';
  try {
    let t;
    if (hasKey()) {
      const how = { stikkord: 'Lag et sammendrag som stikkord: korte punkter (- ) gruppert under overskrifter (# ). Ta med alle viktige navn, årstall, begreper og tall.', kort: 'Lag et kort sammendrag på 1–3 avsnitt (maks ca. 200 ord) med det aller viktigste.', grundig: 'Lag et grundig sammendrag med overskrifter (# ) for hver del av stoffet, og avslutt med «# Viktige begreper» som en punktliste med forklaringer.' }[len];
      t = await gemini(how + ' Bruk bare fakta fra stoffet, i samme rekkefølge som i stoffet.', { system: groundRules(), temp: 0.3 });
    } else {
      const n = { stikkord: 8, kort: 5, grundig: 14 }[len];
      t = keySentences(docText(), n).map(s => (len === 'stikkord' ? '- ' : '') + s).join('\n\n');
    }
    cur.cache.summary = t; saveTopics();
    out.innerHTML = '<div class="row"><button class="btn" id="sPlay">🔊 Les opp</button><button class="btn ghost" id="sCopy">📋 Kopier</button></div>' + md(t);
    $('#sPlay').onclick = () => startReading(out);
    $('#sCopy').onclick = () => navigator.clipboard?.writeText(t).then(() => toast('Kopiert'));
  } catch (e) { out.innerHTML = `<p class="fb bad">⚠ ${esc(e.message)}</p>`; }
}

/* ---------- faktasjekk mot Wikipedia ---------- */
async function wikiFetch(lang, term) {
  const base = `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*`;
  const s = await (await fetch(`${base}&action=query&list=search&srlimit=1&srsearch=${encodeURIComponent(term)}`)).json();
  const title = s.query?.search?.[0]?.title; if (!title) return null;
  const e = await (await fetch(`${base}&action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`)).json();
  const page = Object.values(e.query?.pages || {})[0]; if (!page?.extract) return null;
  return { title: page.title, lang, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, text: page.extract.slice(0, 15000) };
}
async function runCheck() {
  const out = $('#checkOut');
  if (!hasKey()) { out.innerHTML = '<p class="notice">Faktasjekken trenger en gratis Gemini-nøkkel. <button class="linkbtn" data-open-settings>Legg inn nøkkel</button></p>'; return; }
  out.innerHTML = '<p><span class="spin"></span>Finner påstander i stoffet …</p>';
  try {
    const c = await gemini('Plukk ut inntil 15 konkrete, sjekkbare faktapåstander fra studiestoffet (årstall, navn, tall, hendelser, definisjoner). For hver: lag et kort Wikipedia-søkeord (helst artikkelnavnet). JSON: {"claims":[{"claim":"påstanden med egne ord","quote":"kort sitat fra stoffet","search":"søkeord"}]}', { system: groundRules(), json: true, temp: 0 });
    const claims = (c.claims || []).slice(0, 15);
    const terms = [...new Set(claims.map(x => x.search).filter(Boolean))].slice(0, 6);
    const pages = [];
    for (const t of terms) {
      out.innerHTML = `<p><span class="spin"></span>Slår opp «${esc(t)}» på Wikipedia …</p>`;
      try { const p = (await wikiFetch('no', t)) || (await wikiFetch('en', t)); if (p && !pages.some(x => x.url === p.url)) pages.push(p); } catch { }
    }
    if (!pages.length) { out.innerHTML = '<p class="fb part">Fant ingen relevante Wikipedia-artikler å sammenligne med.</p>'; return; }
    out.innerHTML = '<p><span class="spin"></span>Sammenligner …</p>';
    const r = await gemini(`Sammenlign påstandene fra elevens studiestoff med Wikipedia-utdragene.
PÅSTANDER:\n${claims.map((x, i) => `${i + 1}. ${x.claim} (sitat: «${x.quote}»)`).join('\n')}
WIKIPEDIA:\n${pages.map((p, i) => `[W${i + 1}] ${p.title} (${p.url})\n${p.text}`).join('\n\n')}
For hver påstand: "stemmer" hvis Wikipedia sier det samme, "avvik" hvis Wikipedia sier noe annet (f.eks. annet årstall/tall/navn), "ukjent" hvis Wikipedia ikke nevner det. Vær nøye – bare marker avvik når det er en tydelig motsigelse, ikke bare ulik formulering. ${langRule()}
JSON: {"results":[{"claim":"…","quote":"…","verdict":"stemmer"|"avvik"|"ukjent","explanation":"kort forklaring på hva Wikipedia sier","source":"W1"}]}`, { json: true, temp: 0 });
    const res = r.results || [];
    const bad = res.filter(x => x.verdict === 'avvik'), ok = res.filter(x => x.verdict === 'stemmer'), unk = res.filter(x => x.verdict === 'ukjent');
    const src = x => { const p = pages[(parseInt(String(x.source).replace(/\D/g, '')) || 1) - 1]; return p ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)} (${p.lang})</a>` : ''; };
    let html = `<h3>${bad.length ? `⚠ ${bad.length} mulig${bad.length === 1 ? '' : 'e'} feil funnet` : '✅ Fant ingen feil'}</h3>`;
    html += bad.map(x => `<div class="issue"><b>Stoffet sier:</b> «${esc(x.quote || x.claim)}»<br><b>Wikipedia:</b> ${esc(x.explanation)}${src(x)}</div>`).join('');
    if (ok.length) html += `<h3>Stemmer med Wikipedia (${ok.length})</h3>` + ok.map(x => `<div class="issue ok">${esc(x.claim)}${src(x)}</div>`).join('');
    if (unk.length) html += `<p class="muted small">${unk.length} påstand${unk.length === 1 ? '' : 'er'} ble ikke funnet i artiklene som ble sjekket.</p>`;
    html += '<p class="muted small">Wikipedia kan også ta feil. Spør læreren hvis du er usikker. Appen fortsetter å bruke stoffet ditt slik det står.</p>';
    cur.cache.check = html; saveTopics(); out.innerHTML = html;
  } catch (e) { out.innerHTML = `<p class="fb bad">⚠ ${esc(e.message)}</p>`; }
}

/* ---------- innstillinger ---------- */
function fillVoiceSelect() {
  const sel = $('#voiceSel'); if (!sel) return;
  const nb = voices.filter(v => /^(nb|no|nn)/i.test(v.lang));
  sel.innerHTML = '<option value="">Automatisk</option>' + nb.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  sel.value = settings.voice || '';
  if (!nb.length) sel.innerHTML = '<option value="">Ingen norsk stemme funnet – installer «norsk» under talesyntese i telefonens innstillinger</option>';
}
function openSettings() {
  $('#apiKey').value = settings.apiKey; $('#modelName').value = settings.model; fillVoiceSelect(); $('#testOut').textContent = '';
  $('#builtinAi').textContent = PROXY ? '✅ Appen har innebygd AI – du trenger ikke egen nøkkel. Legg inn en egen bare hvis den innebygde kvoten er brukt opp.' : '';
  $('#settings').showModal();
}
$('#saveSettings').onclick = () => { settings.apiKey = $('#apiKey').value.trim(); settings.model = $('#modelName').value.trim(); settings.voice = $('#voiceSel').value; saveSettings(); renderTopics(); toast('Lagret'); };
$('#testKey').onclick = async () => {
  const old = { ...settings }; settings.apiKey = $('#apiKey').value.trim(); settings.model = $('#modelName').value.trim();
  $('#testOut').textContent = 'Tester …';
  try { const r = await gemini('Svar bare med ordet: OK'); $('#testOut').textContent = '✅ Nøkkelen virker! (' + r.slice(0, 20) + ')'; }
  catch (e) { $('#testOut').textContent = '❌ ' + (e.message === 'NOKEY' ? 'Skriv inn en nøkkel først.' : e.message); Object.assign(settings, old); }
};

/* ---------- installering ---------- */
let deferredPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (!isStandalone()) $('#installBtn').hidden = false; });
addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Leksehjelp er installert 🎉'); });
$('#installBtn').onclick = async () => {
  if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#installBtn').hidden = true; }
  else if (isIOS) $('#iosInstall').showModal();
  else toast('Åpne menyen ⋮ i nettleseren og velg «Installer app» / «Legg til på startskjermen».', 5000);
};

/* ---------- koble opp knapper ---------- */
$('#backBtn').onclick = showHome;
$('#settingsBtn').onclick = openSettings;
document.addEventListener('click', e => { if (e.target.closest('[data-open-settings]')) openSettings(); });
$('#langBtn').onclick = () => setLang(settings.lang === 'no' ? 'en' : 'no', true);
$('#newTopicBtn').onclick = () => { const t = { id: uid(), name: '', sources: [], created: Date.now(), updated: Date.now(), chat: [], cache: {} }; topics.push(t); saveTopics(); openTopic(t, 'material'); $('#topicName').focus(); };
$('#topicName').oninput = e => { cur.name = e.target.value.trim(); $('#title').textContent = cur.name || 'Nytt tema'; cur.updated = Date.now(); saveTopics(); };
$$('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$$('.seg').forEach(s => s.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $$('button', s).forEach(x => x.classList.toggle('on', x === b)); }));
$('#addCamera').onclick = () => $('#cameraInput').click();
$('#addFile').onclick = () => $('#fileInput').click();
$('#cameraInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
$('#fileInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
$('#addPaste').onclick = () => { $('#pasteBox').hidden = false; $('#pasteText').focus(); };
$('#pasteCancel').onclick = () => { $('#pasteBox').hidden = true; $('#pasteText').value = ''; };
$('#pasteSave').onclick = () => {
  const t = $('#pasteText').value.trim(); if (!t) return;
  cur.sources.push({ id: uid(), name: 'Tekst ' + (cur.sources.length + 1), text: t });
  if (!cur.name) { cur.name = guessName(t); $('#topicName').value = cur.name; $('#title').textContent = cur.name; }
  touch(); renderSources(); $('#pasteBox').hidden = true; $('#pasteText').value = ''; toast('Tekst lagt til');
};
$('#sendBtn').onclick = () => sendChat($('#chatInput').value);
$('#chatInput').onkeydown = e => { if (e.key === 'Enter') sendChat($('#chatInput').value); };
$('#micBtn').onclick = micChat;
$('#startQuiz').onclick = () => startQuiz();
$('#makeLecture').onclick = makeLecture;
$('#makeSummary').onclick = makeSummary;
$('#runCheck').onclick = runCheck;

/* ---------- oppstart ---------- */
(async () => {
  $('#versionLabel').textContent = 'Versjon ' + VERSION;
  await loadAll();
  setLang(settings.lang || 'no');
  if (isIOS && !isStandalone()) $('#installBtn').hidden = false;
  showHome();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
