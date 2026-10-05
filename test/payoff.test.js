'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { payoff, roundPayoffs, payoffTable, T, R, P, S } = require('../src/payoff');

test('valores de Axelrod y condiciones del dilema por parejas', () => {
  assert.deepEqual([T, R, P, S], [5, 3, 1, 0]);
  assert.ok(T > R && R > P && P > S);
  assert.ok(2 * R > T + S); // cooperar siempre supera alternarse
});

test('traicionar siempre da más, para 2 a 10 jugadores y cualquier k', () => {
  for (let n = 2; n <= 10; n += 1) {
    for (let k = 0; k <= n - 1; k += 1) {
      const c = payoff('C', k, n);
      const d = payoff('D', k, n);
      assert.equal(c, 3 * k);
      assert.equal(d, 4 * k + (n - 1));
      assert.equal(d - c, k + n - 1);
      assert.ok(d > c, `n=${n} k=${k}`);
    }
  }
});

test('todos cooperan gana más que todos traicionan (el triple)', () => {
  for (let n = 2; n <= 10; n += 1) {
    const allC = payoff('C', n - 1, n);
    const allD = payoff('D', 0, n);
    assert.equal(allC, 3 * (n - 1));
    assert.equal(allD, n - 1);
    assert.ok(allC > allD);
  }
});

test('coincide con sumar los duelos por parejas contra cada rival', () => {
  const duel = (me, other) => ({ CC: R, CD: S, DC: T, DD: P })[me + other];
  for (let n = 2; n <= 7; n += 1) {
    for (let mask = 0; mask < 2 ** n; mask += 1) {
      const choices = new Map();
      for (let i = 0; i < n; i += 1) choices.set(`p${i}`, (mask >> i) & 1 ? 'D' : 'C');
      const got = roundPayoffs(choices);
      for (const [id, mine] of choices) {
        let expected = 0;
        for (const [other, theirs] of choices) if (other !== id) expected += duel(mine, theirs);
        assert.equal(got.get(id), expected);
      }
    }
  }
});

test('el bienestar total crece con cada cooperador adicional', () => {
  for (let n = 2; n <= 10; n += 1) {
    let previous = -Infinity;
    for (let c = 0; c <= n; c += 1) {
      const cooperatorsGet = c > 0 ? c * payoff('C', c - 1, n) : 0;
      const defectorsGet = c < n ? (n - c) * payoff('D', c, n) : 0;
      const total = cooperatorsGet + defectorsGet;
      assert.ok(total >= previous);
      previous = total;
    }
  }
});

test('ejemplos del README para 3, 4 y 6 jugadores', () => {
  const pairs = (n) => payoffTable(n).map((r) => [r.cooperate, r.defect]);
  assert.deepEqual(pairs(3), [[0, 2], [3, 6], [6, 10]]);
  assert.deepEqual(pairs(4), [[0, 3], [3, 7], [6, 11], [9, 15]]);
  assert.deepEqual(pairs(6), [[0, 5], [3, 9], [6, 13], [9, 17], [12, 21], [15, 25]]);
  const mixed = roundPayoffs(new Map([['a', 'C'], ['b', 'C'], ['c', 'D'], ['d', 'D']]));
  assert.deepEqual([...mixed.values()], [3, 3, 11, 11]);
});
