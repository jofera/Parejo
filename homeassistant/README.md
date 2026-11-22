# Integración con Home Assistant

Home Assistant y la app hablan por la red local (de contenedor a contenedor), así que **no hace falta HTTPS en la app ni exponer nada a Internet**. Con esto Home Assistant:

- muestra el balance de la semana como sensores y en un panel;
- envía el resumen semanal por notificación a los móviles (app Companion);
- recibe tareas desde pegatinas NFC, botones físicos o cualquier automatización.

> **Por qué no se incrusta la app en un panel.** Si abres Home Assistant por `https://` (Nabu Casa), el navegador bloquea cargar dentro una página `http://` (contenido mixto). La app sigue abriéndose directamente en `http://IP-DEL-NAS:3000` desde la wifi de casa.

## Requisitos

- Home Assistant 2024.10 o superior (usa la sintaxis `triggers:` / `actions:` / `action:`).
- Que el contenedor de Home Assistant llegue a `http://IP-DEL-NAS:3000` (comprueba que `http://IP-DEL-NAS:3000/api/ha` responde con JSON desde un navegador de la misma red).

## Instalación

1. Copia `reparto.yaml` a `packages/reparto.yaml` dentro de tu carpeta de configuración de Home Assistant. Si no usas paquetes, añade esto a `configuration.yaml`:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

2. En `reparto.yaml`, sustituye **`IP-DEL-NAS`** (aparece 2 veces) por la IP de tu NAS.
3. En la automatización del resumen, cambia `notify.mobile_app_iphone_de_persona_1` y `notify.mobile_app_iphone_de_persona_2` por los nombres reales: *Herramientas para desarrolladores → Acciones* y busca `notify.mobile_app_`.
4. *Herramientas para desarrolladores → YAML → Comprobar configuración*, y reinicia Home Assistant.
5. Opcional: pega `panel.yaml` en un panel como tarjeta manual.

## Entidades que se crean

| Entidad | Qué es |
| --- | --- |
| `sensor.reparto_persona_1_semana`, `sensor.reparto_persona_2_semana` | Minutos de cada uno esta semana |
| `sensor.reparto_persona_1_porcentaje`, `sensor.reparto_persona_2_porcentaje` | Porcentaje de cada uno |
| `sensor.reparto_diferencia_semana` | Diferencia en minutos (positivo: Persona 1 va por delante) |
| `sensor.reparto_persona_1_hoy`, `sensor.reparto_persona_2_hoy` | Minutos de hoy |
| `sensor.reparto_mensaje_semana` | Texto listo para notificar |
| `binary_sensor.reparto_equilibrado` | Encendido si la diferencia es menor del 10 % |
| `script.reparto_apuntar_tarea` | Apunta una tarea: `user` (1 o 2), `task` (ID) y `minutes` |

Si cambias los nombres de las personas en la app, cambia también los de los sensores en `reparto.yaml`. El orden (1 = primera persona, 2 = segunda) es el que muestra `/api/ha`.

## Apuntar tareas desde Home Assistant

`ejemplos.yaml` trae dos casos:

- **Pegatina NFC** (p. ej. en el lavavajillas): al acercar el móvil se apunta «Recoger la cocina, 15 min». La automatización sabe quién ha sido por el móvil que ha leído la etiqueta, y solo hay que registrarla una vez en la app Companion.
- **Botón físico** (p. ej. Zigbee): cada pulsación apunta siempre lo mismo a la misma persona.

Los IDs de las tareas están en `http://IP-DEL-NAS:3000/api/ha`, apartado `tasks`.

## Seguridad

La app no tiene autenticación: `/api/ha` es de solo lectura y público dentro de tu red, y quien llame al comando de apuntar con `x-user: 1` o `2` actúa como esa persona. Está pensado para una red doméstica de confianza; no lo expongas a Internet.
