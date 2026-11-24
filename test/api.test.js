import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/app.js';
import { bounds, dayStr, noonOf } from '../src/time.js';
import { weeklyMessage } from '../src/stats.js';

process.env.TZ = 'Europe/Madrid';

// Miércoles 11 nov 2026, 12:00 (hora local)
let clock = new Date(2026, 10, 11, 12, 0, 0).getTime();
let server;
let base;

before(async () => {
  const db = openDb(':memory:', { users: 'Ana,Luis' });
  server = createServer({ db, publicDir: new URL('../public', import.meta.url).pathname, now: () => clock });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, user, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user': String(user) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

test('la semana empieza en lunes y los días se calculan en hora local', () => {
  const b = bounds('week', 0, clock);
  assert.equal(b.from, new Date(2026, 10, 9).getTime());
  assert.equal(b.to, new Date(2026, 10, 16).getTime());
  assert.equal(bounds('week', -1, clock).from, new Date(2026, 10, 2).getTime());
  assert.equal(bounds('month', 0, clock).from, new Date(2026, 10, 1).getTime());
  assert.equal(dayStr(clock), '2026-11-11');
  assert.equal(noonOf('2026-11-10'), new Date(2026, 10, 10, 12).getTime());
  assert.equal(noonOf('2026-02-31'), null);
  assert.equal(noonOf('ayer'), null);
});

test('arranca con dos personas y tareas de ejemplo', async () => {
  const { data } = await call('GET', '/api/bootstrap', 1);
  assert.deepEqual(data.users.map((u) => u.name), ['Ana', 'Luis']);
  assert.ok(data.tasks.length >= 8);
});

test('exige saber quién eres', async () => {
  const { status } = await call('GET', '/api/bootstrap', null);
  assert.equal(status, 400);
});

test('apuntar por duración y balance semanal', async () => {
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 60 })).status, 200);
  assert.equal((await call('POST', '/api/entries/quick', 2, { task: 1, minutes: 20 })).status, 200);
  const { data } = await call('GET', '/api/summary?period=week', 1);
  assert.equal(data.totals[1], 60 * 60000);
  assert.equal(data.totals[2], 20 * 60000);
});

test('apuntar en otro día: se coloca a mediodía de ese día', async () => {
  const { status, data } = await call('POST', '/api/entries/quick', 2, { task: 2, minutes: 30, day: '2026-11-10' });
  assert.equal(status, 200);
  assert.equal(data.entry.start, new Date(2026, 10, 10, 12).getTime());
  assert.equal(data.entry.end - data.entry.start, 30 * 60000);
  assert.equal((await call('POST', '/api/entries/quick', 2, { task: 2, minutes: 30, day: '2026-11-12' })).status, 400); // futuro
  assert.equal((await call('POST', '/api/entries/quick', 2, { task: 2, minutes: 30, day: 'ayer' })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 2, { task: 2, minutes: 30, day: '2024-01-01' })).status, 400); // muy antiguo
  assert.equal((await call('POST', '/api/entries/quick', 2, { task: 2, minutes: 15, day: '2026-11-11' })).status, 200); // hoy
});

test('cronómetro: empezar, cambiar de tarea y parar', async () => {
  clock += 60_000;
  const a = await call('POST', '/api/timer/start', 2, { task: 2 });
  assert.equal(a.status, 200);
  clock += 10 * 60_000;
  const b = await call('POST', '/api/timer/start', 2, { task: 3 });
  assert.equal(b.data.stopped.entry.end - b.data.stopped.entry.start, 10 * 60_000);
  clock += 5_000; // menos de 30 s: se descarta
  const c = await call('POST', '/api/timer/stop', 2);
  assert.equal(c.data.discarded, true);
  assert.equal((await call('POST', '/api/timer/stop', 2)).status, 400);
});

test('editar exige motivo, solo el dueño, y deja historial', async () => {
  clock += 3 * 60_000;
  const { data: created } = await call('POST', '/api/entries/quick', 1, { task: 4, minutes: 30 });
  const id = created.entry.id;
  clock += 3 * 60_000;

  const other = await call('PATCH', `/api/entries/${id}`, 2, { minutes: 45, reason: 'intento ajeno' });
  assert.equal(other.status, 403);
  assert.equal((await call('PATCH', `/api/entries/${id}`, 1, { task: 5 })).status, 400); // sin motivo
  assert.equal((await call('PATCH', `/api/entries/${id}`, 1, { reason: 'Sin cambios' })).status, 400);

  const ok = await call('PATCH', `/api/entries/${id}`, 1, { task: 5, minutes: 45, day: '2026-11-10', reason: 'Me equivoqué' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.entry.task_id, 5);
  assert.equal(ok.data.entry.end - ok.data.entry.start, 45 * 60000);
  assert.equal(dayStr(ok.data.entry.start), '2026-11-10');
  assert.equal(ok.data.entry.edits, 1);

  const { data: hist } = await call('GET', `/api/entries/${id}/edits`, 2);
  assert.equal(hist.edits.length, 1);
  assert.equal(hist.edits[0].reason, 'Me equivoqué');
  assert.deepEqual(hist.edits[0].changes.task, { from: 4, to: 5 });
  assert.deepEqual(hist.edits[0].changes.minutes, { from: 30, to: 45 });
  assert.deepEqual(hist.edits[0].changes.day, { from: '2026-11-11', to: '2026-11-10' });

  // ya no se puede deshacer (tiene historial): hay que eliminar con motivo
  assert.equal((await call('POST', `/api/entries/${id}/undo`, 1)).status, 400);
  assert.equal((await call('DELETE', `/api/entries/${id}`, 1, {})).status, 400);
  assert.equal((await call('DELETE', `/api/entries/${id}`, 1, { reason: 'Duplicado' })).status, 200);
  const { data: list } = await call('GET', `/api/entries?from=${bounds('week', 0, clock).from}`, 1);
  assert.ok(!list.entries.some((e) => e.id === id));
});

test('deshacer un registro recién creado no deja rastro', async () => {
  const { data } = await call('POST', '/api/entries/quick', 2, { task: 6, minutes: 15 });
  assert.equal((await call('POST', `/api/entries/${data.entry.id}/undo`, 2)).status, 200);
});

test('valida duraciones', async () => {
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 0 })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 'mucho' })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 13 * 60 })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 999, minutes: 10 })).status, 400);
});

test('endpoint para Home Assistant: público, solo lectura y con minutos por persona', async () => {
  const { status, data } = await call('GET', '/api/ha', null);
  assert.equal(status, 200);
  assert.deepEqual(data.week.people.map((p) => p.name), ['Ana', 'Luis']);
  assert.equal(data.week.people[0].minutes, 60);
  assert.equal(data.week.total_minutes, data.week.people[0].minutes + data.week.people[1].minutes);
  assert.equal(data.week.people[0].percent + data.week.people[1].percent, 100);
  assert.equal(data.week.diff_minutes, data.week.people[0].minutes - data.week.people[1].minutes);
  assert.equal(typeof data.week.balanced, 'boolean');
  assert.match(data.week.message, /Ana|Luis/);
  assert.ok(Array.isArray(data.tasks) && data.tasks[0].id);
  assert.ok(Array.isArray(data.active));
  assert.equal(data.today.people.length, 2);
  assert.equal((await call('POST', '/api/ha', null, {})).status, 404);
});

test('ranking e histórico', async () => {
  const { data: rank } = await call('GET', '/api/ranking?period=week', 1);
  assert.equal(rank.totals[1], 60 * 60000);
  assert.ok(rank.totals[2] > rank.totals[1]);
  assert.equal(rank.weeks.counted, 0);
  const { data: hist } = await call('GET', '/api/history?kind=week&n=4', 1);
  assert.equal(hist.periods.length, 4);
});

test('mensaje semanal', () => {
  const users = [{ id: 1, name: 'Ana' }, { id: 2, name: 'Luis' }];
  assert.match(weeklyMessage(users, { 1: 0, 2: 0 }), /ninguna tarea/);
  assert.match(weeklyMessage(users, { 1: 100 * 60000, 2: 95 * 60000 }), /equilibrado/);
  assert.match(weeklyMessage(users, { 1: 200 * 60000, 2: 100 * 60000 }), /Ana ha dedicado 1 h 40 min más/);
});

test('sin claves de push no hay rutas de avisos; ya no existe el registro con horas', async () => {
  assert.equal((await call('GET', '/api/push/key', null)).status, 404);
  assert.equal((await call('POST', '/api/entries', 1, { task: 1, start: clock - 3600_000, end: clock })).status, 404);
});

test('horas exactas y comentario opcional', async () => {
  const ok = await call('POST', '/api/entries/quick', 1, { task: 1, from: '09:00', to: '09:45', note: '  Desayuno   tostadas ' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.entry.start, new Date(2026, 10, 11, 9, 0).getTime());
  assert.equal(ok.data.entry.end, new Date(2026, 10, 11, 9, 45).getTime());
  assert.equal(ok.data.entry.note, 'Desayuno tostadas');
  assert.equal(ok.data.entry.timed, true);

  // otro día, con horas
  const prev = await call('POST', '/api/entries/quick', 1, { task: 1, day: '2026-11-10', from: '21:00', to: '21:30' });
  assert.equal(prev.status, 200);
  assert.equal(prev.data.entry.start, new Date(2026, 10, 10, 21, 0).getTime());

  // validaciones
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, from: '10:00' })).status, 400); // falta fin
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, from: '10:30', to: '10:00' })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, from: '23:00', to: '23:30' })).status, 400); // futuro
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, from: '25:00', to: '26:00' })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, day: '2026-11-10', from: '06:00', to: '19:00' })).status, 400); // más de 12 h
});

test('comentario en registro por duración y sugerencias', async () => {
  const { data } = await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 20, note: 'Cena' });
  assert.equal(data.entry.note, 'Cena');
  assert.equal(data.entry.timed, false);
  await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 20, note: 'Cena' });
  const { data: boot } = await call('GET', '/api/bootstrap', 1);
  assert.equal(boot.notes[1][0], 'Cena');
  assert.deepEqual((await call('GET', '/api/bootstrap', 2)).data.notes[1] ?? [], []); // solo las tuyas
});

test('editar horas y comentario deja historial', async () => {
  const { data: c } = await call('POST', '/api/entries/quick', 2, { task: 4, minutes: 30 });
  const id = c.entry.id;
  clock += 3 * 60_000;
  const ok = await call('PATCH', `/api/entries/${id}`, 2, { from: '10:00', to: '10:40', note: 'Baño pequeño', reason: 'Añado horas' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.entry.timed, true);
  assert.equal(ok.data.entry.end - ok.data.entry.start, 40 * 60000);
  assert.equal(ok.data.entry.note, 'Baño pequeño');
  const { data: hist } = await call('GET', `/api/entries/${id}/edits`, 1);
  assert.deepEqual(hist.edits[0].changes.time, { from: null, to: '10:00–10:40' });
  assert.deepEqual(hist.edits[0].changes.note, { from: null, to: 'Baño pequeño' });
  assert.equal((await call('PATCH', `/api/entries/${id}`, 2, { from: '10:00', reason: 'solo inicio' })).status, 400);
  assert.equal((await call('PATCH', `/api/entries/${id}`, 2, { from: '10:00', to: '10:40', note: 'Baño pequeño', reason: 'igual' })).status, 400);
  clock += 60_000; // el historial se ordena por instante: que las dos ediciones no coincidan
  const second = await call('PATCH', `/api/entries/${id}`, 2, { to: '10:50', from: '10:00', reason: 'Terminé más tarde' });
  assert.deepEqual((await call('GET', `/api/entries/${id}/edits`, 2)).data.edits[0].changes.time, { from: '10:00–10:40', to: '10:00–10:50' });
  assert.equal(second.data.entry.end - second.data.entry.start, 50 * 60000);
});

test('grupos de tareas: solo se apunta en las subtareas', async () => {
  const mk = async (body) => (await call('POST', '/api/tasks', 1, body)).data.id;
  const colada = await mk({ name: 'Colada', emoji: '🧺' });
  const poner = await mk({ name: 'Poner lavadora', default_min: 5, parent: colada });
  const tender = await mk({ name: 'Tender', default_min: 10, parent: colada });

  const { data: boot } = await call('GET', '/api/bootstrap', 1);
  assert.equal(boot.tasks.find((t) => t.id === poner).parent_id, colada);
  assert.equal(boot.tasks.find((t) => t.id === colada).parent_id, null);

  // el grupo no es apuntable; las subtareas sí
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: colada, minutes: 10 })).status, 400);
  assert.equal((await call('POST', '/api/timer/start', 1, { task: colada })).status, 400);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: poner, minutes: 5 })).status, 200);
  assert.equal((await call('POST', '/api/entries/quick', 2, { task: tender, minutes: 12 })).status, 200);

  // solo dos niveles
  assert.equal((await call('POST', '/api/tasks', 1, { name: 'Nieta', parent: poner })).status, 400);
  assert.equal((await call('PATCH', `/api/tasks/${colada}`, 1, { parent: tender })).status, 400);
  assert.equal((await call('PATCH', `/api/tasks/${tender}`, 1, { parent: tender })).status, 400);
  assert.equal((await call('PATCH', `/api/tasks/${tender}`, 1, { parent: 9999 })).status, 400);

  // sacar una subtarea del grupo y volver a meterla
  assert.equal((await call('PATCH', `/api/tasks/${tender}`, 1, { parent: null })).status, 200);
  assert.equal((await call('GET', '/api/bootstrap', 1)).data.tasks.find((t) => t.id === tender).parent_id, null);
  assert.equal((await call('PATCH', `/api/tasks/${tender}`, 1, { parent: colada })).status, 200);
  // editar el nombre sin tocar el grupo lo conserva
  await call('PATCH', `/api/tasks/${tender}`, 1, { name: 'Tender la ropa' });
  assert.equal((await call('GET', '/api/bootstrap', 1)).data.tasks.find((t) => t.id === tender).parent_id, colada);

  // Home Assistant solo ve tareas apuntables
  const { data: ha } = await call('GET', '/api/ha', null);
  assert.ok(!ha.tasks.some((t) => t.id === colada));
  assert.ok(ha.tasks.some((t) => t.id === poner));

  // al corregir un registro tampoco se puede mover a un grupo
  const { data: e } = await call('POST', '/api/entries/quick', 1, { task: poner, minutes: 5 });
  clock += 3 * 60_000;
  assert.equal((await call('PATCH', `/api/entries/${e.entry.id}`, 1, { task: colada, reason: 'prueba' })).status, 400);
});

test('migra una base de datos anterior sin grupos', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const file = `${mkdtempSync(`${tmpdir()}/parejo-`)}/old.db`;
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🏠',
            default_min INTEGER NOT NULL DEFAULT 20, archived INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
            INSERT INTO tasks (name) VALUES ('Antigua');`);
  old.close();
  const db = openDb(file, { users: 'A,B' });
  assert.ok(db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'parent_id'));
  assert.equal(db.prepare('SELECT name FROM tasks WHERE id = 1').get().name, 'Antigua');
  db.close();
});

test('apuntar con retraso (`at`) y reintentos sin duplicar (`client_id`)', async () => {
  const at = clock - 90 * 60_000; // el toque fue hace hora y media
  const body = { task: 1, minutes: 30, at, client_id: 'abc12345-aaaa', note: 'Paseo largo' };
  const a = await call('POST', '/api/entries/quick', 1, body);
  assert.equal(a.status, 200);
  assert.equal(a.data.entry.end, at);
  assert.equal(a.data.entry.start, at - 30 * 60_000);
  assert.ok(!a.data.duplicate);

  const b = await call('POST', '/api/entries/quick', 1, body); // el móvil reenvía
  assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(b.data.entry.id, a.data.entry.id);

  // otra persona puede usar el mismo identificador; un identificador raro se rechaza
  assert.equal((await call('POST', '/api/entries/quick', 2, body)).data.duplicate, undefined);
  assert.equal((await call('POST', '/api/entries/quick', 1, { ...body, client_id: 'x' })).status, 400);
  // `at` en el futuro se recorta a ahora; no es una forma de apuntar en el futuro
  const f = await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 10, at: clock + 5 * 3600_000 });
  assert.equal(f.data.entry.end, clock);
  assert.equal((await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 10, at: 'ayer' })).status, 400);
});

test('parar el cronómetro con retraso (`at`)', async () => {
  clock += 60_000;
  assert.equal((await call('POST', '/api/timer/start', 1, { task: 2 })).status, 200);
  const stopAt = clock + 25 * 60_000;
  clock += 40 * 60_000; // el móvil sincroniza mucho después de haber pulsado «Terminar»
  const r = await call('POST', '/api/timer/stop', 1, { at: stopAt, note: 'Sin conexión' });
  assert.equal(r.status, 200);
  assert.equal(r.data.entry.end - r.data.entry.start, 25 * 60_000);
  assert.equal(r.data.entry.note, 'Sin conexión');
});

test('bloquea rutas fuera de public', async () => {
  const res = await fetch(base + '/%2e%2e/package.json');
  assert.ok([403, 404].includes(res.status));
});

test('la versión se publica y el service worker lleva esa versión', async () => {
  const v = await call('GET', '/api/version');
  assert.equal(v.status, 200);
  assert.match(v.data.version, /^\d+\.\d+\.\d+-[0-9a-f]{8}$/);
  const sw = await (await fetch(`${base}/sw.js`)).text();
  assert.ok(sw.includes(`parejo-${v.data.version}`));
  assert.ok(!sw.includes('__VERSION__'));
});
