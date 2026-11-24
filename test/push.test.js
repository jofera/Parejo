import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createHmac, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/app.js';
import { createPush, encrypt, loadVapidKeys, vapidAuth } from '../src/push.js';

process.env.TZ = 'Europe/Madrid';
const unb64 = (s) => Buffer.from(s, 'base64url');
const hmac = (key, ...data) => { const h = createHmac('sha256', key); for (const d of data) h.update(d); return h.digest(); };

// Lo que hace el navegador al recibir el aviso (RFC 8291), para comprobar el cifrado de punta a punta.
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const prkKey = hmac(auth, ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2); // delimitador del último (y único) bloque
  return plain.subarray(0, -1).toString();
}

function fakeBrowser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return { private: ecdh.getPrivateKey(), keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, auth };
}

test('cifrado aes128gcm: coincide con el ejemplo de la RFC 8291', () => {
  const out = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, {
    asKeys: { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' },
    salt: unb64('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  assert.equal(out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('claves VAPID: se crean una vez, se guardan y firman un JWT válido', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parejo-'));
  const keys = loadVapidKeys(dir);
  assert.deepEqual(loadVapidKeys(dir), keys);
  assert.equal(statSync(path.join(dir, 'vapid.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'vapid.json'), 'utf8')).publicKey, keys.publicKey);

  const header = vapidAuth('https://web.push.apple.com/abc', keys, 'mailto:a@example.com', 1_000_000);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(unb64(c)), { aud: 'https://web.push.apple.com', exp: 1000 + 12 * 3600, sub: 'mailto:a@example.com' });
  const pub = unb64(keys.publicKey);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, unb64(s)));
});

test('al apuntar se avisa solo a la otra persona, salvo si se deshace', async () => {
  let clock = new Date(2026, 10, 11, 12, 0, 0).getTime();
  const db = openDb(':memory:', { users: 'Ana,Luis' });
  const sent = [];
  const send = async (endpoint, opts) => { sent.push({ endpoint, opts }); return new Response(null, { status: endpoint.endsWith('/gone') ? 410 : 201 }); };
  const push = createPush({ db, keys: loadVapidKeys(mkdtempSync(path.join(tmpdir(), 'parejo-'))), delayMs: 30, send, log: { error() {} } });
  const server = createServer({ db, publicDir: new URL('../public', import.meta.url).pathname, now: () => clock, push });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, user, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user': String(user) }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const wait = () => new Promise((r) => setTimeout(r, 80));

  try {
    assert.equal((await call('GET', '/api/push/key', 1)).data.key, push.publicKey);
    const luis = fakeBrowser();
    const ana = fakeBrowser();
    assert.equal((await call('POST', '/api/push/subscribe', 2, { subscription: { endpoint: 'https://push.example.com/luis', keys: luis.keys } })).status, 200);
    assert.equal((await call('POST', '/api/push/subscribe', 1, { subscription: { endpoint: 'https://push.example.com/ana', keys: ana.keys } })).status, 200);
    assert.equal((await call('POST', '/api/push/subscribe', 1, { subscription: { endpoint: 'http://192.168.1.1/x', keys: ana.keys } })).status, 400);
    assert.equal((await call('POST', '/api/push/subscribe', 1, { subscription: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);

    // Ana apunta una subtarea: solo le llega a Luis, con el grupo, la duración y el comentario.
    const sub = db.prepare('SELECT id FROM tasks WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1').get().id;
    await call('POST', '/api/entries/quick', 1, { task: sub, minutes: 75, note: 'con prisa' });
    await wait();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, 'https://push.example.com/luis');
    assert.equal(sent[0].opts.headers['content-encoding'], 'aes128gcm');
    assert.match(sent[0].opts.headers.authorization, /^vapid t=.+, k=/);
    const msg = JSON.parse(decrypt(sent[0].opts.body, luis.private, luis.auth));
    assert.equal(msg.title, 'Ana apuntó una tarea');
    assert.match(msg.body, /^📥 Lavavajillas › Poner el lavavajillas · 1 h 15 min\ncon prisa$/);

    // Si lo deshace enseguida, no sale ningún aviso.
    sent.length = 0;
    const { data } = await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 10 });
    await call('POST', `/api/entries/${data.entry.id}/undo`, 1);
    await wait();
    assert.equal(sent.length, 0);

    // Cronómetro: al pararlo avisa a Ana; el arranque no avisa.
    await call('POST', '/api/timer/start', 2, { task: 1 });
    await wait();
    assert.equal(sent.length, 0);
    clock += 20 * 60_000;
    await call('POST', '/api/timer/stop', 2, {});
    await wait();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, 'https://push.example.com/ana');
    assert.match(JSON.parse(decrypt(sent[0].opts.body, ana.private, ana.auth)).body, /Cocinar · 20 min/);

    // Un móvil que ya no acepta avisos (410) se olvida.
    sent.length = 0;
    await call('POST', '/api/push/subscribe', 2, { subscription: { endpoint: 'https://push.example.com/gone', keys: luis.keys } });
    await call('POST', '/api/entries/quick', 1, { task: 1, minutes: 5 });
    await wait();
    assert.equal(sent.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = 2').get().n, 1);

    await call('POST', '/api/push/unsubscribe', 2, { endpoint: 'https://push.example.com/luis' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = 2').get().n, 0);
  } finally {
    server.close();
  }
});
