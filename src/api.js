import { bounds, dayStr, noonOf } from './time.js';
import { BALANCED, isBalanced, weeklyMessage } from './stats.js';

const MIN = 60_000;
const MAX_MINUTES = 12 * 60;
const MAX_AGE_MS = 400 * 24 * 60 * MIN;
const KINDS = ['week', 'month', 'year', 'all'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m) => new HttpError(403, m);
const notFound = (m) => new HttpError(404, m);

// Devuelve un manejador async (req, url, body) -> objeto JSON, o undefined si la ruta no existe.
//
// Modelo: cada registro guarda inicio y fin. Solo son horas reales (`timed`) si salen del
// cronómetro o si la persona las ha escrito; en el registro por duración, los registros "de otro
// día" se colocan a mediodía de ese día y los de hoy terminan en el instante en que se guardan.
// Cada registro puede llevar un comentario opcional (`note`).
export function createApi({ db, now = () => Date.now() }) {
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  const ENTRY_SQL = `SELECT e.*, (SELECT COUNT(*) FROM entry_edits x WHERE x.entry_id = e.id) AS edits FROM entries e`;
  const entryOut = (e) => ({
    id: e.id,
    user_id: e.user_id,
    task_id: e.task_id,
    start: e.start_ts,
    end: e.end_ts,
    note: e.note,
    timed: e.source === 'timer' || e.source === 'times',
    source: e.source,
    edits: e.edits ?? 0,
  });

  const users = () => all('SELECT * FROM users ORDER BY id');
  function me(req) {
    const id = Number(req.headers['x-user']);
    const u = get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw bad('No sé quién eres: elige tu nombre en la aplicación.');
    return u;
  }
  const taskById = (id) => {
    const t = get('SELECT * FROM tasks WHERE id = ?', Number(id));
    if (!t) throw bad('Tarea desconocida');
    return t;
  };
  // Solo se puede apuntar en tareas "hoja": las que tienen subtareas son grupos.
  const leafById = (id) => {
    const t = taskById(id);
    if (get('SELECT 1 AS x FROM tasks WHERE parent_id = ?', t.id)) throw bad(`«${t.name}» tiene subtareas: elige una de ellas.`);
    return t;
  };
  const minutesOf = (v) => {
    const m = Math.round(Number(v));
    if (!Number.isFinite(m) || m < 1) throw bad('La duración debe ser de al menos 1 minuto.');
    if (m > MAX_MINUTES) throw bad('Una tarea no puede durar más de 12 horas.');
    return m;
  };
  const hm = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // Hora local 'HH:MM' de un día 'AAAA-MM-DD' -> milisegundos.
  function atTime(day, hhmm) {
    const noon = noonOf(day);
    if (noon == null) throw bad('Día no válido');
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ''));
    if (!m) throw bad('Hora no válida (usa HH:MM).');
    const d = new Date(noon);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  }
  const noteOf = (v) => {
    const n = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    return n || null;
  };
  function checkRange(start, end) {
    if (end <= start) throw bad('La hora de fin debe ser posterior a la de inicio.');
    if (end - start > MAX_MINUTES * MIN) throw bad('Una tarea no puede durar más de 12 horas.');
    if (end > now() + 5 * MIN) throw bad('No se puede apuntar en el futuro.');
    if (now() - start > MAX_AGE_MS) throw bad('Ese día es demasiado antiguo.');
  }
  const activeOf = (userId) => get(`${ENTRY_SQL} WHERE user_id = ? AND end_ts IS NULL AND deleted = 0`, userId);

  function totalsBetween(from, to) {
    const t = now();
    const rows = all(
      `SELECT user_id, SUM(COALESCE(end_ts, ?) - start_ts) AS ms
         FROM entries WHERE deleted = 0 AND start_ts >= ? AND start_ts < ? GROUP BY user_id`,
      t, from, to,
    );
    const out = {};
    for (const u of users()) out[u.id] = 0;
    for (const r of rows) out[r.user_id] = r.ms;
    return out;
  }
  function byTask(from, to) {
    const t = now();
    const rows = all(
      `SELECT task_id, user_id, SUM(COALESCE(end_ts, ?) - start_ts) AS ms
         FROM entries WHERE deleted = 0 AND start_ts >= ? AND start_ts < ? GROUP BY task_id, user_id`,
      t, from, to,
    );
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.task_id)) map.set(r.task_id, { task_id: r.task_id, totals: {} });
      map.get(r.task_id).totals[r.user_id] = r.ms;
    }
    return [...map.values()];
  }
  function period(query) {
    const kind = query.get('period') || 'week';
    if (!KINDS.includes(kind)) throw bad('Periodo no válido');
    return { kind, ...bounds(kind, Number(query.get('offset')) || 0, now()) };
  }

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

  // ---- Datos generales -------------------------------------------------------------------
  // Pública: la pantalla "¿Quién eres?" la necesita antes de saber quién eres.
  route('GET', '/api/users', () => ({ users: users() }));

  route('GET', '/api/bootstrap', (req) => {
    const u = me(req);
    const since = now() - 60 * 24 * 60 * MIN;
    const rows = all(
      `SELECT t.*, (SELECT COUNT(*) FROM entries e WHERE e.task_id = t.id AND e.user_id = ? AND e.deleted = 0 AND e.start_ts > ?) AS uses
         FROM tasks t`,
      u.id, since,
    );
    // Un grupo cuenta los usos de sus subtareas para ordenarse junto a las demás tareas.
    const uses = new Map(rows.map((t) => [t.id, t.uses]));
    for (const t of rows) if (t.parent_id) uses.set(t.parent_id, (uses.get(t.parent_id) || 0) + t.uses);
    const tasks = rows
      .sort((x, y) => uses.get(y.id) - uses.get(x.id) || x.sort - y.sort || x.id - y.id)
      .map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, default_min: t.default_min, archived: !!t.archived, parent_id: t.parent_id }));
    // Comentarios más usados por esta persona en cada tarea (para sugerirlos con un toque).
    const notes = {};
    for (const r of all(
      `SELECT task_id, note, COUNT(*) AS c FROM entries
        WHERE user_id = ? AND deleted = 0 AND note IS NOT NULL AND note <> '' AND start_ts > ?
        GROUP BY task_id, note ORDER BY c DESC, MAX(start_ts) DESC`,
      u.id, since,
    )) {
      const list = (notes[r.task_id] ??= []);
      if (list.length < 6) list.push(r.note);
    }
    return {
      now: now(),
      users: users(),
      tasks,
      notes,
      active: all(`${ENTRY_SQL} WHERE end_ts IS NULL AND deleted = 0`).map(entryOut),
      settings: { balanced: BALANCED },
    };
  });

  // Pública y de solo lectura, pensada para Home Assistant (sensores REST).
  route('GET', '/api/ha', () => {
    const us = users();
    const t = now();
    const pack = (kind) => {
      const b = bounds(kind, 0, t);
      const totals = totalsBetween(b.from, b.to);
      const total = us.reduce((s, u) => s + totals[u.id], 0);
      const people = us.map((u) => {
        const minutes = Math.round(totals[u.id] / MIN);
        return { id: u.id, name: u.name, minutes, percent: total ? Math.round((totals[u.id] / total) * 100) : 0 };
      });
      const [a, b2] = us;
      const balanced = isBalanced(totals[a.id], totals[b2.id]);
      return {
        total_minutes: Math.round(total / MIN),
        people,
        diff_minutes: people[0].minutes - people[1].minutes, // positivo: la primera persona va por delante
        balanced,
        leader: !total || balanced ? null : totals[a.id] > totals[b2.id] ? a.name : b2.name,
        message: weeklyMessage(us, totals),
      };
    };
    const active = all(`${ENTRY_SQL} WHERE end_ts IS NULL AND deleted = 0`).map((e) => ({
      user_id: e.user_id,
      user: us.find((u) => u.id === e.user_id)?.name,
      task: get('SELECT name FROM tasks WHERE id = ?', e.task_id)?.name,
      minutes: Math.round((t - e.start_ts) / MIN),
    }));
    return {
      generated_at: t,
      week: pack('week'),
      month: pack('month'),
      today: (() => {
        const b = bounds('day', 0, t);
        const totals = totalsBetween(b.from, b.to);
        return { people: us.map((u) => ({ id: u.id, name: u.name, minutes: Math.round(totals[u.id] / MIN) })) };
      })(),
      active,
      tasks: all(`SELECT id, name, emoji, default_min, parent_id FROM tasks t WHERE archived = 0
                    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id) ORDER BY sort, id`),
    };
  });

  route('GET', '/api/summary', (req, q) => {
    me(req);
    const p = period(q);
    return { ...p, totals: totalsBetween(p.from, p.to), byTask: byTask(p.from, p.to) };
  });

  route('GET', '/api/history', (req, q) => {
    me(req);
    const kind = q.get('kind') || 'week';
    if (!['week', 'month', 'year'].includes(kind)) throw bad('Periodo no válido');
    const n = Math.min(Math.max(Number(q.get('n')) || 12, 1), 60);
    const periods = [];
    for (let i = 0; i < n; i++) {
      const b = bounds(kind, -i, now());
      periods.push({ ...b, totals: totalsBetween(b.from, b.to) });
    }
    return { kind, periods };
  });

  route('GET', '/api/ranking', (req, q) => {
    me(req);
    const p = period(q);
    const [a, b] = users();
    const led = { [a.id]: 0, [b.id]: 0 };
    let balanced = 0;
    let counted = 0;
    for (let i = 1; i <= 12; i++) {
      const w = bounds('week', -i, now());
      const t = totalsBetween(w.from, w.to);
      if (t[a.id] + t[b.id] === 0) continue;
      counted++;
      if (isBalanced(t[a.id], t[b.id])) balanced++;
      else led[t[a.id] > t[b.id] ? a.id : b.id]++;
    }
    return {
      ...p,
      totals: totalsBetween(p.from, p.to),
      byTask: byTask(p.from, p.to),
      weeks: { counted, balanced, led },
    };
  });

  route('GET', '/api/entries', (req, q) => {
    me(req);
    const from = Number(q.get('from')) || 0;
    const to = Number(q.get('to')) || now() + MIN;
    const rows = all(`${ENTRY_SQL} WHERE deleted = 0 AND start_ts >= ? AND start_ts < ? ORDER BY start_ts DESC LIMIT 500`, from, to);
    return { entries: rows.map(entryOut) };
  });

  route('GET', '/api/entries/(\\d+)/edits', (req, _q, _b, m) => {
    me(req);
    const rows = all('SELECT * FROM entry_edits WHERE entry_id = ? ORDER BY at DESC', Number(m[1]));
    return { edits: rows.map((r) => ({ id: r.id, user_id: r.user_id, at: r.at, reason: r.reason, changes: JSON.parse(r.changes) })) };
  });

  // ---- Registro de tiempo --------------------------------------------------------------------
  function stopActive(userId, note) {
    const a = activeOf(userId);
    if (!a) return null;
    const t = now();
    if (t - a.start_ts < 30_000) {
      run('DELETE FROM entries WHERE id = ?', a.id); // arranque accidental: no se guarda
      return { discarded: true };
    }
    if (note !== undefined && noteOf(note)) run('UPDATE entries SET end_ts = ?, note = ? WHERE id = ?', t, noteOf(note), a.id);
    else run('UPDATE entries SET end_ts = ? WHERE id = ?', t, a.id);
    return { entry: entryOut(get(`${ENTRY_SQL} WHERE id = ?`, a.id)) };
  }

  route('POST', '/api/timer/start', (req, _q, body) => {
    const u = me(req);
    const task = leafById(body.task);
    const stopped = stopActive(u.id);
    const t = now();
    const r = run(
      `INSERT INTO entries (user_id, task_id, start_ts, note, source, created_at) VALUES (?, ?, ?, ?, 'timer', ?)`,
      u.id, task.id, t, noteOf(body.note), t,
    );
    return { entry: entryOut(get(`${ENTRY_SQL} WHERE id = ?`, r.lastInsertRowid)), stopped };
  });

  route('POST', '/api/timer/stop', (req, _q, body) => {
    const u = me(req);
    const res = stopActive(u.id, body?.note);
    if (!res) throw bad('No tienes ningún cronómetro en marcha.');
    return res;
  });

  // Apunta una tarea. Dos formas:
  //  - por duración: `minutes` (y `day` opcional: sin él, o con el de hoy, termina ahora; con otro
  //    día se coloca a mediodía de ese día);
  //  - con horas: `from` y `to` ('HH:MM') en el día `day` (hoy por defecto).
  // `note` es un comentario opcional.
  route('POST', '/api/entries/quick', (req, _q, body) => {
    const u = me(req);
    const task = leafById(body.task);
    const note = noteOf(body.note);
    const t = now();
    let start;
    let end;
    let source = 'quick';
    if (body.from || body.to) {
      if (!body.from || !body.to) throw bad('Indica la hora de inicio y la de fin.');
      const day = body.day || dayStr(t);
      start = atTime(day, body.from);
      end = atTime(day, body.to);
      source = 'times';
    } else {
      const minutes = minutesOf(body.minutes);
      if (body.day && body.day !== dayStr(t)) {
        const noon = noonOf(body.day);
        if (noon == null) throw bad('Día no válido');
        if (noon > t) throw bad('No se puede apuntar en el futuro.');
        start = noon;
        end = noon + minutes * MIN;
      } else {
        end = t;
        start = end - minutes * MIN;
      }
    }
    checkRange(start, end);
    const r = run(
      `INSERT INTO entries (user_id, task_id, start_ts, end_ts, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      u.id, task.id, start, end, note, source, t,
    );
    return { entry: entryOut(get(`${ENTRY_SQL} WHERE id = ?`, r.lastInsertRowid)) };
  });

  function ownEntry(u, id) {
    const e = get(`${ENTRY_SQL} WHERE id = ? AND deleted = 0`, Number(id));
    if (!e) throw notFound('Registro no encontrado');
    if (e.user_id !== u.id) throw forbidden('Solo puedes modificar tus propios registros.');
    return e;
  }
  function reasonOf(body) {
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 3) throw bad('Indica el motivo del cambio.');
    return reason.slice(0, 300);
  }

  // Deshacer un registro recién creado (primeros 2 minutos): se borra sin dejar rastro.
  route('POST', '/api/entries/(\\d+)/undo', (req, _q, _b, m) => {
    const u = me(req);
    const e = ownEntry(u, m[1]);
    if (now() - e.created_at > 2 * MIN || e.edits) throw bad('Ya no se puede deshacer; elimínalo indicando el motivo.');
    run('DELETE FROM entries WHERE id = ?', e.id);
    return { ok: true };
  });

  // Corregir un registro: tarea, comentario (note), duración (minutes), día (day) y/o horas
  // (from y to, 'HH:MM'). El motivo es obligatorio.
  route('PATCH', '/api/entries/(\\d+)', (req, _q, body, m) => {
    const u = me(req);
    const e = ownEntry(u, m[1]);
    if (e.end_ts == null) throw bad('Para el cronómetro antes de editar este registro.');
    const reason = reasonOf(body);

    const curMin = Math.round((e.end_ts - e.start_ts) / MIN);
    const curDay = dayStr(e.start_ts);
    const wasTimed = e.source === 'timer' || e.source === 'times';
    const changes = {};
    let taskId = e.task_id;
    let note = e.note;
    let source = e.source;
    let start = e.start_ts;
    let duration = e.end_ts - e.start_ts;

    if (body.task !== undefined && Number(body.task) !== e.task_id) {
      taskId = leafById(body.task).id;
      changes.task = { from: e.task_id, to: taskId };
    }
    if (body.note !== undefined) {
      const n = noteOf(body.note);
      if (n !== (e.note || null)) {
        note = n;
        changes.note = { from: e.note || null, to: n };
      }
    }

    if (body.from !== undefined || body.to !== undefined) {
      // Con horas: mandan sobre la duración.
      if (!body.from || !body.to) throw bad('Indica la hora de inicio y la de fin.');
      const day = body.day || curDay;
      const s = atTime(day, body.from);
      const en = atTime(day, body.to);
      if (en <= s) throw bad('La hora de fin debe ser posterior a la de inicio.');
      const before = wasTimed ? `${hm(e.start_ts)}–${hm(e.end_ts)}` : null;
      const after = `${body.from}–${body.to}`;
      if (before !== after) changes.time = { from: before, to: after };
      if (day !== curDay) changes.day = { from: curDay, to: day };
      start = s;
      duration = en - s;
      source = 'times';
    } else {
      if (body.minutes !== undefined) {
        const newMin = minutesOf(body.minutes);
        if (newMin !== curMin) {
          duration = newMin * MIN;
          changes.minutes = { from: curMin, to: newMin };
        }
      }
      if (body.day !== undefined && body.day !== curDay) {
        const noon = noonOf(body.day);
        if (noon == null) throw bad('Día no válido');
        const d = new Date(e.start_ts); // se conserva la hora del registro, solo cambia el día
        const nd = new Date(noon);
        d.setFullYear(nd.getFullYear(), nd.getMonth(), nd.getDate());
        start = d.getTime();
        changes.day = { from: curDay, to: body.day };
      }
    }
    if (!Object.keys(changes).length) throw bad('No has cambiado nada.');

    const end = start + duration;
    checkRange(start, end);
    run('UPDATE entries SET task_id = ?, note = ?, source = ?, start_ts = ?, end_ts = ? WHERE id = ?', taskId, note, source, start, end, e.id);
    run('INSERT INTO entry_edits (entry_id, user_id, at, changes, reason) VALUES (?, ?, ?, ?, ?)', e.id, u.id, now(), JSON.stringify(changes), reason);
    return { entry: entryOut(get(`${ENTRY_SQL} WHERE id = ?`, e.id)) };
  });

  route('DELETE', '/api/entries/(\\d+)', (req, _q, body, m) => {
    const u = me(req);
    const e = ownEntry(u, m[1]);
    const reason = reasonOf(body);
    run('UPDATE entries SET deleted = 1 WHERE id = ?', e.id);
    run(
      'INSERT INTO entry_edits (entry_id, user_id, at, changes, reason) VALUES (?, ?, ?, ?, ?)',
      e.id, u.id, now(), JSON.stringify({ deleted: { from: false, to: true } }), reason,
    );
    return { ok: true };
  });

  // ---- Tareas y personas ----------------------------------------------------------------------
  const taskFields = (body, current = {}) => {
    const name = String(body.name ?? current.name ?? '').trim().slice(0, 40);
    if (!name) throw bad('La tarea necesita un nombre.');
    const emoji = String(body.emoji ?? current.emoji ?? '🏠').trim().slice(0, 8) || '🏠';
    const default_min = Math.min(Math.max(Math.round(Number(body.default_min ?? current.default_min ?? 20)) || 20, 1), 240);
    return { name, emoji, default_min };
  };
  // Grupo al que pertenece la tarea (`parent`): solo hay dos niveles (grupo > subtarea).
  function parentOf(body, current) {
    if (body.parent === undefined) return current ? current.parent_id : null;
    if (!body.parent) return null;
    const p = taskById(body.parent);
    if (p.parent_id) throw bad('Una subtarea no puede ser a la vez un grupo.');
    if (current) {
      if (p.id === current.id) throw bad('Una tarea no puede estar dentro de sí misma.');
      if (get('SELECT 1 AS x FROM tasks WHERE parent_id = ?', current.id)) throw bad('Esta tarea es un grupo con subtareas: no puede estar dentro de otro.');
    }
    return p.id;
  }

  route('POST', '/api/tasks', (req, _q, body) => {
    me(req);
    const f = taskFields(body);
    const parent = parentOf(body, null);
    const sort = (get('SELECT MAX(sort) AS m FROM tasks').m ?? 0) + 1;
    const r = run('INSERT INTO tasks (name, emoji, default_min, sort, parent_id) VALUES (?, ?, ?, ?, ?)', f.name, f.emoji, f.default_min, sort, parent);
    return { id: Number(r.lastInsertRowid) };
  });

  route('PATCH', '/api/tasks/(\\d+)', (req, _q, body, m) => {
    me(req);
    const t = taskById(m[1]);
    const f = taskFields(body, t);
    const parent = parentOf(body, t);
    const archived = body.archived === undefined ? t.archived : body.archived ? 1 : 0;
    run('UPDATE tasks SET name = ?, emoji = ?, default_min = ?, archived = ?, parent_id = ? WHERE id = ?', f.name, f.emoji, f.default_min, archived, parent, t.id);
    return { ok: true };
  });

  route('PATCH', '/api/users/(\\d+)', (req, _q, body, m) => {
    me(req);
    const name = String(body.name ?? '').trim().slice(0, 30);
    if (!name) throw bad('El nombre no puede estar vacío.');
    if (!get('SELECT id FROM users WHERE id = ?', Number(m[1]))) throw notFound('Persona no encontrada');
    run('UPDATE users SET name = ? WHERE id = ?', name, Number(m[1]));
    return { ok: true };
  });

  return async function handle(req, url, body) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) return r.fn(req, url.searchParams, body, m);
    }
    return undefined;
  };
}

export { HttpError };
