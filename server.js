import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { createServer } from './src/app.js';

process.env.TZ ||= 'Europe/Madrid';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(here, 'data');

const db = openDb(path.join(dataDir, 'reparto.db'), { users: process.env.USERS || 'Persona 1,Persona 2' });
const server = createServer({ db, publicDir: path.join(here, 'public') });

server.listen(port, () => console.log(`Parejo escuchando en el puerto ${port} (TZ=${process.env.TZ})`));
