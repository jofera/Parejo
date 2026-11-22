# Parejo — reparto de tareas del hogar

App para dos personas que registra el **tiempo** dedicado a las tareas del hogar y muestra si el reparto es equilibrado (objetivo 50/50). Es una PWA: se abre desde el navegador del móvil y se puede instalar en la pantalla de inicio.

**Principio de diseño:** apuntar algo tiene que costar el mínimo esfuerzo.

- Inicio → toca la tarea → toca la duración. Dos toques, y hay un botón *Deshacer*.
- Las tareas que más usa cada persona aparecen primero, y cada tarea tiene una duración «habitual» ya resaltada.
- Cada persona elige su nombre una sola vez en su móvil; no hay contraseñas ni registro.
- Alternativas: un cronómetro (empezar/terminar), otra duración escrita a mano, o apuntarlo desde Home Assistant (NFC, botones).

## Qué incluye

- Apuntar una tarea por **duración**: sin horas de inicio y fin. Un día distinto de hoy se elige con «Ayer» u «Otro día».
- Balance de la semana siempre visible en la pantalla de inicio.
- Historial por semanas, meses y años, con el detalle de cada periodo.
- Ranking simple (semana, mes, año y total), más el desglose por tarea.
- Cada persona edita solo sus registros (tarea, duración o día). Todo cambio exige un motivo y queda en un historial (cuándo, qué cambió y por qué). Eliminar es «borrado lógico».
- La semana empieza en lunes.
- Integración con Home Assistant (ver abajo): sensores, resumen semanal por notificación y registro desde NFC o botones.

Fuera de esta versión: asignación automática de tareas, pesos por esfuerzo, varios hogares, notificaciones push propias y uso sin conexión.

## Instalación

Hay tres formas de arrancarla. En todas, abre `http://IP-DEL-SERVIDOR:3000` en cada móvil y elige tu nombre. Funciona por `http://` dentro de casa; no necesita certificado.

### Sin Docker

Necesitas Node 22.13 o superior. No hay dependencias que instalar:

```bash
git clone https://github.com/TU-USUARIO/parejo.git
cd parejo
USERS="Ana,Luis" TZ=Europe/Madrid npm start
```

Para que arranque solo con el equipo, usa un servicio de tu sistema (systemd, pm2, el Programador de tareas de Windows…) que ejecute `npm start` en esa carpeta.

### Con Docker (imagen ya construida)

Cada vez que se actualiza la rama `main`, GitHub Actions construye y publica la imagen en `ghcr.io/TU-USUARIO/parejo` (para `amd64` y `arm64`). Con eso no necesitas el código en el NAS, solo un `docker-compose.yml` como este:

```yaml
services:
  reparto:
    image: ghcr.io/TU-USUARIO/parejo:latest
    container_name: parejo
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      TZ: Europe/Madrid
      USERS: "Ana,Luis"
    volumes:
      - ./data:/data
```

Etiquetas disponibles: `latest` (última de `main`), `1.2.3` y `1.2` (al publicar una etiqueta `v1.2.3`) y `sha-XXXXXXX`. Tras el primer publicado, en GitHub ve a *Packages → parejo → Package settings* y cambia la visibilidad a **Public**; si no, tendrás que iniciar sesión en `ghcr.io` para descargarla.

### Con Docker (construyendo tú la imagen)

```bash
docker compose up -d --build
```

Usa el `docker-compose.yml` del repositorio.

### Variables

| Variable | Para qué sirve |
| --- | --- |
| `USERS` | Nombres de las dos personas, separados por coma. Solo se usan la primera vez; después se cambian desde *Más*. |
| `TZ` | Zona horaria; determina cuándo empieza el día y la semana. |
| `PORT` | Puerto (3000 por defecto). |
| `DATA_DIR` | Carpeta de la base de datos (`./data` sin Docker, `/data` en la imagen). |

Los datos están en `reparto.db` (SQLite). **Copia de seguridad = copiar esa carpeta** (con la app parada, o los tres archivos `reparto.db*`). Con Docker, la carpeta del NAS debe poder escribirla el usuario 1000 (`sudo chown 1000:1000 data`).

## Home Assistant

La carpeta [`homeassistant/`](homeassistant/README.md) trae todo lo necesario: sensores del balance, un panel, el resumen semanal por notificación con la app Companion (que sustituye a las push de la app, sin necesidad de HTTPS) y ejemplos para apuntar tareas con pegatinas NFC o botones.

## Desarrollo

```bash
npm install
USERS="Ana,Luis" npm start    # http://localhost:3000
npm test                      # pruebas de la API (node:test)
```

Requiere Node 22.13 o superior. Usa `node:sqlite` (sin compilar nada) y **no tiene dependencias externas**. La interfaz es JavaScript sin paso de build: edita `public/` y recarga.

```
server.js          arranque
src/db.js          esquema SQLite y datos iniciales
src/api.js         rutas de la API (incluye /api/ha, de solo lectura)
src/app.js         servidor HTTP y archivos estáticos
src/stats.js       equilibrio y texto del resumen
src/time.js        límites de semana, mes y año; días locales
public/            interfaz (index.html, app.js, style.css, sw.js, manifest)
homeassistant/     sensores, panel, resumen semanal y ejemplos NFC/botones
test/              pruebas
```

## Modelo de confianza

Pensada para una red doméstica con dos personas de confianza. La API identifica a quien llama por una cabecera `x-user` y **no hay autenticación**: que cada uno solo edite lo suyo es una regla de convivencia que la app aplica, no una barrera de seguridad. `/api/ha` es de solo lectura y público dentro de la red. No expongas la app a Internet sin ponerle delante algún control de acceso.

## Estado

La API, el historial de ediciones, el cronómetro, el registro por duración y día, y la interfaz móvil están probados (pruebas automáticas y recorridos en un navegador móvil simulado). De la integración con Home Assistant se han verificado el endpoint, las plantillas de los sensores y el comando de apuntar contra la API real, pero **aún no contra un Home Assistant real**. Tampoco se ha probado todavía la imagen Docker.

## Licencia

[MIT](LICENSE).
