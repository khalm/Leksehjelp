/* Leksehjelp – studer og pugg et tema basert på ditt eget stoff */
'use strict';
const VERSION = '1.6.0';
const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_DOC_CHARS = 400000;

/* ---------- små hjelpere ---------- */
const ic = (n, cls = '') => `<span class="ms ${cls}" aria-hidden="true">${n}</span>`;
const MIC = ic('mic');
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

const settings = { apiKey: '', model: '', voice: '', lang: 'no', level: 4, levelScale: 6, textSize: 1, font: '', autoRead: false };
let topics = [];
let cur = null; // gjeldende tema
const PROXY = (window.LEKSEHJELP_PROXY || '').replace(/\/$/, '');
const hasKey = () => !!settings.apiKey || !!PROXY;

async function loadAll() {
  Object.assign(settings, (await store.get('settings')) || {});
  if (settings.levelScale !== 6) { settings.level = Math.min(6, (+settings.level || 3) + 1); settings.levelScale = 6; }
  topics = (await store.get('topics')) || [];
}
const saveSettings = () => store.set('settings', { ...settings });
const saveTopics = () => store.set('topics', topics);

/* ---------- språk ---------- */
const LANG = {
  no: { label: 'NO', sr: 'nb-NO', voice: ['nb', 'no', 'nn'], name: 'norsk bokmål' },
  en: { label: 'EN', sr: 'en-US', voice: ['en'], name: 'engelsk (English)' },
};
function setLang(l, announce) {
  settings.lang = l; saveSettings();
  $('#langLabel').textContent = LANG[l].label;
  if (announce) toast(l === 'en' ? 'Switched to English' : 'Byttet til norsk');
}

/* ---------- Gemini ---------- */
/* Finn de nyeste Flash-modellene automatisk (navnene endres ofte hos Google) */
let modelCache = null;
function rankModels(list) {
  const bad = /(image|tts|audio|live|embed|vision|thinking-exp|computer|robotics|veo|imagen|aqa|gemma|nano|banana)/i;
  const usable = list.filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, '')).filter(n => /^gemini/.test(n) && /flash/.test(n) && !bad.test(n));
  const ver = n => { const v = n.match(/gemini-(\d+(?:\.\d+)?)/); return v ? parseFloat(v[1]) : 0; };
  const score = n => ver(n) * 100 - (/lite/.test(n) ? 30 : 0) - (/(preview|exp)/.test(n) ? 5 : 0) - (/-\d{3,}$/.test(n) ? 1 : 0) + (/latest/.test(n) ? 50 : 0);
  return usable.sort((a, b) => score(b) - score(a));
}
let rawModels = null;
async function fetchModelList() {
  if (rawModels) return rawModels;
  const r = settings.apiKey
    ? await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': settings.apiKey } })
    : await fetch(PROXY + '/models');
  if (!r.ok) throw new Error('Fikk ikke modell-listen (' + r.status + ')');
  return (rawModels = (await r.json()).models || []);
}
async function pickModels() {
  if (modelCache) return modelCache;
  const c = settings.autoModels;
  if (c && Date.now() - c.t < 864e5 && c.list?.length) return (modelCache = c.list);
  try {
    const list = rankModels(await fetchModelList()).slice(0, 4);
    if (list.length) { modelCache = list; settings.autoModels = { t: Date.now(), list }; saveSettings(); return list; }
  } catch { }
  return [DEFAULT_MODEL, 'gemini-3-flash', 'gemini-3-flash-preview'];
}
/* Live-modeller (sanntids tale), nyeste først. Unngår «thinking»-varianten fordi den svarer tregere. */
async function pickLiveModels() {
  const fallback = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview'];
  try {
    const ver = n => { const v = n.match(/gemini-(\d+(?:\.\d+)?)/); return v ? parseFloat(v[1]) : 0; };
    const names = (await fetchModelList()).filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
      .map(m => m.name.replace(/^models\//, '')).filter(n => /^gemini/.test(n) && !/(thinking|image|embed)/i.test(n));
    const score = n => ver(n) * 100 + (/live/.test(n) ? 20 : 0) + (/native-audio/.test(n) ? 15 : 0) - (/(preview|exp)/.test(n) ? 5 : 0) - (/-\d{2}-\d{4}$|-\d{3,}$/.test(n) ? 1 : 0);
    const list = names.sort((a, b) => score(b) - score(a));
    return list.length ? [...list.slice(0, 3), ...fallback.filter(f => !list.includes(f))] : fallback;
  } catch { return fallback; }
}

async function gemini(parts, { system = '', json = false, temp = 0.4, history = null } = {}) {
  if (!hasKey()) throw new Error('NOKEY');
  const contents = history ? history : [{ role: 'user', parts: Array.isArray(parts) ? parts : [{ text: parts }] }];
  const body = { contents, generationConfig: { temperature: temp } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const models = settings.model ? [settings.model] : await pickModels();
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
      if (r.status === 404) { lastErr = new Error('Modellen finnes ikke: ' + m); modelCache = null; settings.autoModels = null; saveSettings(); break; }
      if (r.status === 400 && /API key/i.test(msg)) throw new Error(settings.apiKey ? 'API-nøkkelen er ugyldig. Sjekk den under Innstillinger.' : 'Den innebygde AI-nøkkelen virker ikke. Sjekk LEKSEHJELP_GEMINI_API_KEY.');
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
const LEVELS = [
  null,
  { name: 'Rolig og enkelt', rule: 'FORKLARINGSSTIL 1/6 – ROLIG OG ENKELT: Bruk svært korte setninger med bare én ting i hver setning. Bruk bare vanlige hverdagsord. Ingen fremmedord – må et ord fra stoffet brukes, forklar det med en gang med enkle ord. Ta én ting om gangen og bare det viktigste. Gjenta det viktigste. Bruk konkrete eksempler fra hverdagen. Vær varm og tålmodig, og ros innsats.', slow: 0.82 },
  { name: 'Enkelt', rule: 'FORKLARINGSSTIL 2/6 – ENKELT: Korte, enkle setninger og vanlige ord. Forklar alle fagord med enkle ord. Bruk eksempler. Det viktigste først, og ikke for mye om gangen. Vær oppmuntrende.', slow: 0.9 },
  { name: 'Tydelig', rule: 'FORKLARINGSSTIL 3/6 – TYDELIG: Klare, ganske korte setninger. Fagord kan brukes, men forklar dem kort første gang.', slow: 1 },
  { name: 'Standard', rule: 'FORKLARINGSSTIL 4/6 – STANDARD: Vanlig, klart og saklig språk. Bruk fagbegrepene fra stoffet og forklar dem når det trengs. Vis sammenhenger.', slow: 1 },
  { name: 'Detaljert', rule: 'FORKLARINGSSTIL 5/6 – DETALJERT: Presist og faglig språk med riktige fagbegreper uten å forenkle. Ta med detaljer, nyanser og sammenhenger fra stoffet. Forklar bare de mest krevende begrepene.', slow: 1 },
  { name: 'Fagspråk', rule: 'FORKLARINGSSTIL 6/6 – FAGSPRÅK: Akademisk, presist og nyansert språk. Bruk fagterminologi fritt og et rikt ordforråd. Vær nøyaktig med definisjoner, presiseringer, forbehold, årsakssammenhenger og analyse av det som står i stoffet.', slow: 1 },
];
const MAXLVL = 6;
const level = () => Math.min(MAXLVL, Math.max(1, +settings.level || 4));
function levelRule() { return LEVELS[level()].rule + ' Uansett stil: forenkling eller presisering skal ALDRI endre eller legge til fakta – bare måten ting forklares på. Ikke nevn eller kommenter forklaringsstilen, og si aldri noe om elevens alder, klassetrinn, nivå eller evner. Snakk alltid med respekt, som til en likeverdig.'; }
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
- ${levelRule()}
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
      u.rate = (rate || +$('#pRate').value || 1) * LEVELS[level()].slow;
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
  $('#player').hidden = false; $('#pPlay').innerHTML = ic('pause');
  while (player.idx < player.items.length && my === player.token) {
    const el = player.items[player.idx];
    $$('.speaking').forEach(x => x.classList.remove('speaking'));
    el.classList.add('speaking'); if (!touching && Date.now() - lastUserInput > 5000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const done = await speak(el.textContent);
    if (my !== player.token) return;
    if (!done && !player.playing) return;
    player.idx++;
  }
  if (my === player.token) { player.playing = false; $('#pPlay').innerHTML = ic('play_arrow'); $$('.speaking').forEach(x => x.classList.remove('speaking')); }
}
function startReading(container) { player.items = $$('h3,p,li', container); if (player.items.length) playFrom(0); }
function stopPlayer() { player.token++; player.playing = false; stopSpeaking(); $('#player').hidden = true; $$('.speaking').forEach(x => x.classList.remove('speaking')); }
$('#pPlay').onclick = () => { if (player.playing) { player.token++; player.playing = false; stopSpeaking(); $('#pPlay').innerHTML = ic('play_arrow'); } else playFrom(player.idx); };
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
      addSource(name, text); toast('La til ' + name);
    } catch (e) { toast(`Feil med ${f.name}: ${e.message}`, 5000); }
  }
  setStatus('');
}
function guessName(t) { const l = t.split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(s => s.length > 3 && s.length < 60); return l || 'Nytt tema'; }
function touch() { cur.updated = Date.now(); cur.cache = {}; saveTopics(); }

function addSource(name, text, url) {
  cur.sources.push({ id: uid(), name, text, ...(url ? { url } : {}) });
  if (!cur.name) { cur.name = guessName(name.replace(/^Wikipedia: /, '') + '\n' + text); $('#topicName').value = cur.name; $('#title').textContent = cur.name; }
  touch(); renderSources();
}

/* ---------- import fra lenke ---------- */
let readabilityP = null;
function loadReadability() {
  if (!readabilityP) readabilityP = new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js'; s.onload = () => res(window.Readability || null); s.onerror = () => res(null); document.head.appendChild(s); });
  return readabilityP;
}
async function fetchViaProxy(url) {
  const tryDirect = async () => { const r = await fetch(url); if (!r.ok) throw new Error('Siden svarte med feil ' + r.status); return r; };
  if (!PROXY) return tryDirect();
  const r = await fetch(PROXY + '/fetch?url=' + encodeURIComponent(url));
  if (!r.ok) { let m = ''; try { m = (await r.json()).error?.message; } catch { } throw new Error(m || ('Klarte ikke å hente siden (' + r.status + ')')); }
  return r;
}
function htmlToText(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  try { const b = doc.createElement('base'); b.href = baseUrl; doc.head.appendChild(b); } catch { }
  return doc;
}
function domToText(root) {
  root.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[role=navigation],[aria-hidden=true]').forEach(n => n.remove());
  const out = [];
  root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,td,th,figcaption,pre').forEach(n => {
    if (n.closest('li') && n.tagName !== 'LI') return;
    const t = n.textContent.replace(/\s+/g, ' ').trim(); if (!t) return;
    out.push(/^H\d$/.test(n.tagName) ? '# ' + t : n.tagName === 'LI' ? '- ' + t : t);
  });
  const txt = out.join('\n'); return txt.length > 200 ? txt : root.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
function normalizeUrl(u) {
  u = u.trim(); if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u); } catch { return null; }
}
async function importUrl(raw) {
  const u = normalizeUrl(raw); if (!u) { toast('Det ser ikke ut som en gyldig lenke'); return; }
  // Wikipedia-lenker hentes rent via Wikipedia sitt eget grensesnitt
  const wm = u.hostname.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/) ;
  if (wm && /^\/wiki\//.test(u.pathname)) {
    setStatus(`<span class="spin"></span>Henter artikkelen fra Wikipedia …`);
    try { const title = decodeURIComponent(u.pathname.slice(6)).replace(/_/g, ' '); await addWikiArticle(wm[1], title); }
    catch (e) { toast(e.message, 5000); } finally { setStatus(''); }
    return true;
  }
  let fetchUrl = u.href;
  const gdoc = u.href.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  const gslide = u.href.match(/docs\.google\.com\/presentation\/d\/([\w-]+)/);
  const gfile = u.href.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
  if (gdoc) fetchUrl = `https://docs.google.com/document/d/${gdoc[1]}/export?format=txt`;
  else if (gslide) fetchUrl = `https://docs.google.com/presentation/d/${gslide[1]}/export/txt`;
  else if (gfile) fetchUrl = `https://drive.google.com/uc?export=download&id=${gfile[1]}`;
  setStatus(`<span class="spin"></span>Henter ${esc(u.hostname)} …`);
  try {
    const r = await fetchViaProxy(fetchUrl);
    const type = (r.headers.get('content-type') || '').toLowerCase();
    const finalUrl = r.headers.get('x-final-url') || fetchUrl;
    let name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname), text = '';
    if (type.includes('pdf') || /\.pdf($|\?)/i.test(finalUrl)) {
      const blob = await r.blob(); text = await readPdf(new File([blob], name.endsWith('.pdf') ? name : name + '.pdf', { type: 'application/pdf' }));
    } else if (type.startsWith('image/')) {
      const blob = await r.blob(); text = await readImage(new File([blob], name, { type }));
    } else if (type.includes('html') || type.includes('xml')) {
      const html = await r.text(); const doc = htmlToText(html, finalUrl);
      name = (doc.querySelector('meta[property="og:title"]')?.content || doc.title || name).trim();
      const R = await loadReadability();
      if (R) { try { const art = new R(doc.cloneNode(true)).parse(); if (art?.content) { const d = new DOMParser().parseFromString(art.content, 'text/html'); text = domToText(d.body); if (art.title) name = art.title; } } catch { } }
      if (!text || text.length < 200) text = domToText(doc.body);
    } else {
      text = await r.text();
      if (gdoc || gslide) name = 'Google-dokument';
    }
    text = (text || '').trim();
    if (text.length < 40) throw new Error('Fant nesten ingen tekst på siden. Den kan kreve innlogging – prøv å kopiere teksten i stedet.');
    addSource(name.slice(0, 120), text, u.href);
    toast('La til ' + name.slice(0, 60));
    return true;
  } catch (e) {
    toast(/Failed to fetch|NetworkError|Load failed/i.test(e.message) ? 'Klarte ikke å hente siden. Prøv å kopiere teksten og lim den inn i stedet.' : e.message, 6000);
  } finally { setStatus(''); }
}

/* ---------- søk på Wikipedia ---------- */
let wikiLang = 'no';
const WIKI_CUT = /^(Referanser|Kilder|Litteratur|Eksterne lenker|Se også|Noter|Fotnoter|Videre lesning|References|See also|External links|Further reading|Notes|Bibliography|Sources|Citations)$/i;
const wikiApi = (lang, params) => fetch(`https://${lang}.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*&` + new URLSearchParams(params)).then(r => { if (!r.ok) throw new Error('Wikipedia svarte ikke'); return r.json(); });
async function wikiSearch(q) {
  const out = $('#wikiOut'); q = q.trim(); if (!q) return;
  out.innerHTML = `<p class="muted"><span class="spin"></span>Søker på Wikipedia …</p>`;
  try {
    const d = await wikiApi(wikiLang, { action: 'query', generator: 'search', gsrsearch: q, gsrlimit: 8, prop: 'pageimages|description|extracts', exintro: 1, explaintext: 1, exsentences: 2, exlimit: 'max', piprop: 'thumbnail', pithumbsize: 160 });
    const pages = (d.query?.pages || []).sort((a, b) => a.index - b.index);
    if (!pages.length) { out.innerHTML = `<p class="muted">Fant ingen artikler om «${esc(q)}». Prøv et annet ord${wikiLang !== 'en' ? ', eller søk på engelsk Wikipedia' : ''}.</p>`; return; }
    out.innerHTML = `<p class="small muted" style="margin:12px 0 0">Trykk på artikkelen som handler om det du leter etter:</p><ul class="wres">${pages.map((p, i) => `<li data-i="${i}">${p.thumbnail ? `<img src="${esc(p.thumbnail.source)}" alt="" loading="lazy">` : `<span class="noimg">${ic('description')}</span>`}<div><b>${esc(p.title)}</b><small>${esc(p.description || (p.extract || '').slice(0, 140))}</small></div></li>`).join('')}</ul>`;
    $$('.wres li', out).forEach(li => li.onclick = () => wikiPreview(pages[+li.dataset.i], q));
  } catch (e) { out.innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p>`; }
}
async function wikiPreview(p, q) {
  const out = $('#wikiOut');
  out.innerHTML = `<p class="muted"><span class="spin"></span>Henter artikkelen …</p>`;
  try {
    const d = await wikiApi(wikiLang, { action: 'query', titles: p.title, prop: 'pageimages|description|extracts|info', inprop: 'url', exintro: 1, explaintext: 1, piprop: 'thumbnail', pithumbsize: 640, redirects: 1 });
    const a = d.query?.pages?.[0] || p;
    const url = a.fullurl || `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(a.title.replace(/ /g, '_'))}`;
    out.innerHTML = `<div class="wprev">${a.thumbnail ? `<img src="${esc(a.thumbnail.source)}" alt="">` : ''}
      <h4>${esc(a.title)}</h4>${a.description ? `<p class="desc">${esc(a.description)}</p>` : ''}
      <div class="intro">${md(a.extract || 'Ingen innledning.')}</div>
      <a href="${esc(url)}" target="_blank" rel="noopener" class="small">${ic('open_in_new')} Les hele artikkelen på Wikipedia</a>
      <p class="q">Er dette riktig artikkel?</p>
      <div class="row"><button class="btn ghost" id="wNo">${ic('arrow_back')} Nei, vis andre treff</button><button class="btn primary" id="wYes">${ic('check_circle')} Ja, bruk denne</button></div></div>`;
    $('#wNo').onclick = () => wikiSearch(q);
    $('#wYes').onclick = async () => {
      $('#wYes').disabled = true; $('#wYes').innerHTML = '<span class="spin"></span>Legger til …';
      try { await addWikiArticle(wikiLang, a.title); $('#wikiOut').innerHTML = `<div class="fb ok">${ic('check_circle')}«${esc(a.title)}» er lagt til som kilde. Du kan søke etter flere artikler, eller gå videre til Snakk, Quiz eller Foredrag.</div>`; }
      catch (e) { toast(e.message, 5000); $('#wYes').disabled = false; $('#wYes').innerHTML = ic('check_circle') + ' Ja, bruk denne'; }
    };
  } catch (e) { out.innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p>`; }
}
async function addWikiArticle(lang, title) {
  const d = await wikiApi(lang, { action: 'query', titles: title, prop: 'extracts|info', inprop: 'url', explaintext: 1, exsectionformat: 'wiki', redirects: 1 });
  const a = d.query?.pages?.[0];
  if (!a || a.missing || !a.extract) throw new Error('Fant ikke artikkelen på Wikipedia');
  const lines = []; for (const l of a.extract.split('\n')) {
    const h = l.match(/^(=+)\s*(.*?)\s*=+$/);
    if (h) { if (WIKI_CUT.test(h[2])) break; lines.push('#'.repeat(Math.min(3, h[1].length - 1)) + ' ' + h[2]); } else lines.push(l);
  }
  const text = ('# ' + a.title + '\n' + lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
  addSource('Wikipedia: ' + a.title, text, a.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(a.title)}`);
  toast('La til Wikipedia-artikkelen «' + a.title + '»');
}

/* ---------- navigasjon ---------- */
function showHome() {
  stopPlayer(); stopListening(); stopLive(); cur = null;
  $('#home').hidden = false; $('#topic').hidden = true; $('#backBtn').hidden = true; $('#title').textContent = 'Leksehjelp';
  renderTopics();
}
function openTopic(t, tab = 'material') {
  cur = t; cur.cache ||= {}; cur.chat ||= [];
  $('#home').hidden = true; $('#topic').hidden = false; $('#backBtn').hidden = false;
  $('#title').textContent = t.name || 'Nytt tema'; $('#topicName').value = t.name || '';
  renderSources(); renderChat(); resetQuiz(); showPanel(null); $('#wikiOut').innerHTML = '';
  $('#lectureOut').innerHTML = cur.cache.lecture ? md(cur.cache.lecture) : '';
  $('#summaryOut').innerHTML = cur.cache.summary ? md(cur.cache.summary) : '';
  $('#checkOut').innerHTML = cur.cache.check || '';
  switchTab(tab); scrollTo(0, 0);
}
function switchTab(name) {
  stopPlayer(); stopListening(); if (name !== 'chat') stopLive(); $('#newMsgBtn').hidden = true;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(p => p.hidden = p.dataset.pane !== name);
  if (name !== 'material' && !cur.sources.length) { $$('.tab')[0].hidden = false; $$('.tab').forEach(p => { if (p.dataset.pane !== 'material') p.hidden = true; }); $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'material')); toast('Legg inn stoff først'); }
  if (name === 'quiz') $('#quizHint').textContent = hasKey() ? '' : 'Uten AI-nøkkel lages enkle «fyll inn ordet»-spørsmål.';
}
function renderTopics() {
  const ul = $('#topicList');
  ul.innerHTML = topics.length ? '' : '<li class="empty">Ingen temaer ennå. Søk etter et tema over, eller legg inn ditt eget stoff.</li>';
  [...topics].sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach(t => {
    const li = document.createElement('li');
    const wc = words(t.sources.map(s => s.text).join(' ')).length;
    li.innerHTML = `<span class="avatar">${ic('auto_stories')}</span><div class="t"><b>${esc(t.name || 'Uten navn')}</b><small>${t.sources.length} kilde${t.sources.length === 1 ? '' : 'r'} · ${wc} ord</small></div><button class="iconbtn" aria-label="Slett">${ic('delete')}</button>`;
    li.onclick = e => { if (e.target.closest('button')) { if (confirm(`Slette «${t.name}»?`)) { topics = topics.filter(x => x !== t); saveTopics(); renderTopics(); } return; } openTopic(t, t.sources.length ? 'chat' : 'material'); };
    ul.appendChild(li);
  });
  $('#keyNotice').hidden = hasKey();
}
function renderSources() {
  const ul = $('#sourceList'); ul.innerHTML = cur.sources.length ? '' : '<li class="empty">Ingen kilder ennå. Ta bilde av sidene, last opp PDF eller lim inn tekst.</li>';
  cur.sources.forEach(s => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="h">${ic(s.url && /wikipedia\.org/.test(s.url) ? 'travel_explore' : s.url ? 'link' : 'description', 'kind')}<b>${esc(s.name)}</b>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="Åpne kilden">${ic('open_in_new')}</a>` : ''}<button class="iconbtn" data-a="edit" aria-label="Rediger">${ic('edit')}</button><button class="iconbtn" data-a="del" aria-label="Slett">${ic('delete')}</button></div><pre>${esc(s.text.slice(0, 1500))}${s.text.length > 1500 ? ' …' : ''}</pre>`;
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
  $('#wordCount').textContent = cur.sources.length ? `Totalt ${wc} ord. Tips: trykk på blyanten for å rette opp feil i teksten fra bilder.` : '';
}

/* ---------- samtale ---------- */
/* Følg samtalen nedover bare når brukeren allerede er nederst – ikke dra brukeren ned hvis hen har scrollet opp */
let userScrolledUp = false, lastUserInput = 0, touching = false;
const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 140;
const markInput = () => { lastUserInput = Date.now(); };
addEventListener('wheel', markInput, { passive: true });
addEventListener('touchstart', () => { touching = true; markInput(); }, { passive: true });
addEventListener('touchmove', markInput, { passive: true });
addEventListener('touchend', () => { touching = false; markInput(); }, { passive: true });
addEventListener('keydown', e => { if (/Arrow|Page|Home|End|Space/.test(e.code)) markInput(); });
addEventListener('scroll', () => {
  if (Date.now() - lastUserInput > 1200) return; // scroll som appen selv gjorde
  userScrolledUp = !nearBottom();
  if (!userScrolledUp) $('#newMsgBtn').hidden = true;
}, { passive: true });
function follow(el, force) {
  if (force) userScrolledUp = false;
  if (userScrolledUp || touching) { if (userScrolledUp && !$('[data-pane=chat]').hidden) $('#newMsgBtn').hidden = false; return; }
  scrollTo(0, document.documentElement.scrollHeight);
}
function addMsg(role, text, force) {
  const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text;
  if (role === 'bot') d.title = 'Trykk for å høre';
  $('#chatLog').appendChild(d); follow(d, force); return d;
}
document.addEventListener('click', e => { const m = e.target.closest('.msg.bot'); if (m && !live.on && m.textContent && m.textContent !== '…') speak(m.textContent); });
function renderChat() {
  $('#chatLog').innerHTML = '';
  if (!cur.chat.length) addMsg('sys', hasKey() ? 'Trykk på den store knappen for å snakke fritt med appen – som Gemini Live. Du kan også skrive under. Si «snakk engelsk» for å bytte språk.' : 'Uten AI-nøkkel finner appen setningene i stoffet som passer best til spørsmålet ditt.');
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
  text = text.trim(); if (!text) return;
  if (live.on && live.setupDone && live.ws?.readyState === 1) {
    $('#chatInput').value = ''; if (live.botB) flushBot(); stopPlayback();
    addMsg('user', text, true); cur.chat.push({ role: 'user', text });
    const sw = detectLangSwitch(text); if (sw && sw !== settings.lang) setLang(sw, true);
    live.ws.send(JSON.stringify({ realtimeInput: { text } })); return;
  }
  if (chatBusy) return;
  chatBusy = true; $('#chatInput').value = '';
  const sw = detectLangSwitch(text); if (sw && sw !== settings.lang) setLang(sw, true);
  addMsg('user', text, true); cur.chat.push({ role: 'user', text });
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
  } catch (e) { reply = 'Feil: ' + e.message; }
  pending.textContent = reply; cur.chat.push({ role: 'model', text: reply }); saveTopics();
  chatBusy = false;
  if ($('#speakReplies').checked && !reply.startsWith('Feil: ')) {
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

/* ---------- live-samtale (som Gemini Live) ---------- */
const LIVE_VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];
const live = { ws: null, on: false, setupDone: false, micCtx: null, outCtx: null, stream: null, node: null, sources: new Set(), nextT: 0, speaking: false, userB: null, botB: null, userT: '', botT: '', attempts: [], ai: 0, level: 0 };
const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.c=0;this.a=0;this.n=0;this.out=[];this.e=0}
process(inp){const ch=inp[0]&&inp[0][0];if(!ch)return true;
for(let i=0;i<ch.length;i++){const x=ch[i];this.a+=x;this.n++;this.c++;this.e+=x*x;if(this.c>=this.r){this.out.push(this.a/this.n);this.a=0;this.n=0;this.c-=this.r}}
if(this.out.length>=1600){const s=new Int16Array(this.out.length);for(let i=0;i<s.length;i++){const v=Math.max(-1,Math.min(1,this.out[i]));s[i]=v<0?v*32768:v*32767}
const lvl=Math.sqrt(this.e/(this.out.length*this.r));this.out=[];this.e=0;this.port.postMessage({pcm:s.buffer,lvl},[s.buffer])}return true}}
registerProcessor('cap',Cap);`;
function b64FromBuf(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function setLiveState(state, text) {
  const orb = $('#liveBtn'); orb.className = 'liveorb ' + state;
  $('#liveStatus').textContent = text;
  $('#liveStop').hidden = !live.on;
}
function liveSystem() {
  const doc = docText(); const capped = doc.length > 150000 ? doc.slice(0, 150000) + '\n[…forkortet…]' : doc;
  const recent = cur.chat.slice(-12).map(m => (m.role === 'user' ? 'Eleven: ' : 'Du: ') + m.text).join('\n');
  return `Du er Leksehjelp, en varm, tålmodig og engasjert studiehjelper i en LIVE muntlig samtale med en elev om temaet «${cur.name || 'temaet'}».
SPRÅK: Snakk norsk bokmål med naturlig norsk uttale. Hvis eleven ber deg snakke engelsk, bytt til engelsk og fortsett på engelsk til eleven ber om norsk igjen.
${levelRule()}${level() <= 2 ? ' Snakk rolig og tydelig med små pauser. Still bare ett enkelt spørsmål om gangen. Ros innsats, og hvis eleven svarer feil: si det vennlig og hjelp eleven videre med et hint.' : ''} Hvis eleven ber deg forklare enklere eller mer avansert, juster deg etter det.
FAKTA: Bruk KUN fakta fra STUDIESTOFFET under. Ikke finn på eller legg til fakta, tall, navn eller årstall. Står noe ikke i stoffet, si det rett ut. Gjengi fakta slik de står i stoffet.
STIL: Dette er en muntlig samtale – svar kort og naturlig (som regel 1–4 setninger), snakk som en hyggelig lærer, ikke som en tekst. Ingen lister eller opplesning av overskrifter. Still gjerne oppfølgingsspørsmål for å sjekke at eleven har forstått.
Eleven kan be deg om:
- å bli forhørt / ta en muntlig quiz: still ETT spørsmål om gangen, vent på svaret, si om det var riktig (med en kort forklaring fra stoffet), hold tellingen og si poengsummen til slutt.
- et foredrag: hold et levende, sammenhengende foredrag basert på stoffet, i passende lengde.
- et sammendrag: fortell de viktigste punktene kort.
- å forklare noe enklere: bruk enkle ord og eksempler, men ikke nye fakta.
${recent ? 'TIDLIGERE I SAMTALEN:\n' + recent + '\n' : ''}STUDIESTOFF:
"""
${capped}
"""`;
}
function stopPlayback() {
  live.sources.forEach(s => { try { s.stop(); } catch { } }); live.sources.clear(); live.nextT = 0; setSpeaking(false);
}
function setSpeaking(on) {
  live.speaking = on;
  if (live.on && live.setupDone) setLiveState(on ? 'speak' : 'listen', on ? (settings.lang === 'en' ? 'Speaking … (just talk to interrupt)' : 'Snakker … (bare snakk for å avbryte)') : (settings.lang === 'en' ? 'Listening – just talk' : 'Lytter – bare snakk'));
}
function playPcm(b64, mime) {
  const ctx = live.outCtx; if (!ctx) return;
  const rate = +((mime || '').match(/rate=(\d+)/) || [0, 24000])[1];
  const bin = atob(b64); const n = bin.length >> 1; const f = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; f[i] = v / 32768; }
  const buf = ctx.createBuffer(1, n, rate); buf.copyToChannel(f, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
  const t = Math.max(ctx.currentTime + 0.04, live.nextT); src.start(t); live.nextT = t + buf.duration;
  live.sources.add(src); setSpeaking(true);
  src.onended = () => { live.sources.delete(src); if (!live.sources.size) setSpeaking(false); };
}
function flushUser() {
  if (live.userT.trim()) {
    cur.chat.push({ role: 'user', text: live.userT.trim() });
    const sw = detectLangSwitch(live.userT); if (sw && sw !== settings.lang) setLang(sw, true);
  }
  live.userB = null; live.userT = '';
}
function flushBot() { if (live.botT.trim()) cur.chat.push({ role: 'model', text: live.botT.trim() }); live.botB = null; live.botT = ''; saveTopics(); }
function liveUserText(t) {
  if (live.botB) flushBot();
  if (!live.userB) live.userB = addMsg('user', '');
  live.userT += t; live.userB.textContent = live.userT.trim(); follow(live.userB);
}
function liveBotText(t) {
  if (live.userB) flushUser();
  if (!live.botB) live.botB = addMsg('bot', '');
  live.botT += t; live.botB.textContent = live.botT.trim(); follow(live.botB);
}
async function startLive() {
  if (live.on) return stopLive();
  if (!hasKey()) { toast('Live-samtale trenger AI – legg inn nøkkel under Innstillinger', 4000); return; }
  stopSpeaking(); stopPlayer(); stopListening();
  live.on = true; live.setupDone = false; setLiveState('connect', 'Kobler til …');
  try {
    // Lydkontekster må lages i selve trykket (krav på iPhone)
    live.outCtx = new (window.AudioContext || window.webkitAudioContext)(); await live.outCtx.resume();
    live.micCtx = new (window.AudioContext || window.webkitAudioContext)(); await live.micCtx.resume();
    live.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await live.micCtx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    const src = live.micCtx.createMediaStreamSource(live.stream);
    live.node = new AudioWorkletNode(live.micCtx, 'cap');
    const mute = live.micCtx.createGain(); mute.gain.value = 0;
    src.connect(live.node); live.node.connect(mute); mute.connect(live.micCtx.destination);
    live.node.port.onmessage = e => {
      const { pcm, lvl } = e.data;
      if (live.setupDone && !live.speaking) $('#liveBtn').style.setProperty('--lvl', Math.min(1, lvl * 6).toFixed(2));
      if (!live.on || !live.setupDone || live.ws?.readyState !== 1) return;
      if (live.speaking && $('#liveHalfDuplex').checked) return;
      live.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBuf(pcm), mimeType: 'audio/pcm;rate=16000' } } }));
    };
    const models = await pickLiveModels();
    live.attempts = models.flatMap(m => [{ m, voice: true }, { m, voice: false }]); live.ai = 0;
    openLiveSocket();
  } catch (e) {
    stopLive();
    toast(/Permission|NotAllowed/i.test(e.name + e.message) ? 'Mikrofonen er blokkert. Gi nettleseren tilgang til mikrofonen.' : 'Klarte ikke å starte: ' + e.message, 5000);
  }
}
function openLiveSocket() {
  const a = live.attempts[live.ai]; if (!a) { stopLive(); toast('Fant ingen live-modell som virker akkurat nå.', 5000); return; }
  const url = settings.apiKey
    ? 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(settings.apiKey)
    : PROXY.replace(/^http/, 'ws') + '/live';
  const ws = live.ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    const gen = { responseModalities: ['AUDIO'] };
    if (a.voice) gen.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.liveVoice || 'Kore' } } };
    ws.send(JSON.stringify({ setup: { model: 'models/' + a.m, generationConfig: gen, systemInstruction: { parts: [{ text: liveSystem() }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } }));
  };
  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)); } catch { return; }
    if (msg.setupComplete) {
      live.setupDone = true; setSpeaking(false);
      addMsg('sys', (settings.lang === 'en' ? 'Live conversation started' : 'Live-samtale startet') + ' (' + a.m + ')');
      const hello = settings.lang === 'en' ? '(The student just started a live conversation. Greet them very briefly in English and ask what they want to go through.)' : '(Eleven har akkurat startet en live-samtale. Hils veldig kort og spør hva eleven vil gå gjennom – for eksempel forklaring, forhør, foredrag eller sammendrag.)';
      ws.send(JSON.stringify({ realtimeInput: { text: hello } }));
      return;
    }
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) { stopPlayback(); if (live.botB) flushBot(); }
      if (sc.inputTranscription?.text) liveUserText(sc.inputTranscription.text);
      if (sc.outputTranscription?.text) liveBotText(sc.outputTranscription.text);
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data && /audio/.test(p.inlineData.mimeType || 'audio')) playPcm(p.inlineData.data, p.inlineData.mimeType);
      if (sc.turnComplete) { if (live.userB) flushUser(); flushBot(); }
    }
    if (msg.goAway) toast(settings.lang === 'en' ? 'The session will end soon – just start again.' : 'Samtalen når snart tidsgrensen – bare start igjen etterpå.', 4000);
  };
  ws.onclose = e => {
    if (live.ws !== ws || !live.on) return;
    if (!live.setupDone && live.ai < live.attempts.length - 1 && e.code !== 1006) { live.ai++; openLiveSocket(); return; }
    const why = e.code === 1006 && !live.setupDone ? 'Fikk ikke kontakt med AI-tjenesten.' : e.reason ? e.reason : 'Forbindelsen ble lukket.';
    const quota = /quota|exhaust|rate/i.test(e.reason || '');
    stopLive(); addMsg('sys', (quota ? 'Gratiskvoten for live-samtale er brukt opp for nå. Prøv igjen senere, eller bruk vanlig samtale under.' : why + ' Trykk på mikrofonen for å fortsette.'));
  };
}
function stopLive() {
  const was = live.on; live.on = false; live.setupDone = false;
  try { live.ws?.close(); } catch { } live.ws = null;
  stopPlayback();
  live.stream?.getTracks().forEach(t => t.stop()); live.stream = null;
  try { live.micCtx?.close(); } catch { } try { live.outCtx?.close(); } catch { }
  live.micCtx = live.outCtx = live.node = null;
  if (live.userB) flushUser(); if (live.botB) flushBot();
  $('#liveBtn').style.setProperty('--lvl', 0);
  setLiveState('', settings.lang === 'en' ? 'Tap to start a live conversation' : 'Trykk for å starte live-samtale');
  if (was) saveTopics();
}

/* ---------- quiz ---------- */
let quiz = null;
function resetQuiz() { quiz = null; $('#quizSetup').hidden = false; $('#quizRun').hidden = true; $('#quizRun').innerHTML = ''; }
async function startQuiz(focus = null) {
  const mode = segVal('quizMode'), type = segVal('quizType'), count = +segVal('quizCount'), qlevel = segVal('quizLevel');
  const nOpt = level() <= 1 ? 3 : 4;
  $('#quizSetup').hidden = true; const run = $('#quizRun'); run.hidden = false;
  run.innerHTML = '<p><span class="spin"></span>Lager quiz …</p>';
  let qs;
  try {
    if (hasKey()) {
      const typeTxt = type === 'mc' ? `Bare flervalg (${nOpt} alternativer).` : type === 'open' ? 'Bare åpne spørsmål (kort svar).' : `Bland flervalg (${nOpt} alternativer) og åpne spørsmål omtrent likt.`;
      const res = await gemini(`Lag en quiz med ${count} spørsmål om studiestoffet. Vanskelighetsgrad: ${qlevel}. ${typeTxt}
Språket i spørsmål, alternativer, hint og forklaringer skal følge FORKLARINGSSTILEN (${LEVELS[level()].name}).${level() <= 2 ? ' Spørsmålene skal være korte og konkrete, med bare én ting i hvert spørsmål. Åpne spørsmål skal kunne besvares med ett eller noen få ord.' : ''}${level() >= 5 ? ' Spørsmålene kan kreve forståelse, sammenligning og resonnering, ikke bare gjengivelse – men svaret må fortsatt følge av stoffet.' : ''}
${mode === 'oral' ? 'Quizen tas MUNTLIG: spørsmålene skal være lette å forstå når de leses høyt, korte alternativer.' : ''}
${focus ? 'Eleven bommet på disse – lag NYE spørsmål som øver på akkurat de samme faktaene fra en annen vinkel:\n' + focus.map(q => '- ' + q.question + ' (riktig: ' + q.answer + ')').join('\n') : 'Dekk de viktigste faktaene i hele stoffet, ikke bare starten.'}
Alle svar SKAL kunne finnes i stoffet. Feil alternativer skal være troverdige men tydelig feil ifølge stoffet.
Svar som JSON: {"questions":[{"type":"mc"|"open","question":"…","options":["…","…","…","…"],"correct":0,"answer":"riktig svar formulert kort","explanation":"kort forklaring","hint":"et lite hint som hjelper uten å røpe svaret","quote":"kort sitat fra stoffet som viser svaret"}]}  (options og correct bare for mc).`, { system: groundRules(), json: true, temp: 0.7 });
      qs = (res.questions || res).filter(q => q.question);
      qs.forEach(q => { if (q.type === 'mc' && (!Array.isArray(q.options) || q.options.length < 2)) q.type = 'open'; if (q.type === 'mc') { q.correct = Math.max(0, Math.min(q.options.length - 1, +q.correct || 0)); q.answer ||= q.options[q.correct]; } });
    } else qs = clozeQuiz(docText(), count);
    if (!qs.length) throw new Error('Fikk ikke laget spørsmål – er det nok tekst i stoffet?');
  } catch (e) { run.innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p><button class="btn wide" onclick="resetQuiz()">Tilbake</button>`; return; }
  quiz = { qs, i: 0, mode, results: [] };
  showQuestion();
}
const LETTERS = 'ABCDEFG';
function showQuestion() {
  const q = quiz.qs[quiz.i], run = $('#quizRun');
  run.innerHTML = `<div class="progress"><i style="width:${(quiz.i / quiz.qs.length) * 100}%"></i></div>
  <div class="qcard"><div class="num">Spørsmål ${quiz.i + 1} av ${quiz.qs.length}</div><div class="q">${esc(q.question)}</div>
  <div class="row qtools"><button class="btn ghost small" id="qSay">${ic('volume_up')} Les opp</button>${q.hint ? `<button class="btn ghost small" id="qHint">${ic('lightbulb')} Hint</button>` : ''}</div><div id="qHintOut"></div>
  ${q.type === 'mc' ? `<div class="opts">${q.options.map((o, k) => `<button data-k="${k}"><span class="key">${LETTERS[k]}</span><span>${esc(o)}</span></button>`).join('')}</div>`
      : `<textarea id="openAns" rows="3" placeholder="Skriv svaret ditt"></textarea>`}
  ${quiz.mode === 'oral' || q.type === 'open' ? `<div class="row" style="margin-top:10px">${quiz.mode === 'oral' ? '<button class="btn" id="qMic">' + MIC + ' Svar muntlig</button><button class="btn ghost" id="qRepeat">' + ic('replay') + ' Les opp igjen</button>' : ''}${q.type === 'open' ? '<button class="btn primary" id="qSubmit">Svar</button>' : ''}</div>` : ''}
  <div id="qFb"></div></div>
  <div class="row" style="margin-top:12px"><button class="btn ghost" id="qQuit">Avslutt</button><span style="flex:1"></span><button class="btn" id="qSkip">Hopp over</button></div>`;
  $$('.opts button', run).forEach(b => b.onclick = () => answerMC(+b.dataset.k));
  $('#qSubmit') && ($('#qSubmit').onclick = () => answerOpen($('#openAns').value));
  $('#qQuit').onclick = finishQuiz;
  const sayQ = () => speak(q.question + (q.type === 'mc' ? '. ' + q.options.map((o, k) => `${LETTERS[k]}: ${o}.`).join(' ') : ''));
  $('#qSay').onclick = sayQ;
  $('#qHint') && ($('#qHint').onclick = () => { $('#qHintOut').innerHTML = `<div class="fb part">${ic('lightbulb')}${esc(q.hint)}</div>`; if (settings.autoRead || quiz.mode === 'oral') speak(q.hint); });
  if (quiz.mode !== 'oral' && settings.autoRead) sayQ();
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
  btn.innerHTML = MIC + ' Lytter …'; btn.classList.add('listening');
  if ($('#openAns')) listen.onInterim = t => $('#openAns').value = t;
  try {
    const t = await listen(); btn.innerHTML = MIC + ' Svar muntlig'; btn.classList.remove('listening');
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
  } catch (e) { btn.innerHTML = MIC + ' Svar muntlig'; btn.classList.remove('listening'); toast(e.message, 5000); }
  finally { listen.onInterim = null; }
}
function record(ok, given, partial = false) { const q = quiz.qs[quiz.i]; q.done = true; quiz.results.push({ q, ok, partial, given }); }
function answerMC(k) {
  const q = quiz.qs[quiz.i]; if (q.done) return;
  const ok = k === q.correct; record(ok, q.options[k]);
  $$('.opts button').forEach((b, i) => { b.disabled = true; if (i === q.correct) b.classList.add('right'); else if (i === k) b.classList.add('wrong'); });
  feedback(ok ? 'ok' : 'bad', ok ? 'Riktig!' : `Feil. Riktig svar er ${LETTERS[q.correct]}: ${q.options[q.correct]}.`, q);
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
  } catch (e) { $('#qFb').innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p>`; $('#qSubmit') && ($('#qSubmit').disabled = false); return; }
  record(verdict === 'ok', given, verdict === 'part');
  const head = verdict === 'ok' ? 'Riktig!' : verdict === 'part' ? 'Delvis riktig.' : 'Ikke helt.';
  feedback(verdict, `${head} ${comment}${verdict !== 'ok' ? ' Riktig svar: ' + q.answer : ''}`, q);
}
function feedback(cls, text, q) {
  $('#qFb').innerHTML = `<div class="fb ${cls}">${esc(text)}${q.explanation ? '<br>' + esc(q.explanation) : ''}${q.quote ? `<span class="quote">«${esc(q.quote)}»</span>` : ''}</div>
    <button class="btn primary wide" id="qNext">${quiz.i + 1 < quiz.qs.length ? 'Neste spørsmål' : 'Se resultat'}</button>`;
  $('#qNext').onclick = () => { stopSpeaking(); nextQ(); };
  if (quiz.mode === 'oral') { const my = quiz.i; speak(text).then(done => { if (done && quiz && quiz.i === my) nextQ(); }); }
}
function nextQ() { stopListening(); quiz.i++; if (quiz.i >= quiz.qs.length) finishQuiz(); else showQuestion(); }
function finishQuiz() {
  stopSpeaking(); stopListening(); if (!quiz) return resetQuiz();
  const n = quiz.results.length, pts = quiz.results.reduce((a, r) => a + (r.ok ? 1 : r.partial ? .5 : 0), 0);
  const missed = quiz.results.filter(r => !r.ok);
  const pct = n ? Math.round(pts / n * 100) : 0;
  $('#quizRun').innerHTML = `<div class="qcard"><span class="trophy">${ic('emoji_events')}</span><div class="score">${pts} / ${n}</div><p style="text-align:center">${pct >= 90 ? 'Strålende!' : pct >= 70 ? 'Godt jobbet!' : pct >= 40 ? 'Bra start – øv litt til' : 'Dette temaet trenger mer øving'}</p>
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
    out.innerHTML = '<div class="row"><button class="btn" id="lPlay">' + ic('play_arrow') + ' Les opp</button></div>' + md(t);
    $('#lPlay').onclick = () => startReading(out);
    startReading(out);
  } catch (e) { out.innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p>`; }
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
    out.innerHTML = '<div class="row"><button class="btn" id="sPlay">' + ic('volume_up') + ' Les opp</button><button class="btn ghost" id="sCopy">' + ic('content_copy') + ' Kopier</button></div>' + md(t);
    $('#sPlay').onclick = () => startReading(out);
    $('#sCopy').onclick = () => navigator.clipboard?.writeText(t).then(() => toast('Kopiert'));
  } catch (e) { out.innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p>`; }
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
    let html = `<h3>${bad.length ? `${ic('error')} ${bad.length} mulig${bad.length === 1 ? '' : 'e'} feil funnet` : `${ic('check_circle')} Fant ingen feil`}</h3>`;
    html += bad.map(x => `<div class="issue"><b>Stoffet sier:</b> «${esc(x.quote || x.claim)}»<br><b>Wikipedia:</b> ${esc(x.explanation)}${src(x)}</div>`).join('');
    if (ok.length) html += `<h3>Stemmer med Wikipedia (${ok.length})</h3>` + ok.map(x => `<div class="issue ok">${esc(x.claim)}${src(x)}</div>`).join('');
    if (unk.length) html += `<p class="muted small">${unk.length} påstand${unk.length === 1 ? '' : 'er'} ble ikke funnet i artiklene som ble sjekket.</p>`;
    html += '<p class="muted small">Wikipedia kan også ta feil. Spør læreren hvis du er usikker. Appen fortsetter å bruke stoffet ditt slik det står.</p>';
    cur.cache.check = html; saveTopics(); out.innerHTML = html;
  } catch (e) { out.innerHTML = `<p class="fb bad">${ic('error')}${esc(e.message)}</p>`; }
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
  $('#apiKey').value = settings.apiKey; $('#modelName').value = settings.model; $('#modelName').placeholder = 'Automatisk' + (modelCache ? ' (' + modelCache[0] + ')' : ''); fillVoiceSelect(); $('#testOut').textContent = '';
  $('#textSize').value = settings.textSize || 1; $('#fontSel').value = settings.font || ''; $('#autoRead').checked = !!settings.autoRead;
  $('#liveVoiceSel').innerHTML = LIVE_VOICES.map(v => `<option${v === (settings.liveVoice || 'Kore') ? ' selected' : ''}>${v}</option>`).join('');
  $('#builtinAi').textContent = PROXY ? 'Appen har innebygd AI – du trenger ikke egen nøkkel. Legg inn en egen bare hvis den innebygde kvoten er brukt opp.' : '';
  $('#settings').showModal();
}
$('#saveSettings').onclick = () => { settings.apiKey = $('#apiKey').value.trim(); settings.model = $('#modelName').value.trim(); settings.voice = $('#voiceSel').value; settings.liveVoice = $('#liveVoiceSel').value; settings.textSize = +$('#textSize').value; settings.font = $('#fontSel').value; settings.autoRead = $('#autoRead').checked; applyReading(); saveSettings(); renderTopics(); toast('Lagret'); };
$('#testKey').onclick = async () => {
  const old = { ...settings }; settings.apiKey = $('#apiKey').value.trim(); settings.model = $('#modelName').value.trim();
  $('#testOut').textContent = 'Tester …';
  try { const r = await gemini('Svar bare med ordet: OK'); $('#testOut').textContent = 'AI-tilkoblingen virker. (' + r.slice(0, 20) + ')'; }
  catch (e) { $('#testOut').textContent = 'Virket ikke: ' + (e.message === 'NOKEY' ? 'Skriv inn en nøkkel først.' : e.message); Object.assign(settings, old); }
};

/* ---------- installering ---------- */
let deferredPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (!isStandalone()) $('#installBtn').hidden = false; });
addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Leksehjelp er installert'); });
$('#installBtn').onclick = async () => {
  if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#installBtn').hidden = true; }
  else if (isIOS) $('#iosInstall').showModal();
  else toast('Åpne menyen ⋮ i nettleseren og velg «Installer app» / «Legg til på startskjermen».', 5000);
};

/* ---------- koble opp knapper ---------- */
$('#backBtn').onclick = showHome;
$('#settingsBtn').onclick = openSettings;
document.addEventListener('click', e => { if (e.target.closest('[data-open-settings]')) openSettings(); });
$('#langBtn').onclick = () => {
  setLang(settings.lang === 'no' ? 'en' : 'no', true);
  if (live.on && live.setupDone && live.ws?.readyState === 1) live.ws.send(JSON.stringify({ realtimeInput: { text: settings.lang === 'en' ? '(Please switch to English now and keep speaking English.)' : '(Bytt til norsk nå og fortsett på norsk.)' } }));
  else if (!live.on) stopLive();
};
$('#liveBtn').onclick = startLive;
$('#newMsgBtn').onclick = () => { userScrolledUp = false; $('#newMsgBtn').hidden = true; lastUserInput = 0; scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); };
function showLevel() { $('#levelRange').value = level(); $('#levelName').textContent = LEVELS[level()].name; }
function applyReading() {
  const r = document.documentElement;
  r.style.setProperty('--fs', ({ 1: '16px', 2: '18px', 3: '21px' })[settings.textSize || 1]);
  r.dataset.font = settings.font || '';
  if (settings.font && !document.getElementById('fontcss')) {
    const l = document.createElement('link'); l.id = 'fontcss'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Lexend:wght@400;600&family=Atkinson+Hyperlegible:wght@400;700&display=swap';
    document.head.appendChild(l);
  }
}
$('#levelRange').oninput = () => { settings.level = +$('#levelRange').value; showLevel(); };
$('#levelRange').onchange = () => {
  saveSettings();
  if (live.on && live.setupDone && live.ws?.readyState === 1) live.ws.send(JSON.stringify({ realtimeInput: { text: '(Bytt forklaringsstil fra nå: ' + LEVELS[level()].rule + ' Ikke kommenter endringen, bare fortsett.)' } }));
  toast('Språkbruk: ' + LEVELS[level()].name);
};
$('#liveStop').onclick = stopLive;
$('#newTopicBtn').onclick = () => { const t = { id: uid(), name: '', sources: [], created: Date.now(), updated: Date.now(), chat: [], cache: {} }; topics.push(t); saveTopics(); openTopic(t, 'material'); $('#topicName').focus(); };
$('#topicName').oninput = e => { cur.name = e.target.value.trim(); $('#title').textContent = cur.name || 'Nytt tema'; cur.updated = Date.now(); saveTopics(); };
$$('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$$('.seg').forEach(s => s.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $$('button', s).forEach(x => x.classList.toggle('on', x === b)); }));
$('#addCamera').onclick = () => $('#cameraInput').click();
$('#addFile').onclick = () => $('#fileInput').click();
$('#cameraInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
$('#fileInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
function showPanel(id) {
  const ids = { pasteBox: 'addPaste', linkBox: 'addLink', wikiBox: 'addWiki' };
  for (const [p, t] of Object.entries(ids)) { const on = p === id && $('#' + p).hidden; $('#' + p).hidden = !on; $('#' + t).classList.toggle('on', on); }
}
$('#addPaste').onclick = () => { showPanel('pasteBox'); if (!$('#pasteBox').hidden) $('#pasteText').focus(); };
$('#pasteCancel').onclick = () => { showPanel(null); $('#pasteText').value = ''; };
$('#addLink').onclick = () => { showPanel('linkBox'); if (!$('#linkBox').hidden) $('#linkInput').focus(); };
$('#linkCancel').onclick = () => { showPanel(null); $('#linkInput').value = ''; };
$('#linkBox').onsubmit = async e => { e.preventDefault(); const v = $('#linkInput').value; if (await importUrl(v)) { $('#linkInput').value = ''; showPanel(null); } };
$('#addWiki').onclick = () => { showPanel('wikiBox'); if (!$('#wikiBox').hidden) { if (!$('#wikiQuery').value && cur.name) $('#wikiQuery').value = cur.name; $('#wikiQuery').focus(); } };
$('#wikiForm').onsubmit = e => { e.preventDefault(); $('#wikiQuery').blur(); wikiSearch($('#wikiQuery').value); };
$('#wikiLang').onclick = e => { const b = e.target.closest('button'); if (!b) return; wikiLang = b.dataset.l; $$('#wikiLang button').forEach(x => x.classList.toggle('on', x === b)); if ($('#wikiQuery').value.trim()) wikiSearch($('#wikiQuery').value); };
$('#homeSearch').onsubmit = e => {
  e.preventDefault(); const q = $('#homeQuery').value.trim(); if (!q) { $('#homeQuery').focus(); return; }
  const t = { id: uid(), name: '', sources: [], created: Date.now(), updated: Date.now(), chat: [], cache: {} }; topics.push(t); saveTopics();
  openTopic(t, 'material'); $('#homeQuery').value = '';
  showPanel('wikiBox'); $('#wikiQuery').value = q; wikiSearch(q);
};
// Lim inn lenke rett i tekstfeltet → tilby å hente den
$('#pasteText').addEventListener('paste', e => { const t = (e.clipboardData?.getData('text') || '').trim(); if (/^https?:\/\/\S+$/.test(t) && !$('#pasteText').value) { e.preventDefault(); showPanel('linkBox'); $('#linkInput').value = t; toast('Det var en lenke – trykk «Hent» for å hente innholdet'); } });
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
  setLang(settings.lang || 'no'); showLevel(); applyReading();
  if (isIOS && !isStandalone()) $('#installBtn').hidden = false;
  showHome();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.update().catch(() => { });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => { }); });
    }).catch(() => { });
    // Ny versjon tatt i bruk → last siden på nytt én gang
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
