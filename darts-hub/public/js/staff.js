/* Staff console: sessions, settings and status from behind the till. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });
  let state = null;

  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'show' + (kind === 'error' ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 2200);
  }

  function paintBrand(b) {
    if (!b) return;
    Brand.applyTheme(b.theme);
    Brand.title(b.name, 'Staff');
    Brand.render($('sbrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'sm' });
    Brand.render($('gatebrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'md' });
  }
  fetch('/api/brand').then((r) => r.json()).then(paintBrand).catch(() => {});

  /* ------------------------------------------------------------ PIN gate -- */

  const RELOCK_MS = 30000;
  let pinBuf = '';
  let hiddenAt = null;
  function pinDots() {
    document.querySelectorAll('#pindots i').forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  }
  function lockNow() {
    sessionStorage.removeItem('staffPin');
    socket.emit('lockSettings');
    $('app').hidden = true;
    $('pingate').hidden = false;
    pinBuf = ''; pinDots();
  }
  function tryUnlock(pin, silent) {
    socket.emit('unlock', pin, (res) => {
      if (res && res.ok) {
        sessionStorage.setItem('staffPin', pin);
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
  socket.on('connect', () => {
    const saved = sessionStorage.getItem('staffPin');
    if (saved) tryUnlock(saved, true);
  });
  // Walked away: the console locks itself 30s after the screen is left.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= RELOCK_MS) lockNow();
    hiddenAt = null;
  });
  $('lock').addEventListener('click', lockNow);

  /* ------------------------------------------------------------ session -- */

  let sess = null;
  let sessOffset = 0;
  function fmtMs(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
  }
  function renderClock() {
    const big = $('clockbig');
    if (!sess) {
      $('clockstate').textContent = 'no timer';
      big.className = ''; big.textContent = '—';
      $('clocksub').textContent = 'Start a session below when the group pays.';
      return;
    }
    if (!sess.started) {
      $('clockstate').textContent = 'armed - waiting for their first game';
      big.className = 'warn'; big.textContent = `${sess.minutes} min`;
      $('clocksub').textContent = 'The countdown starts the moment they start a game.';
      return;
    }
    const left = sess.endsAt - (Date.now() + sessOffset);
    if (left <= 0) {
      $('clockstate').textContent = 'time is up';
      big.className = 'bad'; big.textContent = '0:00';
      $('clocksub').textContent = 'The oche is locked. Extend to reopen, or start a fresh session.';
      return;
    }
    $('clockstate').textContent = 'counting down';
    big.className = left < 5 * 60000 ? 'bad' : '';
    big.textContent = fmtMs(left);
    $('clocksub').textContent = `of ${sess.minutes} minutes`;
  }
  setInterval(renderClock, 1000);

  $('s60').addEventListener('click', () => socket.emit('sessionStart', 60));
  $('s120').addEventListener('click', () => socket.emit('sessionStart', 120));
  $('scustom').addEventListener('click', () => {
    const m = Number($('smins').value);
    if (!m) return toast('Type the minutes first', 'error');
    socket.emit('sessionStart', m);
    $('smins').value = '';
  });
  $('sclear').addEventListener('click', () => socket.emit('sessionClear'));
  $('e15').addEventListener('click', () => socket.emit('sessionExtend', 15));
  $('e30').addEventListener('click', () => socket.emit('sessionExtend', 30));
  $('ecustom').addEventListener('click', () => {
    const m = Number($('emins').value);
    if (!m) return toast('Type the minutes first', 'error');
    socket.emit('sessionExtend', m);
    $('emins').value = '';
  });
  $('endnow').addEventListener('click', () => socket.emit('sessionEnd'));

  /* ----------------------------------------------------------- settings -- */

  function renderThemes(b) {
    const host = $('themepick');
    host.innerHTML = '';
    for (const t of (b.themes || [])) {
      const btn = document.createElement('button');
      btn.className = 'chipbtn' + (t === b.theme ? ' sel' : '');
      btn.textContent = t;
      btn.addEventListener('click', () => socket.emit('saveSettings', { theme: t }));
      host.appendChild(btn);
    }
  }
  $('vsave').addEventListener('click', () => {
    socket.emit('saveSettings', {
      venueName: $('vname').value, venueTagline: $('vtag').value, venueLocation: $('vloc').value,
    });
    toast('Saved');
  });
  $('testsound').addEventListener('click', () => socket.emit('testCaller'));
  $('savepin').addEventListener('click', () => {
    const v = $('newpin').value.trim();
    if (!/^\d{4,8}$/.test(v)) return toast('PIN must be 4-8 digits', 'error');
    socket.emit('saveSettings', { adminPin: v });
    sessionStorage.setItem('staffPin', v);
    $('newpin').value = '';
    toast('PIN changed');
  });

  /* -------------------------------------------------------------- state -- */

  const BOARD_MAP = {
    connected: ['ok', 'board ready'], scanning: ['warn', 'searching…'], connecting: ['warn', 'connecting…'],
    error: ['bad', 'board error'], off: ['bad', 'bluetooth off'], idle: ['warn', 'board off'],
  };
  socket.on('state', (s) => {
    state = s;
    sess = s.session || null;
    if (sess && sess.serverNow) sessOffset = sess.serverNow - Date.now();
    renderClock();

    const b = s.board || {};
    const [cls, text] = BOARD_MAP[b.state] || ['warn', b.state || '…'];
    $('boardpill').className = 'pill ' + cls;
    $('boardpill').textContent = text;
    const bp = $('battpill');
    if (b.battery === null || b.battery === undefined || b.state !== 'connected') bp.hidden = true;
    else {
      bp.hidden = false;
      bp.className = 'pill ' + (b.batteryLow ? 'bad' : b.battery <= 60 ? 'warn' : 'ok');
      bp.textContent = `🔋 ${b.battery}%`;
    }

    const m = s.match;
    $('nowplaying').innerHTML = m
      ? `<b>${m.title || m.gameId}</b> — ${m.rows.map((r) => `${r.name} ${r.primary}`).join(' · ')}`
        + (m.finished ? ' <b>(finished)</b>' : '')
      : 'No game running.';

    if (document.activeElement !== $('vname')) $('vname').value = s.settings.venueName || '';
    if (document.activeElement !== $('vtag')) $('vtag').value = s.settings.venueTagline || '';
    if (document.activeElement !== $('vloc')) $('vloc').value = s.settings.venueLocation || '';
    if (s.brand) { paintBrand(s.brand); renderThemes(s.brand); }
  });

  socket.on('toast', (t) => toast(t.text, t.kind));
})();
