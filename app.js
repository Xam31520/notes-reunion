// Notes de réunion — PWA locale : import audio, transcription Mistral (Voxtral),
// résumé et questions via l'API de chat Mistral. Tout est stocké dans IndexedDB.

/* ---------------------------------------------------------------- stockage */

const DB_NAME = 'notes-reunion';
const DB_VERSION = 1;
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meetings')) d.createObjectStore('meetings', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const store = {
  all: () => tx('meetings', 'readonly', (s) => reqP(s.getAll())),
  get: (id) => tx('meetings', 'readonly', (s) => reqP(s.get(id))),
  put: (m) => tx('meetings', 'readwrite', (s) => { s.put(m); }),
  del: (id) => tx('meetings', 'readwrite', (s) => { s.delete(id); }),
  getAudio: (id) => tx('audio', 'readonly', (s) => reqP(s.get(id))),
  putAudio: (id, blob) => tx('audio', 'readwrite', (s) => { s.put(blob, id); }),
  delAudio: (id) => tx('audio', 'readwrite', (s) => { s.delete(id); }),
  getKV: (k) => tx('kv', 'readonly', (s) => reqP(s.get(k))),
  putKV: (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); }),
};

async function update(id, patch) {
  const m = await store.get(id);
  if (!m) return null;
  Object.assign(m, typeof patch === 'function' ? patch(m) : patch);
  await store.put(m);
  return m;
}

/* ---------------------------------------------------------------- réglages */

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.mistral.ai',
  sttModel: 'voxtral-mini-latest',
  chatModel: 'mistral-medium-latest',
  vocab: '',
  keepAudio: true,
};
function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) { localStorage.setItem('settings', JSON.stringify(s)); }
const apiBase = () => (settings().baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');

/* ---------------------------------------------------------------- API Mistral */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function apiFetch(path, init) {
  const { apiKey } = settings();
  if (!apiKey) throw new ApiError(0, 'Aucune clé API. Ajoute ta clé Mistral dans les réglages.');
  let res;
  try {
    res = await fetch(apiBase() + path, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
    });
  } catch (e) {
    throw new ApiError(0, 'Connexion impossible à l\'API (réseau coupé, ou appel bloqué par le navigateur). ' +
      'Si le problème persiste, configure un relais dans Réglages → Avancé.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.message || j.detail || j.error?.message || JSON.stringify(j);
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch { detail = res.statusText; }
    const hints = {
      401: 'Clé API refusée. Vérifie-la dans les réglages.',
      402: 'Crédit insuffisant sur ton compte Mistral.',
      413: 'Fichier trop gros pour l\'API.',
      429: 'Trop de requêtes ou quota atteint. Réessaie dans un moment.',
    };
    throw new ApiError(res.status, `${hints[res.status] || 'Erreur de l\'API'} (${res.status}) ${detail}`.trim());
  }
  return res.json();
}

async function transcribe(blob, fileName) {
  const s = settings();
  const build = (withLanguage) => {
    const fd = new FormData();
    fd.append('model', s.sttModel || DEFAULTS.sttModel);
    fd.append('file', blob, fileName || 'audio.m4a');
    fd.append('diarize', 'true');
    fd.append('timestamp_granularities', 'segment');
    if (withLanguage) fd.append('language', 'fr');
    for (const w of (s.vocab || '').split(',').map((x) => x.trim()).filter(Boolean)) fd.append('context_bias', w);
    return fd;
  };
  try {
    return await apiFetch('/v1/audio/transcriptions', { method: 'POST', body: build(true) });
  } catch (e) {
    // Si l'API refuse la langue forcée avec la diarisation, on réessaie en détection auto.
    if ((e.status === 400 || e.status === 422) && /language/i.test(e.message)) {
      return apiFetch('/v1/audio/transcriptions', { method: 'POST', body: build(false) });
    }
    throw e;
  }
}

async function chat(messages, { maxTokens = 2000 } = {}) {
  const j = await apiFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings().chatModel || DEFAULTS.chatModel, messages, temperature: 0.2, max_tokens: maxTokens }),
  });
  const c = j.choices?.[0]?.message?.content;
  return Array.isArray(c) ? c.map((p) => p.text || '').join('') : (c || '');
}

/* ---------------------------------------------------------------- utilitaires */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const fmtDate = (ts) => new Date(ts).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const SPEAKER_COLORS = ['#ff8a7a', '#7ab8ff', '#8ee09b', '#f5c66b', '#c79bff', '#6fe0d6', '#ff9ed1', '#b8c4d6', '#e0a36f', '#9fd36b'];
function speakerName(m, id) {
  if (m.speakers?.[id]) return m.speakers[id];
  const n = /(\d+)$/.exec(id || '');
  return n ? `Intervenant ${n[1]}` : (id || 'Intervenant');
}
function speakerIds(m) { return [...new Set((m.segments || []).map((s) => s.speaker_id || 'speaker_1'))]; }

// Regroupe les segments consécutifs d'un même intervenant.
function turns(m) {
  const out = [];
  for (const s of m.segments || []) {
    const id = s.speaker_id || 'speaker_1';
    const last = out[out.length - 1];
    if (last && last.id === id) { last.text += s.text; last.end = s.end; }
    else out.push({ id, start: s.start, end: s.end, text: s.text });
  }
  for (const t of out) t.text = t.text.trim();
  return out;
}

function transcriptText(m, { times = true } = {}) {
  const t = turns(m);
  if (!t.length) return (m.text || '').trim();
  return t.map((x) => `${times ? `[${fmtTime(x.start)}] ` : ''}${speakerName(m, x.id)} : ${x.text}`).join('\n');
}

// Markdown minimal et sûr (titres, listes, gras, italique).
function md(src) {
  const lines = esc(src || '').split('\n');
  let html = '', list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { close(); const l = Math.min(3, m[1].length + 1); html += `<h${l}>${inline(m[2])}</h${l}>`; }
    else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) { close(); }
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return html;
}

function audioDuration(blob) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* non bloquant */ }
}

async function shareOrDownload(fileName, text, mime = 'text/plain') {
  const file = new File([text], fileName, { type: `${mime};charset=utf-8` });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fileName }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = (s) => (s || 'reunion').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

/* ---------------------------------------------------------------- traitement */

const running = new Set();

async function importFiles(files) {
  let firstId = null;
  for (const f of files) {
    const id = uid();
    firstId ??= id;
    const duration = await audioDuration(f);
    const title = f.name.replace(/\.[^.]+$/, '') || 'Réunion';
    await store.putAudio(id, f);
    await store.put({
      id, title, autoTitle: true, fileName: f.name, mime: f.type, size: f.size,
      date: f.lastModified || Date.now(), importedAt: Date.now(), duration,
      status: 'pending', segments: [], text: '', speakers: {}, summary: '', chat: [], hasAudio: true,
    });
  }
  queueAll(); // transcrit les fichiers l'un après l'autre
  return firstId;
}

let queueBusy = false;
async function queueAll() {
  if (queueBusy) return;
  queueBusy = true;
  try {
    for (;;) {
      const next = (await store.all()).filter((m) => m.status === 'pending').sort((a, b) => a.importedAt - b.importedAt)[0];
      if (!next) break;
      await runTranscription(next.id);
    }
  } finally { queueBusy = false; keepAwake(false); }
}

async function runTranscription(id) {
  if (running.has(id)) return;
  running.add(id);
  await update(id, { status: 'running', error: '' });
  rerender(id);
  keepAwake(true);
  try {
    const m = await store.get(id);
    const blob = await store.getAudio(id);
    if (!blob) throw new Error('Audio introuvable : réimporte le fichier.');
    const r = await transcribe(blob, m.fileName);
    const segments = (r.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text || '', speaker_id: s.speaker_id || 'speaker_1' }));
    const dur = m.duration || r.usage?.prompt_audio_seconds || segments.at(-1)?.end || 0;
    await update(id, { status: 'done', segments, text: r.text || segments.map((s) => s.text).join('').trim(), duration: dur, error: '', transcribedAt: Date.now() });
    if (!settings().keepAudio) { await store.delAudio(id); await update(id, { hasAudio: false }); }
  } catch (e) {
    await update(id, { status: 'error', error: e.message || String(e) });
  } finally {
    running.delete(id);
    rerender(id);
  }
}

async function summarize(id) {
  const m = await store.get(id);
  const sys = 'Tu es un assistant qui rédige des comptes rendus de réunion en français, factuels et concis. ' +
    'N\'invente rien : si une information manque, ne la mentionne pas.';
  const user = `Voici la transcription d'une réunion (« ${m.title} », ${fmtDate(m.date)}). Les intervenants sont identifiés automatiquement et peuvent être approximatifs.\n\n` +
    `${transcriptText(m)}\n\n` +
    'Rédige le compte rendu en Markdown, exactement dans ce format :\n' +
    'Titre : <titre court et explicite de la réunion, 8 mots maximum>\n\n' +
    '## Résumé\n<3 à 6 phrases>\n\n## Décisions\n- ...\n\n## Actions\n- <qui> : <quoi> (<échéance si mentionnée>)\n\n## Points ouverts\n- ...\n\n' +
    'Si une section est vide, écris « Aucune ».';
  let out = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 1800 });
  let title = null;
  out = out.replace(/^\s*\**Titre\**\s*:\s*(.+)\n+/i, (_, t) => { title = t.replace(/\*+/g, '').trim(); return ''; }).trim();
  await update(id, (cur) => ({ summary: out, summarizedAt: Date.now(), ...(title && cur.autoTitle ? { title, autoTitle: false } : {}) }));
}

async function askMeeting(id, question) {
  const m = await store.get(id);
  const sys = 'Tu réponds en français à des questions sur une réunion, uniquement à partir de sa transcription. ' +
    'Cite les intervenants et les horodatages [mm:ss] utiles. Si la réponse n\'est pas dans la transcription, dis-le simplement.\n\n' +
    `Réunion : « ${m.title} », ${fmtDate(m.date)}\n\nTranscription :\n${transcriptText(m)}` +
    (m.summary ? `\n\nCompte rendu déjà rédigé :\n${m.summary}` : '');
  const history = (m.chat || []).slice(-10).map(({ role, content }) => ({ role, content }));
  const answer = await chat([{ role: 'system', content: sys }, ...history, { role: 'user', content: question }]);
  await update(id, (cur) => ({ chat: [...(cur.chat || []), { role: 'user', content: question, at: Date.now() }, { role: 'assistant', content: answer, at: Date.now() }] }));
}

// Contexte pour une question sur tout l'historique : tout le texte si ça tient,
// sinon les résumés de toutes les réunions + le texte complet des plus pertinentes.
const HISTORY_BUDGET = 280000; // caractères (≈ 70 000 tokens)
function buildHistoryContext(meetings, question) {
  const done = meetings.filter((m) => m.status === 'done').sort((a, b) => b.date - a.date);
  const head = (m) => `### « ${m.title} » — ${fmtDate(m.date)}${m.duration ? ' — ' + fmtDuration(m.duration) : ''}`;
  const full = done.map((m) => `${head(m)}\n${transcriptText(m, { times: false })}`);
  if (full.join('\n\n').length <= HISTORY_BUDGET) return { context: full.join('\n\n'), count: done.length, mode: 'full' };

  const words = [...new Set(norm(question).split(/[^a-z0-9]+/).filter((w) => w.length > 3))];
  const scored = done.map((m) => {
    const hay = norm(m.title + ' ' + m.summary + ' ' + m.text);
    const score = words.reduce((n, w) => n + (hay.split(w).length - 1), 0);
    return { m, score };
  }).sort((a, b) => b.score - a.score || b.m.date - a.m.date);

  const overview = done.map((m) => `${head(m)}\n${m.summary || (m.text || '').slice(0, 1200) + '…'}`).join('\n\n');
  let ctx = `## Vue d'ensemble de toutes les réunions\n\n${overview}`;
  const detailed = [];
  for (const { m, score } of scored) {
    if (!score) break;
    const block = `${head(m)}\n${transcriptText(m, { times: false })}`;
    if (ctx.length + block.length > HISTORY_BUDGET) continue;
    ctx += `\n\n## Transcription complète\n\n${block}`;
    detailed.push(m.title);
  }
  if (ctx.length > HISTORY_BUDGET) ctx = ctx.slice(0, HISTORY_BUDGET);
  return { context: ctx, count: done.length, mode: 'partial', detailed };
}

async function askHistory(question) {
  const meetings = await store.all();
  const { context, count } = buildHistoryContext(meetings, question);
  if (!count) throw new Error('Aucune réunion transcrite pour l\'instant.');
  const sys = 'Tu es l\'assistant de mémoire de réunions de l\'utilisateur. Réponds en français, uniquement à partir des réunions ci-dessous. ' +
    'Indique de quelle réunion (titre et date) vient chaque information. Si l\'information n\'y est pas, dis-le. ' +
    `Nous sommes le ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.\n\n${context}`;
  const log = (await store.getKV('historyChat')) || [];
  const history = log.slice(-8).map(({ role, content }) => ({ role, content }));
  const answer = await chat([{ role: 'system', content: sys }, ...history, { role: 'user', content: question }]);
  await store.putKV('historyChat', [...log, { role: 'user', content: question, at: Date.now() }, { role: 'assistant', content: answer, at: Date.now() }]);
}

function exportText(m) {
  const parts = [`${m.title}`, `${fmtDate(m.date)}${m.duration ? ' · ' + fmtDuration(m.duration) : ''}`, ''];
  if (m.summary) parts.push('COMPTE RENDU', '', m.summary, '', '');
  parts.push('TRANSCRIPTION', '', transcriptText(m));
  return parts.join('\n');
}

/* ---------------------------------------------------------------- interface */

const app = $('#app');
const titleEl = $('#viewTitle');
const backBtn = $('#backBtn');
let currentView = null;

function mount(tplId, title, back) {
  app.replaceChildren($(tplId).content.cloneNode(true));
  titleEl.textContent = title;
  backBtn.hidden = !back;
  window.scrollTo(0, 0);
}

backBtn.onclick = () => { location.hash = '#/'; };
$('#settingsBtn').onclick = () => { location.hash = '#/settings'; };

const fileInput = $('#fileInput');
fileInput.onchange = async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;
  const id = await importFiles(files);
  location.hash = files.length === 1 ? `#/m/${id}` : '#/';
  route();
};

function rerender(id) {
  if (!currentView) return;
  if (currentView.name === 'list') renderList();
  else if (currentView.name === 'meeting' && currentView.id === id) renderMeeting(id, { keepTab: true });
}

async function renderList() {
  currentView = { name: 'list' };
  mount('#tpl-list', 'Réunions', false);
  $('#setupHint').hidden = !!settings().apiKey;
  $('#importBtn').onclick = () => fileInput.click();
  $('#askAllBtn').onclick = () => { location.hash = '#/ask'; };
  const input = $('#searchInput');
  input.value = sessionStorage.getItem('q') || '';
  const all = (await store.all()).sort((a, b) => b.date - a.date);
  const draw = () => {
    const query = norm(input.value.trim());
    sessionStorage.setItem('q', input.value);
    const ul = $('#meetingList');
    ul.replaceChildren();
    const shown = all.filter((m) => !query || norm(`${m.title} ${m.text} ${m.summary} ${Object.values(m.speakers || {}).join(' ')}`).includes(query));
    for (const m of shown) {
      const li = document.createElement('li');
      const badge = m.status === 'done' ? (m.summary ? '<span class="badge">résumé</span>' : '')
        : m.status === 'error' ? '<span class="badge err">erreur</span>'
          : '<span class="badge run">transcription…</span>';
      let excerpt = '';
      const src = m.summary ? m.summary.replace(/^#+.*$/gm, '').replace(/\s+/g, ' ') : (m.text || '');
      if (query) {
        const hay = m.text || '';
        const i = norm(hay).indexOf(query);
        if (i >= 0) {
          const a = Math.max(0, i - 60), b = Math.min(hay.length, i + query.length + 80);
          excerpt = (a ? '…' : '') + esc(hay.slice(a, i)) + '<mark>' + esc(hay.slice(i, i + query.length)) + '</mark>' + esc(hay.slice(i + query.length, b)) + (b < hay.length ? '…' : '');
        }
      }
      if (!excerpt && src) excerpt = esc(src.trim().slice(0, 200));
      li.innerHTML = `<a href="#/m/${m.id}"><div class="t">${esc(m.title)}${badge}</div>` +
        `<div class="s">${esc(fmtDate(m.date))}${m.duration ? ' · ' + fmtDuration(m.duration) : ''}</div>` +
        (excerpt ? `<div class="x">${excerpt}</div>` : '') + '</a>';
      ul.append(li);
    }
    $('#emptyList').hidden = shown.length > 0;
    $('#emptyList').textContent = all.length ? 'Aucun résultat.' : 'Aucune réunion pour l\'instant.';
  };
  input.oninput = draw;
  draw();
}

async function renderMeeting(id, { keepTab = false } = {}) {
  const prevTab = keepTab ? app.querySelector('.tab.active')?.dataset.tab : null;
  const prevChat = keepTab ? $('#chatInput')?.value : '';
  const m = await store.get(id);
  if (!m) { location.hash = '#/'; return; }
  const audioTime = keepTab ? $('#player')?.currentTime : 0;
  currentView = { name: 'meeting', id };
  mount('#tpl-meeting', 'Réunion', true);

  const titleInput = $('#titleInput');
  titleInput.value = m.title;
  titleInput.onchange = () => update(id, { title: titleInput.value.trim() || 'Réunion', autoTitle: false });
  $('#meta').textContent = `${fmtDate(m.date)}${m.duration ? ' · ' + fmtDuration(m.duration) : ''}${m.fileName ? ' · ' + m.fileName : ''}`;

  // Audio
  const player = $('#player');
  const blob = m.hasAudio ? await store.getAudio(id) : null;
  if (blob) {
    player.src = URL.createObjectURL(blob);
    if (audioTime) player.addEventListener('loadedmetadata', () => { player.currentTime = audioTime; }, { once: true });
  } else player.hidden = true;

  // Statut
  const status = $('#statusBox');
  if (m.status === 'pending' || m.status === 'running') {
    status.hidden = false;
    status.innerHTML = '<div class="spinner"></div><div>Transcription en cours… Garde l\'app ouverte jusqu\'à la fin (environ 1 minute par tranche de 10 minutes d\'audio).</div>';
  } else if (m.status === 'error') {
    status.hidden = false;
    status.className = 'card status err';
    status.textContent = `La transcription a échoué : ${m.error}`;
    $('#retryBtn').hidden = !blob;
  }
  $('#retryBtn').onclick = async () => { await update(id, { status: 'pending' }); queueAll(); renderMeeting(id); };

  // Onglets
  const tabs = app.querySelectorAll('.tab');
  const show = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    app.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  };
  tabs.forEach((t) => { t.onclick = () => show(t.dataset.tab); });
  show(prevTab || 'transcript');

  // Transcription
  const tr = $('#transcript');
  const ids = speakerIds(m);
  const color = (sid) => SPEAKER_COLORS[ids.indexOf(sid) % SPEAKER_COLORS.length];
  if (m.status === 'done') {
    const t = turns(m);
    if (!t.length && m.text) tr.innerHTML = `<div class="seg"><div class="txt">${esc(m.text)}</div></div>`;
    for (const x of t) {
      const d = document.createElement('div');
      d.className = 'seg';
      d.innerHTML = `<div><span class="who" style="color:${color(x.id)}">${esc(speakerName(m, x.id))}</span>` +
        `<span class="when" data-t="${x.start}">${fmtTime(x.start)}</span></div><div class="txt">${esc(x.text)}</div>`;
      tr.append(d);
    }
    tr.onclick = (e) => {
      const t0 = e.target.dataset?.t;
      if (t0 != null && blob) { player.currentTime = Number(t0); player.play(); }
    };
    const form = $('#speakersForm');
    for (const sid of ids) {
      const l = document.createElement('label');
      l.innerHTML = `<span style="color:${color(sid)}">${esc(speakerName({}, sid))}</span>`;
      const inp = document.createElement('input');
      inp.value = m.speakers?.[sid] || '';
      inp.placeholder = 'Nom';
      inp.onchange = async () => {
        await update(id, (cur) => ({ speakers: { ...cur.speakers, [sid]: inp.value.trim() } }));
        renderMeeting(id, { keepTab: true });
      };
      l.append(inp);
      form.append(l);
    }
    if (!ids.length) $('#speakersBox').hidden = true;
  } else {
    $('#speakersBox').hidden = true;
  }

  // Résumé
  const sumBtn = $('#summarizeBtn');
  $('#summary').innerHTML = md(m.summary);
  sumBtn.textContent = m.summary ? '↻ Régénérer le résumé' : '✨ Générer le résumé';
  sumBtn.disabled = m.status !== 'done';
  sumBtn.onclick = async () => {
    sumBtn.disabled = true;
    sumBtn.textContent = 'Rédaction du résumé…';
    try { await summarize(id); }
    catch (e) { alertInline($('#summary'), e.message); sumBtn.disabled = false; sumBtn.textContent = '✨ Générer le résumé'; return; }
    renderMeeting(id, { keepTab: true });
  };

  // Questions
  setupChat({
    log: m.chat || [],
    disabled: m.status !== 'done',
    draft: prevChat,
    onAsk: (q) => askMeeting(id, q),
    reload: () => renderMeeting(id, { keepTab: true }),
  });

  $('#exportBtn').disabled = m.status !== 'done';
  $('#exportBtn').onclick = async () => shareOrDownload(`${safeName(m.title)}.txt`, exportText(await store.get(id)));
  $('#deleteBtn').onclick = async () => {
    if (!confirm('Supprimer cette réunion et sa transcription ?')) return;
    await store.del(id); await store.delAudio(id);
    location.hash = '#/';
  };
}

function alertInline(el, msg) {
  el.innerHTML = `<p class="msg err">${esc(msg)}</p>`;
}

function setupChat({ log, disabled, draft, onAsk, reload }) {
  const box = $('#chatLog');
  const form = $('#chatForm');
  const input = $('#chatInput');
  input.value = draft || '';
  box.replaceChildren();
  for (const msg of log) {
    const d = document.createElement('div');
    d.className = `msg ${msg.role}`;
    if (msg.role === 'assistant') d.classList.add('md'), d.innerHTML = md(msg.content);
    else d.textContent = msg.content;
    box.append(d);
  }
  if (disabled) { input.disabled = true; input.placeholder = 'Disponible une fois la transcription terminée.'; }
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || disabled) return;
    const btn = form.querySelector('button');
    btn.disabled = true; input.disabled = true;
    const u = document.createElement('div'); u.className = 'msg user'; u.textContent = q; box.append(u);
    const w = document.createElement('div'); w.className = 'msg assistant'; w.innerHTML = '<div class="spinner"></div>'; box.append(w);
    w.scrollIntoView({ block: 'end', behavior: 'smooth' });
    try { await onAsk(q); input.value = ''; await reload(); }
    catch (err) { w.className = 'msg assistant err'; w.textContent = err.message; btn.disabled = false; input.disabled = false; }
    const last = $('#chatLog')?.lastElementChild;
    last?.scrollIntoView({ block: 'end' });
  };
}

async function renderAskAll() {
  currentView = { name: 'ask' };
  mount('#tpl-ask-all', 'Tout l\'historique', true);
  const draw = async (draft = '') => {
    setupChat({
      log: (await store.getKV('historyChat')) || [],
      disabled: false,
      draft,
      onAsk: askHistory,
      reload: () => draw(),
    });
  };
  await draw();
  $('#clearChatBtn').onclick = async () => { await store.putKV('historyChat', []); draw(); };
}

async function renderSettings() {
  currentView = { name: 'settings' };
  mount('#tpl-settings', 'Réglages', true);
  const form = $('#settingsForm');
  const s = settings();
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = k === 'baseUrl' && v === DEFAULTS.baseUrl ? '' : v;
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = form.elements;
    saveSettings({
      apiKey: f.apiKey.value.trim(),
      baseUrl: f.baseUrl.value.trim() || DEFAULTS.baseUrl,
      sttModel: f.sttModel.value.trim() || DEFAULTS.sttModel,
      chatModel: f.chatModel.value.trim() || DEFAULTS.chatModel,
      vocab: f.vocab.value.trim(),
      keepAudio: f.keepAudio.checked,
    });
    $('#settingsSaved').hidden = false;
    setTimeout(() => { location.hash = '#/'; }, 600);
  };

  $('#backupBtn').onclick = async () => {
    const data = { app: 'notes-reunion', version: 1, exportedAt: new Date().toISOString(), meetings: await store.all(), historyChat: (await store.getKV('historyChat')) || [] };
    data.meetings.forEach((m) => { m.hasAudio = false; });
    await shareOrDownload(`sauvegarde-reunions-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  };
  const ri = $('#restoreInput');
  $('#restoreBtn').onclick = () => ri.click();
  ri.onchange = async () => {
    const f = ri.files[0]; ri.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'notes-reunion' || !Array.isArray(data.meetings)) throw new Error('Fichier non reconnu.');
      let n = 0;
      for (const m of data.meetings) {
        const existing = await store.get(m.id);
        if (existing) continue;
        await store.put({ ...m, hasAudio: false, status: m.status === 'done' ? 'done' : 'error', error: m.status === 'done' ? '' : 'Audio absent de la sauvegarde.' });
        n++;
      }
      alert(`${n} réunion(s) restaurée(s).`);
    } catch (e) { alert(`Import impossible : ${e.message}`); }
  };
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    $('#storageInfo').textContent = `Espace utilisé : ${(usage / 1e6).toFixed(1)} Mo${quota ? ` sur ${(quota / 1e9).toFixed(1)} Go disponibles` : ''}. ` +
      (persisted ? 'Stockage protégé contre l\'effacement automatique.' : 'Installe l\'app sur l\'écran d\'accueil pour protéger le stockage.');
  }
}

function route() {
  const h = location.hash || '#/';
  let m;
  if ((m = /^#\/m\/(.+)$/.exec(h))) renderMeeting(decodeURIComponent(m[1]));
  else if (h === '#/ask') renderAskAll();
  else if (h === '#/settings') renderSettings();
  else renderList();
}
window.addEventListener('hashchange', route);

/* ---------------------------------------------------------------- démarrage */

(async () => {
  // Une transcription « en cours » au démarrage a été interrompue (app fermée) : on la relance.
  for (const m of await store.all()) {
    if (m.status === 'running') await update(m.id, { status: 'pending' });
  }
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  route();
  queueAll();
})();

document.addEventListener('visibilitychange', () => { if (!document.hidden && running.size) keepAwake(true); });
