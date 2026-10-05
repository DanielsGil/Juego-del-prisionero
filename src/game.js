'use strict';

const crypto = require('node:crypto');
const { roundPayoffs } = require('./payoff');

const LIMITS = Object.freeze({
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 10,
  NAME_MAX: 16,
  MIN_ROUNDS_MIN: 1,
  MIN_ROUNDS_MAX: 30,
  END_CHANCE_MIN: 0.05,
  END_CHANCE_MAX: 1,
  ROUND_SECONDS_MIN: 10,
  ROUND_SECONDS_MAX: 120,
  MAX_ROUNDS: 60, // tope de seguridad; no se anuncia a los jugadores
  MISSES_TO_AWAY: 2, // rondas seguidas sin decidir para quedar "ausente"
  REVEAL_MS: 6000, // pausa para ver los resultados antes de la siguiente ronda
  GRACE_MS: 1500, // margen para corregir un toque accidental cuando ya decidieron todos
  ONLINE_GRACE_MS: 12000, // cuánto tiempo seguimos considerando "en línea" a alguien sin conexión abierta
});

// Al menos 7 rondas y, desde ahí, cada ronda tiene 1/4 de ser la última
// (unas 10 rondas en promedio). endChance = 1 significa número fijo de rondas.
const DEFAULT_CONFIG = Object.freeze({ minRounds: 7, endChance: 0.25, roundSeconds: 30 });

class GameError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'GameError';
    this.status = status;
    this.code = code;
  }
}

function validateConfig(input, base = DEFAULT_CONFIG) {
  if (input === undefined || input === null) return { ...base };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new GameError(400, 'BAD_CONFIG', 'La configuración debe ser un objeto JSON.');
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'minRounds') {
      if (!Number.isInteger(value) || value < LIMITS.MIN_ROUNDS_MIN || value > LIMITS.MIN_ROUNDS_MAX) {
        throw new GameError(400, 'BAD_CONFIG', `minRounds debe ser un entero entre ${LIMITS.MIN_ROUNDS_MIN} y ${LIMITS.MIN_ROUNDS_MAX}.`);
      }
      out.minRounds = value;
    } else if (key === 'endChance') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < LIMITS.END_CHANCE_MIN || value > LIMITS.END_CHANCE_MAX) {
        throw new GameError(400, 'BAD_CONFIG', `endChance debe ser un número entre ${LIMITS.END_CHANCE_MIN} y ${LIMITS.END_CHANCE_MAX} (1 = número fijo de rondas).`);
      }
      out.endChance = Math.round(value * 10000) / 10000;
    } else if (key === 'roundSeconds') {
      if (!Number.isInteger(value) || value < LIMITS.ROUND_SECONDS_MIN || value > LIMITS.ROUND_SECONDS_MAX) {
        throw new GameError(400, 'BAD_CONFIG', `roundSeconds debe ser un entero entre ${LIMITS.ROUND_SECONDS_MIN} y ${LIMITS.ROUND_SECONDS_MAX}.`);
      }
      out.roundSeconds = value;
    } else {
      throw new GameError(400, 'BAD_CONFIG', `Opción desconocida: «${String(key).slice(0, 40)}». Las opciones son minRounds, endChance y roundSeconds.`);
    }
  }
  return out;
}

// Rondas esperadas: el mínimo más el valor esperado de rondas extra.
function expectedRounds(config) {
  if (config.endChance >= 1) return config.minRounds;
  return config.minRounds + (1 - config.endChance) / config.endChance;
}

// Caracteres invisibles o de control que permitirían apodos vacíos,
// duplicados que parecen distintos o texto que cambia de dirección.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF0-\uFFFB]/g;

function cleanName(raw) {
  if (typeof raw !== 'string') throw new GameError(400, 'BAD_NAME', 'Escribe un apodo.');
  const name = raw.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
  if (!name) throw new GameError(400, 'BAD_NAME', 'Escribe un apodo.');
  if (Array.from(name).length > LIMITS.NAME_MAX) {
    throw new GameError(400, 'BAD_NAME', `El apodo puede tener hasta ${LIMITS.NAME_MAX} caracteres.`);
  }
  return name;
}

// Clave para comparar apodos sin distinguir mayúsculas ni tildes.
function nameKey(name) {
  return name.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
}

const CHOICE_ALIASES = new Map([
  ['c', 'C'], ['cooperar', 'C'], ['coopero', 'C'], ['cooperate', 'C'], ['cooperation', 'C'],
  ['d', 'D'], ['t', 'D'], ['traicionar', 'D'], ['traiciono', 'D'], ['defect', 'D'], ['defection', 'D'], ['betray', 'D'],
]);

function normalizeChoice(raw) {
  if (typeof raw === 'string' && raw.length <= 20) {
    const choice = CHOICE_ALIASES.get(nameKey(raw));
    if (choice) return choice;
  }
  throw new GameError(400, 'BAD_CHOICE', 'La decisión debe ser "C" (cooperar) o "D" (traicionar).');
}

function secureRandom() {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48; // [0, 1)
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function defaultSetTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function defaultClearTimer(timer) {
  clearTimeout(timer);
}

class Game {
  constructor(options = {}) {
    const {
      code, config, now = Date.now, random = secureRandom, onChange = null,
      setTimer = defaultSetTimer, clearTimer = defaultClearTimer,
    } = options;
    this.code = code;
    this.config = validateConfig(config);
    this.now = now;
    this.random = random;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.createdAt = now();
    this.updatedAt = this.createdAt;
    this.startedAt = null;
    this.status = 'lobby'; // lobby | playing | finished
    this.phase = 'lobby'; // lobby | deciding | reveal | paused | finished

    this.players = []; // en orden de llegada
    this.byId = new Map();
    this.byToken = new Map();
    this.hostId = null;

    this.rounds = []; // solo rondas ya reveladas
    this.current = null; // ronda abierta; sus decisiones NUNCA salen de aquí salvo en viewFor para su dueño
    this.nextRoundAt = null;
    this.endReason = null; // random | fixed | cap
    this.finishedAt = null;
    this.rematchCode = null;
    this.rematchLinks = new Map(); // id aquí -> id en la revancha

    this.rev = 0; // versión pública del estado
    this.timer = null;
    this.streams = new Map(); // id -> conexiones en vivo abiertas
    this.lastSeen = new Map(); // id -> última petición
    this.lastPresenceKey = '';
    this.destroyed = false;
  }

  // ---------- consultas ----------

  player(id) {
    return this.byId.get(id) || null;
  }

  playerByToken(token) {
    return typeof token === 'string' ? this.byToken.get(token) || null : null;
  }

  requirePlayer(id) {
    const player = this.byId.get(id);
    if (!player) throw new GameError(404, 'PLAYER_NOT_FOUND', 'Ese jugador no está en esta partida.');
    return player;
  }

  requireHost(id) {
    this.requirePlayer(id);
    if (id !== this.hostId) throw new GameError(403, 'NOT_HOST', 'Solo el anfitrión de la sala puede hacer esto.');
  }

  requireLobby(message) {
    if (this.status !== 'lobby') throw new GameError(409, 'NOT_IN_LOBBY', message);
  }

  // Jugadores a los que la ronda abierta todavía espera.
  waitingFor() {
    const cur = this.current;
    if (!cur || this.phase !== 'deciding') return [];
    return this.players.filter((p) => cur.eligible.has(p.id) && !p.away && !cur.choices.has(p.id));
  }

  isOnline(id) {
    if ((this.streams.get(id) || 0) > 0) return true;
    const seen = this.lastSeen.get(id);
    return seen !== undefined && this.now() - seen < LIMITS.ONLINE_GRACE_MS;
  }

  presenceKey() {
    return this.players.filter((p) => this.isOnline(p.id)).map((p) => p.id).join(',');
  }

  // ---------- jugadores ----------

  addPlayer(rawName, rawKind) {
    if (this.status === 'finished') {
      throw new GameError(409, 'GAME_FINISHED', 'Esta partida ya terminó. Pide la revancha o crea otra partida.');
    }
    const kind = rawKind === undefined || rawKind === null ? 'human' : rawKind;
    if (kind !== 'human' && kind !== 'agent') {
      throw new GameError(400, 'BAD_KIND', 'kind debe ser "human" o "agent".');
    }
    const name = cleanName(rawName);
    if (this.players.length >= LIMITS.MAX_PLAYERS) {
      throw new GameError(409, 'GAME_FULL', `La partida está llena: ya tiene ${LIMITS.MAX_PLAYERS} jugadores.`);
    }
    const key = nameKey(name);
    if (this.players.some((p) => p.key === key)) {
      throw new GameError(409, 'NAME_TAKEN', `Ya hay alguien con el apodo «${name}» en esta partida. Elige otro.`);
    }
    const late = this.status === 'playing';
    let id;
    do id = `p_${crypto.randomBytes(6).toString('base64url')}`; while (this.byId.has(id));
    const player = {
      id,
      token: newToken(),
      name,
      key,
      kind,
      joinedAt: this.now(),
      // Quien llega tarde entra en la próxima ronda que se abra.
      joinRound: late ? this.rounds.length + (this.current ? 2 : 1) : 1,
      late,
      pendingStart: late,
      startScore: late ? null : 0,
      score: late ? null : 0,
      missed: 0,
      away: false,
      rev: 0, // versión privada: cambia solo con lo que ve este jugador
    };
    this.players.push(player);
    this.byId.set(player.id, player);
    this.byToken.set(player.token, player);
    if (!this.hostId) this.hostId = player.id;
    if (this.phase === 'paused') this.openRound(); // alguien nuevo reanuda la partida
    else this.changed();
    return player;
  }

  removePlayer(player) {
    this.players = this.players.filter((p) => p !== player);
    this.byId.delete(player.id);
    this.byToken.delete(player.token);
    this.lastSeen.delete(player.id);
    if (this.hostId === player.id) {
      const next = this.players.find((p) => p.kind === 'human') || this.players[0] || null;
      this.hostId = next ? next.id : null;
    }
  }

  kick(byId, targetId) {
    this.requireHost(byId);
    this.requireLobby('Solo se puede expulsar a alguien antes de empezar la partida.');
    const target = typeof targetId === 'string' ? this.byId.get(targetId) : null;
    if (!target) throw new GameError(404, 'PLAYER_NOT_FOUND', 'Ese jugador ya no está en la sala.');
    if (target.id === byId) {
      throw new GameError(400, 'CANNOT_KICK_SELF', 'No puedes expulsarte a ti. Usa «Salir» para dejar la sala.');
    }
    this.removePlayer(target);
    this.changed();
  }

  // En la sala de espera (o antes de su primera ronda) salir borra al jugador.
  // Con la partida en curso lo deja ausente: su historial se conserva y
  // puede volver con el mismo enlace.
  leave(playerId) {
    const player = this.requirePlayer(playerId);
    if (this.status === 'lobby' || player.pendingStart) {
      this.removePlayer(player);
      this.changed();
      return 'removed';
    }
    if (this.status === 'playing' && !player.away) {
      player.away = true;
      this.maybeSeal();
      this.changed();
    }
    return 'away';
  }

  // "Estoy aquí": quita la marca de ausente sin tener que esperar a decidir.
  back(playerId) {
    const player = this.requirePlayer(playerId);
    if (this.status !== 'playing') return false;
    const wasAway = player.away;
    if (wasAway) {
      player.away = false;
      player.missed = 0;
    }
    if (this.phase === 'paused') {
      this.openRound();
      return true;
    }
    if (wasAway) this.changed();
    return wasAway;
  }

  setConfig(byId, patch) {
    this.requireHost(byId);
    this.requireLobby('La configuración solo se puede cambiar antes de empezar.');
    this.config = validateConfig(patch, this.config);
    this.changed();
    return this.config;
  }

  start(byId) {
    this.requireHost(byId);
    this.requireLobby('La partida ya empezó.');
    if (this.players.length < LIMITS.MIN_PLAYERS) {
      throw new GameError(409, 'TOO_FEW_PLAYERS', `Hacen falta al menos ${LIMITS.MIN_PLAYERS} jugadores para empezar.`);
    }
    this.startedAt = this.now();
    this.openRound();
  }

  // ---------- rondas ----------

  openRound() {
    if (this.destroyed || this.status === 'finished') return;
    const number = this.rounds.length + 1;

    // Quien llegó tarde empieza con el promedio (redondeado) de los jugadores
    // activos, calculado justo antes de su primera ronda.
    const starting = this.players.filter((p) => p.pendingStart && p.joinRound <= number);
    if (starting.length) {
      const settled = this.players.filter((p) => !p.pendingStart);
      const active = settled.filter((p) => !p.away);
      const base = active.length ? active : settled;
      const average = base.length ? Math.round(base.reduce((sum, p) => sum + p.score, 0) / base.length) : 0;
      for (const p of starting) {
        p.pendingStart = false;
        p.startScore = average;
        p.score = average;
        p.joinRound = number;
      }
    }

    const openedAt = this.now();
    this.current = {
      number,
      openedAt,
      deadline: openedAt + this.config.roundSeconds * 1000,
      sealAt: null,
      eligible: new Set(this.players.filter((p) => !p.pendingStart).map((p) => p.id)),
      choices: new Map(), // SECRETO hasta la revelación
    };
    this.status = 'playing';
    this.phase = 'deciding';
    this.nextRoundAt = null;
    this.schedule(this.current.deadline, () => this.resolveRound('timeout'));
    this.changed();
  }

  decide(playerId, rawChoice, rawRound) {
    const player = this.requirePlayer(playerId);
    const cur = this.current;
    if (!cur || this.phase !== 'deciding') {
      throw new GameError(409, 'ROUND_CLOSED', 'No hay ninguna ronda abierta ahora mismo.');
    }
    if (rawRound !== undefined && rawRound !== null) {
      const round = typeof rawRound === 'string' && /^\d+$/.test(rawRound) ? Number(rawRound) : rawRound;
      if (round !== cur.number) throw new GameError(409, 'WRONG_ROUND', `La ronda abierta es la ${cur.number}.`);
    }
    if (!cur.eligible.has(player.id)) {
      throw new GameError(409, 'NOT_ELIGIBLE', player.pendingStart
        ? `Empiezas a jugar en la ronda ${player.joinRound}.`
        : 'No participas en esta ronda.');
    }
    const choice = normalizeChoice(rawChoice);
    const previous = cur.choices.get(player.id);
    const wasAway = player.away;
    cur.choices.set(player.id, choice);
    if (wasAway) {
      player.away = false;
      player.missed = 0;
    }
    if (previous === undefined || wasAway) {
      // Público: los demás ven QUIÉN decidió, nunca QUÉ.
      this.maybeSeal();
      this.changed();
    } else if (previous !== choice) {
      // Cambio de opinión: solo lo ve (y solo recibe tráfico) este jugador.
      this.changed(player.id);
    }
    return choice;
  }

  // Si ya no falta nadie, se revela tras un margen corto. El margen no se
  // reinicia si alguien corrige su elección, para no delatar el cambio.
  maybeSeal() {
    const cur = this.current;
    if (!cur || this.phase !== 'deciding' || cur.sealAt !== null) return;
    if (cur.choices.size === 0 || this.waitingFor().length > 0) return;
    cur.sealAt = Math.min(this.now() + LIMITS.GRACE_MS, cur.deadline);
    this.schedule(cur.sealAt, () => this.resolveRound('all'));
  }

  resolveRound(endedBy) {
    const cur = this.current;
    if (!cur || this.phase !== 'deciding') return;
    this.cancelTimer();
    const points = roundPayoffs(cur.choices);
    const results = {};
    let cooperators = 0;
    for (const p of this.players) {
      if (!cur.eligible.has(p.id)) continue;
      const choice = cur.choices.get(p.id) || null;
      if (choice) {
        const earned = points.get(p.id);
        p.score += earned;
        p.missed = 0;
        if (choice === 'C') cooperators += 1;
        results[p.id] = { choice, points: earned };
      } else {
        // Inactivo: 0 puntos y la ronda se calcula como si no estuviera.
        p.missed += 1;
        if (p.missed >= LIMITS.MISSES_TO_AWAY) p.away = true;
        results[p.id] = { choice: null, points: 0 };
      }
    }
    this.rounds.push({ number: cur.number, endedBy, participants: cur.choices.size, cooperators, results });
    this.current = null;

    const reason = this.endReasonAfter(cur.number);
    if (reason) {
      this.finish(reason);
    } else if (!this.players.some((p) => !p.away)) {
      // Todos ausentes: no tiene sentido seguir abriendo rondas vacías.
      // Se reanuda cuando alguien pulsa "Estoy aquí" o entra alguien nuevo.
      this.phase = 'paused';
      this.nextRoundAt = null;
    } else {
      this.phase = 'reveal';
      this.nextRoundAt = this.now() + LIMITS.REVEAL_MS;
      this.schedule(this.nextRoundAt, () => this.openRound());
    }
    this.changed();
  }

  // El sorteo del final se hace al cerrar cada ronda, así que no existe
  // ningún dato sobre la última ronda que se pueda filtrar antes de tiempo.
  endReasonAfter(number) {
    if (number >= LIMITS.MAX_ROUNDS) return 'cap';
    if (number < this.config.minRounds) return null;
    if (this.config.endChance >= 1) return 'fixed';
    return this.random() < this.config.endChance ? 'random' : null;
  }

  finish(reason) {
    this.cancelTimer();
    this.status = 'finished';
    this.phase = 'finished';
    this.current = null;
    this.nextRoundAt = null;
    this.endReason = reason;
    this.finishedAt = this.now();
  }

  // ---------- presencia ----------

  attachStream(id) {
    if (!id) return;
    this.streams.set(id, (this.streams.get(id) || 0) + 1);
    if (this.byId.has(id)) this.lastSeen.set(id, this.now());
    this.checkPresence();
  }

  detachStream(id) {
    if (!id) return;
    const open = (this.streams.get(id) || 0) - 1;
    if (open > 0) this.streams.set(id, open);
    else this.streams.delete(id);
    if (this.byId.has(id)) this.lastSeen.set(id, this.now());
  }

  seen(id) {
    if (this.byId.has(id)) this.lastSeen.set(id, this.now());
  }

  // Se llama periódicamente: si cambió quién está en línea, se difunde.
  checkPresence() {
    if (!this.destroyed && this.presenceKey() !== this.lastPresenceKey) this.changed();
  }

  // ---------- infraestructura ----------

  // onlyId: el cambio solo afecta a lo que ve ese jugador.
  changed(onlyId = null) {
    if (this.destroyed) return;
    this.updatedAt = this.now();
    if (onlyId) {
      const player = this.byId.get(onlyId);
      if (player) player.rev += 1;
    } else {
      this.rev += 1;
      this.lastPresenceKey = this.presenceKey();
    }
    if (this.onChange) this.onChange(this, onlyId);
  }

  schedule(at, fn) {
    this.cancelTimer();
    const delay = Math.max(0, at - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.destroyed) return;
      try {
        fn();
      } catch (err) {
        console.error(`[partida ${this.code}] error en un temporizador:`, err);
      }
    }, delay);
  }

  cancelTimer() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.cancelTimer();
  }
}

module.exports = {
  Game,
  GameError,
  LIMITS,
  DEFAULT_CONFIG,
  validateConfig,
  expectedRounds,
  cleanName,
  nameKey,
  normalizeChoice,
};
