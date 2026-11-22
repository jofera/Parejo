// Parejo: interfaz sin dependencias ni paso de build.
// Principio de diseño: apuntar una tarea cuesta dos toques (tarea + duración) y lo habitual va primero.

const $app = document.getElementById('app');
const $layer = document.getElementById('layer');
const $toast = document.getElementById('toast');

/* ---------- utilidades ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

// Sin zoom con pellizco (Safari ignora user-scalable=no).
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault());

const S = {
  me: Number(store.get('me')) || null,
  tab: 'home',
  users: [], tasks: [], notes: {}, active: [], settings: {}, week: null, today: [], order: null,
  skew: 0, histKind: 'week', histOpen: null, rankPeriod: 'week', renderToken: 0,
  offline: false, snapAt: null, local: null, update: false,
};
try { S.local = JSON.parse(store.get('ltimer') || 'null'); } catch { S.local = null; }
if (S.local && S.local.user !== S.me) S.local = null;

// Si el servidor no responde (sin red, fuera de casa, NAS apagado) el error lleva `offline: true`.
async function api(path, { method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  const offline = () => Object.assign(new Error('Sin conexión con el servidor.'), { offline: true });
  let res, data;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(S.me ? { 'x-user': String(S.me) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch { throw offline(); } finally { clearTimeout(timer); }
  if ([502, 503, 504].includes(res.status)) throw offline();
  if (!res.ok) throw new Error(data.error || 'Algo ha fallado. Inténtalo de nuevo.');
  return data;
}

// Lecturas de solo consulta (historial, ranking): se guarda la última respuesta buena
// para poder verlas sin conexión. Los datos dependen de quién eres, por eso la clave lleva S.me.
async function apiCached(path) {
  const key = `c${S.me}:${path}`;
  try {
    const data = await api(path);
    store.set(key, JSON.stringify({ at: Date.now(), data }));
    return data;
  } catch (e) {
    if (!e.offline) throw e;
    let hit = null;
    try { hit = JSON.parse(store.get(key) || 'null'); } catch { hit = null; }
    if (!hit) throw e;
    S.offline = true;
    S.snapAt = Math.min(S.snapAt || hit.at, hit.at);
    return hit.data;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeStr = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const parseLocal = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number); return new Date(y, m - 1, d, hh, mm).getTime(); };
const midnight = (ms = Date.now()) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const serverNow = () => Date.now() + S.skew;

function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), r = m % 60;
  return r ? `${hh} h ${r} min` : `${hh} h`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
function dayLabel(ms) {
  const diff = Math.round((midnight() - midnight(ms)) / 864e5);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'short' }).format(ms);
}
function periodLabel(kind, p, i) {
  if (kind === 'week') {
    if (i === 0) return 'Esta semana';
    if (i === 1) return 'Semana pasada';
    const f = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
    return `${f.format(p.from)} – ${f.format(p.to - 864e5)}`;
  }
  if (kind === 'month') return new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(p.from);
  return String(new Date(p.from).getFullYear());
}

const user = (id) => S.users.find((u) => u.id === id);
const other = () => S.users.find((u) => u.id !== S.me);
const task = (id) => S.tasks.find((t) => t.id === id) || { emoji: '🏠', name: 'Tarea' };
const childrenOf = (id) => S.tasks.filter((t) => t.parent_id === id);
const isGroup = (t) => childrenOf(t.id).length > 0;
const parentOf = (t) => (t.parent_id ? S.tasks.find((x) => x.id === t.parent_id) : null);
const fullName = (t) => { const p = parentOf(t); return p ? `${p.name} › ${t.name}` : t.name; };
const liveChildren = (g) => childrenOf(g.id).filter((c) => !c.archived);
// Inicio: tareas sueltas y grupos (un grupo sin subtareas visibles no se muestra).
const topTasks = () => S.tasks.filter((t) => !t.archived && !t.parent_id && (!isGroup(t) || liveChildren(t).length));
// Tareas en las que se puede apuntar: las que no son grupos.
const leafTasks = () => S.tasks.filter((t) => !t.archived && !isGroup(t) && !parentOf(t)?.archived);
const buzz = () => navigator.vibrate?.(15);

/* ---------- toast y hojas ---------- */
let toastTimer;
function toast(msg, action, ms = 6000) {
  clearTimeout(toastTimer);
  $toast.replaceChildren(
    h('div', { class: 'bubble' }, h('span', null, msg),
      action && h('button', { onclick: () => { hideToast(); action.fn(); } }, action.label)),
  );
  $toast.classList.add('show');
  toastTimer = setTimeout(hideToast, ms);
}
const hideToast = () => $toast.classList.remove('show');
const fail = (e) => toast(e.message || String(e), null, 4500);

function sheet(build) {
  hideToast();
  const close = () => $layer.replaceChildren();
  const el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }), build(close));
  $layer.replaceChildren(h('div', { class: 'backdrop', onclick: close }), el);
  return close;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $layer.replaceChildren(); });

/* ---------- sin conexión ---------- */
// Lo que se apunta sin llegar al servidor se guarda en el móvil (`outbox`) y se envía solo cuando
// vuelve la conexión: al abrir la app, al recuperar la red o en el refresco periódico. Cada envío
// lleva su `client_id` (el servidor ignora un reintento) y el instante real del toque (`at`).
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const outbox = {
  all() { try { return JSON.parse(store.get('outbox') || '[]'); } catch { return []; } },
  save(list) { if (list.length) store.set('outbox', JSON.stringify(list)); else store.del('outbox'); },
  mine() { return this.all().filter((o) => o.user === S.me); },
  add(op) { this.save([...this.all(), op]); },
  remove(id) { this.save(this.all().filter((o) => o.id !== id)); },
};

// Registros pendientes como si fueran del servidor (para verlos en «Hoy» y sumarlos al balance).
function pendingEntries() {
  return outbox.mine().map((o) => {
    if (o.kind === 'stop') return { id: `p${o.id}`, pending: true, op: o.id, user_id: o.user, task_id: o.task, start: o.start, end: o.body.at, timed: true, note: o.body.note || null };
    const b = o.body;
    let start, end;
    if (b.from && b.to) { const d = b.day || dateStr(b.at); start = parseLocal(d, b.from); end = parseLocal(d, b.to); }
    else if (b.day && b.day !== dateStr(b.at)) { start = parseLocal(b.day, '12:00'); end = start + b.minutes * 60000; }
    else { end = b.at; start = end - b.minutes * 60000; }
    return { id: `p${o.id}`, pending: true, op: o.id, user_id: o.user, task_id: b.task, start, end, timed: !!(b.from && b.to), note: b.note || null };
  });
}

function weekTotals() {
  const totals = { ...S.week.totals };
  for (const p of pendingEntries()) {
    if (p.start >= S.week.from && p.start < S.week.to) totals[p.user_id] = (totals[p.user_id] || 0) + (p.end - p.start);
  }
  return totals;
}

let flushing = false;
async function flush() {
  if (flushing || !S.me) return false;
  flushing = true;
  let sent = false;
  try {
    for (const op of outbox.mine()) {
      try {
        await api(op.kind === 'stop' ? '/api/timer/stop' : '/api/entries/quick', { method: 'POST', body: op.body });
        outbox.remove(op.id);
        sent = true;
      } catch (e) {
        if (e.offline) break;
        outbox.remove(op.id); // el servidor lo rechaza: reintentar no lo arreglaría
        if (op.kind !== 'stop') toast(`No se pudo enviar «${op.label}»: ${e.message}`, null, 9000);
      }
    }
  } finally { flushing = false; }
  return sent;
}

// Copia de la última pantalla para poder consultarla sin conexión.
function saveSnapshot() {
  S.snapAt = Date.now();
  store.set('snap', JSON.stringify({ me: S.me, at: S.snapAt, users: S.users, tasks: S.tasks, notes: S.notes, settings: S.settings, week: S.week, today: S.today, active: S.active.filter((a) => a.user_id === S.me) }));
}
function loadSnapshot() {
  try {
    const snap = JSON.parse(store.get('snap') || 'null');
    if (!snap || snap.me !== S.me) return false;
    Object.assign(S, { users: snap.users, tasks: snap.tasks, notes: snap.notes, settings: snap.settings, week: snap.week, active: snap.active, snapAt: snap.at });
    S.order = S.tasks.map((t) => t.id);
    S.today = snap.today.filter((e) => e.start >= midnight());
    if (S.week.to <= Date.now()) S.week = { ...S.week, from: S.week.to, to: S.week.to + 7 * 864e5, totals: {} }; // la semana guardada ya terminó
    return true;
  } catch { return false; }
}

/* ---------- datos ---------- */
async function refresh() {
  const from = midnight();
  const [b, week, today] = await Promise.all([
    api('/api/bootstrap'),
    api('/api/summary?period=week'),
    api(`/api/entries?from=${from}&to=${Date.now() + 36e5}`),
  ]);
  S.skew = b.now - Date.now();
  S.users = b.users;
  S.active = b.active;
  S.notes = b.notes || {};
  S.settings = b.settings;
  if (!S.order) S.order = b.tasks.map((t) => t.id); // el orden por uso solo cambia al abrir la app
  const pos = (t) => { const i = S.order.indexOf(t.id); return i < 0 ? 1e9 + t.id : i; };
  S.tasks = [...b.tasks].sort((x, y) => pos(x) - pos(y));
  S.week = week;
  S.today = today.entries;
  S.offline = false;
  saveSnapshot();
  prefetch();
}

// Con conexión, deja guardadas las vistas de consulta para poder abrirlas sin ella.
// Como mucho cada 10 minutos, y sin esperar: si algo falla, no pasa nada.
function prefetch() {
  if (Date.now() - (S.prefetchAt || 0) < 6e5) return;
  S.prefetchAt = Date.now();
  const paths = [
    '/api/history?kind=week&n=12', '/api/history?kind=month&n=12', '/api/history?kind=year&n=5',
    ...['week', 'month', 'year', 'all'].map((p) => `/api/ranking?period=${p}`),
  ];
  for (const p of paths) apiCached(p).catch(() => {});
}

// Actualiza y, si hay conexión, envía lo pendiente. Sin conexión no molesta: solo lo indica arriba.
async function sync() {
  try {
    await refresh();
    if (await flush()) await refresh();
  } catch (e) {
    if (!e.offline) throw e;
    S.offline = true;
  }
}

async function reload() {
  try { await sync(); await render(); } catch (e) { fail(e); }
}

/* ---------- componentes ---------- */
function splitBar(totals, extra = '') {
  const [a, b] = S.users;
  const ta = totals[a.id] || 0, tb = totals[b.id] || 0, tot = ta + tb;
  const pa = tot ? (ta / tot) * 100 : 50;
  return h('div', { class: `split ${tot ? '' : 'empty'} ${extra}`, role: 'img', 'aria-label': tot ? `${a.name} ${Math.round(pa)} %, ${b.name} ${100 - Math.round(pa)} %` : 'Sin datos' },
    h('div', { class: 'seg', style: `width:${pa}%;background:${a.color}` }),
    h('div', { class: 'seg', style: `width:${100 - pa}%;background:${b.color}` }),
    h('i', { class: 'mid' }));
}

function whoLine(totals) {
  const tot = S.users.reduce((s, u) => s + (totals[u.id] || 0), 0);
  const cell = (u) => h('div', null,
    h('div', { class: 'n' }, h('span', { class: 'dot', style: `background:${u.color}` }), u.id === S.me ? `${u.name} (tú)` : u.name),
    h('div', { class: 't' }, `${fmtDur(totals[u.id] || 0)}${tot ? ` · ${Math.round(((totals[u.id] || 0) / tot) * 100)} %` : ''}`));
  return h('div', { class: 'who' }, cell(S.users[0]), cell(S.users[1]));
}

function verdict(totals) {
  const mine = totals[S.me] || 0, theirs = totals[other().id] || 0, tot = mine + theirs;
  if (!tot) return 'Todavía no hay nada apuntado esta semana';
  if (Math.abs(mine - theirs) / tot <= S.settings.balanced) return 'Estáis equilibrados 👌';
  return mine > theirs ? `Vas ${fmtDur(mine - theirs)} por delante` : `${other().name} va ${fmtDur(theirs - mine)} por delante`;
}

function entryRow(e, { showUser = true } = {}) {
  const t = task(e.task_id), u = user(e.user_id), mine = e.user_id === S.me;
  const children = [
    h('span', { class: 'em' }, t.emoji),
    h('span', { class: 'main' },
      h('b', null, fullName(t)),
      h('span', null, [e.pending ? '⏳ pendiente de enviar' : '', showUser ? u.name : '', e.timed ? `${timeStr(e.start)}–${timeStr(e.end)}` : '', e.note ? `“${e.note}”` : '', e.edits ? 'editado' : ''].filter(Boolean).join(' · ') || '\u00a0')),
    h('span', { class: 'dur' }, fmtDur(e.end - e.start)),
    mine && h('span', { class: 'edit', 'aria-hidden': 'true' }, '✎'),
  ];
  if (e.pending) return h('button', { class: 'row pending', 'aria-label': `Pendiente: ${t.name}`, onclick: () => pendingSheet(e) }, children);
  return mine
    ? h('button', { class: 'row', 'aria-label': `Editar ${t.name}`, onclick: () => editSheet(e) }, children)
    : h('div', { class: 'row' }, children);
}

/* ---------- registrar ---------- */
function minLabel(m) {
  if (m < 60) return [String(m), 'min'];
  const hh = Math.floor(m / 60), r = m % 60;
  return [r ? `${hh} h ${r}` : `${hh} h`, ''];
}

const dayText = (day) => dayLabel(parseLocal(day, '12:00')).toLowerCase();

// `opts`: { note, from, to } (horas 'HH:MM'; si hay horas, `minutes` no se usa).
async function quickLog(t, minutes, day, opts = {}) {
  const body = { task: t.id, day, at: serverNow(), client_id: uid() };
  if (opts.from && opts.to) { body.from = opts.from; body.to = opts.to; } else body.minutes = minutes;
  if (opts.note) body.note = opts.note;
  return send(t, body);
}

// Envía el registro; si no hay conexión lo deja en el móvil para enviarlo después.
async function send(t, body) {
  const label = `${t.emoji} ${fullName(t)}`;
  try {
    const { entry } = await api('/api/entries/quick', { method: 'POST', body });
    const minutes = Math.round((entry.end - entry.start) / 60000);
    buzz();
    await refresh(); await render();
    const when = body.day && body.day !== dateStr(serverNow()) ? ` · ${dayText(body.day)}` : '';
    toast(`✓ ${label}${entry.note ? ` (${entry.note})` : ''} · ${fmtDur(minutes * 60000)}${when}`, {
      label: 'Deshacer',
      fn: () => api(`/api/entries/${entry.id}/undo`, { method: 'POST' }).then(reload).catch(fail),
    });
  } catch (e) {
    if (!e.offline) return fail(e);
    const op = { id: uid(), user: S.me, kind: 'quick', body, label };
    outbox.add(op);
    S.offline = true;
    buzz();
    await render();
    const pe = pendingEntries().find((x) => x.op === op.id);
    toast(`⏳ ${label} · ${fmtDur(pe.end - pe.start)}. Guardado en el móvil: se enviará al volver la conexión.`, {
      label: 'Deshacer',
      fn: () => { outbox.remove(op.id); render(); },
    }, 9000);
  }
}

async function startTimer(t, note) {
  try {
    if (S.local) await stopLocal(true);
    const r = await api('/api/timer/start', { method: 'POST', body: { task: t.id, note } });
    buzz();
    await refresh(); await render();
    toast(r.stopped?.entry ? `Cronómetro de ${t.emoji} ${t.name} en marcha. Guardé la tarea anterior.` : `Cronómetro de ${t.emoji} ${t.name} en marcha`);
  } catch (e) {
    if (e.offline) return startLocalTimer(t, note);
    fail(e);
  }
}

// Sin conexión el cronómetro corre en el móvil; al pararlo se apunta como cualquier otro registro.
function startLocalTimer(t, note) {
  S.local = { user: S.me, task: t.id, start: serverNow(), note: note || '' };
  store.set('ltimer', JSON.stringify(S.local));
  S.offline = true;
  buzz();
  render();
  toast(`Cronómetro de ${t.emoji} ${t.name} en marcha. Sin conexión: se guardará en el móvil.`, null, 7000);
}

async function stopLocal(quiet) {
  const lt = S.local;
  if (!lt) return;
  S.local = null;
  store.del('ltimer');
  const dur = serverNow() - lt.start;
  if (dur < 30_000) { if (!quiet) { toast('Cronómetro descartado (duró menos de 30 s)'); render(); } return; }
  const body = { task: lt.task, minutes: Math.min(720, Math.max(1, Math.round(dur / 60000))), day: dateStr(serverNow()), at: serverNow(), client_id: uid() };
  if (lt.note) body.note = lt.note;
  await send(task(lt.task), body);
}

async function stopTimer() {
  if (S.local) return stopLocal();
  const mine = S.active.find((a) => a.user_id === S.me);
  const at = serverNow();
  try {
    const r = await api('/api/timer/stop', { method: 'POST', body: { at } });
    buzz();
    await refresh(); await render();
    if (r.discarded) toast('Cronómetro descartado (duró menos de 30 s)');
    else toast(`✓ Guardado: ${task(r.entry.task_id).emoji} ${task(r.entry.task_id).name} · ${fmtDur(r.entry.end - r.entry.start)}`);
  } catch (e) {
    if (!e.offline || !mine) return fail(e);
    const t = task(mine.task_id);
    outbox.add({ id: uid(), user: S.me, kind: 'stop', body: { at }, task: mine.task_id, start: mine.start, label: `${t.emoji} ${fullName(t)}` });
    S.offline = true;
    await render();
    toast('⏳ Guardado en el móvil: se enviará al volver la conexión.', null, 7000);
  }
}

// Un registro pendiente aún no está en el servidor: se puede enviar ya o descartar.
function pendingSheet(e) {
  const t = task(e.task_id);
  sheet((close) => [
    h('h2', null, `${t.emoji} ${fullName(t)}`),
    h('p', { class: 'hint' }, `${fmtDur(e.end - e.start)} · todavía no se ha enviado al servidor. Se enviará solo cuando haya conexión.`),
    h('div', { class: 'stack', style: 'margin-top:14px' },
      h('button', { class: 'btn', onclick: () => { close(); reload(); } }, 'Intentar enviar ahora'),
      h('button', { class: 'btn ghost danger', onclick: () => { outbox.remove(e.op); close(); render(); } }, 'Descartar este registro')),
  ]);
}

// Hoja de una tarea: un toque en la duración la guarda. Arriba se elige el día (por defecto, hoy).
function taskSheet(t) {
  const today = dateStr(serverNow());
  const yesterday = dateStr(serverNow() - 864e5);
  let day = today;
  const base = [10, 15, 30, 45, 60, 90, 120];
  const mins = [...new Set([t.default_min, ...base])].sort((a, b) => a - b).slice(0, 8);

  sheet((close) => {
    const err = h('p', { class: 'err' });
    const dateIn = h('input', { type: 'date', value: yesterday, max: today, 'aria-label': 'Día', onchange: () => pick('otro') });
    const dateWrap = h('div', { hidden: true }, dateIn);
    const timerBtn = h('button', { class: 'btn', onclick: () => { close(); startTimer(t, note.value); } }, '▶  Empezar cronómetro');
    const chips = {};
    const pick = (mode) => {
      day = mode === 'hoy' ? today : mode === 'ayer' ? yesterday : (dateIn.value || yesterday);
      for (const [k, el] of Object.entries(chips)) el.setAttribute('aria-pressed', String(k === mode));
      dateWrap.hidden = mode !== 'otro';
      timerBtn.hidden = mode !== 'hoy'; // el cronómetro solo tiene sentido para ahora
    };
    for (const [k, label] of [['hoy', 'Hoy'], ['ayer', 'Ayer'], ['otro', 'Otro día']]) {
      chips[k] = h('button', { class: 'chip', 'aria-pressed': String(k === 'hoy'), onclick: () => pick(k) }, label);
    }

    // Comentario opcional + horas exactas, ocultos tras «Más detalles» para que lo normal siga siendo dos toques.
    const note = h('input', { type: 'text', maxlength: '200', autocomplete: 'off', placeholder: 'Comentario (opcional): p. ej. cena, lasaña…', 'aria-label': 'Comentario' });
    const suggestions = (S.notes[t.id] || []).map((n) => h('button', { class: 'chip', onclick: () => { note.value = n; } }, n));
    const from = h('input', { type: 'time', 'aria-label': 'Hora de inicio' });
    const to = h('input', { type: 'time', 'aria-label': 'Hora de fin' });
    const saveTimes = () => {
      if (!from.value || !to.value) { err.textContent = 'Indica la hora de inicio y la de fin.'; return; }
      if (to.value <= from.value) { err.textContent = 'La hora de fin debe ser posterior a la de inicio.'; return; }
      close(); quickLog(t, 0, day, { note: note.value, from: from.value, to: to.value });
    };
    const details = h('details', { class: 'more' },
      h('summary', null, 'Más detalles: comentario y horas'),
      h('div', { class: 'form', style: 'margin-top:10px' },
        h('label', null, 'Comentario', note),
        suggestions.length ? h('div', { class: 'chips' }, suggestions) : null,
        h('div', { class: 'two' }, h('label', null, 'Empecé a las', from), h('label', null, 'Terminé a las', to)),
        h('button', { class: 'btn ghost', onclick: saveTimes }, 'Guardar con estas horas')));

    const custom = h('input', {
      type: 'number', inputmode: 'numeric', min: '1', max: '720', placeholder: 'Otra duración (minutos)', 'aria-label': 'Otra duración en minutos',
      onkeydown: (ev) => { if (ev.key === 'Enter') saveCustom(); },
    });
    const saveCustom = () => {
      const m = Math.round(Number(custom.value));
      if (!(m >= 1)) { err.textContent = 'Escribe cuántos minutos has tardado.'; return; }
      close(); quickLog(t, m, day, { note: note.value });
    };

    return [
      h('h2', null, `${t.emoji} ${fullName(t)}`),
      h('div', { class: 'chips', style: 'margin-top:10px' }, chips.hoy, chips.ayer, chips.otro),
      h('div', { style: 'margin-top:10px' }, dateWrap),
      h('h3', null, '¿Cuánto has tardado?'),
      h('div', { class: 'mins' }, mins.map((m) => {
        const [big, small] = minLabel(m);
        return h('button', { class: m === t.default_min ? 'habit' : '', onclick: () => { close(); quickLog(t, m, day, { note: note.value }); } },
          big, small && ` ${small}`, m === t.default_min && h('small', null, 'habitual'));
      })),
      h('div', { class: 'two', style: 'grid-template-columns:1fr auto;margin-top:10px' },
        custom, h('button', { class: 'btn ghost', style: 'width:auto;padding:0 20px', onclick: saveCustom }, 'Guardar')),
      err,
      details,
      h('div', { class: 'stack' }, timerBtn),
    ];
  });
}

// Un grupo (p. ej. «Colada») abre la lista de sus subtareas.
function groupSheet(g) {
  sheet(() => [
    h('h2', null, `${g.emoji} ${g.name}`),
    h('p', { class: 'hint' }, '¿Qué parte has hecho?'),
    h('div', { class: 'grid', style: 'margin-top:12px' }, liveChildren(g).map((c) =>
      h('button', { class: 'tile', onclick: () => taskSheet(c) }, h('span', { class: 'em' }, c.emoji), c.name))),
  ]);
}

function taskSelect(selectedId) {
  const list = leafTasks();
  const cur = S.tasks.find((t) => t.id === selectedId);
  if (cur && !list.includes(cur)) list.push(cur); // tarea oculta o que ahora es un grupo: se conserva la actual
  return h('select', { id: 'f-task' }, list.map((t) =>
    h('option', { value: t.id, selected: t.id === selectedId }, `${t.emoji} ${fullName(t)}`)));
}

const REASONS = ['Me equivoqué de tarea', 'Duración incorrecta', 'Día incorrecto', 'Se me olvidó parar', 'Añadir comentario'];
const changeText = (key, c) => {
  if (key === 'task') return `Tarea: ${task(c.from).name} → ${task(c.to).name}`;
  if (key === 'minutes') return `Duración: ${fmtDur(c.from * 60000)} → ${fmtDur(c.to * 60000)}`;
  if (key === 'note') return `Comentario: ${c.from ? `“${c.from}”` : '(vacío)'} → ${c.to ? `“${c.to}”` : '(vacío)'}`;
  if (key === 'time') return `Horas: ${c.from || 'sin horas'} → ${c.to}`;
  if (key === 'day') return `Día: ${dayText(c.from)} → ${dayText(c.to)}`;
  if (key === 'start') return `Inicio: ${dayLabel(c.from)} ${timeStr(c.from)} → ${dayLabel(c.to)} ${timeStr(c.to)}`; // registros antiguos
  if (key === 'end') return `Fin: ${timeStr(c.from)} → ${timeStr(c.to)}`; // registros antiguos
  return 'Registro eliminado';
};

function editSheet(e) {
  sheet((close) => {
    const err = h('p', { class: 'err' });
    const curMin = Math.round((e.end - e.start) / 60000);
    const curDay = dateStr(e.start);
    const sel = taskSelect(e.task_id);
    const mins = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '720', value: curMin });
    const date = h('input', { type: 'date', value: curDay, max: dateStr(serverNow()) });
    const noteIn = h('input', { type: 'text', maxlength: '200', autocomplete: 'off', value: e.note || '', placeholder: 'Comentario (opcional)' });
    const curFrom = e.timed ? timeStr(e.start) : '';
    const curTo = e.timed ? timeStr(e.end) : '';
    const fromIn = h('input', { type: 'time', value: curFrom, 'aria-label': 'Hora de inicio' });
    const toIn = h('input', { type: 'time', value: curTo, 'aria-label': 'Hora de fin' });
    const reason = h('input', { type: 'text', placeholder: 'Motivo del cambio', maxlength: '300', autocomplete: 'off' });
    const history = h('div');
    let confirmDelete = false;
    api(`/api/entries/${e.id}/edits`).then(({ edits }) => {
      if (!edits.length) return;
      history.append(h('h3', null, 'Historial de cambios'), ...edits.map((x) => h('div', { class: 'hist-item' },
        h('div', { class: 'when' }, `${user(x.user_id).name} · ${dayLabel(x.at)} ${timeStr(x.at)}`),
        Object.entries(x.changes).map(([k, c]) => h('div', null, changeText(k, c))),
        h('div', null, h('em', null, `“${x.reason}”`)))));
    }).catch(() => {});

    const del = h('button', { class: 'btn danger', onclick: async () => {
      if (reason.value.trim().length < 3) { err.textContent = 'Indica el motivo para eliminarlo.'; reason.focus(); return; }
      if (!confirmDelete) { confirmDelete = true; del.textContent = 'Pulsa otra vez para confirmar'; return; }
      try { await api(`/api/entries/${e.id}`, { method: 'DELETE', body: { reason: reason.value } }); close(); await reload(); toast('Registro eliminado'); }
      catch (x) { err.textContent = x.message; }
    } }, 'Eliminar registro');

    return [
      h('h2', null, `${task(e.task_id).emoji} Editar registro`),
      h('p', { class: 'hint' }, 'Los cambios quedan anotados con su motivo.'),
      h('div', { class: 'form', style: 'margin-top:12px' },
        h('label', null, 'Tarea', sel),
        h('label', null, 'Comentario', noteIn),
        h('div', { class: 'two' }, h('label', null, 'Duración (minutos)', mins), h('label', null, 'Día', date)),
        h('div', { class: 'two' }, h('label', null, 'Inicio', fromIn), h('label', null, 'Fin', toIn)),
        h('p', { class: 'hint' }, 'Si indicas las horas, mandan sobre la duración.'),
        h('div', { class: 'chips' }, REASONS.map((r) => h('button', { class: 'chip', onclick: () => { reason.value = r; } }, r))),
        h('label', null, '¿Por qué lo cambias?', reason),
        err,
        h('button', { class: 'btn', onclick: async (ev) => {
          const body = { reason: reason.value };
          if (Number(sel.value) !== e.task_id) body.task = Number(sel.value);
          if (noteIn.value.trim() !== (e.note || '')) body.note = noteIn.value;
          if (fromIn.value !== curFrom || toIn.value !== curTo) {
            if (!fromIn.value || !toIn.value) { err.textContent = 'Indica la hora de inicio y la de fin, o deja las dos vacías.'; return; }
            body.from = fromIn.value; body.to = toIn.value;
          } else if (Math.round(Number(mins.value)) !== curMin) body.minutes = Number(mins.value);
          if (date.value && date.value !== curDay) body.day = date.value;
          const btn = ev.currentTarget;
          btn.disabled = true;
          try { await api(`/api/entries/${e.id}`, { method: 'PATCH', body }); close(); await reload(); toast('✓ Cambio guardado'); }
          catch (x) { err.textContent = x.message; btn.disabled = false; }
        } }, 'Guardar cambios'),
        del),
      history,
    ];
  });
}

/* ---------- vistas ---------- */
function homeView() {
  const me = user(S.me), o = other();
  const stopPending = outbox.mine().some((p) => p.kind === 'stop');
  const mine = S.local
    ? { task_id: S.local.task, start: S.local.start }
    : stopPending ? null : S.active.find((a) => a.user_id === S.me);
  const theirs = S.offline ? null : S.active.find((a) => a.user_id === o.id);
  const totals = weekTotals();

  const nodes = [
    h('div', { class: 'top' }, h('h1', null, `Hola, ${me.name}`), h('span', { class: 'sub' }, new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'short' }).format(Date.now()))),
  ];

  if (mine) {
    const t = task(mine.task_id);
    nodes.push(h('section', { class: 'card timer' },
      h('div', { class: 'lbl' }, 'En marcha'),
      h('div', { class: 'name' }, `${t.emoji} ${fullName(t)}`),
      h('div', { class: 'clock', 'data-clock': mine.start }, fmtClock(serverNow() - mine.start)),
      h('button', { class: 'btn-stop', onclick: stopTimer }, '■  Terminar')));
  }
  if (theirs) {
    const t = task(theirs.task_id);
    nodes.push(h('p', { class: 'partner' }, `${o.name} está con ${t.emoji} ${fullName(t)} (desde hace `, h('span', { 'data-since': theirs.start }, fmtDur(serverNow() - theirs.start)), ')'));
  }

  nodes.push(h('section', { class: 'card' },
    h('h2', null, 'Esta semana'),
    splitBar(totals), whoLine(totals), h('div', { class: 'verdict' }, verdict(totals))));

  nodes.push(h('section', null,
    h('h2', { class: 'card', style: 'background:none;box-shadow:none;padding:0 2px;margin-bottom:8px' }, '¿Qué has hecho?'),
    h('div', { class: 'grid' }, topTasks().map((t) =>
      isGroup(t)
        ? h('button', { class: 'tile', onclick: () => groupSheet(t) }, h('span', { class: 'em' }, t.emoji), t.name, h('small', { class: 'grp' }, `${liveChildren(t).length} partes ▸`))
        : h('button', { class: 'tile', onclick: () => taskSheet(t) }, h('span', { class: 'em' }, t.emoji), t.name)))));

  const done = [...pendingEntries().filter((p) => p.start >= midnight()), ...S.today.filter((e) => e.end)];
  nodes.push(h('section', { class: 'card' },
    h('h2', null, 'Hoy'),
    done.length ? done.map((e) => entryRow(e)) : h('p', { class: 'empty-note' }, 'Aún no hay nada apuntado hoy.')));

  return h('div', { class: 'view' }, nodes);
}

async function historyView() {
  const { periods } = await apiCached(`/api/history?kind=${S.histKind}&n=${S.histKind === 'year' ? 5 : 12}`);
  let detail = null;
  const open = periods.find((p) => p.from === S.histOpen);
  if (open) {
    try { detail = (await apiCached(`/api/entries?from=${open.from}&to=${open.to}`)).entries.filter((e) => e.end); } catch (e) {
      if (!e.offline) throw e;
      detail = []; // periodo que no se había abierto antes de perder la conexión
    }
  }

  const seg = h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'Periodo' },
    [['week', 'Semanas'], ['month', 'Meses'], ['year', 'Años']].map(([k, label]) =>
      h('button', { 'aria-pressed': String(S.histKind === k), onclick: () => { S.histKind = k; S.histOpen = null; render(); } }, label)));

  const rows = periods.map((p, i) => {
    const tot = S.users.reduce((s, u) => s + (p.totals[u.id] || 0), 0);
    const isOpen = p.from === S.histOpen;
    return h('div', null,
      h('button', { class: 'period', 'aria-expanded': String(isOpen), onclick: () => { S.histOpen = isOpen ? null : p.from; render(); } },
        h('div', { class: 'head' }, h('b', null, periodLabel(S.histKind, p, i)), h('span', null, tot ? fmtDur(tot) : 'sin datos')),
        splitBar(p.totals),
        tot ? whoLine(p.totals) : null),
      isOpen && h('div', { class: 'period-detail' }, entryGroups(detail)));
  });

  return h('div', { class: 'view' },
    h('div', { class: 'top' }, h('h1', null, 'Historial')),
    seg,
    h('section', { class: 'card' }, rows));
}

function entryGroups(entries) {
  if (!entries.length) return h('p', { class: 'empty-note' }, 'Nada apuntado en este periodo.');
  const out = [];
  let last = null;
  for (const e of entries) {
    const key = dateStr(e.start);
    if (key !== last) { out.push(h('div', { class: 'day' }, dayLabel(e.start))); last = key; }
    out.push(entryRow(e));
  }
  return out;
}

async function rankingView() {
  const r = await apiCached(`/api/ranking?period=${S.rankPeriod}`);
  const [a, b] = S.users;
  const ta = r.totals[a.id] || 0, tb = r.totals[b.id] || 0, tot = ta + tb;
  const balanced = tot > 0 && Math.abs(ta - tb) / tot <= S.settings.balanced;
  const sorted = [...S.users].sort((x, y) => (r.totals[y.id] || 0) - (r.totals[x.id] || 0));

  const seg = h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'Periodo' },
    [['week', 'Semana'], ['month', 'Mes'], ['year', 'Año'], ['all', 'Total']].map(([k, label]) =>
      h('button', { 'aria-pressed': String(S.rankPeriod === k), onclick: () => { S.rankPeriod = k; render(); } }, label)));

  const podium = tot
    ? h('div', { class: 'podium' },
        balanced && h('p', { class: 'tie' }, 'Empate técnico 🤝'),
        sorted.map((u, i) => h('div', { class: 'place', style: `--c:${u.color}` },
          h('span', { class: 'medal' }, balanced ? '🤝' : i === 0 ? '🥇' : '🥈'),
          h('div', { class: 'info' }, h('b', null, u.id === S.me ? `${u.name} (tú)` : u.name), h('span', null, fmtDur(r.totals[u.id] || 0))),
          h('span', { class: 'pct' }, `${Math.round(((r.totals[u.id] || 0) / tot) * 100)} %`))))
    : h('section', { class: 'card' }, h('p', { class: 'empty-note' }, 'Todavía no hay nada apuntado en este periodo.'));

  const w = r.weeks;
  const weeks = w.counted
    ? h('section', { class: 'card' },
        h('h2', null, `Últimas ${w.counted} semanas`),
        h('div', { class: 'stat' }, h('span', null, 'Semanas equilibradas'), h('b', null, String(w.balanced))),
        S.users.map((u) => h('div', { class: 'stat' }, h('span', null, `Semanas en cabeza de ${u.name}`), h('b', null, String(w.led[u.id] || 0)))))
    : null;

  // Se suma por grupo (p. ej. «Colada»), con el detalle de sus subtareas debajo.
  const sumOf = (totals) => Object.values(totals).reduce((s2, v) => s2 + v, 0);
  const groups = new Map();
  for (const x of r.byTask) {
    const t = task(x.task_id);
    const key = t.parent_id || x.task_id;
    if (!groups.has(key)) groups.set(key, { key, totals: {}, parts: [] });
    const g = groups.get(key);
    for (const u of S.users) g.totals[u.id] = (g.totals[u.id] || 0) + (x.totals[u.id] || 0);
    g.parts.push({ ...x, sum: sumOf(x.totals) });
  }
  const byTask = [...groups.values()].map((g) => ({ ...g, sum: sumOf(g.totals) })).sort((x, y) => y.sum - x.sum);
  const tasks = byTask.length
    ? h('section', { class: 'card' },
        h('h2', null, 'Por tarea'),
        byTask.map((g) => {
          const t = task(g.key);
          return h('div', { class: 'task-line' },
            h('div', { class: 'head' }, h('b', null, `${t.emoji} ${t.name}`), h('span', null, `${a.name} ${fmtDur(g.totals[a.id] || 0)} · ${b.name} ${fmtDur(g.totals[b.id] || 0)}`)),
            splitBar(g.totals),
            isGroup(t) && g.parts.sort((x, y) => y.sum - x.sum).map((p) =>
              h('div', { class: 'sub-line' }, h('span', null, p.task_id === g.key ? 'Otros' : task(p.task_id).name),
                h('span', null, `${a.name} ${fmtDur(p.totals[a.id] || 0)} · ${b.name} ${fmtDur(p.totals[b.id] || 0)}`))));
        }))
    : null;

  return h('div', { class: 'view' }, h('div', { class: 'top' }, h('h1', null, 'Ranking')), seg, podium, weeks, tasks);
}

/* ---------- ajustes ---------- */
function taskEditSheet(t) {
  sheet((close) => {
    const err = h('p', { class: 'err' });
    const emoji = h('input', { type: 'text', value: t?.emoji || '🏠', maxlength: '8', 'aria-label': 'Icono' });
    const name = h('input', { type: 'text', value: t?.name || '', maxlength: '40', placeholder: 'Nombre de la tarea' });
    const min = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '240', value: t?.default_min || 20 });
    const hasKids = !!t && isGroup(t);
    const parentSel = h('select', { 'aria-label': 'Dentro de', disabled: hasKids },
      h('option', { value: '' }, 'Ninguno (tarea suelta)'),
      S.tasks.filter((p) => !p.parent_id && p.id !== t?.id).map((p) =>
        h('option', { value: p.id, selected: t?.parent_id === p.id }, `${p.emoji} ${p.name}`)));
    const save = async (extra = {}) => {
      try {
        const body = { emoji: emoji.value, name: name.value, default_min: Number(min.value), ...extra };
        if (!hasKids) body.parent = parentSel.value ? Number(parentSel.value) : null;
        if (t) await api(`/api/tasks/${t.id}`, { method: 'PATCH', body }); else await api('/api/tasks', { method: 'POST', body });
        close(); await reload();
      } catch (x) { err.textContent = x.message; }
    };
    return [
      h('h2', null, t ? 'Editar tarea' : 'Nueva tarea'),
      h('div', { class: 'form', style: 'margin-top:12px' },
        h('div', { class: 'two', style: 'grid-template-columns:90px 1fr' }, h('label', null, 'Icono', emoji), h('label', null, 'Nombre', name)),
        hasKids ? null : h('label', null, 'Duración habitual (minutos)', min),
        h('label', null, 'Dentro de (opcional)', parentSel),
        h('p', { class: 'hint' }, hasKids
          ? `Es un grupo con ${childrenOf(t.id).length} subtareas. Se apunta en cada subtarea.`
          : 'Elige un grupo para hacerla subtarea (p. ej. «Tender» dentro de «Colada»). Si el grupo elegido ya tenía registros propios, se conservan, pero a partir de ahora se apunta en sus subtareas.'),
        err,
        h('button', { class: 'btn', onclick: () => save() }, 'Guardar'),
        t && h('button', { class: 'btn danger', onclick: () => save({ archived: !t.archived }) }, t.archived ? 'Volver a mostrar' : 'Ocultar tarea')),
    ];
  });
}

async function moreView() {
  const me = user(S.me);
  let ver = store.get('ver') || '';
  try { ver = (await api('/api/version')).version; store.set('ver', ver); } catch { /* sin conexión: la última conocida */ }
  const names = S.users.map((u) => h('label', null, `Nombre de la persona ${u.id === S.me ? '(tú)' : ''}`,
    h('input', { type: 'text', value: u.name, maxlength: '30', onchange: (ev) => api(`/api/users/${u.id}`, { method: 'PATCH', body: { name: ev.target.value } }).then(reload).catch(fail) })));

  const archived = S.tasks.filter((t) => t.archived);
  const taskRow = (t) => h('button', { class: `row${t.parent_id ? ' child' : ''}`, onclick: () => taskEditSheet(t) },
    h('span', { class: 'em' }, t.emoji),
    h('span', { class: 'main' }, h('b', null, t.name),
      h('span', null, isGroup(t) ? `Grupo · ${childrenOf(t.id).length} subtareas` : `${t.parent_id ? `En «${parentOf(t)?.name}» · ` : ''}Habitual: ${t.default_min} min`)),
    h('span', { class: 'edit' }, '✎'));
  // Tareas sueltas y grupos, cada grupo seguido de sus subtareas.
  const ordered = S.tasks.filter((t) => !t.archived && !t.parent_id).flatMap((t) => [t, ...childrenOf(t.id).filter((c) => !c.archived)]);

  return h('div', { class: 'view' },
    h('div', { class: 'top' }, h('h1', null, 'Más')),
    h('section', { class: 'card' }, h('h2', null, 'Tareas'),
      ordered.map(taskRow),
      h('button', { class: 'link', onclick: () => taskEditSheet(null) }, '＋ Nueva tarea'),
      archived.length > 0 && [h('h2', { style: 'margin-top:10px' }, 'Ocultas'), archived.map(taskRow)]),
    h('section', { class: 'card' }, h('h2', null, 'Personas'),
      h('div', { class: 'form' }, names,
        h('p', { class: 'hint' }, `Estás usando la app como ${me.name}.`),
        h('button', { class: 'btn ghost', onclick: () => { store.del('me'); S.me = null; S.order = null; start(); } }, 'No soy yo: cambiar de persona'),
        ver && h('p', { class: 'hint ver' }, `Versión ${ver}${S.update ? ' · hay una nueva, recarga para usarla' : ''}`))));
}

/* ---------- estructura ---------- */
const TABS = [['home', '🏠', 'Inicio'], ['history', '📅', 'Historial'], ['ranking', '🏆', 'Ranking'], ['more', '⚙️', 'Más']];

function nav() {
  return h('nav', { 'aria-label': 'Secciones' }, h('div', { class: 'inner' }, TABS.map(([k, ic, label]) =>
    h('button', { 'aria-current': S.tab === k ? 'page' : null, onclick: () => { if (S.tab !== k) { S.tab = k; scrollTo(0, 0); render(); } } },
      h('span', { class: 'ic' }, ic), label))));
}

function updateBar() {
  if (!S.update) return null;
  return h('button', { class: 'statusbar update', onclick: () => location.reload() }, h('b', null, '✨ Hay una versión nueva'),
    h('small', null, 'Toca para actualizar. Lo que tengas pendiente de enviar no se pierde.'));
}

function statusBar() {
  const n = outbox.mine().length;
  if (!S.offline && !n) return null;
  const parts = [];
  if (S.offline) parts.push(`📴 Sin conexión${S.snapAt ? ` · datos de las ${timeStr(S.snapAt)}${dateStr(S.snapAt) === dateStr(Date.now()) ? '' : ` del ${dayText(dateStr(S.snapAt))}`}` : ''}`);
  if (n) parts.push(`⏳ ${n} ${n === 1 ? 'pendiente' : 'pendientes'} de enviar`);
  return h('button', { class: 'statusbar', onclick: () => reload() }, h('b', null, parts.join(' · ')),
    h('small', null, S.offline ? 'Lo que apuntes se enviará al volver. Toca para reintentar.' : 'Toca para enviar ahora.'));
}

async function render() {
  if (!S.me) return;
  const token = ++S.renderToken;
  let view;
  try {
    view = await ({ home: homeView, history: historyView, ranking: rankingView, more: moreView }[S.tab])();
  } catch (e) {
    if (e.offline) S.offline = true;
    view = h('div', { class: 'view' }, h('div', { class: 'card' }, h('p', { class: 'err' }, e.offline ? 'Esta sección aún no se había abierto con conexión en este móvil. Ábrela una vez con conexión y después también se verá sin ella.' : e.message)));
  }
  if (token !== S.renderToken) return;
  $app.replaceChildren(...[updateBar(), statusBar(), view, nav()].filter(Boolean));
}

async function welcome() {
  let users;
  try { ({ users } = await api('/api/users')); } catch (e) {
    $app.replaceChildren(h('div', { class: 'welcome' }, h('h1', null, 'Sin conexión'),
      h('p', { class: 'hint' }, 'La primera vez hace falta conexión con el servidor para elegir quién eres.'),
      h('button', { class: 'who-btn', style: 'background:var(--accent)', onclick: () => start() }, 'Reintentar')));
    return;
  }
  $app.replaceChildren(h('div', { class: 'welcome' },
    h('h1', null, '¿Quién eres?'),
    h('p', { class: 'hint' }, 'Solo hace falta elegirlo una vez en este móvil.'),
    users.map((u) => h('button', { class: 'who-btn', style: `background:${u.color}`, onclick: () => { S.me = u.id; store.set('me', u.id); start(); } }, u.name))));
}

async function start() {
  if (!S.me) return welcome();
  // Se enseña enseguida la última copia guardada; si hay conexión, se actualiza en cuanto responda el servidor.
  if (loadSnapshot()) await render();
  try { await sync(); } catch (e) {
    if (/quién eres/i.test(e.message)) { S.me = null; store.del('me'); return welcome(); }
    $app.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'card' }, h('p', { class: 'err' }, e.message))));
    return;
  }
  if (S.offline && !S.tasks.length) {
    $app.replaceChildren(h('div', { class: 'welcome' }, h('h1', null, 'Sin conexión'),
      h('p', { class: 'hint' }, 'Aún no hay datos guardados en este móvil. Ábrela una vez con conexión.'),
      h('button', { class: 'who-btn', style: 'background:var(--accent)', onclick: () => start() }, 'Reintentar')));
    return;
  }
  await render();
}

// Relojes en vivo y refresco periódico (también al volver a la app).
setInterval(() => {
  document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = fmtClock(serverNow() - Number(el.dataset.clock)); });
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtDur(serverNow() - Number(el.dataset.since)); });
}, 1000);
const quietRefresh = () => {
  if (!S.me || $layer.firstChild || /^(INPUT|SELECT)$/.test(document.activeElement?.tagName)) return;
  reload();
};
setInterval(quietRefresh, 45_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) quietRefresh(); });
window.addEventListener('online', () => { if (S.me) reload(); });

if ('serviceWorker' in navigator) {
  // Si ya había un service worker y toma el control otro nuevo, es que hay versión nueva:
  // no se recarga sola (podrías estar rellenando algo), se avisa para que lo decida la persona.
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !S.update) { S.update = true; render(); } });
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
start();
