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

test('ya no existen las notificaciones push ni el registro con horas', async () => {
  assert.equal((await call('GET', '/api/push/key', null)).status, 404);
  assert.equal((await call('POST', '/api/entries', 1, { task: 1, start: clock - 3600_000, end: clock })).status, 404);
});

test('bloquea rutas fuera de public', async () => {
  const res = await fetch(base + '/%2e%2e/package.json');
  assert.ok([403, 404].includes(res.status));
});
