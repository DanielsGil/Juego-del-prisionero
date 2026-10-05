/* Dilema del prisionero: cliente sin frameworks.
   El servidor es la única fuente de verdad; aquí solo se pinta la vista que
   el servidor preparó para este jugador (o espectador) y se envían acciones. */
(() => {
  'use strict';

  const API = '/api/v1';
  const NBSP = '\u00A0';
  const root = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const announcer = document.getElementById('announcer');
  const $ = (id) => document.getElementById(id);

  // ---------- utilidades ----------

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const pct = (x) => `${Math.round(x * 100)}${NBSP}%`;
  const plural = (n, one, many) => `${n}${NBSP}${n === 1 ? one : many}`;
  const playerMap = (s) => new Map(s.players.map((p) => [p.id, p]));

  function tilt(id, round) {
    let h = 7;
    for (const ch of `${id}:${round}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const deg = (Math.abs(h) % 5) + 2;
    return h & 1 ? deg : -deg;
  }

  function storageArea(name) {
    try { return window[name]; } catch { return null; }
  }
  const LOCAL = storageArea('localStorage');
  const SESSION = storageArea('sessionStorage');
  function readJson(area, key) {
    try { return area ? JSON.parse(area.getItem(key)) : null; } catch { return null; }
  }
  function writeJson(area, key, value) {
    try { if (area) area.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento no disponible */ }
  }
  function removeKey(area, key) {
    try { if (area) area.removeItem(key); } catch { /* almacenamiento no disponible */ }
  }

  // Sesión por pestaña (sessionStorage) + sesiones recordadas (localStorage)
  // para ofrecer "Continuar como…" al volver a abrir el enlace.
  const sessions = {
    all: () => readJson(LOCAL, 'pd:sessions') || {},
    tab: (code) => readJson(SESSION, `pd:tab:${code}`),
    saved(code) { return this.all()[code] || null; },
    save(code, s) {
      writeJson(SESSION, `pd:tab:${code}`, s);
      const all = this.all();
      all[code] = { ...s, at: Date.now() };
      const newest = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 20);
      writeJson(LOCAL, 'pd:sessions', Object.fromEntries(newest));
    },
    forget(code) {
      removeKey(SESSION, `pd:tab:${code}`);
      const all = this.all();
      delete all[code];
      writeJson(LOCAL, 'pd:sessions', all);
    },
  };
  const nick = {
    get: () => readJson(LOCAL, 'pd:nick') || '',
    set: (v) => writeJson(LOCAL, 'pd:nick', v),
  };

  async function api(method, path, body, token) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(API + path, {
        method, headers, cache: 'no-store',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.'), { code: 'NETWORK' });
    }
    let data = null;
    try { data = await res.json(); } catch { /* respuesta sin JSON */ }
    if (!res.ok) {
      const e = data && data.error
        ? data.error
        : { code: `HTTP_${res.status}`, message: 'El servidor respondió con un error. Inténtalo de nuevo.' };
      throw Object.assign(new Error(e.message), { code: e.code, status: res.status });
    }
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  function announce(message) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = message; }, 60);
  }

  // Reemplaza el contenido de una región solo si cambió, y devuelve el foco
  // al control equivalente (data-key) para no perderlo al redibujar.
  function patch(target, html) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el || el.__html === html) return false;
    const active = document.activeElement;
    const key = active && el.contains(active) && active.dataset ? active.dataset.key : null;
    el.innerHTML = html;
    el.__html = html;
    if (key) {
      const again = el.querySelector(`[data-key="${key}"]`);
      if (again) again.focus({ preventScroll: true });
    }
    return true;
  }

  // ---------- estado de la app ----------

  const app = {
    view: null,
    shown: null,
    code: null,
    session: null,
    state: null,
    offset: 0,
    joinInfo: null,
    joinFailed: '',
    joinError: '',
    notice: '',
    homeErrors: {},
    busy: false,
    es: null,
    live: false,
    streamOk: false,
    lastMsg: 0,
    pollTimer: null,
    reconnectTimer: null,
    watchdog: null,
    sending: false,
    queued: null,
    optimistic: null,
    revealAnim: { key: '', animate: false },
    seenRound: 0,
    histCount: 0,
  };

  function resetGame() {
    app.state = null;
    app.joinInfo = null;
    app.joinFailed = '';
    app.joinError = '';
    app.notice = '';
    app.queued = null;
    app.optimistic = null;
    app.revealAnim = { key: '', animate: false };
    app.seenRound = 0;
    app.histCount = 0;
  }

  // ---------- rutas ----------

  function parseRoute() {
    const m = /^\/p\/([A-Za-z0-9]{1,12})\/?$/.exec(location.pathname);
    if (!m) return { name: 'home' };
    return { name: 'game', code: m[1].toUpperCase(), spectate: new URLSearchParams(location.search).has('ver') };
  }

  function go(path) {
    history.pushState(null, '', path);
    route();
  }

  function route() {
    const r = parseRoute();
    if (r.name === 'home') {
      disconnect();
      resetGame();
      app.code = null;
      app.session = null;
      app.view = 'home';
      document.title = 'Dilema del prisionero';
      render();
      return;
    }
    if (r.spectate) {
      openGame(r.code, null);
      return;
    }
    const tab = sessions.tab(r.code);
    if (tab) openGame(r.code, tab);
    else showJoin(r.code);
  }

  function openGame(code, session, state) {
    disconnect();
    resetGame();
    app.code = code;
    app.session = session;
    app.view = 'game';
    document.title = `${code} | Dilema del prisionero`;
    render();
    if (state) applyState(state);
    else loadState();
    connect();
  }

  async function showJoin(code, notice = '') {
    disconnect();
    resetGame();
    app.code = code;
    app.session = null;
    app.notice = notice;
    app.view = 'join';
    document.title = `Unirse a ${code} | Dilema del prisionero`;
    render();
    try {
      const info = await api('GET', `/games/${code}/state`);
      if (app.view !== 'join' || app.code !== code) return;
      app.joinInfo = info;
    } catch (err) {
      if (app.view !== 'join' || app.code !== code) return;
      if (err.code === 'NOT_FOUND') {
        showMissing(`No existe ninguna partida con el código ${code}. Revisa que esté bien escrito o crea una nueva.`);
        return;
      }
      app.joinFailed = err.message;
    }
    render();
  }

  function showMissing(text) {
    disconnect();
    resetGame();
    app.view = 'missing';
    app.notice = text;
    document.title = 'Partida no disponible | Dilema del prisionero';
    render();
  }

  const GONE = {
    expired: 'Esta partida se cerró por inactividad.',
    empty: 'La sala quedó vacía y se cerró.',
    shutdown: 'El servidor se reinició y las partidas que estaban abiertas se perdieron.',
    missing: 'Esta partida ya no existe.',
  };

  function gameGone(reason) {
    if (app.code) sessions.forget(app.code);
    showMissing(`${GONE[reason] || GONE.missing} Puedes crear una nueva desde el inicio.`);
  }

  function sessionLost() {
    const code = app.code;
    sessions.forget(code);
    showJoin(code, 'Ya no estás en esta partida: saliste de la sala o el anfitrión te sacó. Puedes volver a unirte.');
  }

  // ---------- conexión en vivo ----------
  // SSE (servidor → cliente) para recibir el estado; si la conexión cae,
  // consultas cada 2 s hasta que se recupere.

  function connect() {
    disconnect();
    app.live = true;
    app.lastMsg = Date.now();
    if (!('EventSource' in window)) {
      startPolling();
      return;
    }
    const token = app.session && app.session.token;
    const url = `${API}/games/${app.code}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSource(url);
    app.es = es;
    const alive = () => {
      app.lastMsg = Date.now();
      if (!app.streamOk) {
        app.streamOk = true;
        stopPolling();
        if (app.state) renderBanners(app.state);
      }
    };
    es.addEventListener('open', alive);
    es.addEventListener('ping', alive);
    es.addEventListener('state', (e) => {
      alive();
      let s = null;
      try { s = JSON.parse(e.data); } catch { return; }
      applyState(s);
    });
    es.addEventListener('gone', (e) => {
      let reason = 'missing';
      try { reason = JSON.parse(e.data).reason; } catch { /* sin motivo */ }
      gameGone(reason);
    });
    es.addEventListener('error', () => {
      if (app.es !== es) return;
      app.streamOk = false;
      if (app.state && app.view === 'game') renderBanners(app.state);
      startPolling();
      if (es.readyState === 2) scheduleReconnect(); // el navegador ya no reintentará
    });
    app.watchdog = setInterval(() => {
      if (app.live && Date.now() - app.lastMsg > 50000) connect(); // conexión muerta sin aviso
    }, 10000);
  }

  function scheduleReconnect() {
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = setTimeout(() => { if (app.live) connect(); }, 15000);
  }

  function disconnect() {
    app.live = false;
    app.streamOk = false;
    if (app.es) app.es.close();
    app.es = null;
    stopPolling();
    clearTimeout(app.reconnectTimer);
    clearInterval(app.watchdog);
    app.watchdog = null;
  }

  function startPolling() {
    if (app.pollTimer) return;
    app.pollTimer = setInterval(loadState, 2000);
    loadState();
  }

  function stopPolling() {
    clearInterval(app.pollTimer);
    app.pollTimer = null;
  }

  async function loadState() {
    const code = app.code;
    if (!code || app.view !== 'game') return;
    try {
      const s = await api('GET', `/games/${code}/state`, undefined, app.session && app.session.token);
      if (app.code === code && app.view === 'game') applyState(s);
    } catch (err) {
      if (err.code === 'NOT_FOUND' && app.code === code && app.view === 'game') gameGone('missing');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !app.live) return;
    loadState();
    if (!app.es || app.es.readyState === 2) connect();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && app.view === 'game') {
      loadState();
      connect();
    }
  });
  window.addEventListener('popstate', route);

  function applyState(s) {
    if (!s || s.code !== app.code || app.view !== 'game') return;
    const prev = app.state;
    if (prev) {
      // Las respuestas pueden llegar desordenadas (SSE, consultas, POST).
      if (s.rev < prev.rev) return;
      if (s.rev === prev.rev && s.me && prev.me && s.me.rev < prev.me.rev) return;
    }
    app.offset = s.serverTime - Date.now();
    app.state = s;
    if (app.session && !s.me) {
      sessionLost();
      return;
    }
    if (app.optimistic && (!s.round || s.round.number !== app.optimistic.round || !s.me || !s.me.canDecide)) {
      app.optimistic = null;
    }
    afterState(prev, s);
    render();
  }

  function afterState(prev, s) {
    const notes = [];
    const grew = prev && s.history.length > prev.history.length;
    if (grew) {
      const last = s.history[s.history.length - 1];
      app.revealAnim = { key: `${s.code}:${last.number}`, animate: true };
      notes.push(`Ronda ${last.number} revelada. ${youText(s, last) || coopText(last)}`);
    }
    if (s.phase === 'deciding' && s.round && s.round.number !== app.seenRound) {
      app.seenRound = s.round.number;
      if (prev) notes.push(`Ronda ${s.round.number}.${s.me && s.me.canDecide ? ' Elige cooperar o traicionar.' : ''}`);
    }
    if (prev && s.status === 'finished' && prev.status !== 'finished') notes.push('La partida terminó.');
    if (notes.length) announce(notes.join(' '));
  }

  // ---------- pintar ----------

  function render() {
    const key = `${app.view}:${app.code || ''}`;
    if (app.shown !== key) {
      const first = app.shown === null;
      root.innerHTML = SHELLS[app.view]();
      app.shown = key;
      if (app.view === 'home') setupHome();
      if (!first) root.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
    if (app.view === 'home') renderHome();
    else if (app.view === 'join') renderJoin();
    else if (app.view === 'game') renderGame();
    else if (app.view === 'missing') renderMissing();
  }

  const SHELLS = {
    home: () => `
<div class="wrap home">
  <header class="hero">
    <div class="hero-stamps" aria-hidden="true"><span class="stamp coop">Cooperó</span><span class="stamp defect">Traicionó</span></div>
    <h1 class="title">Dilema del prisionero</h1>
    <p class="lede">De 2 a 10 personas, cada una desde su teléfono o computador. En cada ronda eliges en secreto entre cooperar y traicionar. Traicionar siempre te da más puntos, pero si todos cooperan, a todos les va mejor.</p>
  </header>
  <section class="sheet home-card" aria-label="Crear o unirse a una partida">
    <form data-form="create" novalidate>
      <label for="nick">Tu apodo</label>
      <input type="text" id="nick" name="nick" maxlength="16" autocomplete="nickname" autocapitalize="words" spellcheck="false" enterkeyhint="go">
      <p class="field-note">Así te verán los demás. No hace falta registrarse.</p>
      <p class="field-error" id="create-error" role="alert"></p>
      <button class="btn primary wide" type="submit" id="create-btn" style="margin-top:0.9rem">Crear partida</button>
    </form>
    <form data-form="join-code" novalidate>
      <label for="code">¿Te pasaron un código?</label>
      <div class="inline-field">
        <input type="text" id="code" name="code" class="code-input" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" aria-describedby="code-note">
        <button class="btn" type="submit" id="join-btn">Unirme</button>
      </div>
      <p class="field-note" id="code-note">Entras con el apodo de arriba.</p>
      <p class="field-error" id="code-error" role="alert"></p>
    </form>
  </section>
  ${rulesBlock(4, null)}
</div>`,
    join: () => `
<div class="wrap join">
  <a class="bar-home" href="/" data-action="home">Inicio</a>
  <h1 class="title-sm">Partida ${esc(app.code)}</h1>
  <div id="join-info" class="join-info"></div>
  <div id="join-body" class="join-body"></div>
</div>`,
    game: () => `
<header class="bar"><div class="bar-inner" id="bar"></div></header>
<div class="timeline" aria-hidden="true"><div class="timeline-fill" id="timefill"></div></div>
<div class="game" id="game">
  <div class="game-grid">
    <div class="col col-main"><div id="banners"></div><div id="action"></div><div id="roster"></div></div>
    <div class="col col-side"><div id="history"></div><div id="rules"></div><div id="exit"></div></div>
  </div>
</div>`,
    missing: () => `
<div class="wrap join">
  <a class="bar-home" href="/" data-action="home">Inicio</a>
  <h1 class="title-sm">Partida no disponible</h1>
  <p class="lede" id="missing-text" style="margin-top:0.75rem"></p>
  <div class="row" style="margin-top:1.25rem"><a class="btn primary" href="/" data-action="home">Ir al inicio</a></div>
</div>`,
  };

  function payoffRows(n) {
    const rows = [];
    for (let k = 0; k <= n - 1; k += 1) rows.push({ k, c: 3 * k, d: 4 * k + (n - 1) });
    return rows;
  }

  function endRuleText(cfg) {
    const c = cfg || { minRounds: 7, endChance: 0.25 };
    if (c.endChance >= 1) return `Se juegan exactamente ${c.minRounds} rondas.`;
    return `Se juegan al menos ${c.minRounds} rondas. Desde ahí, cada ronda tiene un ${pct(c.endChance)} de probabilidad de ser la última, así que nadie sabe cuál será la final.`;
  }

  function rulesBlock(n, cfg) {
    const rows = payoffRows(n).map((r) => `<tr><th scope="row">${r.k}</th><td class="t-coop">${r.c}</td><td class="t-defect">${r.d}</td></tr>`).join('');
    return `<details class="rules"><summary>Cómo se juega</summary><div class="rules-body">
  <p>En cada ronda juegas a la vez contra cada rival, con una sola decisión. Contra cada uno sumas:</p>
  <table class="duel"><thead><tr><td></td><th scope="col">Si el rival coopera</th><th scope="col">Si traiciona</th></tr></thead><tbody>
    <tr><th scope="row" class="t-coop">Cooperas</th><td>3</td><td>0</td></tr>
    <tr><th scope="row" class="t-defect">Traicionas</th><td>5</td><td>1</td></tr>
  </tbody></table>
  <p>Con ${n} jugadores, tus puntos de la ronda según cuántos rivales cooperen:</p>
  <table class="paytable"><thead><tr><th scope="col">Rivales que cooperan</th><th scope="col">Si cooperas</th><th scope="col">Si traicionas</th></tr></thead><tbody>${rows}</tbody></table>
  <p>Traicionar siempre da más que cooperar, hagan lo que hagan los demás. Pero si todos cooperan, cada uno gana ${3 * (n - 1)}; si todos traicionan, solo ${n - 1}.</p>
  <ul>
    <li>Las decisiones son secretas y se revelan cuando todos eligieron o se acaba el tiempo. Puedes cambiar la tuya hasta ese momento.</li>
    <li>Quien no decide a tiempo suma 0 y la ronda se calcula sin esa persona. Tras 2 rondas seguidas sin decidir queda ausente y ya no se le espera; vuelve en cuanto elija.</li>
    <li>Quien llega con la partida en marcha entra en la ronda siguiente con el promedio de puntos del grupo.</li>
    <li>${esc(endRuleText(cfg))}</li>
  </ul>
</div></details>`;
  }

  // ----- inicio -----

  function setupHome() {
    const input = $('nick');
    if (input) input.value = nick.get();
  }

  function renderHome() {
    $('create-error').textContent = app.homeErrors.create || '';
    $('code-error').textContent = app.homeErrors.code || '';
    $('create-btn').disabled = app.busy;
    $('join-btn').disabled = app.busy;
  }

  // ----- unirse -----

  function renderJoin() {
    const info = app.joinInfo;
    const notice = app.notice ? `<div class="banner"><p>${esc(app.notice)}</p></div>` : '';
    if (!info) {
      patch('join-info', `${notice}${app.joinFailed
        ? `<p>${esc(app.joinFailed)}</p><button class="btn" data-action="retry-join">Reintentar</button>`
        : '<p class="muted">Buscando la partida…</p>'}`);
      patch('join-body', '');
      return;
    }
    const players = info.players;
    const saved = sessions.saved(app.code);
    const savedPlayer = saved && players.find((p) => p.id === saved.playerId);
    let status;
    if (info.status === 'lobby') status = `Está en la sala de espera, con ${players.length} de ${info.rules.maxPlayers} jugadores.`;
    else if (info.status === 'playing') status = `Está en juego: ${info.round ? `ronda ${info.round.number}` : `${plural(info.history.length, 'ronda jugada', 'rondas jugadas')}`}.`;
    else status = `Terminó después de ${plural(info.history.length, 'ronda', 'rondas')}.`;
    patch('join-info', `${notice}<p>${esc(status)}</p>${players.length
      ? `<ul class="name-list" aria-label="Jugadores">${players.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ul>`
      : ''}`);

    const code = esc(app.code);
    const full = players.length >= info.rules.maxPlayers;
    let html = '';
    if (savedPlayer) {
      html += `<div class="banner"><p>Ya estás en esta partida como <strong>${esc(savedPlayer.name)}</strong>.</p><button class="btn primary" data-action="continue">Continuar como ${esc(savedPlayer.name)}</button></div>`;
    }
    if (info.status === 'finished') {
      html += `<div class="row" style="margin-top:1rem"><a class="btn primary" href="/p/${code}?ver" data-action="spectate">Ver resultados</a><a class="btn" href="/" data-action="home">Crear otra partida</a></div>`;
    } else if (full) {
      html += `<p style="margin-top:1rem">La partida está llena: ya tiene ${info.rules.maxPlayers} jugadores.</p><div class="row" style="margin-top:0.75rem"><a class="btn" href="/p/${code}?ver" data-action="spectate">Mirar sin jugar</a></div>`;
    } else {
      const late = info.status === 'playing';
      const current = info.round ? info.round.number : info.history.length;
      const joinRound = info.history.length + (info.round ? 2 : 1);
      html += `<form data-form="join" class="sheet" novalidate style="margin-top:1rem">
  <label for="join-nick">${savedPlayer ? 'O entra con otro apodo' : 'Tu apodo'}</label>
  <input type="text" id="join-nick" name="nick" maxlength="16" autocomplete="nickname" autocapitalize="words" spellcheck="false" enterkeyhint="go">
  ${late ? `<p class="field-note">La partida va por la ronda ${current}. Si entras ahora, juegas desde la ronda ${joinRound} con el promedio de puntos del grupo, y tus rondas anteriores quedan marcadas con «—».</p>` : ''}
  <p class="field-error" id="joinform-error" role="alert"></p>
  <button class="btn primary wide" type="submit" id="joinform-btn" style="margin-top:0.9rem">${late ? 'Entrar a jugar' : 'Unirme a la partida'}</button>
</form>
<p style="margin-top:1rem"><a href="/p/${code}?ver" data-action="spectate">Mirar sin jugar</a></p>`;
    }
    if (patch('join-body', html)) {
      const input = $('join-nick');
      if (input) input.value = nick.get();
    }
    const error = $('joinform-error');
    if (error) error.textContent = app.joinError || '';
    const button = $('joinform-btn');
    if (button) button.disabled = app.busy;
  }

  function renderMissing() {
    $('missing-text').textContent = app.notice;
  }

  // ----- juego -----

  function renderGame() {
    const s = app.state;
    if (!s) {
      patch('action', '<p class="muted">Cargando la partida…</p>');
      return;
    }
    const game = $('game');
    game.classList.toggle('is-lobby', s.status === 'lobby');
    game.classList.toggle('is-final', s.status === 'finished');
    renderBar(s);
    renderBanners(s);
    renderAction(s);
    renderRoster(s);
    renderHistory(s);
    renderRules(s);
    renderExit(s);
    updateTitle(s);
    tick();
  }

  function renderBar(s) {
    let where;
    if (s.status === 'lobby') where = 'Sala de espera';
    else if (s.status === 'finished') where = plural(s.history.length, 'ronda', 'rondas');
    else if (s.round) where = `Ronda ${s.round.number}`;
    else where = `Ronda ${s.history.length}`;
    patch('bar', `
<a class="bar-home" href="/" data-action="home">Inicio</a>
<button class="bar-case" type="button" data-action="share" data-key="bar-share" aria-label="Compartir el enlace de la partida ${esc(s.code)}"><span>Exp.</span>${esc(s.code)}</button>
<span class="bar-spacer"></span>
<span class="bar-round">${esc(where)}</span>
<span class="bar-clock" id="clock" aria-hidden="true"></span>`);
  }

  function renderBanners(s) {
    const out = [];
    const me = s.me;
    if (app.live && !app.streamOk) {
      out.push('<div class="banner quiet"><p>Sin conexión en vivo. La página se actualiza cada 2 segundos mientras se recupera.</p></div>');
    }
    if (!me) {
      const canJoin = s.status !== 'finished' && s.players.length < s.rules.maxPlayers;
      out.push(`<div class="banner quiet"><p>Estás mirando sin jugar.</p>${canJoin ? `<a class="btn small" href="/p/${esc(s.code)}" data-action="join-screen">Unirme</a>` : ''}</div>`);
    }
    if (s.phase === 'paused') {
      out.push(`<div class="banner"><p>Partida en pausa: todos quedaron ausentes.${me ? ' Pulsa «Estoy aquí» para seguir jugando.' : ''}</p>${me ? '<button class="btn primary small" data-action="back" data-key="back">Estoy aquí</button>' : ''}</div>`);
    } else if (me && me.away && s.status === 'playing') {
      out.push(`<div class="banner"><p>Quedaste como ausente: no decidiste en ${s.rules.missesToAway} rondas seguidas y las rondas ya no te esperan. Vuelves en cuanto elijas.</p><button class="btn primary small" data-action="back" data-key="back">Estoy aquí</button></div>`);
    }
    const mine = me && s.players.find((p) => p.id === me.id);
    if (mine && mine.waitingToStart && s.status === 'playing') {
      out.push(`<div class="banner"><p>Llegaste con la partida en marcha. Juegas desde la ronda ${mine.joinRound}, con el promedio de puntos del grupo en ese momento.</p></div>`);
    }
    patch('banners', out.join(''));
  }

  function renderAction(s) {
    if (s.status === 'lobby') renderLobby(s);
    else if (s.status === 'finished') renderFinal(s);
    else if (s.phase === 'deciding' && s.round) renderDecide(s);
    else renderReveal(s);
  }

  // sala de espera
  function renderLobby(s) {
    const canShare = typeof navigator.share === 'function';
    const spaced = s.code.split('').join(' ');
    patch('action', `<section class="panel" aria-labelledby="lobby-title">
  <h2 class="h2" id="lobby-title">Sala de espera</h2>
  <p style="margin-top:0.4rem">Comparte el código o el enlace para que entren los demás.</p>
  <div class="case-code num" role="text" aria-label="Código de la partida: ${esc(spaced)}">${esc(s.code)}</div>
  <div class="row"><button class="btn small" data-action="copy-link" data-key="copy">Copiar enlace</button>${canShare ? '<button class="btn small" data-action="share" data-key="share">Compartir</button>' : ''}</div>
  <div id="lobby-config"></div>
  <div id="lobby-start" style="margin-top:1.25rem"></div>
</section>`);
    renderLobbyConfig(s);
    renderLobbyStart(s);
  }

  function configSummary(c) {
    const seconds = `${c.roundSeconds} segundos para decidir cada ronda.`;
    if (c.endChance >= 1) {
      return `Exactamente ${c.minRounds} rondas. ${seconds} Ojo: si todos saben cuál es la última ronda, en ella traicionar no tiene consecuencias.`;
    }
    const expected = Math.round(c.minRounds + (1 - c.endChance) / c.endChance);
    return `Al menos ${c.minRounds} rondas; desde ahí, cada ronda tiene un ${pct(c.endChance)} de probabilidad de ser la última (unas ${expected} rondas en promedio). ${seconds}`;
  }

  function selectField(name, label, options, value) {
    let opts = options;
    if (!opts.some(([v]) => v === value)) {
      const text = name === 'endChance' ? `${pct(value)} por ronda` : name === 'roundSeconds' ? `${value} s` : String(value);
      opts = [...opts, [value, text]].sort((a, b) => a[0] - b[0]);
    }
    const id = `cfg-${name}`;
    return `<div><label for="${id}">${label}</label><select id="${id}" data-config="${name}" data-key="${id}">${opts
      .map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  }

  function renderLobbyConfig(s) {
    const c = s.config;
    const host = s.me && s.me.host;
    let html = '';
    if (host) {
      html += `<div class="config-grid">
  ${selectField('minRounds', 'Rondas mínimas', [3, 5, 7, 10, 15, 20].map((v) => [v, String(v)]), c.minRounds)}
  ${selectField('endChance', 'Final sorpresa', [[0.1, `${pct(0.1)} por ronda`], [0.25, `${pct(0.25)} por ronda`], [0.5, `${pct(0.5)} por ronda`], [1, 'No, rondas fijas']], c.endChance)}
  ${selectField('roundSeconds', 'Tiempo por ronda', [15, 20, 30, 45, 60, 90].map((v) => [v, `${v} s`]), c.roundSeconds)}
</div>`;
    }
    html += `<p class="config-summary${host ? ' small muted' : ''}">${esc(configSummary(c))}</p>`;
    patch('lobby-config', html);
  }

  function renderLobbyStart(s) {
    const min = s.rules.minPlayers;
    const n = s.players.length;
    let html;
    if (s.me && s.me.host) {
      html = `<button class="btn primary wide" data-action="start" data-key="start"${n < min ? ' disabled' : ''}>Empezar partida</button>${n < min
        ? `<p class="field-note">Hacen falta al menos ${min} jugadores para empezar.</p>` : ''}`;
    } else {
      const host = s.players.find((p) => p.host);
      html = `<p class="muted">Esperando a que ${host ? esc(host.name) : 'el anfitrión'} empiece la partida.</p>`;
    }
    patch('lobby-start', html);
  }

  // decidir
  function displayedChoice(s) {
    const o = app.optimistic;
    if (o && s.round && o.round === s.round.number) return o.choice;
    return s.me ? s.me.choice : null;
  }

  function watchText(s) {
    const mine = s.me && s.players.find((p) => p.id === s.me.id);
    if (mine && mine.waitingToStart) return `Entras a jugar en la ronda ${mine.joinRound}. Mientras tanto puedes ver cómo avanza.`;
    if (s.me) return 'No participas en esta ronda.';
    return 'Ronda en juego. Verás las decisiones cuando se revelen.';
  }

  function endNote(s) {
    const c = s.config;
    const n = s.round.number;
    if (c.endChance >= 1) return n >= c.minRounds ? 'Esta es la última ronda.' : `Se juegan ${c.minRounds} rondas en total.`;
    if (n >= c.minRounds) return `Esta podría ser la última ronda: tiene un ${pct(c.endChance)} de probabilidad.`;
    const left = c.minRounds - n;
    return `Después de esta quedan al menos ${plural(left, 'ronda', 'rondas')} más.`;
  }

  function renderDecide(s) {
    const r = s.round;
    const can = Boolean(s.me && s.me.canDecide);
    patch('action', `<section class="panel decide" aria-labelledby="decide-title">
  <h2 class="h2" id="decide-title">Ronda ${r.number}</h2>
  ${can ? `<p class="lede" style="margin-top:0.3rem">¿Cooperas o traicionas?</p>
  <div class="choices" role="group" aria-label="Tu decisión en la ronda ${r.number}">
    <button type="button" class="choice coop" data-action="choose" data-choice="C" data-key="choose-C" aria-pressed="false" aria-keyshortcuts="C"><span class="choice-word">Cooperar</span><span class="choice-hint">Por cada rival: 3 si coopera, 0 si traiciona</span></button>
    <button type="button" class="choice defect" data-action="choose" data-choice="D" data-key="choose-D" aria-pressed="false" aria-keyshortcuts="T"><span class="choice-word">Traicionar</span><span class="choice-hint">Por cada rival: 5 si coopera, 1 si traiciona</span></button>
  </div>
  <p class="choice-note" id="choice-note"></p>` : `<p class="lede" style="margin-top:0.3rem">${esc(watchText(s))}</p>`}
  <p class="progress-line" id="progress" style="margin-top:0.5rem"></p>
  <p class="small muted" id="endnote" style="margin-top:0.5rem"></p>
</section>`);
    if (can) syncChoice(s);
    const byId = playerMap(s);
    const awayWaiting = r.eligible.filter((id) => !r.decided.includes(id) && byId.get(id) && byId.get(id).away).length;
    let progress;
    if (r.sealAt) progress = '<strong>Todos decidieron.</strong> Revelando…';
    else {
      progress = `<strong>${r.decided.length} de ${r.eligible.length}</strong> ya decidieron.`;
      if (awayWaiting) progress += ` No se espera a ${plural(awayWaiting, 'ausente', 'ausentes')}.`;
    }
    patch('progress', progress);
    patch('endnote', esc(endNote(s)));
  }

  function syncChoice(s) {
    const choice = displayedChoice(s);
    for (const button of root.querySelectorAll('.choice')) {
      button.setAttribute('aria-pressed', String(button.dataset.choice === choice));
    }
    const note = $('choice-note');
    if (!note) return;
    note.textContent = choice
      ? `Elegiste ${choice === 'C' ? 'cooperar' : 'traicionar'}. Nadie lo verá hasta la revelación; puedes cambiarlo mientras tanto.`
      : 'Nadie verá tu elección hasta la revelación. Puedes cambiarla mientras tanto.';
  }

  // revelar
  function coopText(round) {
    if (!round.participants) return 'Nadie decidió a tiempo.';
    return `${round.cooperators} de ${round.participants} cooperaron.`;
  }

  function youText(s, round) {
    if (!s.me) return '';
    const mine = round.results[s.me.id];
    if (!mine) return '';
    const me = s.players.find((p) => p.id === s.me.id);
    const total = me && me.score !== null ? ` Llevas ${me.score}.` : '';
    if (!mine.choice) return `No decidiste a tiempo: 0 puntos esta ronda.${total}`;
    return `${mine.choice === 'C' ? 'Cooperaste' : 'Traicionaste'} y sumaste ${plural(mine.points, 'punto', 'puntos')}.${total}`;
  }

  function revealHtml(s, round, final) {
    const key = `${s.code}:${round.number}`;
    if (app.revealAnim.key !== key) app.revealAnim = { key, animate: s.phase === 'reveal' };
    const animate = app.revealAnim.animate;
    const byId = playerMap(s);
    const ids = s.players.map((p) => p.id).filter((id) => round.results[id]);
    const files = ids.map((id, i) => {
      const r = round.results[id];
      const p = byId.get(id);
      const cls = r.choice === 'C' ? 'coop' : r.choice === 'D' ? 'defect' : 'none';
      const word = r.choice === 'C' ? 'Cooperó' : r.choice === 'D' ? 'Traicionó' : 'No decidió';
      const isMe = s.me && s.me.id === id;
      return `<li class="file${isMe ? ' is-me' : ''}"><span class="file-name">${esc(p ? p.name : '¿?')}${isMe ? ' <small>(tú)</small>' : ''}</span><span class="file-pts num">+${r.points}</span><span class="stamp ${cls}" style="--i:${i};--r:${tilt(id, round.number)}deg">${word}</span></li>`;
    }).join('');
    const you = youText(s, round);
    return `<section class="panel reveal${animate ? ' animate' : ''}" aria-labelledby="reveal-title-${round.number}">
  <h2 class="h2" id="reveal-title-${round.number}">Ronda ${round.number} revelada</h2>
  <p class="muted" style="margin-top:0.3rem">${esc(coopText(round))}${round.endedBy === 'timeout' && round.participants ? ' Se acabó el tiempo.' : ''}</p>
  <ul class="files">${files}</ul>
  ${you ? `<p class="you-line">${esc(you)}</p>` : ''}
  ${!final && s.phase === 'reveal' ? '<p class="small muted" id="next-count" style="margin-top:0.5rem"></p>' : ''}
</section>`;
  }

  function renderReveal(s) {
    const last = s.history[s.history.length - 1];
    patch('action', last ? revealHtml(s, last, false) : '<p class="muted">Preparando la siguiente ronda…</p>');
  }

  // final
  function rankOf(s) {
    const scored = s.players.filter((p) => p.score !== null).sort((a, b) => b.score - a.score);
    const ranks = new Map();
    scored.forEach((p, i) => {
      ranks.set(p.id, i > 0 && scored[i - 1].score === p.score ? ranks.get(scored[i - 1].id) : i + 1);
    });
    return { scored, ranks };
  }

  function endReasonText(s) {
    const n = s.history.length;
    const c = s.config;
    if (s.endReason === 'random') return `Terminó en la ronda ${n}: al cerrarla salió el final sorpresa (${pct(c.endChance)} por ronda desde la ronda ${c.minRounds}).`;
    if (s.endReason === 'fixed') return `Se jugaron las ${n} rondas acordadas.`;
    if (s.endReason === 'cap') return `Se alcanzó el máximo de ${n} rondas.`;
    return 'La partida terminó.';
  }

  function renderFinal(s) {
    const last = s.history[s.history.length - 1];
    const reveal = last ? revealHtml(s, last, true) : '';
    const animate = Boolean(last && app.revealAnim.animate);
    const { scored, ranks } = rankOf(s);
    const rows = scored.map((p) => {
      let decided = 0;
      let coop = 0;
      let missed = 0;
      for (const r of s.history) {
        const x = r.results[p.id];
        if (!x) continue;
        if (!x.choice) missed += 1;
        else {
          decided += 1;
          if (x.choice === 'C') coop += 1;
        }
      }
      const meta = [decided ? `cooperó ${coop} de ${plural(decided, 'vez', 'veces')} (${pct(coop / decided)})` : 'no llegó a decidir'];
      if (missed) meta.push(`${missed} sin decidir`);
      if (p.late) meta.push(`entró en la ronda ${p.joinRound} con ${p.startScore}`);
      if (p.kind === 'agent') meta.push('agente IA');
      const isMe = s.me && s.me.id === p.id;
      return `<li><span class="rank">${ranks.get(p.id)}</span><span class="rk-name">${esc(p.name)}${isMe ? ' <span class="tag">(tú)</span>' : ''}</span><span class="rk-score">${p.score}</span><span class="rk-meta">${esc(meta.join('; '))}</span></li>`;
    }).join('');
    const never = s.players.filter((p) => p.score === null);

    let decisions = 0;
    let coops = 0;
    let earned = 0;
    let possible = 0;
    for (const r of s.history) {
      decisions += r.participants;
      coops += r.cooperators;
      possible += 3 * r.participants * (r.participants - 1);
      for (const x of Object.values(r.results)) earned += x.points;
    }
    const bars = s.history.map((r) => {
      const share = r.participants ? r.cooperators / r.participants : 0;
      return `<span style="height:${Math.max(2, Math.round(share * 100))}%"></span>`;
    }).join('');
    const barsLabel = s.history.map((r) => `ronda ${r.number}: ${r.participants ? pct(r.cooperators / r.participants) : 'sin decisiones'}`).join(', ');
    const stats = decisions ? `<div class="stats">
  <h3 class="h3">El grupo</h3>
  <p>Cooperó en el ${pct(coops / decisions)} de las decisiones.</p>
  ${possible ? `<p>Consiguió el ${pct(earned / possible)} de los puntos que habría sumado cooperando siempre. Traicionando todos siempre habría sido el 33${NBSP}%.</p>` : ''}
  <div class="bars" role="img" aria-label="Cooperación por ronda: ${esc(barsLabel)}">${bars}</div>
  <div class="bars-axis" aria-hidden="true"><span>Ronda 1</span><span>Ronda ${s.history.length}</span></div>
  <p class="small muted">Cada barra es el porcentaje de cooperación de una ronda.</p>
</div>` : '<p class="stats">Nadie llegó a decidir en ninguna ronda.</p>';

    let actions;
    if (s.me) {
      actions = `<button class="btn primary" data-action="rematch" data-key="rematch">${s.rematchCode ? 'Unirme a la revancha' : 'Jugar la revancha'}</button><a class="btn" href="/" data-action="home">Volver al inicio</a>`;
    } else {
      actions = `${s.rematchCode ? `<a class="btn primary" href="/p/${esc(s.rematchCode)}" data-action="goto">Ver la revancha</a>` : ''}<a class="btn" href="/" data-action="home">Crear otra partida</a>`;
    }
    const rematchNote = s.rematchCode ? `<p class="small muted" style="margin-top:0.6rem">La revancha ya está abierta con el código ${esc(s.rematchCode)} y la misma configuración.</p>` : '<p class="small muted" style="margin-top:0.6rem">La revancha usa la misma configuración; quien la pida primero será el anfitrión.</p>';

    patch('action', `${reveal}
<section class="sheet final${animate ? ' animate' : ''}" style="--n:${last ? Object.keys(last.results).length : 0}; margin-top:1.25rem" aria-labelledby="final-title">
  <div class="final-stamp" aria-hidden="true"><span class="stamp closed" style="--r:-6deg">Caso cerrado</span></div>
  <h2 class="h2" id="final-title">Resultado final</h2>
  <p class="final-reason">${esc(endReasonText(s))}</p>
  <ol class="ranking" aria-label="Clasificación">${rows}</ol>
  ${never.length ? `<p class="small muted" style="margin-top:0.6rem">No llegaron a jugar: ${esc(never.map((p) => p.name).join(', '))}.</p>` : ''}
  ${stats}
  <div class="row" style="margin-top:1.25rem">${actions}</div>
  ${rematchNote}
</section>`);
  }

  // jugadores
  function chipState(s, p) {
    if (p.waitingToStart) return [`entra en la ronda ${p.joinRound}`, 'is-wait'];
    if (s.phase === 'deciding' && s.round && p.decided !== null) {
      if (p.decided) return ['decidió', 'is-done'];
      if (p.away) return ['ausente', 'is-away'];
      return p.online ? ['pensando…', ''] : ['sin conexión', 'is-off'];
    }
    if (p.away) return ['ausente', 'is-away'];
    if (!p.online) return ['sin conexión', 'is-off'];
    return [plural(p.score, 'punto', 'puntos'), ''];
  }

  function renderRoster(s) {
    if (s.status === 'finished') {
      patch('roster', '');
      return;
    }
    const meId = s.me ? s.me.id : null;
    if (s.status === 'lobby') {
      const canKick = s.me && s.me.host;
      const items = s.players.map((p) => {
        const tags = [];
        if (p.id === meId) tags.push('tú');
        if (p.host) tags.push('anfitrión');
        if (p.kind === 'agent') tags.push('agente IA');
        if (!p.online) tags.push('sin conexión');
        return `<li><span class="who-name">${esc(p.name)}</span>${tags.length ? `<span class="tag">${esc(tags.join(', '))}</span>` : ''}${canKick && p.id !== meId
          ? `<button class="btn small" data-action="kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-key="kick-${esc(p.id)}">Expulsar</button>` : ''}</li>`;
      }).join('');
      patch('roster', `<section class="panel" aria-labelledby="roster-title"><h2 class="h3" id="roster-title">Jugadores <span class="muted num">${s.players.length} de ${s.rules.maxPlayers}</span></h2><ul class="lobby-list">${items}</ul></section>`);
      return;
    }
    const chips = s.players.map((p) => {
      const [label, cls] = chipState(s, p);
      const isMe = p.id === meId;
      return `<li class="who ${cls}${isMe ? ' is-me' : ''}"><span class="who-name">${esc(p.name)}</span>${isMe ? '<span class="sr-only">(tú)</span>' : ''}<span class="who-state">${esc(label)}</span></li>`;
    }).join('');
    patch('roster', `<section class="panel" aria-labelledby="roster-title"><h2 class="h3" id="roster-title">Jugadores</h2><ul class="roster">${chips}</ul></section>`);
  }

  // historial
  function renderHistory(s) {
    if (s.status === 'lobby') {
      patch('history', '');
      return;
    }
    const rounds = s.history;
    if (!rounds.length) {
      patch('history', '<section class="sheet history" aria-labelledby="history-title"><h2 class="h2" id="history-title">Historial</h2><p class="empty-note">Cada ronda aparecerá aquí en cuanto se revele: quién cooperó, quién traicionó y cuántos puntos ganó.</p></section>');
      app.histCount = 0;
      return;
    }
    const withStart = s.players.some((p) => p.late);
    const { ranks } = rankOf(s);
    const meId = s.me ? s.me.id : null;
    const head = `<tr><th scope="col" class="c-name">Jugador</th>${withStart ? '<th scope="col">Inicio</th>' : ''}${rounds
      .map((r) => `<th scope="col"><span class="sr-only">Ronda </span><span aria-hidden="true">R</span>${r.number}</th>`).join('')}<th scope="col" class="c-total">Total</th></tr>`;
    const body = s.players.map((p) => {
      let sum = p.startScore || 0;
      const cells = rounds.map((r) => {
        const x = r.results[p.id];
        if (!x) return '<td class="cell pre"><b><span aria-hidden="true">—</span><span class="sr-only">aún no jugaba</span></b></td>';
        sum += x.points;
        const acc = `<i><span class="sr-only">acumulado </span>${sum}</i>`;
        if (!x.choice) return `<td class="cell none"><b><span aria-hidden="true">⌛︎</span><span class="sr-only">no decidió,</span> 0</b>${acc}</td>`;
        const coop = x.choice === 'C';
        return `<td class="cell ${coop ? 'coop' : 'defect'}"><b><span aria-hidden="true">${coop ? 'C' : 'T'}</span><span class="sr-only">${coop ? 'cooperó' : 'traicionó'},</span> ${x.points}</b>${acc}</td>`;
      }).join('');
      const tag = p.late ? `<span class="tag">${p.waitingToStart ? 'entra' : 'entró'} en R${p.joinRound}</span>` : '';
      const start = withStart ? `<td class="cell"><b>${p.startScore === null ? '—' : p.startScore}</b></td>` : '';
      const rank = ranks.get(p.id);
      return `<tr${p.id === meId ? ' class="is-me"' : ''}><th scope="row" class="c-name">${esc(p.name)}${tag}</th>${start}${cells}<td class="c-total">${p.score === null ? '—' : p.score}${rank ? `<small>${rank}.º</small>` : ''}</td></tr>`;
    }).join('');
    const foot = `<tr><th scope="row" class="c-name">Cooperación</th>${withStart ? '<td></td>' : ''}${rounds
      .map((r) => `<td>${r.participants ? pct(r.cooperators / r.participants) : '—'}</td>`).join('')}<td class="c-total"></td></tr>`;
    const old = $('hist-scroll');
    const left = old ? old.scrollLeft : 0;
    const changed = patch('history', `<section class="sheet history" aria-labelledby="history-title">
  <h2 class="h2" id="history-title">Historial</h2>
  <div class="table-scroll" id="hist-scroll" tabindex="0" role="region" aria-label="Tabla del historial, se desplaza horizontalmente">
    <table class="ledger">
      <caption class="sr-only">Decisión, puntos de la ronda y acumulado de cada jugador en cada ronda</caption>
      <thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot>
    </table>
  </div>
  <p class="legend">C cooperó, T traicionó, ⌛︎ no decidió a tiempo, — aún no jugaba. En cada celda: arriba los puntos de la ronda, abajo el acumulado.</p>
</section>`);
    if (changed) {
      const scroller = $('hist-scroll');
      if (scroller) scroller.scrollLeft = rounds.length > app.histCount ? scroller.scrollWidth : left;
    }
    app.histCount = rounds.length;
  }

  function renderRules(s) {
    const n = Math.max(2, s.players.filter((p) => !p.waitingToStart).length);
    const current = $('rules').querySelector('details');
    const open = Boolean(current && current.open);
    if (patch('rules', rulesBlock(n, s.config)) && open) $('rules').querySelector('details').open = true;
  }

  function renderExit(s) {
    let html = '';
    if (s.me && s.status === 'lobby') html = '<button class="linkish" data-action="leave" data-key="leave">Salir de la sala</button>';
    else if (s.me && s.status === 'playing') html = '<button class="linkish" data-action="leave" data-key="leave">Dejar la partida</button>';
    patch('exit', html);
  }

  function updateTitle(s) {
    const needs = s.phase === 'deciding' && s.round && s.me && s.me.canDecide && !displayedChoice(s);
    document.title = needs ? `● Ronda ${s.round.number}: elige | Dilema del prisionero` : `${s.code} | Dilema del prisionero`;
  }

  // Reloj: solo toca el texto y el ancho de la barra, sin redibujar nada.
  function tick() {
    if (app.view !== 'game' || !app.state) return;
    const s = app.state;
    const now = Date.now() + app.offset;
    const clock = $('clock');
    const fill = $('timefill');
    if (s.phase === 'deciding' && s.round) {
      const total = s.round.deadline - s.round.openedAt;
      const left = Math.max(0, s.round.deadline - now);
      const secs = Math.ceil(left / 1000);
      const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (clock) {
        if (clock.textContent !== text) clock.textContent = text;
        clock.classList.toggle('is-low', secs <= 5);
      }
      if (fill) fill.style.width = `${total > 0 ? (left / total) * 100 : 0}%`;
    } else {
      if (clock && clock.textContent) clock.textContent = '';
      if (fill) fill.style.width = '0%';
    }
    const next = $('next-count');
    if (next && s.phase === 'reveal' && s.nextRoundAt) {
      const secs = Math.max(0, Math.ceil((s.nextRoundAt - now) / 1000));
      const text = secs > 0 ? `Siguiente ronda en ${secs}${NBSP}s.` : 'Abriendo la siguiente ronda…';
      if (next.textContent !== text) next.textContent = text;
    }
  }

  // ---------- acciones ----------

  async function createGame(form) {
    const name = form.elements.nick.value.trim();
    if (!name) {
      app.homeErrors = { create: 'Escribe un apodo para crear la partida.' };
      renderHome();
      form.elements.nick.focus();
      return;
    }
    app.busy = true;
    app.homeErrors = {};
    renderHome();
    try {
      const r = await api('POST', '/games', { name });
      nick.set(r.state.me.name);
      app.busy = false;
      enterGame(r);
    } catch (err) {
      app.busy = false;
      app.homeErrors = { create: err.message };
      if (app.view === 'home') renderHome();
    }
  }

  async function joinByCode(form) {
    const code = form.elements.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = ($('nick').value || '').trim();
    if (code.length !== 5) {
      app.homeErrors = { code: 'El código tiene 5 caracteres, por ejemplo K7QX2.' };
      renderHome();
      form.elements.code.focus();
      return;
    }
    if (!name || sessions.saved(code)) {
      go(`/p/${code}`); // allí se ve la partida y se puede elegir apodo o continuar
      return;
    }
    app.busy = true;
    app.homeErrors = {};
    renderHome();
    try {
      const r = await api('POST', `/games/${code}/join`, { name });
      nick.set(r.state.me.name);
      app.busy = false;
      enterGame(r);
    } catch (err) {
      app.busy = false;
      if (err.code === 'GAME_FINISHED' || err.code === 'GAME_FULL') {
        go(`/p/${code}`);
        return;
      }
      app.homeErrors = err.code === 'NAME_TAKEN' || err.code === 'BAD_NAME' ? { create: err.message } : { code: err.message };
      if (app.view === 'home') renderHome();
    }
  }

  async function joinFromScreen(form) {
    const name = form.elements.nick.value.trim();
    if (!name) {
      app.joinError = 'Escribe un apodo para unirte.';
      renderJoin();
      form.elements.nick.focus();
      return;
    }
    const code = app.code;
    app.busy = true;
    app.joinError = '';
    renderJoin();
    try {
      const r = await api('POST', `/games/${code}/join`, { name });
      nick.set(r.state.me.name);
      app.busy = false;
      enterGame(r);
    } catch (err) {
      app.busy = false;
      if (app.view !== 'join' || app.code !== code) return;
      app.joinError = err.message;
      renderJoin();
    }
  }

  function enterGame(r) {
    const session = { playerId: r.playerId, token: r.token, name: r.state.me.name };
    sessions.save(r.code, session);
    history.pushState(null, '', `/p/${r.code}`);
    openGame(r.code, session, r.state);
  }

  function continueSaved() {
    const saved = sessions.saved(app.code);
    if (!saved) return;
    const session = { playerId: saved.playerId, token: saved.token, name: saved.name };
    sessions.save(app.code, session);
    openGame(app.code, session);
  }

  async function act(path, body) {
    const code = app.code;
    try {
      const r = await api('POST', `/games/${code}/${path}`, body || {}, app.session && app.session.token);
      if (app.code === code && r.state) applyState(r.state);
      return r;
    } catch (err) {
      if (app.code === code) toast(err.message);
      return null;
    }
  }

  function choose(choice) {
    const s = app.state;
    if (!s || !s.me || !s.me.canDecide || s.phase !== 'deciding' || !s.round) return;
    if (displayedChoice(s) === choice) return;
    const round = s.round.number;
    app.optimistic = { round, choice };
    syncChoice(s);
    updateTitle(s);
    app.queued = { round, choice };
    pump();
  }

  // Envía las decisiones de una en una; si llegan varios toques seguidos,
  // solo se manda la última elección pendiente.
  async function pump() {
    if (app.sending || !app.queued) return;
    const job = app.queued;
    app.queued = null;
    app.sending = true;
    const code = app.code;
    try {
      const r = await api('POST', `/games/${code}/decision`, { choice: job.choice, round: job.round }, app.session && app.session.token);
      if (app.code === code) applyState(r.state);
    } catch (err) {
      if (app.code === code) {
        toast(err.code === 'ROUND_CLOSED' || err.code === 'WRONG_ROUND'
          ? 'La ronda ya se cerró: esa elección no llegó a tiempo.'
          : err.message);
        if (!app.queued) {
          app.optimistic = null;
          if (app.state) render();
        }
        loadState();
      }
    } finally {
      app.sending = false;
      if (app.queued) pump();
    }
  }

  async function updateConfig(key, value, el) {
    const code = app.code;
    try {
      const r = await api('PATCH', `/games/${code}/config`, { [key]: value }, app.session && app.session.token);
      if (app.code === code) applyState(r.state);
    } catch (err) {
      toast(err.message);
      if (app.state) el.value = String(app.state.config[key]);
    }
  }

  async function leaveGame() {
    const s = app.state;
    if (!s || !s.me) return;
    const message = s.status === 'lobby'
      ? '¿Salir de la sala?'
      : '¿Dejar la partida? Quedarás como ausente y las rondas no te esperarán. Puedes volver con el mismo enlace.';
    if (!window.confirm(message)) return;
    const code = app.code;
    try {
      const r = await api('POST', `/games/${code}/leave`, {}, app.session.token);
      if (r.result === 'removed') sessions.forget(code);
      else removeKey(SESSION, `pd:tab:${code}`);
      go('/');
    } catch (err) {
      toast(err.message);
    }
  }

  async function kick(id, name) {
    if (!window.confirm(`¿Expulsar a ${name} de la sala?`)) return;
    await act('kick', { playerId: id });
  }

  async function rematch() {
    const code = app.code;
    try {
      const r = await api('POST', `/games/${code}/rematch`, {}, app.session && app.session.token);
      enterGame(r);
      toast(`Revancha: partida ${r.code}`);
    } catch (err) {
      toast(err.message);
    }
  }

  const gameUrl = () => `${location.origin}/p/${app.code}`;

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      window.prompt('Copia este enlace:', text);
    }
  }

  async function shareLink() {
    const url = gameUrl();
    if (typeof navigator.share === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'Dilema del prisionero', text: `Únete a mi partida del dilema del prisionero (código ${app.code}).`, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    copyText(url, 'Enlace copiado.');
  }

  // ---------- eventos ----------

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    if (el.tagName === 'A' && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
    const action = el.dataset.action;
    switch (action) {
      case 'home': e.preventDefault(); go('/'); break;
      case 'spectate': e.preventDefault(); go(`/p/${app.code}?ver`); break;
      case 'join-screen': e.preventDefault(); go(`/p/${app.code}`); break;
      case 'goto': e.preventDefault(); go(el.getAttribute('href')); break;
      case 'retry-join': showJoin(app.code); break;
      case 'continue': continueSaved(); break;
      case 'share': shareLink(); break;
      case 'copy-link': copyText(gameUrl(), 'Enlace copiado.'); break;
      case 'start': act('start'); break;
      case 'back': act('back'); break;
      case 'kick': kick(el.dataset.id, el.dataset.name); break;
      case 'leave': leaveGame(); break;
      case 'choose': choose(el.dataset.choice); break;
      case 'rematch': rematch(); break;
      default: break;
    }
  });

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    if (app.busy) return;
    if (form.dataset.form === 'create') createGame(form);
    else if (form.dataset.form === 'join-code') joinByCode(form);
    else if (form.dataset.form === 'join') joinFromScreen(form);
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.config) updateConfig(el.dataset.config, Number(el.value), el);
  });

  root.addEventListener('input', (e) => {
    if (e.target.id !== 'code') return;
    const clean = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean !== e.target.value) e.target.value = clean;
  });

  // Atajos: C coopera, T (o D) traiciona.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const s = app.state;
    if (app.view !== 'game' || !s || !s.me || !s.me.canDecide || s.phase !== 'deciding') return;
    const key = e.key.toLowerCase();
    if (key === 'c') {
      e.preventDefault();
      choose('C');
    } else if (key === 't' || key === 'd') {
      e.preventDefault();
      choose('D');
    }
  });

  setInterval(tick, 250);
  route();
})();
