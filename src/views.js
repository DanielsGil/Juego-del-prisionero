'use strict';

const { PAYOFFS } = require('./payoff');
const { LIMITS } = require('./game');

// ÚNICA función que construye lo que un cliente puede ver de una partida.
// Todo lo que sale del servidor (REST, SSE, historial) pasa por aquí.
// De la ronda abierta solo publica QUIÉN decidió; QUÉ decidió cada uno solo
// lo ve su dueño (me.choice) hasta que la ronda se revela.
function viewFor(game, viewerId = null) {
  const cur = game.phase === 'deciding' ? game.current : null;
  const viewer = viewerId ? game.byId.get(viewerId) || null : null;

  const players = game.players.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    host: p.id === game.hostId,
    late: p.late,
    joinRound: p.joinRound,
    waitingToStart: p.pendingStart,
    startScore: p.startScore,
    score: p.score,
    away: p.away,
    online: game.isOnline(p.id),
    decided: cur && cur.eligible.has(p.id) ? cur.choices.has(p.id) : null,
  }));

  const round = cur ? {
    number: cur.number,
    openedAt: cur.openedAt,
    deadline: cur.deadline,
    sealAt: cur.sealAt,
    eligible: game.players.filter((p) => cur.eligible.has(p.id)).map((p) => p.id),
    // En orden de jugadores, no de decisión, para no revelar quién eligió antes.
    decided: game.players.filter((p) => cur.choices.has(p.id)).map((p) => p.id),
    waitingFor: game.waitingFor().map((p) => p.id),
  } : null;

  const history = game.rounds.map((r) => ({
    number: r.number,
    endedBy: r.endedBy,
    participants: r.participants,
    cooperators: r.cooperators,
    results: Object.fromEntries(Object.entries(r.results).map(([id, x]) => [id, { choice: x.choice, points: x.points }])),
  }));

  return {
    code: game.code,
    status: game.status,
    phase: game.phase,
    rev: game.rev,
    serverTime: game.now(),
    config: { ...game.config },
    rules: {
      payoffs: { ...PAYOFFS },
      minPlayers: LIMITS.MIN_PLAYERS,
      maxPlayers: LIMITS.MAX_PLAYERS,
      missesToAway: LIMITS.MISSES_TO_AWAY,
      revealSeconds: LIMITS.REVEAL_MS / 1000,
      graceSeconds: LIMITS.GRACE_MS / 1000,
    },
    hostId: game.hostId,
    players,
    round,
    nextRoundAt: game.nextRoundAt,
    history,
    endReason: game.endReason,
    finishedAt: game.finishedAt,
    rematchCode: game.rematchCode,
    me: viewer ? {
      id: viewer.id,
      name: viewer.name,
      kind: viewer.kind,
      host: viewer.id === game.hostId,
      rev: viewer.rev,
      away: viewer.away,
      canDecide: Boolean(cur && cur.eligible.has(viewer.id)),
      choice: cur ? cur.choices.get(viewer.id) || null : null,
    } : null,
  };
}

// Historial completo pensado para agentes: derivado de viewFor, así que
// no puede mostrar nada que la vista no muestre.
function historyFor(game, viewerId = null) {
  const view = viewFor(game, viewerId);
  return {
    code: view.code,
    status: view.status,
    phase: view.phase,
    rev: view.rev,
    serverTime: view.serverTime,
    config: view.config,
    rules: view.rules,
    currentRound: view.round ? view.round.number : null,
    players: view.players.map(({ id, name, kind, late, joinRound, waitingToStart, startScore, score, away }) => ({
      id, name, kind, late, joinRound, waitingToStart, startScore, score, away,
    })),
    rounds: view.history,
    endReason: view.endReason,
    me: view.me,
  };
}

module.exports = { viewFor, historyFor };
