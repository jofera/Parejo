import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApi, HttpError } from './api.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// Versión = la de package.json + una huella de los archivos de la interfaz. Así el service worker
// cambia solo cuando cambia algo de public/, aunque se olvide subir el número de versión.
function appVersion(root) {
  let base = '0';
  try { base = JSON.parse(readFileSync(path.resolve(root, '..', 'package.json'), 'utf8')).version || '0'; } catch { /* sin package.json */ }
  const hash = createHash('sha1');
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f !== path.join(root, 'sw.js')) hash.update(path.relative(root, f)).update(readFileSync(f));
    }
  };
  try { walk(root); } catch { /* sin carpeta */ }
  return `${base}-${hash.digest('hex').slice(0, 8)}`;
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new HttpError(413, 'Petición demasiado grande');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON no válido');
  }
}

export function createServer({ db, publicDir, now, push }) {
  const api = createApi({ db, now, push });
  const root = path.resolve(publicDir);
  const version = appVersion(root);

  return http.createServer(async (req, res) => {
    const send = (status, data, headers = {}) => {
      const isBuf = Buffer.isBuffer(data);
      res.writeHead(status, {
        'content-type': isBuf ? headers['content-type'] : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(isBuf ? data : JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/version') return send(200, { version });
      if (url.pathname.startsWith('/api/')) {
        const out = await api(req, url, await readBody(req));
        if (out === undefined) return send(404, { error: 'No existe' });
        return send(200, out);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'Método no permitido' });
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) return send(403, { error: 'Prohibido' });
      try {
        let data = await readFile(file);
        if (file === path.join(root, 'sw.js')) data = Buffer.from(data.toString('utf8').replaceAll('__VERSION__', version));
        return send(200, data, {
          'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
      } catch {
        return send(404, { error: 'No existe' });
      }
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      console.error(err);
      return send(500, { error: 'Error interno' });
    }
  });
}
