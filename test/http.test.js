'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');

function request(port, method, path, { body, token, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data !== null) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function openStream(port, path) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ port, path, headers: { Accept: 'text/event-stream' } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      });
      resolve({ res, events, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Tiempo de espera agotado');
}

test('API y SSE de extremo a extremo', async (t) => {
  const server = createServer({ rateLimits: false, production: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => server.app.stop());

  const index = await request(port, 'GET', '/api/v1');
  assert.equal(index.status, 200);
  assert.ok(index.json.endpoints.length > 5);

  const bad = await request(port, 'POST', '/api/v1/games', { raw: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'BAD_JSON');

  const created = await request(port, 'POST', '/api/v1/games', { body: { name: 'Ana' } });
  assert.equal(created.status, 201);
  const { code, token: tokenA, playerId: idA } = created.json;
  assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(created.json.state.me.host, true);

  const joined = await request(port, 'POST', `/api/v1/games/${code.toLowerCase()}/join`, { body: { name: 'Beto', kind: 'agent' } });
  assert.equal(joined.status, 201);
  const { token: tokenB, playerId: idB } = joined.json;

  const dup = await request(port, 'POST', `/api/v1/games/${code}/join`, { body: { name: 'BETO' } });
  assert.equal(dup.json.error.code, 'NAME_TAKEN');

  const notHost = await request(port, 'POST', `/api/v1/games/${code}/start`, { token: tokenB });
  assert.equal(notHost.status, 403);
  const noToken = await request(port, 'POST', `/api/v1/games/${code}/start`);
  assert.equal(noToken.status, 401);
  const wrongToken = await request(port, 'POST', `/api/v1/games/${code}/start`, { token: 'x'.repeat(32) });
  assert.equal(wrongToken.json.error.code, 'BAD_TOKEN');

  const cfg = await request(port, 'PATCH', `/api/v1/games/${code}/config`, { token: tokenA, body: { roundSeconds: 20 } });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.config.roundSeconds, 20);

  const started = await request(port, 'POST', `/api/v1/games/${code}/start`, { token: tokenA });
  assert.equal(started.status, 200);
  assert.equal(started.json.state.round.number, 1);

  const streamB = await openStream(port, `/api/v1/games/${code}/stream?token=${tokenB}`);
  t.after(() => streamB.close());
  const spectator = await openStream(port, `/api/v1/games/${code}/stream`);
  t.after(() => spectator.close());
  await waitFor(() => streamB.events.length && spectator.events.length);
  assert.equal(streamB.events[0].data.me.id, idB);
  assert.equal(spectator.events[0].data.me, null);

  // Ana decide: los demás reciben un evento que dice que decidió, no qué.
  const firstA = await request(port, 'POST', `/api/v1/games/${code}/decision`, { token: tokenA, body: { choice: 'C', round: 1 } });
  assert.equal(firstA.json.state.me.choice, 'C');
  const afterFirst = await waitFor(() => streamB.events.find((e) => e.event === 'state' && e.data.round && e.data.round.decided.includes(idA)));
  assert.equal(afterFirst.data.me.choice, null);
  await sleep(150);
  const countB = streamB.events.length;
  const countSpectator = spectator.events.length;

  // Ana cambia de opinión: ni Beto ni el espectador reciben NADA.
  const change = await request(port, 'POST', `/api/v1/games/${code}/decision`, { token: tokenA, body: { choice: 'traicionar' } });
  assert.equal(change.json.choice, 'D');
  await sleep(300);
  assert.equal(streamB.events.length, countB);
  assert.equal(spectator.events.length, countSpectator);
  for (const e of [...streamB.events, ...spectator.events]) {
    if (e.data.round) assert.ok(!JSON.stringify(e.data).includes('"choice":"D"'));
  }

  // La vista por SSE coincide con GET /state (salvo la hora del servidor).
  const polled = await request(port, 'GET', `/api/v1/games/${code}/state`, { token: tokenB });
  const lastB = streamB.events.filter((e) => e.event === 'state').at(-1).data;
  assert.deepEqual({ ...polled.json, serverTime: 0 }, { ...lastB, serverTime: 0 });

  const wrongRound = await request(port, 'POST', `/api/v1/games/${code}/decision`, { token: tokenB, body: { choice: 'C', round: 7 } });
  assert.equal(wrongRound.json.error.code, 'WRONG_ROUND');
  const badChoice = await request(port, 'POST', `/api/v1/games/${code}/decision`, { token: tokenB, body: { choice: 'quizás' } });
  assert.equal(badChoice.json.error.code, 'BAD_CHOICE');

  await request(port, 'POST', `/api/v1/games/${code}/decision`, { token: tokenB, body: { choice: 'C' } });
  const revealed = await waitFor(() => streamB.events.find((e) => e.event === 'state' && e.data.history.length === 1), 4000);
  assert.equal(revealed.data.phase, 'reveal');
  assert.deepEqual(revealed.data.history[0].results[idA], { choice: 'D', points: 5 });
  assert.deepEqual(revealed.data.history[0].results[idB], { choice: 'C', points: 0 });

  const history = await request(port, 'GET', `/api/v1/games/${code}/history`, { token: tokenB });
  assert.equal(history.json.rounds.length, 1);
  assert.equal(history.json.players.find((p) => p.id === idA).score, 5);

  const missing = await request(port, 'GET', '/api/v1/games/ZZZZZ/state');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('archivos estáticos, rutas de partida y cabeceras de seguridad', async (t) => {
  const server = createServer({ rateLimits: false, production: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => server.app.stop());

  for (const path of ['/', '/p/K7QX2']) {
    const res = await request(port, 'GET', path);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
  const js = await request(port, 'GET', '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  const font = await request(port, 'GET', '/fonts/pd-cond-bold.woff');
  assert.equal(font.status, 200);
  assert.match(font.headers['cache-control'], /immutable/);
  const traversal = await request(port, 'GET', '/..%2fserver.js');
  assert.equal(traversal.status, 404);
  const health = await request(port, 'GET', '/api/v1/health');
  assert.equal(health.json.ok, true);
});

test('límite de peticiones por IP', async (t) => {
  const server = createServer({ production: false, rateLimits: { read: [3, 60000] } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => server.app.stop());
  for (let i = 0; i < 3; i += 1) assert.equal((await request(port, 'GET', '/api/v1/health')).status, 200);
  const limited = await request(port, 'GET', '/api/v1/health');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});
