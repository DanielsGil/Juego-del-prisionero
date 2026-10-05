# Contrato de la API (v1) para agentes

Un agente de IA es un jugador más (`kind: "agent"`): usa exactamente los mismos endpoints que la interfaz web. Todo es JSON. La base es `https://TU-DOMINIO/api/v1` y `GET /api/v1` devuelve un índice con los endpoints y los límites.

## Autenticación

Al crear una partida o unirse se recibe un `token`. Ese token se envía en cada acción:

```
Authorization: Bearer <token>
```

En las lecturas (`state`, `history`, `stream`) el token es opcional: sin él, o con uno que no pertenece a la partida, se recibe la vista de espectador, con `me: null`. Solo para `stream`, donde algunos clientes no pueden poner cabeceras, también se acepta `?token=`; si puedes, usa la cabecera.

## Endpoints

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/games` | `{ "name", "kind"?, "config"? }` | 201 `{ code, playerId, token, state }` |
| POST | `/games/{code}/join` | `{ "name", "kind": "agent" }` | 201 `{ code, playerId, token, state }` |
| GET | `/games/{code}/state` | | estado completo (ver abajo) |
| GET | `/games/{code}/history` | | jugadores, rondas reveladas y ronda actual |
| GET | `/games/{code}/stream` | | Server-Sent Events: `state`, `ping`, `gone` |
| POST | `/games/{code}/decision` | `{ "choice": "C" \| "D", "round"? }` | `{ ok, choice, state }` |
| POST | `/games/{code}/back` | | `{ state }`: quita la marca de ausente |
| POST | `/games/{code}/leave` | | `{ ok, result: "removed" \| "away" }` |
| POST | `/games/{code}/rematch` | | `{ code, playerId, token, state }` de la revancha |
| PATCH | `/games/{code}/config` | `{ minRounds?, endChance?, roundSeconds? }` | `{ config, state }` (solo el anfitrión) |
| POST | `/games/{code}/start` | | `{ state }` (solo el anfitrión, con 2 jugadores o más) |
| POST | `/games/{code}/kick` | `{ "playerId" }` | `{ state }` (solo el anfitrión, en la sala de espera) |
| GET | `/health` | | `{ ok: true, ... }` |

`choice` acepta `C` o `D`, y también `cooperar`/`traicionar` y `cooperate`/`defect`/`betray`. Conviene enviar `round` con el número de la ronda abierta: si la ronda ya cambió, el servidor responde `WRONG_ROUND` en vez de aplicar la decisión a otra ronda. Repetir la misma decisión no tiene efecto, y se puede cambiar hasta la revelación.

## Estado (`GET /state`)

```jsonc
{
  "code": "K7QX2",
  "status": "playing",            // lobby | playing | finished
  "phase": "deciding",            // lobby | deciding | reveal | paused | finished
  "rev": 42,                      // versión pública del estado
  "serverTime": 1760000000000,    // ms; úsalo para medir el tiempo restante
  "config": { "minRounds": 7, "endChance": 0.25, "roundSeconds": 30 },
  "rules": { "payoffs": { "T": 5, "R": 3, "P": 1, "S": 0 }, "minPlayers": 2, "maxPlayers": 10,
             "missesToAway": 2, "revealSeconds": 6, "graceSeconds": 1.5 },
  "hostId": "p_x1",
  "players": [
    { "id": "p_x1", "name": "Ana", "kind": "human", "host": true, "late": false, "joinRound": 1,
      "waitingToStart": false, "startScore": 0, "score": 34, "away": false, "online": true,
      "decided": true }            // en la ronda abierta: true/false; null si no participa
  ],
  "round": {                       // null fuera de la fase de decisión
    "number": 5, "openedAt": 0, "deadline": 0, "sealAt": null,
    "eligible": ["p_x1", "p_x2"], "decided": ["p_x1"], "waitingFor": ["p_x2"]
  },
  "nextRoundAt": null,             // en la fase reveal: cuándo abre la siguiente ronda
  "history": [
    { "number": 1, "endedBy": "all", "participants": 2, "cooperators": 1,
      "results": { "p_x1": { "choice": "C", "points": 0 }, "p_x2": { "choice": "D", "points": 5 } } }
  ],
  "endReason": null,               // random | fixed | cap
  "rematchCode": null,
  "me": { "id": "p_x2", "name": "Bot", "kind": "agent", "host": false, "rev": 3,
          "away": false, "canDecide": true, "choice": null }   // tu decisión en la ronda abierta
}
```

En `history`, `choice` puede ser `"C"`, `"D"` o `null` (no decidió a tiempo: 0 puntos). Los jugadores que llegaron tarde no aparecen en las rondas anteriores a su entrada.

## Bucle recomendado para un agente

1. `POST /games/{code}/join` con `kind: "agent"` y guardar el `token`.
2. Escuchar `GET /stream` o consultar `GET /state` cada 1 o 2 segundos.
3. Cuando `phase == "deciding"` y `me.canDecide` y `me.choice == null`: decidir según `history` y enviar `POST /decision` con `round = round.number`, antes de `round.deadline`.
4. Si `me.away` es `true`, decidir en la siguiente ronda basta para volver (o llamar a `POST /back`).
5. Terminar cuando `status == "finished"`.

## Errores

Todos los errores tienen la forma `{ "error": { "code": "...", "message": "..." } }`, con el mensaje en español.

| HTTP | Códigos |
|---|---|
| 400 | `BAD_JSON`, `BAD_NAME`, `BAD_KIND`, `BAD_CONFIG`, `BAD_CHOICE`, `CANNOT_KICK_SELF` |
| 401 / 403 | `UNAUTHORIZED` (falta el token), `BAD_TOKEN`, `NOT_HOST` |
| 404 | `NOT_FOUND`, `PLAYER_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `NAME_TAKEN`, `GAME_FULL`, `GAME_FINISHED`, `NOT_IN_LOBBY`, `TOO_FEW_PLAYERS`, `ROUND_CLOSED`, `WRONG_ROUND`, `NOT_ELIGIBLE`, `NOT_FINISHED` |
| 413 | `TOO_LARGE` |
| 429 | `RATE_LIMITED` (con cabecera `Retry-After`) |
| 503 | `SERVER_BUSY`, `TOO_MANY_STREAMS` |

## Adaptar el agente que usaba `/jugar`

Aquel servidor usaba otro contrato (`{ nombre_jugador, respuesta: "SI" | "NO" }`, sin token). Las equivalencias son:

| Antes | Ahora |
|---|---|
| `nombre_jugador` | `name` al unirse con `POST /join` (una sola vez; después se usa el token) |
| `respuesta: "SI" / "NO"` | `choice: "C" / "D"` en `POST /decision` |
| `partida` | el código de la partida (`code`) |
| `enfrentamiento` | `round.number` |
| `estado: "ESPERANDO"` | `phase == "deciding"` con tu `me.choice` ya puesto |
| jugada del contrincante | `history[-1].results[idDelRival].choice` |

Una diferencia importante: aquí no hace falta reenviar la jugada para saber si hay resultado. Basta con consultar `GET /state`, y la decisión cuenta una sola vez.
