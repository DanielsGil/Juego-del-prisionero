'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { GameStore } = require('./src/store');
const { GameError, LIMITS, DEFAULT_CONFIG, validateConfig, cleanName } = require('./src/game');
const { viewFor, historyFor } = require('./src/views');
const { PAYOFFS } = require('./src/payoff');

const API = '/api/v1';
const BODY_LIMIT = 8 * 1024;
const PING_MS = 20000;
const PRESENCE_MS = 5000;
const SWEEP_MS = 60000;
const STREAMS_PER_GAME = 60;
const STREAMS_TOTAL = 3000;
const MAX_BUFFERED = 1024 * 1024;
// [peticiones, ventana en ms] por IP. Generosos: una clase entera puede
// compartir la misma IP pública.
const DEFAULT_RATE_LIMITS = { read: [1200, 60000], write: [600, 60000], create: [60, 600000] };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// La API se puede usar desde cualquier origen (agentes, herramientas):
// la autenticación va en la cabecera Authorization, no en cookies.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const NOT_FOUND_HTML = '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No encontrado</title><body style="font-family:system-ui,sans-serif;padding:2rem"><h1>No encontrado</h1><p>Esta dirección no existe. <a href="/">Ir al inicio</a>.</p></body></html>';

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function httpError(status, code, message, headers) {
  const err = new GameError(status, code, message);
  if (headers) err.headers = headers;
  return err;
}

class RateLimiter {
  constructor(limits, now) {
    this.limits = limits;
    this.now = now;
    this.buckets = new Map();
  }

  // Devuelve null si se permite, o los segundos que hay que esperar.
  hit(kind, key) {
    const [limit, windowMs] = this.limits[kind];
    const id = `${kind}|${key}`;
    const now = this.now();
    let bucket = this.buckets.get(id);
    if (!bucket || now >= bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      this.buckets.set(id, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit ? null : Math.max(1, Math.ceil((bucket.reset - now) / 1000));
  }

  sweep() {
    const now = this.now();
    for (const [id, bucket] of this.buckets) if (now >= bucket.reset) this.buckets.delete(id);
  }
}

// Conexiones SSE abiertas, agrupadas por partida. Los cambios de una misma
// vuelta del bucle se agrupan en un único envío por cliente.
class Hub {
  constructor() {
    this.games = new Map();
    this.total = 0;
    this.pending = new Map();
    this.scheduled = false;
  }

  count(code) {
    const set = this.games.get(code);
    return set ? set.size : 0;
  }

  add(client) {
    let set = this.games.get(client.code);
    if (!set) this.games.set(client.code, (set = new Set()));
    set.add(client);
    this.total += 1;
  }

  remove(client) {
    const set = this.games.get(client.code);
    if (set && set.delete(client)) {
      this.total -= 1;
      if (!set.size) this.games.delete(client.code);
    }
  }

  notify(game, onlyId) {
    if (!this.games.has(game.code)) return;
    let entry = this.pending.get(game.code);
    if (!entry) this.pending.set(game.code, (entry = { game, all: false, ids: new Set() }));
    if (onlyId) entry.ids.add(onlyId);
    else entry.all = true;
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  flush() {
    this.scheduled = false;
    const pending = this.pending;
    this.pending = new Map();
    for (const { game, all, ids } of pending.values()) {
      const clients = this.games.get(game.code);
      if (!clients || game.destroyed) continue;
      const cache = new Map(); // una vista por espectador/jugador en cada envío
      for (const client of clients) {
        // Un cambio privado (cambio de opinión) solo genera tráfico para su dueño.
        if (!all && !(client.playerId && ids.has(client.playerId))) continue;
        const key = client.playerId || '';
        let payload = cache.get(key);
        if (!payload) {
          payload = frame('state', viewFor(game, client.playerId));
          cache.set(key, payload);
        }
        this.send(client, payload);
      }
    }
  }

  send(client, payload) {
    const { res } = client;
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > MAX_BUFFERED) {
      res.destroy(); // cliente demasiado lento: que se reconecte
      return;
    }
    res.write(payload);
  }

  ping(t) {
    const payload = frame('ping', { t });
    for (const set of this.games.values()) for (const client of set) this.send(client, payload);
  }

  closeGame(code, reason) {
    const set = this.games.get(code);
    if (!set) return;
    const payload = frame('gone', { reason });
    for (const client of [...set]) {
      this.send(client, payload);
      client.res.end();
      this.remove(client);
    }
  }

  closeAll(reason) {
    for (const code of [...this.games.keys()]) this.closeGame(code, reason);
  }
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconocida';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => httpError(413, 'TOO_LARGE', `El cuerpo de la petición supera ${BODY_LIMIT / 1024} KB.`, { Connection: 'close' });
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        failed = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        reject(httpError(400, 'BAD_JSON', 'El cuerpo de la petición no es JSON válido.'));
        return;
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        reject(httpError(400, 'BAD_JSON', 'El cuerpo de la petición debe ser un objeto JSON.'));
        return;
      }
      resolve(data);
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...CORS,
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof GameError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
    return;
  }
  console.error('Error inesperado:', err);
  sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Error interno del servidor. Inténtalo de nuevo.' } });
}

function apiIndex() {
  return {
    name: 'Dilema del prisionero multijugador',
    version: 1,
    auth: 'Authorization: Bearer <token>. El token se recibe al crear una partida o al unirse. En GET también vale ?token=.',
    choices: { C: 'cooperar', D: 'traicionar' },
    payoffs: PAYOFFS,
    defaults: DEFAULT_CONFIG,
    limits: {
      minPlayers: LIMITS.MIN_PLAYERS,
      maxPlayers: LIMITS.MAX_PLAYERS,
      nameMaxLength: LIMITS.NAME_MAX,
      minRounds: [LIMITS.MIN_ROUNDS_MIN, LIMITS.MIN_ROUNDS_MAX],
      endChance: [LIMITS.END_CHANCE_MIN, LIMITS.END_CHANCE_MAX],
      roundSeconds: [LIMITS.ROUND_SECONDS_MIN, LIMITS.ROUND_SECONDS_MAX],
    },
    endpoints: [
      'GET    /api/v1/health',
      'POST   /api/v1/games                    {name, kind?, config?}',
      'POST   /api/v1/games/{code}/join        {name, kind?}',
      'GET    /api/v1/games/{code}/state',
      'GET    /api/v1/games/{code}/history',
      'GET    /api/v1/games/{code}/stream      (Server-Sent Events)',
      'POST   /api/v1/games/{code}/decision    {choice: "C"|"D", round?}',
      'PATCH  /api/v1/games/{code}/config      {minRounds?, endChance?, roundSeconds?}  (anfitrión)',
      'POST   /api/v1/games/{code}/start       (anfitrión)',
      'POST   /api/v1/games/{code}/back',
      'POST   /api/v1/games/{code}/leave',
      'POST   /api/v1/games/{code}/kick        {playerId}  (anfitrión)',
      'POST   /api/v1/games/{code}/rematch',
    ],
  };
}

function createStatic(dir, production) {
  const root = path.resolve(dir);
  const cache = new Map();
  function load(urlPath) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (rel.includes('\0') || rel.split('/').some((part) => part.startsWith('.'))) return null;
    const full = path.resolve(root, `.${rel}`);
    if (!full.startsWith(root + path.sep)) return null;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const body = fs.readFileSync(full);
    return {
      body,
      type: MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
      immutable: rel.startsWith('/fonts/'),
    };
  }
  return (urlPath) => {
    if (!production) return load(urlPath); // en desarrollo, siempre fresco
    if (cache.has(urlPath)) return cache.get(urlPath);
    const file = load(urlPath);
    if (file) cache.set(urlPath, file);
    return file;
  };
}

function createServer(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const now = options.now || Date.now;
  const limiter = options.rateLimits === false
    ? null
    : new RateLimiter({ ...DEFAULT_RATE_LIMITS, ...(options.rateLimits || {}) }, now);
  const hub = new Hub();
  const store = new GameStore({
    now,
    random: options.random,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    maxGames: options.maxGames,
    onChange: (game, onlyId) => hub.notify(game, onlyId),
    onDelete: (game, reason) => hub.closeGame(game.code, reason),
  });
  const getStatic = createStatic(options.publicDir || path.join(__dirname, 'public'), production);

  function requireAuth(game, req) {
    const token = bearerToken(req);
    if (!token) throw httpError(401, 'UNAUTHORIZED', 'Falta el token del jugador: envía la cabecera Authorization: Bearer <token>.');
    const player = game.playerByToken(token);
    if (!player) throw httpError(403, 'BAD_TOKEN', 'Ese token no corresponde a ningún jugador de esta partida.');
    game.seen(player.id);
    return player;
  }

  // En lecturas el token es opcional: sin token (o con uno ajeno) se recibe
  // la vista de espectador, con me = null.
  function optionalViewer(game, req, url) {
    const token = bearerToken(req) || url.searchParams.get('token');
    const player = token ? game.playerByToken(token) : null;
    if (player) game.seen(player.id);
    return player;
  }

  function credentials(game, player) {
    return { code: game.code, playerId: player.id, token: player.token, state: viewFor(game, player.id) };
  }

  function openStream(req, res, game, viewer) {
    if (hub.count(game.code) >= STREAMS_PER_GAME || hub.total >= STREAMS_TOTAL) {
      throw httpError(503, 'TOO_MANY_STREAMS', 'Hay demasiadas conexiones en vivo abiertas. Consulta el estado periódicamente.');
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS,
      ...SECURITY_HEADERS,
    });
    const client = { res, code: game.code, playerId: viewer ? viewer.id : null };
    hub.add(client);
    res.write('retry: 3000\n\n');
    res.write(frame('state', viewFor(game, client.playerId)));
    game.attachStream(client.playerId);
    res.on('close', () => {
      hub.remove(client);
      game.detachStream(client.playerId);
    });
  }

  async function handleApi(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, ...SECURITY_HEADERS });
      res.end();
      return;
    }
    if (url.pathname !== API && !url.pathname.startsWith(`${API}/`)) {
      throw httpError(404, 'NOT_FOUND', 'Ruta de API desconocida. Consulta GET /api/v1.');
    }
    const parts = url.pathname.slice(API.length).split('/').filter(Boolean);
    const method = req.method;
    const isRead = method === 'GET' || method === 'HEAD';

    if (limiter) {
      const ip = clientIp(req);
      const creating = method === 'POST' && parts.length === 1 && parts[0] === 'games';
      const wait = limiter.hit(isRead ? 'read' : 'write', ip) ?? (creating ? limiter.hit('create', ip) : null);
      if (wait) {
        throw httpError(429, 'RATE_LIMITED', `Demasiadas peticiones seguidas. Espera ${wait} s y vuelve a intentarlo.`, { 'Retry-After': String(wait) });
      }
    }

    const allow = (...methods) => {
      if (!methods.includes(method)) {
        throw httpError(405, 'METHOD_NOT_ALLOWED', `Esta ruta acepta ${methods.join(' o ')}.`, { Allow: methods.join(', ') });
      }
    };
    const notFound = () => httpError(404, 'NOT_FOUND', 'Ruta de API desconocida. Consulta GET /api/v1.');

    if (parts.length === 0) {
      allow('GET');
      sendJson(res, 200, apiIndex());
      return;
    }
    if (parts[0] === 'health' && parts.length === 1) {
      allow('GET');
      sendJson(res, 200, { ok: true, games: store.games.size, streams: hub.total, uptime: Math.round(process.uptime()) });
      return;
    }
    if (parts[0] !== 'games' || parts.length > 3) throw notFound();

    if (parts.length === 1) {
      allow('POST');
      const body = await readBody(req);
      cleanName(body.name); // validar antes de crear nada
      validateConfig(body.config);
      const game = store.create(body.config);
      let player;
      try {
        player = game.addPlayer(body.name, body.kind);
      } catch (err) {
        store.delete(game.code, 'aborted');
        throw err;
      }
      game.seen(player.id);
      sendJson(res, 201, credentials(game, player));
      return;
    }

    const game = store.require(parts[1]);
    const action = parts[2] || 'state';

    if (action === 'state') {
      allow('GET');
      const viewer = optionalViewer(game, req, url);
      sendJson(res, 200, viewFor(game, viewer ? viewer.id : null));
      return;
    }
    if (action === 'history') {
      allow('GET');
      const viewer = optionalViewer(game, req, url);
      sendJson(res, 200, historyFor(game, viewer ? viewer.id : null));
      return;
    }
    if (action === 'stream') {
      allow('GET');
      openStream(req, res, game, optionalViewer(game, req, url));
      return;
    }

    const known = ['join', 'config', 'start', 'decision', 'back', 'leave', 'kick', 'rematch'];
    if (!known.includes(action)) throw notFound();
    if (action === 'config') allow('PATCH', 'POST');
    else allow('POST');
    const body = await readBody(req);

    if (action === 'join') {
      const player = game.addPlayer(body.name, body.kind);
      game.seen(player.id);
      sendJson(res, 201, credentials(game, player));
      return;
    }

    const player = requireAuth(game, req);
    switch (action) {
      case 'config': {
        game.setConfig(player.id, body.config !== undefined ? body.config : body);
        sendJson(res, 200, { config: game.config, state: viewFor(game, player.id) });
        return;
      }
      case 'start':
        game.start(player.id);
        sendJson(res, 200, { state: viewFor(game, player.id) });
        return;
      case 'decision': {
        const choice = game.decide(player.id, body.choice, body.round);
        sendJson(res, 200, { ok: true, choice, state: viewFor(game, player.id) });
        return;
      }
      case 'back':
        game.back(player.id);
        sendJson(res, 200, { state: viewFor(game, player.id) });
        return;
      case 'leave': {
        const result = game.leave(player.id);
        const state = result === 'removed' ? null : viewFor(game, player.id);
        if (game.players.length === 0) store.delete(game.code, 'empty');
        sendJson(res, 200, { ok: true, result, state });
        return;
      }
      case 'kick':
        game.kick(player.id, body.playerId);
        sendJson(res, 200, { state: viewFor(game, player.id) });
        return;
      case 'rematch': {
        const { game: next, player: joined, created } = store.rematch(game, player);
        next.seen(joined.id);
        sendJson(res, created ? 201 : 200, credentials(next, joined));
        return;
      }
      default:
        throw notFound();
    }
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    let urlPath = url.pathname;
    if (urlPath === '/' || /^\/p\/[A-Za-z0-9]{1,12}\/?$/.test(urlPath)) urlPath = '/index.html';
    const file = getStatic(urlPath);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : NOT_FOUND_HTML);
      return;
    }
    const headers = {
      'Content-Type': file.type,
      ETag: file.etag,
      'Cache-Control': !production ? 'no-store' : file.immutable ? 'public, max-age=2592000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    };
    if (file.type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    if (production && req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = file.body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      res.end();
      return;
    }
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65000; // mayor que el del balanceador de Render
  server.headersTimeout = 66000;

  const intervals = [
    setInterval(() => hub.ping(now()), PING_MS),
    setInterval(() => { for (const game of store.games.values()) game.checkPresence(); }, PRESENCE_MS),
    setInterval(() => {
      store.sweep();
      if (limiter) limiter.sweep();
    }, SWEEP_MS),
  ];
  for (const interval of intervals) interval.unref();

  let stopped = false;
  function stop() {
    if (!stopped) {
      stopped = true;
      for (const interval of intervals) clearInterval(interval);
      hub.closeAll('shutdown');
      store.destroyAll('shutdown');
    }
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      const force = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, 1000);
      force.unref();
    });
  }

  server.app = { store, hub, stop };
  return server;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  }
  return out;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Dilema del prisionero listo en http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  En tu red local: http://${ip}:${port}`);
  });
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: cerrando el servidor…`);
    server.app.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer };
