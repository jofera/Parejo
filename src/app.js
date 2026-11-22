import http from 'node:http';
import { readFile } from 'node:fs/promises';
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

export function createServer({ db, publicDir, now }) {
  const api = createApi({ db, now });
  const root = path.resolve(publicDir);

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
        const data = await readFile(file);
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
