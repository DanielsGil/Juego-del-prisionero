'use strict';

const crypto = require('node:crypto');
const { Game, GameError, LIMITS, nameKey } = require('./game');

// Sin I, L, O, 0 ni 1 para que el código no se confunda al dictarlo.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const HOUR = 60 * 60 * 1000;
const IDLE_LIMITS = { lobby: 2 * HOUR, playing: 1 * HOUR, finished: 3 * HOUR };

function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
}

function freeName(game, base) {
  for (let i = 2; i < 100; i += 1) {
    const suffix = ` ${i}`;
    const candidate = Array.from(base).slice(0, LIMITS.NAME_MAX - suffix.length).join('').trim() + suffix;
    const key = nameKey(candidate);
    if (!game.players.some((p) => p.key === key)) return candidate;
  }
  return base;
}

class GameStore {
  constructor(options = {}) {
    this.games = new Map();
    this.now = options.now || Date.now;
    this.random = options.random;
    this.setTimer = options.setTimer;
    this.clearTimer = options.clearTimer;
    this.maxGames = options.maxGames || 1000;
    this.onChange = options.onChange || null;
    this.onDelete = options.onDelete || null;
  }

  newCode() {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.games.has(code)) return code;
    }
    throw new GameError(503, 'SERVER_BUSY', 'No se pudo generar un código libre. Inténtalo de nuevo.');
  }

  create(config) {
    if (this.games.size >= this.maxGames) {
      this.sweep();
      if (this.games.size >= this.maxGames) {
        throw new GameError(503, 'SERVER_BUSY', 'El servidor tiene demasiadas partidas abiertas. Inténtalo en unos minutos.');
      }
    }
    const options = {
      code: this.newCode(),
      config,
      now: this.now,
      onChange: (game, onlyId) => { if (this.onChange) this.onChange(game, onlyId); },
    };
    if (this.random) options.random = this.random;
    if (this.setTimer) options.setTimer = this.setTimer;
    if (this.clearTimer) options.clearTimer = this.clearTimer;
    const game = new Game(options);
    this.games.set(game.code, game);
    return game;
  }

  get(code) {
    return this.games.get(normalizeCode(code)) || null;
  }

  require(code) {
    const game = this.get(code);
    if (!game) throw new GameError(404, 'NOT_FOUND', 'No existe ninguna partida con ese código. Revisa que esté bien escrito.');
    return game;
  }

  delete(code, reason = 'deleted') {
    const game = this.games.get(code);
    if (!game) return false;
    this.games.delete(code);
    game.destroy();
    if (this.onDelete) this.onDelete(game, reason);
    return true;
  }

  // Borra partidas abandonadas (todo vive en memoria).
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const game of [...this.games.values()]) {
      const since = game.status === 'finished' ? game.finishedAt || game.updatedAt : game.updatedAt;
      if (game.players.length === 0 || now - since > IDLE_LIMITS[game.status]) {
        this.delete(game.code, 'expired');
        removed += 1;
      }
    }
    return removed;
  }

  destroyAll(reason = 'shutdown') {
    for (const code of [...this.games.keys()]) this.delete(code, reason);
  }

  // Revancha: la primera persona que la pide crea una partida nueva con la
  // misma configuración (y queda como anfitriona); los demás se unen a esa.
  // Pedirla dos veces devuelve el mismo jugador.
  rematch(game, player) {
    if (game.status !== 'finished') {
      throw new GameError(409, 'NOT_FINISHED', 'La revancha se puede pedir cuando termina la partida.');
    }
    let next = game.rematchCode ? this.get(game.rematchCode) : null;
    const linked = game.rematchLinks.get(player.id);
    if (next && linked && next.player(linked)) return { game: next, player: next.player(linked), created: false };
    if (!next || next.status === 'finished') {
      next = this.create(game.config);
      game.rematchCode = next.code;
      game.changed();
    }
    let joined;
    try {
      joined = next.addPlayer(player.name, player.kind);
    } catch (err) {
      if (err.code !== 'NAME_TAKEN') throw err;
      joined = next.addPlayer(freeName(next, player.name), player.kind);
    }
    game.rematchLinks.set(player.id, joined.id);
    return { game: next, player: joined, created: true };
  }
}

module.exports = { GameStore, normalizeCode, CODE_ALPHABET, CODE_LENGTH };
