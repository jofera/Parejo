import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { createServer } from './src/app.js';
import { createPush, loadVapidKeys } from './src/push.js';

process.env.TZ ||= 'Europe/Madrid';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(here, 'data');

const db = openDb(path.join(dataDir, 'reparto.db'), { users: process.env.USERS || 'Persona 1,Persona 2' });
// Avisos push: PUSH=off los desactiva. PUSH_SUBJECT es el contacto que se da a los servicios de push.
const push = process.env.PUSH === 'off' ? null
  : createPush({ db, keys: loadVapidKeys(dataDir), ...(process.env.PUSH_SUBJECT ? { subject: process.env.PUSH_SUBJECT } : {}) });
const server = createServer({ db, publicDir: path.join(here, 'public'), push });

server.listen(port, () => console.log(`Parejo escuchando en el puerto ${port} (TZ=${process.env.TZ})`));
