# Dilema del prisionero multijugador

Web app para jugar el dilema del prisionero entre **2 y 10 personas** en tiempo real, cada una desde su celular o computador, sin instalar nada ni registrarse. Se crea una partida, se comparte el código (o el enlace `/p/CÓDIGO`) y en cada ronda todos eligen en secreto entre **cooperar** o **traicionar**.

## Ejecutar en tu computador

Necesitas Node.js 18 o superior. No hay dependencias que instalar.

```bash
npm start          # servidor en http://localhost:3000
npm run dev        # igual, pero se reinicia al cambiar el código del servidor
npm test           # 22 pruebas automáticas
```

Al arrancar, el servidor muestra también su dirección en la red local (por ejemplo `http://192.168.1.20:3000`): cualquier celular conectado al mismo Wi-Fi puede jugar abriendo esa dirección. El puerto se cambia con la variable `PORT`.

Para probar con varias pestañas en el mismo navegador, ten en cuenta que en local (HTTP/1.1) los navegadores permiten unas 6 conexiones simultáneas por sitio y cada pestaña usa una para el tiempo real. Con más de 5 pestañas, usa otro navegador o una ventana de incógnito. Publicado en Render (HTTP/2) esto no pasa.

## Publicar en internet (gratis, en Render)

1. Sube esta carpeta a un repositorio de GitHub.
2. En [render.com](https://render.com), elige **New → Blueprint** y selecciona el repositorio. Render lee `render.yaml` y crea el servicio solo. Si prefieres hacerlo a mano: **New → Web Service**, runtime Node, build `npm install`, start `npm start`, health check `/api/v1/health`, variable `NODE_ENV=production`.
3. Te dará una dirección como `https://dilema-prisionero.onrender.com`. Las partidas se comparten como `https://dilema-prisionero.onrender.com/p/K7QX2`.

Funciona igual en cualquier servicio que ejecute Node (Railway, Fly.io, un VPS...): basta con `npm start` y la variable `PORT`.

**Ojo con el plan gratis:** el servicio se duerme tras un rato sin visitas (unos 15 minutos, según Render) y la primera visita después tarda hasta un minuto en despertarlo. Como las partidas viven en memoria, al dormirse o al publicar una versión nueva se pierden las partidas abiertas. Para clases o eventos, abre la página unos minutos antes. Debe correr **una sola instancia**: no lo escales horizontalmente.

## Cómo se juega

1. Alguien crea la partida con su apodo y queda como anfitrión. Comparte el código o el enlace.
2. En la sala de espera, el anfitrión ajusta las rondas mínimas, el final sorpresa y el tiempo por ronda, y pulsa **Empezar** (hacen falta 2 jugadores).
3. En cada ronda todos eligen **Cooperar** o **Traicionar**. Nadie ve lo que eligieron los demás, solo quién ya decidió. Se puede cambiar la elección hasta la revelación. En computador, las teclas **C** y **T** también sirven.
4. La ronda se revela cuando todos decidieron o se acaba el tiempo: se ve qué hizo cada uno y cuántos puntos ganó. A los 6 segundos empieza la siguiente.
5. Al final aparecen la clasificación, el porcentaje de cooperación del grupo y la opción de revancha.

## Fórmula de recompensas

Cada jugador juega un dilema del prisionero clásico **contra cada rival** con una sola decisión, y se suman los resultados. Contra cada rival:

|                | el rival coopera | el rival traiciona |
|----------------|:---:|:---:|
| **tú cooperas**    | 3 | 0 |
| **tú traicionas**  | 5 | 1 |

Son los valores de los torneos de Axelrod (T = 5 > R = 3 > P = 1 > S = 0). Si N jugadores decidieron y **k** de tus rivales cooperaron:

- **Cooperar = 3k**
- **Traicionar = 5k + 1·(N − 1 − k) = 4k + (N − 1)**

**Condición 1:** traicionar − cooperar = k + N − 1 ≥ 1 para todo N ≥ 2, así que traicionar siempre da más, hagan lo que hagan los demás.
**Condición 2:** si todos cooperan cada uno gana 3(N − 1); si todos traicionan, N − 1. Cooperar entre todos rinde el triple.

| Rivales que cooperan (k) | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| **3 jugadores**: cooperar / traicionar | 0 / 2 | 3 / 6 | 6 / 10 | | | |
| **4 jugadores**: cooperar / traicionar | 0 / 3 | 3 / 7 | 6 / 11 | 9 / 15 | | |
| **6 jugadores**: cooperar / traicionar | 0 / 5 | 3 / 9 | 6 / 13 | 9 / 17 | 12 / 21 | 15 / 25 |

- Con **3** jugadores: todos cooperan → 6 cada uno; todos traicionan → 2.
- Con **4**: todos cooperan → 9; todos traicionan → 3. Si 2 cooperan y 2 traicionan: los cooperadores ganan 3 y los traidores 11 (total del grupo 28, frente a 36 si todos cooperan y 12 si todos traicionan).
- Con **6**: todos cooperan → 15; todos traicionan → 5.

Además, cada cooperador adicional aumenta el total del grupo. Las pruebas (`test/payoff.test.js`) comprueban todo esto para N de 2 a 10 y verifican que la fórmula coincide con sumar los duelos uno a uno en todas las combinaciones posibles.

**Por qué no el "bien público":** también cumple las dos condiciones, pero reparte fracciones (por ejemplo 1,6 puntos con m = 1,6), lo que hace la tabla más difícil de leer en un celular. Con N = 2 esta fórmula es exactamente el dilema clásico.

## Decisiones de diseño

- **Máximo 10 jugadores.** Con más, la tabla del historial deja de leerse bien en un celular, la revelación pierde impacto y es difícil seguir a cada persona.
- **Rondas: al menos 7 y luego un 25 % de probabilidad de terminar en cada ronda** (unas 10 en promedio). Si se sabe cuál es la última ronda, conviene traicionar en ella, y por inducción hacia atrás en la anterior, y así sucesivamente. Un final incierto mantiene vivo el incentivo a cooperar, y el mínimo garantiza que haya tiempo de que surjan patrones. El sorteo se hace en el servidor **al cerrar** cada ronda, así que no existe ningún dato sobre la última ronda que pueda filtrarse antes. El anfitrión puede cambiarlo, incluido un modo de rondas fijas. Hay además un tope de seguridad de 60 rondas.
- **30 segundos por ronda** (configurable de 10 a 120). Cuando todos decidieron, se espera 1,5 s antes de revelar, para corregir un toque accidental. Ese margen no se reinicia si alguien cambia de opinión, para no delatar el cambio.
- **Jugador inactivo:** quien no decide a tiempo suma 0 puntos esa ronda y la ronda se calcula como si no estuviera (no cuenta como cooperador ni como traidor de nadie). Tras **2 rondas seguidas** sin decidir queda **ausente**: las rondas ya no lo esperan. Vuelve en cuanto elige o pulsa «Estoy aquí». Si todos quedan ausentes, la partida se pausa en vez de quemar rondas vacías.
- **Llegar tarde:** se puede entrar con la partida en marcha. Se recibe todo el historial y se empieza a jugar en la **siguiente ronda que se abra**, con el **promedio redondeado de los jugadores activos** calculado justo antes de esa ronda. Así no se llega en último lugar ni con ventaja. En la tabla aparece la etiqueta «entró en R5», una columna «Inicio» con los puntos de entrada y «—» en las rondas anteriores.
- **Sin registro:** cada persona entra con un apodo (máximo 16 caracteres, sin repetir; no distingue mayúsculas ni tildes). El navegador recuerda la sesión: al recargar se vuelve automáticamente, y desde otra pestaña aparece «Continuar como…».
- **Extras:** modo espectador («Mirar sin jugar»), expulsar en la sala de espera, traspaso del anfitrión si sale, revancha con la misma configuración, atajos de teclado y modo oscuro automático.

## Tiempo real: por qué SSE y no WebSockets

El flujo es asimétrico: los jugadores envían pocas acciones (unirse, decidir) y el servidor difunde cambios de estado. Por eso:

- **Las acciones van por REST** (`POST /decision`, etc.). Son exactamente los mismos endpoints que usará un agente de IA: no hay un protocolo distinto para humanos y bots.
- **Los cambios llegan por Server-Sent Events** (`GET /stream`). Es HTTP normal, atraviesa proxies y balanceadores, el navegador reconecta solo y no necesita ninguna librería. Los WebSockets aportarían comunicación bidireccional, que aquí no hace falta, a costa de más código y una dependencia.
- **Si el stream falla**, el cliente consulta `GET /state` cada 2 segundos hasta recuperarlo, y además reintenta conectar. Un vigilante reconecta si pasan 50 s sin noticias (el servidor envía un latido cada 20 s).

## Cómo se garantiza el secreto

Todo lo que sale del servidor (respuestas REST, eventos SSE, historial) pasa por **una única función, `viewFor(partida, jugador)`**, en `src/views.js`. De la ronda abierta solo publica **quién** decidió, en orden de jugadores y no en orden de decisión, y nunca **qué** decidió. Cada jugador recibe únicamente su propia elección (`me.choice`). Las decisiones de los demás solo aparecen en `history` cuando la ronda se revela.

Hay una sutileza más: si alguien **cambia de opinión**, el servidor solo envía tráfico a esa persona, y la versión pública del estado no cambia. Así ni siquiera el momento o el tamaño de los mensajes delata un cambio. Las pruebas lo comprueban con conexiones SSE reales: cuando alguien cambia de opinión, los demás no reciben ni un byte.

## Arquitectura

```
server.js           HTTP: API REST, SSE, archivos estáticos, límites y cabeceras de seguridad
src/payoff.js       fórmula de puntos
src/game.js         reglas y máquina de estados de una partida (temporizadores, ausencias, llegadas tarde)
src/views.js        viewFor(): la única función que decide qué ve cada cliente
src/store.js        partidas en memoria: códigos, limpieza de partidas abandonadas, revancha
public/             interfaz (HTML, CSS y JavaScript sin frameworks) y tipografía
test/               pruebas con node:test (reglas, secreto, HTTP y SSE de extremo a extremo)
render.yaml         despliegue en Render
API.md              contrato de la API para agentes
```

**Modelo de datos.** Una partida tiene código, configuración, estado (`lobby`, `playing`, `finished`), fase (`deciding`, `reveal`, `paused`...), jugadores, rondas reveladas y la ronda abierta. Un **jugador** es la misma entidad para humanos y agentes (`kind: "human" | "agent"`): id público, token secreto, apodo, ronda de entrada, puntos de inicio, puntaje, rondas seguidas sin decidir y si está ausente. Cada ronda revelada guarda, por jugador, la decisión (`C`, `D` o `null`) y los puntos.

**Seguridad y límites.** Tokens aleatorios de 192 bits, enviados en la cabecera `Authorization`. Política de contenido estricta (solo scripts propios), `no-referrer` para no filtrar el enlace de la partida, cuerpos de máximo 8 KB, límite de peticiones por IP (generoso, porque toda una clase puede compartir la misma IP), máximo 1000 partidas y 60 conexiones en vivo por partida. Las partidas abandonadas se borran solas: 2 h en la sala de espera, 1 h detenidas en juego y 3 h después de terminar.

## Limitaciones conocidas

- El estado vive en memoria: un reinicio del servidor borra las partidas abiertas. Para persistirlas habría que guardar las partidas en Redis o en una base de datos; la lógica ya está aislada en `src/game.js`.
- Una sola instancia del servidor; escalar a varias requeriría compartir el estado y la difusión (por ejemplo con Redis pub/sub).

## Créditos

Tipografía derivada de **TeX Gyre Heros** (GUST e-foundry), recortada y renombrada como «PD Sans» y «PD Cond». Licencia GUST Font License: `public/fonts/GUST-FONT-LICENSE.txt`.
