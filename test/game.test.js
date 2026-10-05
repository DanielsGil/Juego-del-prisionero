'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, LIMITS } = require('../src/game');
const { GameStore } = require('../src/store');
const { viewFor, historyFor } = require('../src/views');
const { fakeClock } = require('./helpers');

function setup({ config, random, names = ['Ana', 'Beto', 'Caro'] } = {}) {
  const clock = fakeClock();
  const changes = [];
  const game = new Game({
    code: 'TEST1',
    config,
    now: clock.now,
    random: random || (() => 0.99),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: (_g, onlyId) => changes.push(onlyId),
  });
  const players = names.map((n) => game.addPlayer(n));
  return { game, clock, changes, players };
}

test('flujo completo: decidir, margen de 1,5 s, revelar, pausa y siguiente ronda', () => {
  const { game, clock, players: [a, b, c] } = setup();
  assert.equal(game.hostId, a.id);
  assert.throws(() => game.start(b.id), { code: 'NOT_HOST' });
  game.start(a.id);
  assert.equal(game.phase, 'deciding');
  assert.equal(game.current.number, 1);

  game.decide(a.id, 'C');
  game.decide(b.id, 'cooperar');
  assert.equal(game.current.sealAt, null);
  game.decide(c.id, 'traicionar');
  assert.equal(game.current.sealAt, clock.now() + LIMITS.GRACE_MS);

  clock.advance(LIMITS.GRACE_MS - 1);
  assert.equal(game.phase, 'deciding');
  clock.advance(1);
  assert.equal(game.phase, 'reveal');
  const r1 = game.rounds[0];
  assert.equal(r1.endedBy, 'all');
  assert.deepEqual(r1.results[a.id], { choice: 'C', points: 3 });
  assert.deepEqual(r1.results[c.id], { choice: 'D', points: 10 }); // 4·2 + (3 − 1)
  assert.equal(r1.cooperators, 2);

  clock.advance(LIMITS.REVEAL_MS);
  assert.equal(game.phase, 'deciding');
  assert.equal(game.current.number, 2);
  assert.equal(game.current.deadline - game.current.openedAt, game.config.roundSeconds * 1000);
});

test('secreto: cambiar de opinión no altera nada de lo que ven los demás', () => {
  const { game, changes, players: [a, b] } = setup();
  game.start(a.id);
  game.decide(a.id, 'C');
  const before = JSON.stringify(viewFor(game, b.id));
  const spectatorBefore = JSON.stringify(viewFor(game, null));
  const rev = game.rev;
  changes.length = 0;

  game.decide(a.id, 'D');
  assert.equal(JSON.stringify(viewFor(game, b.id)), before);
  assert.equal(JSON.stringify(viewFor(game, null)), spectatorBefore);
  assert.equal(game.rev, rev);
  assert.deepEqual(changes, [a.id]); // solo tráfico privado para Ana
  assert.equal(viewFor(game, a.id).me.choice, 'D');
  assert.ok(!before.includes('"C"') && !before.includes('"D"'));
  assert.equal(viewFor(game, b.id).me.choice, null);
  assert.deepEqual(viewFor(game, b.id).round.decided, [a.id]);

  // Elegir lo mismo otra vez no genera ningún evento.
  changes.length = 0;
  game.decide(a.id, 'D');
  assert.deepEqual(changes, []);
});

test('el margen tras decidir todos no se reinicia si alguien corrige', () => {
  const { game, clock, players: [a, b, c] } = setup();
  game.start(a.id);
  game.decide(a.id, 'C');
  game.decide(b.id, 'C');
  game.decide(c.id, 'C');
  const sealAt = game.current.sealAt;
  clock.advance(1000);
  game.decide(b.id, 'D');
  assert.equal(game.current.sealAt, sealAt);
  clock.advance(500);
  assert.equal(game.rounds[0].results[b.id].choice, 'D');
});

test('inactivo: 0 puntos, se calcula sin él y tras 2 fallos queda ausente', () => {
  const { game, clock, players: [a, b, c] } = setup();
  game.start(a.id);
  const seconds = game.config.roundSeconds * 1000;
  for (let round = 1; round <= 2; round += 1) {
    game.decide(a.id, 'C');
    game.decide(b.id, 'C');
    assert.deepEqual(game.waitingFor().map((p) => p.id), [c.id]);
    clock.advance(seconds);
    const r = game.rounds[round - 1];
    assert.equal(r.endedBy, 'timeout');
    assert.equal(r.participants, 2);
    assert.deepEqual(r.results[c.id], { choice: null, points: 0 });
    assert.equal(r.results[a.id].points, 3); // N = 2, no 3
    clock.advance(LIMITS.REVEAL_MS);
  }
  assert.equal(c.away, true);
  // Ronda 3: ya no se le espera.
  game.decide(a.id, 'D');
  game.decide(b.id, 'C');
  assert.notEqual(game.current.sealAt, null);
  clock.advance(LIMITS.GRACE_MS);
  assert.equal(game.rounds[2].endedBy, 'all');
  clock.advance(LIMITS.REVEAL_MS);
  // Vuelve decidiendo.
  game.decide(c.id, 'C');
  assert.equal(c.away, false);
  assert.equal(c.missed, 0);
});

test('llegada tarde: entra en la ronda siguiente con el promedio del grupo', () => {
  const { game, clock, players: [a, b] } = setup({ names: ['Ana', 'Beto'] });
  game.start(a.id);
  game.decide(a.id, 'D');
  game.decide(b.id, 'C');
  clock.advance(LIMITS.GRACE_MS); // Ana 5, Beto 0
  clock.advance(LIMITS.REVEAL_MS); // abre la ronda 2
  const d = game.addPlayer('Dani');
  assert.equal(d.late, true);
  assert.equal(d.joinRound, 3);
  const view = viewFor(game, d.id);
  assert.equal(view.me.canDecide, false);
  assert.equal(view.players[2].waitingToStart, true);
  assert.equal(view.players[2].score, null);
  assert.throws(() => game.decide(d.id, 'C'), { code: 'NOT_ELIGIBLE' });
  game.decide(a.id, 'C');
  game.decide(b.id, 'C');
  clock.advance(LIMITS.GRACE_MS); // Ana 8, Beto 3
  assert.equal(game.rounds[1].results[d.id], undefined);
  clock.advance(LIMITS.REVEAL_MS); // ronda 3
  assert.equal(d.pendingStart, false);
  assert.equal(d.startScore, Math.round((8 + 3) / 2));
  assert.equal(d.score, 6);
  assert.equal(viewFor(game, d.id).me.canDecide, true);
  const h = historyFor(game, d.id);
  assert.equal(h.players[2].joinRound, 3);
  assert.equal(h.players[2].late, true);
});

test('llegar durante la revelación entra en la ronda que viene justo después', () => {
  const { game, clock, players: [a, b] } = setup({ names: ['Ana', 'Beto'] });
  game.start(a.id);
  game.decide(a.id, 'C');
  game.decide(b.id, 'C');
  clock.advance(LIMITS.GRACE_MS);
  assert.equal(game.phase, 'reveal');
  const d = game.addPlayer('Dani');
  assert.equal(d.joinRound, 2);
  clock.advance(LIMITS.REVEAL_MS);
  assert.equal(game.current.eligible.has(d.id), true);
  assert.equal(d.score, 3);
});

test('final aleatorio: el sorteo ocurre al cerrar cada ronda desde el mínimo', () => {
  const draws = [0.9, 0.8, 0.1];
  const { game, clock, players: [a, b] } = setup({
    names: ['Ana', 'Beto'],
    config: { minRounds: 2, endChance: 0.25, roundSeconds: 10 },
    random: () => draws.shift(),
  });
  game.start(a.id);
  const play = () => {
    game.decide(a.id, 'C');
    game.decide(b.id, 'C');
    clock.advance(LIMITS.GRACE_MS);
  };
  play(); // ronda 1: no se sortea
  assert.equal(draws.length, 3);
  clock.advance(LIMITS.REVEAL_MS);
  play(); // ronda 2: 0.9 → sigue
  clock.advance(LIMITS.REVEAL_MS);
  play(); // ronda 3: 0.8 → sigue
  clock.advance(LIMITS.REVEAL_MS);
  play(); // ronda 4: 0.1 → termina
  assert.equal(game.status, 'finished');
  assert.equal(game.endReason, 'random');
  assert.equal(game.rounds.length, 4);
  assert.throws(() => game.addPlayer('Tarde'), { code: 'GAME_FINISHED' });
});

test('número fijo de rondas (endChance = 1)', () => {
  const { game, clock, players: [a, b] } = setup({ names: ['Ana', 'Beto'], config: { minRounds: 2, endChance: 1 } });
  game.start(a.id);
  for (let i = 0; i < 2; i += 1) {
    game.decide(a.id, 'D');
    game.decide(b.id, 'D');
    clock.advance(LIMITS.GRACE_MS + LIMITS.REVEAL_MS);
  }
  assert.equal(game.status, 'finished');
  assert.equal(game.endReason, 'fixed');
  assert.equal(a.score, 2);
});

test('si todos quedan ausentes la partida se pausa y "Estoy aquí" la reanuda', () => {
  const { game, clock, players: [a, b] } = setup({ names: ['Ana', 'Beto'] });
  game.start(a.id);
  clock.advance(game.config.roundSeconds * 1000 + LIMITS.REVEAL_MS);
  clock.advance(game.config.roundSeconds * 1000);
  assert.equal(game.phase, 'paused');
  assert.equal(clock.pending(), 0);
  game.back(b.id);
  assert.equal(game.phase, 'deciding');
  assert.equal(game.current.number, 3);
  assert.equal(b.away, false);
  assert.equal(a.away, true);
});

test('apodos: limpieza, duplicados sin distinguir tildes y máximo de jugadores', () => {
  const { game } = setup({ names: ['Ana'] });
  assert.throws(() => game.addPlayer('ána'), { code: 'NAME_TAKEN' });
  assert.throws(() => game.addPlayer('  \u200B '), { code: 'BAD_NAME' });
  assert.throws(() => game.addPlayer('x'.repeat(17)), { code: 'BAD_NAME' });
  assert.throws(() => game.addPlayer('Zoe', 'robot'), { code: 'BAD_KIND' });
  assert.equal(game.addPlayer('  Luz \u202E  Marina ').name, 'Luz Marina');
  for (let i = 3; i <= 10; i += 1) game.addPlayer(`Jugador ${i}`);
  assert.throws(() => game.addPlayer('Once'), { code: 'GAME_FULL' });
});

test('configuración y sala: solo el anfitrión; salir traspasa el anfitrión', () => {
  const { game, players: [a, b, c] } = setup();
  assert.throws(() => game.setConfig(a.id, { minRounds: 0 }), { code: 'BAD_CONFIG' });
  assert.throws(() => game.setConfig(a.id, { rondas: 5 }), { code: 'BAD_CONFIG' });
  assert.throws(() => game.setConfig(b.id, { minRounds: 5 }), { code: 'NOT_HOST' });
  game.setConfig(a.id, { minRounds: 5, roundSeconds: 45 });
  assert.deepEqual(game.config, { minRounds: 5, endChance: 0.25, roundSeconds: 45 });
  assert.throws(() => game.kick(a.id, a.id), { code: 'CANNOT_KICK_SELF' });
  game.kick(a.id, c.id);
  assert.equal(game.players.length, 2);
  assert.equal(game.leave(a.id), 'removed');
  assert.equal(game.hostId, b.id);
  assert.throws(() => game.start(b.id), { code: 'TOO_FEW_PLAYERS' });
});

test('revancha: misma configuración, idempotente, primer jugador de anfitrión', () => {
  const clock = fakeClock();
  const store = new GameStore({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const game = store.create({ minRounds: 1, endChance: 1, roundSeconds: 10 });
  const a = game.addPlayer('Ana');
  const b = game.addPlayer('Beto');
  assert.throws(() => store.rematch(game, a), { code: 'NOT_FINISHED' });
  game.start(a.id);
  game.decide(a.id, 'C');
  game.decide(b.id, 'D');
  clock.advance(LIMITS.GRACE_MS);
  assert.equal(game.status, 'finished');
  const first = store.rematch(game, b);
  const again = store.rematch(game, b);
  assert.equal(first.player.id, again.player.id);
  assert.equal(again.created, false);
  const second = store.rematch(game, a);
  assert.equal(second.game.code, first.game.code);
  assert.equal(first.game.hostId, first.player.id);
  assert.deepEqual(first.game.config, game.config);
  assert.equal(viewFor(game, a.id).rematchCode, first.game.code);
});
