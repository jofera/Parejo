// Notificaciones push (Web Push) sin dependencias: firma VAPID (RFC 8292) y cifrado aes128gcm
// (RFC 8291) con node:crypto. El servidor no habla con el móvil: entrega el aviso cifrado al
// servicio de push del navegador (Apple, Google, Mozilla), que lo hace llegar aunque el móvil
// esté fuera de casa. Solo hace falta que el servidor tenga salida a internet.
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, ...data) => { const h = createHmac('sha256', key); for (const d of data) h.update(d); return h.digest(); };

// Claves del servidor (VAPID): se generan una vez y se guardan junto a la base de datos.
// Si se pierden, los móviles tienen que volver a activar los avisos.
export function loadVapidKeys(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try {
    const k = JSON.parse(readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return k;
  } catch { /* no existen todavía */ }
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const k = { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}

// Cifra el mensaje para una suscripción (RFC 8291). `asKeys` y `salt` solo se pasan en los tests.
export function encrypt(payload, { p256dh, auth }, { asKeys, salt = randomBytes(16) } = {}) {
  const uaPublic = unb64(p256dh);
  const ecdh = createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(unb64(asKeys.privateKey)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(unb64(auth), shared);
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Cabecera Authorization con un JWT ES256 para el origen del servicio de push (RFC 8292).
export function vapidAuth(endpoint, keys, subject, nowMs = Date.now()) {
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)), d: keys.privateKey },
  });
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(sig)}, k=${keys.publicKey}`;
}

const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

// Avisa a la otra persona cuando alguien apunta una tarea. El aviso sale unos segundos después
// (`delayMs`) y solo si el registro sigue ahí: así no se avisa de algo que se ha deshecho al momento.
export function createPush({ db, keys, subject = 'mailto:parejo@example.com', delayMs = 10_000, send = fetch, log = console }) {
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  async function deliver(sub, payload) {
    const res = await send(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuth(sub.endpoint, keys, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(24 * 3600),
        urgency: 'normal',
      },
      body: encrypt(JSON.stringify(payload), sub),
    });
    // 404/410: el móvil ya no acepta avisos (app borrada, permiso retirado): se olvida la suscripción.
    if (res.status === 404 || res.status === 410) run('DELETE FROM push_subs WHERE endpoint = ?', sub.endpoint);
    else if (!res.ok) log.error(`Aviso push rechazado (${res.status}): ${await res.text().catch(() => '')}`.slice(0, 300));
    return res.status;
  }

  function message(entryId) {
    const e = get('SELECT * FROM entries WHERE id = ? AND deleted = 0 AND end_ts IS NOT NULL', entryId);
    if (!e) return null;
    const u = get('SELECT name FROM users WHERE id = ?', e.user_id);
    const t = get('SELECT * FROM tasks WHERE id = ?', e.task_id);
    const p = t.parent_id ? get('SELECT name FROM tasks WHERE id = ?', t.parent_id) : null;
    const minutes = Math.max(1, Math.round((e.end_ts - e.start_ts) / 60_000));
    return {
      entry: e,
      payload: {
        title: `${u.name} apuntó una tarea`,
        body: `${t.emoji} ${p ? `${p.name} › ` : ''}${t.name} · ${fmtMin(minutes)}${e.note ? `\n${e.note}` : ''}`,
        tag: `entry-${e.id}`,
      },
    };
  }

  async function notifyEntry(entryId) {
    const m = message(entryId);
    if (!m) return [];
    const subs = all('SELECT * FROM push_subs WHERE user_id != ?', m.entry.user_id);
    return Promise.all(subs.map((s) => deliver(s, m.payload).catch((err) => log.error(`Aviso push fallido: ${err.message}`))));
  }

  return {
    publicKey: keys.publicKey,
    subscribe(userId, sub) {
      run(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      sub.endpoint, userId, sub.p256dh, sub.auth, Date.now());
    },
    unsubscribe(endpoint) { run('DELETE FROM push_subs WHERE endpoint = ?', endpoint); },
    // Programa el aviso de un registro recién terminado.
    entryDone(entryId) {
      const t = setTimeout(() => notifyEntry(entryId).catch((err) => log.error(err)), delayMs);
      t.unref?.();
    },
    notifyEntry,
  };
}
