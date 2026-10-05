'use strict';

// Dilema del prisionero por parejas con los valores clásicos de Axelrod.
// En cada ronda, cada jugador "juega" contra todos sus rivales con una sola
// decisión y se suman los resultados de esos duelos:
//
//                      el rival coopera   el rival traiciona
//   yo coopero               R = 3             S = 0
//   yo traiciono             T = 5             P = 1
//
// Con N jugadores que decidieron y k rivales que cooperaron:
//   cooperar   = 3k
//   traicionar = 5k + 1·(N − 1 − k) = 4k + (N − 1)
//
// Traicionar siempre da k + N − 1 ≥ 1 punto más (condición 1), y si todos
// cooperan cada uno gana 3(N − 1), el triple que si todos traicionan (N − 1)
// (condición 2). Con N = 2 es exactamente el dilema clásico.

const T = 5; // tentación: yo traiciono, el rival coopera
const R = 3; // recompensa: ambos cooperan
const P = 1; // castigo: ambos traicionan
const S = 0; // ingenuo: yo coopero, el rival traiciona

const PAYOFFS = Object.freeze({ T, R, P, S });

function payoff(choice, k, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n debe ser un entero ≥ 1 (recibido ${n})`);
  if (!Number.isInteger(k) || k < 0 || k > n - 1) throw new RangeError(`k debe estar entre 0 y ${n - 1} (recibido ${k})`);
  const defectors = n - 1 - k;
  if (choice === 'C') return R * k + S * defectors;
  if (choice === 'D') return T * k + P * defectors;
  throw new TypeError(`Decisión desconocida: ${choice}`);
}

// choices: Map<playerId, 'C' | 'D'> solo con quienes decidieron en la ronda.
// Devuelve Map<playerId, puntos>.
function roundPayoffs(choices) {
  const n = choices.size;
  let cooperators = 0;
  for (const choice of choices.values()) if (choice === 'C') cooperators += 1;
  const result = new Map();
  for (const [id, choice] of choices) {
    const k = choice === 'C' ? cooperators - 1 : cooperators;
    result.set(id, payoff(choice, k, n));
  }
  return result;
}

// Tabla de pagos para N jugadores: una fila por cada número posible de
// rivales que cooperan.
function payoffTable(n) {
  const rows = [];
  for (let k = 0; k <= n - 1; k += 1) {
    rows.push({ k, cooperate: payoff('C', k, n), defect: payoff('D', k, n) });
  }
  return rows;
}

module.exports = { T, R, P, S, PAYOFFS, payoff, roundPayoffs, payoffTable };
