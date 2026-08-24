/*
 * Staff console - every board in the venue from one iPad.
 *
 * The hub serving this page lists its peers (Settings -> This venue's boards);
 * the page opens a socket to each and shows one card per board. All the staff
 * controls that used to live on the players' iPad live here now: timers,
 * board connect/wake/line-up, diagnostics, venue branding, the PIN.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'show' + (kind === 'error' ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 2400);
  }

  /* ------------------------------------------------------------- hubs ---- */

  // Hub 0 is always the one serving the page; peers come from its settings.
  const hubs = [];   // { url, socket, state, name, unlocked, offline }

  function addHub(url) {
    const hub = { url, socket: null, state: null, name: url || 'this board', unlocked: false, offline: true };
    hub.socket = url ? io(url, { transports: ['websocket', 'polling'] })
                     : io({ transports: ['websocket', 'polling'] });
    hub.socket.on('connect', () => {
      hub.offline = false;
      const pin = sessionStorage.getItem('staffPin');
      if (pin) unlockHub(hub, pin);
      render();
    });
    hub.socket.on('disconnect', () => { hub.offline = true; render(); });
    hub.socket.on('state', (s) => {
      hub.state = s;
      hub.name = (s.settings && s.settings.boardName) || hub.name;
      if (s.session && s.session.serverNow) hub.offset = s.session.serverNow - Date.now();
      render();
    });
    hub.socket.on('toast', (t) => toast(`${hub.name}: ${t.text}`, t.kind));
    hubs.push(hub);
    return hub;
  }

  function unlockHub(hub, pin, cb) {
    hub.socket.emit('unlock', pin, (res) => {
      hub.unlocked = !!(res && res.ok);
      if (cb) cb(hub.unlocked);
      render();
    });
  }

  /* ---------------------------------------------------------- PIN gate --- */

  const RELOCK_MS = 30000;
  let pinBuf = '';
  let hiddenAt = null;
  function pinDots() {
    document.querySelectorAll('#pindots i').forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  }
  function lockNow() {
    sessionStorage.removeItem('staffPin');
    for (const h of hubs) { h.unlocked = false; try { h.socket.emit('lockSettings'); } catch (_) {} }
    $('app').hidden = true;
    $('pingate').hidden = false;
    pinBuf = ''; pinDots();
  }
  function tryUnlock(pin, silent) {
    // The serving hub decides whether the gate opens; peers follow silently.
    unlockHub(hubs[0], pin, (ok) => {
      if (ok) {
        sessionStorage.setItem('staffPin', pin);
        for (const h of hubs.slice(1)) unlockHub(h, pin);
        $('pingate').hidden = true;
        $('app').hidden = false;
        pinBuf = ''; pinDots();
      } else if (!silent) {
        sessionStorage.removeItem('staffPin');
        const box = $('pindots');
        box.classList.add('err');
        setTimeout(() => { box.classList.remove('err'); pinBuf = ''; pinDots(); }, 380);
      } else {
        lockNow();
      }
    });
  }
  $('pinpad').addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]');
    if (!k) return;
    const v = k.dataset.k;
    if (v === 'c') { pinBuf = ''; pinDots(); return; }
    if (v === 'b') { pinBuf = pinBuf.slice(0, -1); pinDots(); return; }
    if (pinBuf.length >= 8) return;
    pinBuf += v; pinDots();
    if (pinBuf.length >= 4) tryUnlock(pinBuf, false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= RELOCK_MS) lockNow();
    hiddenAt = null;
  });
  $('lock').addEventListener('click', lockNow);

  /* ------------------------------------------------------------ render ---- */

  function fmtMs(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
  }
  function esc(x) {
    const d = document.createElement('div');
    d.textContent = String(x == null ? '' : x);
    return d.innerHTML;
  }

  const BOARD_MAP = {
    connected: ['ok', 'board ready'], scanning: ['warn', 'searching…'], connecting: ['warn', 'connecting…'],
    error: ['bad', 'board error'], off: ['bad', 'bluetooth off'], idle: ['warn', 'board off'],
  };

  function cardHtml(hub, i) {
    if (hub.offline || !hub.state) {
      return `<div class="card"><div class="bhead"><span class="bname">${esc(hub.name)}</span></div>
        <div class="offline">offline — check that PC is on</div></div>`;
    }
    const s = hub.state;
    const b = s.board || {};
    const [bc, bt] = BOARD_MAP[b.state] || ['warn', b.state || '…'];
    const batt = (b.battery !== null && b.battery !== undefined && b.state === 'connected')
      ? `<span class="pill ${b.batteryLow ? 'bad' : b.battery <= 60 ? 'warn' : 'ok'}">🔋 ${b.battery}%</span>` : '';

    const sess = s.session;
    let clock;
    if (!sess) clock = `<div class="st">no timer — oche closed</div><div class="big warn">—</div>
                        <div class="st">start a session to open it</div>`;
    else if (sess.mode === 'stopwatch') {
      clock = sess.started
        ? `<div class="st">stopwatch — pay at the end</div>
           <div class="big">${fmtMs(Date.now() + (hub.offset || 0) - sess.startedAt)}</div>
           <div class="st">counting up</div>`
        : `<div class="st">stopwatch on — waiting for their first game</div>
           <div class="big warn">0:00</div><div class="st">&nbsp;</div>`;
    }
    else if (!sess.started) clock = `<div class="st">armed — waiting for their first game</div>
                        <div class="big warn">${sess.minutes} min</div><div class="st">&nbsp;</div>`;
    else {
      const left = sess.endsAt - (Date.now() + (hub.offset || 0));
      clock = left <= 0
        ? `<div class="st">time is up — oche closed</div><div class="big bad">0:00</div><div class="st">extend to reopen</div>`
        : `<div class="st">counting down</div><div class="big ${left < 5 * 60000 ? 'bad' : ''}">${fmtMs(left)}</div>
           <div class="st">of ${sess.minutes} minutes</div>`;
    }

    const m = s.match;
    const now = m
      ? `<b>${esc(m.title || m.gameId)}</b> — ${m.rows.map((r) => `${esc(r.name)} ${esc(r.primary)}`).join(' · ')}${m.finished ? ' <b>(finished)</b>' : ''}`
      : 'No game running.';

    const base = hub.url || '';
    return `<div class="card" data-hub="${i}">
      <div class="bhead">
        <span class="bname">${esc(hub.name)}</span>
        <span class="spacer"></span>
        ${batt}<span class="pill ${bc}">${bt}</span>
        ${hub.unlocked ? '' : '<span class="pill bad">different PIN</span>'}
      </div>
      <div class="bclock">${clock}</div>
      <div class="actions">
        <button class="go" data-act="start" data-m="60">1 hour</button>
        <button class="go" data-act="start" data-m="120">2 hours</button>
        <button data-act="stopwatch">Stopwatch (pay at end)</button>
        <button class="ghost" data-act="clear">Clear</button>
      </div>
      <div class="rowline">
        <input type="number" min="5" max="480" placeholder="Custom minutes" data-in="mins">
        <button data-act="startcustom">Start</button>
      </div>
      <div class="actions three">
        <button data-act="extend" data-m="15">+15 min</button>
        <button data-act="extend" data-m="30">+30 min</button>
        <button class="danger" data-act="end">End now</button>
      </div>
      <div class="nowline">${now}</div>
      <details class="more">
        <summary>Board &amp; sound</summary>
        <div class="actions three" style="margin-top:8px">
          <button data-act="connect">Connect</button>
          <button data-act="wake">Wake board</button>
          <button class="ghost" data-act="disconnect">Disconnect</button>
        </div>
        <div class="actions">
          <button data-act="calibrate">Line up board (dart in the 20)</button>
          <button class="ghost" data-act="test">Test caller on TV</button>
        </div>
        <p class="subhint">Diagnostics: <a href="${base}/api/board-diag.txt" target="_blank" rel="noopener">open the report</a>
          — it also saves diagnostics.txt next to that PC's exe.</p>
        <div class="rowline">
          <input type="text" maxlength="24" placeholder="Rename this board" data-in="bname">
          <button data-act="rename">Rename</button>
        </div>
      </details>
    </div>`;
  }

  let lastSig = '';
  function render() {
    const host = $('boards');
    // Re-render only when something structural changed; the clocks tick below.
    const sig = hubs.map((h) => [h.name, h.offline, h.unlocked, !!h.state,
      h.state && JSON.stringify([h.state.session, h.state.match && h.state.match.rows, h.state.board && h.state.board.state, h.state.board && h.state.board.battery])].join('|')).join('§');
    if (sig === lastSig) return;
    lastSig = sig;
    host.innerHTML = hubs.map((h, i) => cardHtml(h, i)).join('');

    const self = hubs[0].state;
    if (self && self.settings) {
      if (document.activeElement !== $('vname')) $('vname').value = self.settings.venueName || '';
      if (document.activeElement !== $('vtag')) $('vtag').value = self.settings.venueTagline || '';
      if (document.activeElement !== $('vloc')) $('vloc').value = self.settings.venueLocation || '';
      renderPeers(self.settings.peers || []);
    }
    if (self && self.brand) { paintBrand(self.brand); renderThemes(self.brand); }
  }

  // Tick just the clock digits between renders.
  setInterval(() => {
    document.querySelectorAll('#boards .card[data-hub]').forEach((card) => {
      const hub = hubs[Number(card.dataset.hub)];
      if (!hub || !hub.state || !hub.state.session || !hub.state.session.started) return;
      const sess = hub.state.session;
      const big = card.querySelector('.big');
      if (!big) return;
      if (sess.mode === 'stopwatch') { big.textContent = fmtMs(Date.now() + (hub.offset || 0) - sess.startedAt); return; }
      const left = sess.endsAt - (Date.now() + (hub.offset || 0));
      if (left > 0) { big.textContent = fmtMs(left); big.className = 'big' + (left < 5 * 60000 ? ' bad' : ''); }
      else { lastSig = ''; render(); }
    });
  }, 1000);

  $('boards').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = e.target.closest('[data-hub]');
    const hub = hubs[Number(card.dataset.hub)];
    const sk = hub.socket;
    const act = btn.dataset.act;
    if (act === 'start') sk.emit('sessionStart', Number(btn.dataset.m));
    else if (act === 'startcustom') {
      const inp = card.querySelector('[data-in="mins"]');
      if (!Number(inp.value)) return toast('Type the minutes first', 'error');
      sk.emit('sessionStart', Number(inp.value)); inp.value = '';
    } else if (act === 'stopwatch') sk.emit('sessionStopwatch');
    else if (act === 'extend') sk.emit('sessionExtend', Number(btn.dataset.m));
    else if (act === 'end') sk.emit('sessionEnd');
    else if (act === 'clear') sk.emit('sessionClear');
    else if (act === 'connect') sk.emit('boardConnect');
    else if (act === 'wake') sk.emit('boardWake');
    else if (act === 'disconnect') sk.emit('boardDisconnect');
    else if (act === 'calibrate') sk.emit('calibrate');
    else if (act === 'test') sk.emit('testCaller');
    else if (act === 'rename') {
      const inp = card.querySelector('[data-in="bname"]');
      if (!inp.value.trim()) return toast('Type the new name first', 'error');
      sk.emit('saveSettings', { boardName: inp.value.trim() }); inp.value = '';
    }
  });

  /* --------------------------------------------- venue-wide settings ----- */

  function everyHub(fn) { for (const h of hubs) if (!h.offline) fn(h.socket); }

  function paintBrand(b) {
    Brand.applyTheme(b.theme);
    Brand.title(b.name, 'Staff');
    Brand.render($('sbrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'sm' });
    Brand.render($('gatebrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'md' });
  }
  let themeKey = '';
  function renderThemes(b) {
    const key = b.theme + '|' + (b.themes || []).join(',');
    if (key === themeKey) return;
    themeKey = key;
    const host = $('themepick');
    host.innerHTML = '';
    for (const t of (b.themes || [])) {
      const btn = document.createElement('button');
      btn.className = 'chipbtn' + (t === b.theme ? ' sel' : '');
      btn.textContent = t;
      btn.addEventListener('click', () => everyHub((sk) => sk.emit('saveSettings', { theme: t })));
      host.appendChild(btn);
    }
  }
  $('vsave').addEventListener('click', () => {
    const patch = { venueName: $('vname').value, venueTagline: $('vtag').value, venueLocation: $('vloc').value };
    everyHub((sk) => sk.emit('saveSettings', patch));
    toast('Saved to every board');
  });
  $('savepin').addEventListener('click', () => {
    const v = $('newpin').value.trim();
    if (!/^\d{4,8}$/.test(v)) return toast('PIN must be 4-8 digits', 'error');
    everyHub((sk) => sk.emit('saveSettings', { adminPin: v }));
    sessionStorage.setItem('staffPin', v);
    $('newpin').value = '';
    toast('PIN changed on every board');
  });

  /* ------------------------------------------------------------- peers --- */

  function renderPeers(peers) {
    const host = $('peerlist');
    host.innerHTML = peers.length
      ? peers.map((u) => `<button class="ghost" data-peer="${esc(u)}" style="margin-bottom:8px;text-transform:none;letter-spacing:0">${esc(u)} ✕</button>`).join('')
      : '<p class="hint" style="margin:0 0 4px">Just this board so far.</p>';
  }
  $('peerlist').addEventListener('click', (e) => {
    const b = e.target.closest('[data-peer]');
    if (!b) return;
    const peers = ((hubs[0].state && hubs[0].state.settings.peers) || []).filter((u) => u !== b.dataset.peer);
    hubs[0].socket.emit('saveSettings', { peers });
    toast('Board removed - reload this page');
  });
  $('addpeer').addEventListener('click', () => {
    const u = $('newpeer').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(u)) return toast('Address must start with http://', 'error');
    addBoards([u]);
    $('newpeer').value = '';
  });

  // Save new boards on the serving hub, then reload: the reload is the
  // "relink" - the page reopens a socket to every board on the new list.
  // The reload waits for the hub to echo the saved list back, so a dropped
  // connection shows an error instead of quietly losing the board.
  function addBoards(urls) {
    if (!hubs[0].socket.connected) return toast('Reconnecting to this board - try again in a moment', 'error');
    const current = (hubs[0].state && hubs[0].state.settings.peers) || [];
    let fresh = urls.filter((u) => !current.includes(u));
    if (!fresh.length) return toast('Already on the list');
    const room = 8 - current.length;
    if (room <= 0) return toast('Board list is full (8) - remove one first', 'error');
    if (fresh.length > room) {
      fresh = fresh.slice(0, room);
      toast(`Only room for ${room} more - adding ${room}`, 'error');
    }
    hubs[0].socket.emit('saveSettings', { peers: current.concat(fresh) });
    const t0 = Date.now();
    const confirm = setInterval(() => {
      const saved = (hubs[0].state && hubs[0].state.settings.peers) || [];
      if (fresh.every((u) => saved.includes(u))) {
        clearInterval(confirm);
        toast(fresh.length === 1 ? 'Board added - linking up...' : `${fresh.length} boards added - linking up...`);
        setTimeout(() => location.reload(), 900);
      } else if (Date.now() - t0 > 4000) {
        clearInterval(confirm);
        toast('That did not save - check this board and try again', 'error');
      }
    }, 200);
  }

  $('findboards').addEventListener('click', () => {
    const btn = $('findboards');
    const host = $('foundlist');
    btn.disabled = true;
    btn.textContent = 'Looking for boards...';
    if (!hubs[0].socket.connected) {
      btn.disabled = false;
      btn.textContent = 'Find boards';
      return toast('Reconnecting to this board - try again in a moment', 'error');
    }
    let answered = false;
    const settle = (res) => {
      if (answered) return;
      answered = true;
      btn.disabled = false;
      btn.textContent = 'Find boards';
      if (!res) return toast('Scan timed out - try again', 'error');
      if (res.locked) return toast('Settings are locked - enter the PIN again', 'error');
      const boards = (res.boards || []).slice(0, 24);
      // A hub whose PIN differs (a fresh PC, usually) is real but not addable
      // until its PIN matches - one tap would otherwise hand our PIN to a
      // machine that has not proved it belongs to this venue.
      const strayNote = res.mismatched
        ? `<p class="hint" style="margin:0 0 8px">${res.mismatched} more answered but ${res.mismatched === 1 ? "isn't" : "aren't"} using this venue's PIN - set the PIN on that PC to match, then scan again.</p>`
        : '';
      const mine = new Set(((hubs[0].state && hubs[0].state.settings.peers) || []));
      const fresh = boards.filter((b) => !mine.has(b.url));
      if (!boards.length) {
        host.innerHTML = strayNote || '<p class="hint" style="margin:0 0 8px">No other boards answered. Check the other PCs are on, running WinchesterDarts, and on this network.</p>';
        return;
      }
      if (!fresh.length) {
        host.innerHTML = strayNote;
        return toast(`All ${boards.length} board${boards.length === 1 ? '' : 's'} found are already added`);
      }
      host.innerHTML = fresh.map((b) =>
        `<button data-found="${esc(b.url)}" style="width:100%;margin-bottom:8px;text-transform:none;letter-spacing:0">+ ${esc(b.name)} — ${esc(b.url)}</button>`).join('')
        + (fresh.length > 1
          ? `<button id="addall" class="ghost" style="width:100%;margin-bottom:8px">Add all ${fresh.length}</button>` : '')
        + strayNote;
    };
    hubs[0].socket.emit('findBoards', (res) => settle(res || null));
    setTimeout(() => settle(null), 6000); // lost packet: never hang the button
  });

  $('foundlist').addEventListener('click', (e) => {
    const all = e.target.closest('#addall');
    if (all) return addBoards([...document.querySelectorAll('#foundlist [data-found]')].map((b) => b.dataset.found));
    const one = e.target.closest('[data-found]');
    if (one) addBoards([one.dataset.found]);
  });

  /* -------------------------------------------------------------- boot --- */

  fetch('/api/brand').then((r) => r.json()).then(paintBrand).catch(() => {});
  addHub('');
  fetch('/api/peers').then((r) => r.json()).then((p) => {
    for (const u of (p.peers || [])) addHub(u);
  }).catch(() => {});
})();
