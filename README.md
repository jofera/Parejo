# Parejo — reparto de tareas del hogar

App para dos personas que registra el **tiempo** dedicado a las tareas del hogar y muestra si el reparto es equilibrado (objetivo 50/50). Es una PWA: se abre desde el navegador del móvil y se puede instalar en la pantalla de inicio.

**Principio de diseño:** apuntar algo tiene que costar el mínimo esfuerzo.

- Inicio → toca la tarea → toca la duración. Dos toques, y hay un botón *Deshacer*.
- Las tareas que más usa cada persona aparecen primero, y cada tarea tiene una duración «habitual» ya resaltada.
- Cada persona elige su nombre una sola vez en su móvil; no hay contraseñas ni registro.
- Alternativas: un cronómetro (empezar/terminar), otra duración escrita a mano, o apuntarlo desde Home Assistant (NFC, botones).

## Qué incluye

- Apuntar una tarea por **duración**, en dos toques. Un día distinto de hoy se elige con «Ayer» u «Otro día».
- Opcional, en «Más detalles»: un **comentario** (cena, lasaña…; la app sugiere los que más usas en cada tarea) y la **hora de inicio y de fin** exactas.
- **Grupos de tareas**: una tarea puede tener subtareas (p. ej. «Ropa» → poner la lavadora, tender, recoger, doblar, planchar). Se apunta siempre en la subtarea; el ranking suma por grupo y detalla cada parte. Se crean desde *Más → Tareas* eligiendo «Dentro de».
- **Sin conexión**: si el móvil no llega al servidor, lo que apuntas (también con cronómetro) se guarda en el móvil, se ve marcado como pendiente y se envía solo al volver la conexión o al reabrir la app, sin duplicados. La última pantalla queda guardada para consultarla. Para que la app *abra* sin conexión hace falta servirla por HTTPS (ver abajo).
- Balance de la semana siempre visible en la pantalla de inicio.
- Historial por semanas, meses y años, con el detalle de cada periodo.
- Ranking simple (semana, mes, año y total), más el desglose por tarea.
- Cada persona edita solo sus registros (tarea, duración o día). Todo cambio exige un motivo y queda en un historial (cuándo, qué cambió y por qué). Eliminar es «borrado lógico».
- La semana empieza en lunes.
- Integración con Home Assistant (ver abajo): sensores, resumen semanal por notificación y registro desde NFC o botones.

Fuera de esta versión: asignación automática de tareas, pesos por esfuerzo, varios hogares y notificaciones push propias.

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

## Uso sin conexión y HTTPS

Los navegadores solo permiten *service workers* (lo que hace que una web abra sin red) en páginas HTTPS o en `localhost`. Por `http://IP-DEL-SERVIDOR:3000` la app funciona y guarda en el móvil lo que apuntes si se pierde la conexión, pero **no puede abrirse sin conexión** (y Chrome no la ofrecerá como app instalada). Para eso, sírvela por HTTPS detrás de un proxy inverso con un certificado de confianza:

- Con un dominio propio cuyo DNS tenga API: un subdominio apuntando a la IP privada del servidor y un proxy (Caddy, Nginx Proxy Manager…) que obtenga el certificado con el reto DNS de Let's Encrypt. No hace falta abrir puertos ni instalar nada en los móviles. Hay una receta más abajo.
- Con [Tailscale](https://tailscale.com/kb/1153/enabling-https/): certificado de confianza para el nombre `*.ts.net` y, además, acceso desde fuera de casa sin abrir puertos.

### Receta: Caddy + BIND propio (reto DNS por RFC 2136)

Sirve si gestionas tu propio servidor DNS con BIND. Ejemplo con `casa.example.com`; sustituye dominio e IPs por los tuyos. Probado con Caddy 2 y BIND 9.20; no depende de Parejo, que sigue sirviéndose por `http` detrás del proxy.

1. **DNS.** En la zona de tu dominio:

   ```
   casa                  A      192.168.x.x                       ; IP privada del servidor
   acme-dns              NS     ns.example.com.                   ; delegación de una subzona solo para el reto
   _acme-challenge.casa  CNAME  casa.acme-dns.example.com.
   ```

2. **BIND.** Genera una clave (`tsig-keygen -a hmac-sha256 caddy-key`, o `openssl rand -base64 32` para el secreto) y declara una subzona **fuera de lo que gestione tu panel** (así no se pisan las actualizaciones dinámicas con el fichero de zona). En `named.conf.local`:

   ```
   key "caddy-key" { algorithm hmac-sha256; secret "BASE64"; };

   zone "acme-dns.example.com" {
       type master;
       file "/var/lib/bind/acme-dns.example.com.db";
       update-policy { grant caddy-key name casa.acme-dns.example.com. TXT; };
   };
   ```

   La política solo deja a esa clave escribir TXT en ese nombre. El fichero de zona lleva únicamente `SOA` y `NS`. Valida con `named-checkconf` y `named-checkzone`, y recarga con `rndc reload`.

3. **Caddy con el plugin.** La imagen oficial no lo trae:

   ```dockerfile
   FROM caddy:builder AS b
   RUN xcaddy build --with github.com/caddy-dns/rfc2136
   FROM caddy:latest
   COPY --from=b /usr/bin/caddy /usr/bin/caddy
   ```

   ```
   {
       https_port 8443
       auto_https disable_redirects
   }

   casa.example.com {
       tls {
           dns rfc2136 {
               key_name "caddy-key"
               key_alg "hmac-sha256"
               key "{env.TSIG_KEY}"
               server "IP-DEL-BIND:53"
           }
           dns_challenge_override_domain casa.acme-dns.example.com
           resolvers IP-DEL-BIND
           propagation_delay 5s
       }
       reverse_proxy IP-PRIVADA:3000
   }
   ```

   Pasa el secreto como variable de entorno (`TSIG_KEY`), no lo guardes en el repositorio. El puerto 8443 evita chocar con el 80 y el 443 si el servidor ya los usa (por ejemplo, DSM en Synology). Persiste `/data` de Caddy en un volumen para conservar certificados y cuenta.

4. **Comprobar.** Abre `https://casa.example.com:8443` en el móvil, en la consola `window.isSecureContext` debe dar `true`, y el service worker debe aparecer registrado. Instala la app **desde esa URL**: una app instalada queda ligada a su origen, y cambiar de URL obliga a reinstalar y a elegir de nuevo el nombre. Si el nombre no resuelve en casa, revisa la protección contra *DNS rebinding* del router.

Fuera de casa, la IP privada solo se alcanza con una VPN. Sin ella, la app instalada sigue abriendo y guarda lo que apuntes para enviarlo al volver.

**Actualizaciones.** La versión de la app (`package.json` + una huella de `public/`) se ve en *Más* y en `/api/version`. Cuando la imagen del servidor cambia, el móvil descarga la interfaz nueva en segundo plano, borra la caché vieja y muestra el aviso «Hay una versión nueva»; al tocarlo se recarga, sin perder lo pendiente de enviar.

La sincronización en segundo plano con la app cerrada no está disponible en Safari ni Firefox, así que lo pendiente se envía al abrir la app o al recuperar la conexión.

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
