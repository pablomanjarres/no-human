# sick-clone-ui

Landing estática con estilo SICK. Es la puerta de entrada a la consola de
equivalencias. Sin build: `npm run dev` la sirve en el puerto 3300.

```
index.html    markup de la página + el shell del Engineering Copilot
styles.css    estilos del sitio (tokens en :root)
app.js        menú móvil, banner de cookies, scroll suave
copilot.css   estilos del widget, todo prefijado .cp-
copilot.js    apertura/cierre del widget y motor de respuestas
assets/       imágenes
```

## Engineering Copilot

Popup de consulta anclado abajo a la derecha. Existe para filtrar: resuelve lo
sencillo en la página y **entrega lo técnico a la consola de análisis**.

### El contrato que importa

El popup **no hace análisis de ingeniería y no debe aparentar que lo hace**. No
lista agentes, no compara modelos y no inventa referencias. Cuando la consulta
pide ingeniería, muestra la tarjeta de escalado y enlaza a:

```
https://sick-cross.vercel.app/console?q=<consulta codificada>
```

La consulta viaja tal cual la escribió el usuario (`encodeURIComponent`), así
que la consola recibe el texto íntegro y no una versión recortada. El análisis
completo vive solo ahí.

### Cómo se clasifica una consulta

`RULES` en `copilot.js` es una lista **ordenada**; gana la primera que coincide.
El texto se normaliza antes (minúsculas, sin acentos), por eso los patrones se
escriben sin tildes. Tres desenlaces:

| Tipo       | Cuándo                                                              | Se ve como                    |
| ---------- | ------------------------------------------------------------------- | ----------------------------- |
| `simple`   | saludos, qué es SICK, gama, contacto, ubicación, horario            | tarjeta blanca del asistente  |
| `alert`    | precios, plazos, stock, pedidos — ni el popup ni la consola cubren esto | tarjeta ámbar             |
| `advanced` | marcas rivales, equivalencias, referencias, especificaciones, >160 caracteres | tarjeta de escalado |

Sin coincidencia, el desenlace por defecto es `advanced`: ante la duda se
escala, nunca se responde a medias.

Al añadir reglas, cuidado con el orden. Las reglas `advanced` de marca y
especificación van **antes** que las `simple` de catálogo a propósito: si no,
«qué productos son equivalentes al Banner Q45» caería en la respuesta genérica
de catálogo en vez de escalar.

### Color

Hereda `--primary-blue` y `--dark-navy` del sitio. Verde solo para estados
correctos (el LED del launcher, «Listo para ayudar»); ámbar **solo** para
alertas. Si el ámbar empieza a aparecer en sitios normales, pierde su función.

### Comportamiento

Enter envía, Shift+Enter salta de línea, Escape cierra y devuelve el foco al
botón flotante. En móvil (≤520 px) ocupa casi todo el ancho, por encima del
resto (`z-index: 1200`, sobre el header y el banner de cookies). Respeta
`prefers-reduced-motion`.

El estado abierto lo marca la clase `.is-open`, no el atributo `hidden`: `hidden`
se aplica 180 ms más tarde, cuando termina la animación de cierre.
