/* TV screen: live board, scoreboard, celebrations. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });
  const boardSvg = $('board');

  DartBoard.render(boardSvg, { numbers: true });
  DartBoard.render($('idleboard'), { numbers: false });

  let celebrationFiles = [];
  fetch('/api/celebrations').then((r) => r.json()).then((f) => { celebrationFiles = f; }).catch(() => {});

  let settings = { celebrations: true, sound: true };

  function paintBrand(b) {
    if (!b) return;
    Brand.applyTheme(b.theme);
    Brand.title(b.name, 'TV');
    Brand.render($('tvbrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'md' });
    Brand.render($('idlebrand'), { name: b.name, tagline: b.tagline, location: b.location,
                                   logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'lg' });
    Brand.render($('wmbrand'), { name: b.name, tagline: '', logoUrl: null, size: 'lg' });
    Brand.render($('celbrand'), { name: b.name, tagline: '', logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'sm' });
  }
  fetch('/api/brand').then((r) => r.json()).then(paintBrand).catch(() => {});

  // Addresses for the idle screen, so anyone walking up knows where to point a device
  fetch('/api/urls').then((r) => r.json()).then((u) => {
    $('idle-tv').textContent = u.tv;
    $('idle-pad').textContent = u.pad;
    if (u.qrPad) $('idleqrimg').src = u.qrPad;
  }).catch(() => {});

  /* ------------------------------------------------------------ render -- */

  let brandKey = '';
  function renderState(s) {
    const m = s.match;
    settings = s.settings || settings;
    // Repaint only when the venue name, tagline, theme or logo actually changes
    const key = JSON.stringify(s.brand || {});
    if (s.brand && key !== brandKey) { brandKey = key; paintBrand(s.brand); }


    if (!m) {
      $('idle').classList.remove('hidden');
      return;
    }
    $('idle').classList.add('hidden');

    $('gtitle').textContent = m.title || 'Darts';
    $('gsub').textContent = m.subtitle || '';

    const rows = $('rows');
    rows.innerHTML = '';
    for (const r of m.rows) {
      const div = document.createElement('div');
      div.className = 'row' + (r.active ? ' on' : '');

      const left = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = r.name;
      left.appendChild(nm);

      if (r.marks) {
        const mk = document.createElement('div');
        mk.className = 'marks';
        for (const k of r.marks) {
          const cell = document.createElement('div');
          cell.className = `mk p${k.count}` + (k.dead ? ' dead' : '');
          cell.innerHTML = `<div class="t">${k.target}</div><div class="v">${['–', '/', 'X', '⊗'][k.count]}</div>`;
          mk.appendChild(cell);
        }
        left.appendChild(mk);
      }

      if (r.chips && r.chips.length) {
        const chips = document.createElement('div');
        chips.className = 'chips';
        for (const c of r.chips) {
          const sp = document.createElement('span');
          sp.className = 'chip';
          sp.innerHTML = `${c.label}<b>${c.value}</b>`;
          chips.appendChild(sp);
        }
        left.appendChild(chips);
      }

      if (r.checkout && r.checkout.length) {
        const co = document.createElement('div');
        co.className = 'co';
        co.innerHTML = 'checkout ' + r.checkout.map((x) => `<b>${x}</b>`).join('');
        left.appendChild(co);
      }
      if (r.progress !== undefined) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.innerHTML = `<i style="width:${Math.round(r.progress * 100)}%"></i>`;
        left.appendChild(bar);
      }

      const right = document.createElement('div');
      right.style.textAlign = 'right';
      const big = document.createElement('div');
      big.className = 'big';
      big.textContent = r.primary;
      right.appendChild(big);
      if (r.legs) {
        const lg = document.createElement('div');
        lg.className = 'legs';
        lg.textContent = `${r.legs} leg${r.legs > 1 ? 's' : ''}`;
        right.appendChild(lg);
      }

      div.appendChild(left);
      div.appendChild(right);
      rows.appendChild(div);
    }

    const showing = m.visit.length ? m.visit : (m.lastVisit || []);
    const stale = !m.visit.length && (m.lastVisit || []).length > 0;
    for (let i = 0; i < 3; i++) {
      const slot = $('s' + i);
      const d = showing[i];
      slot.textContent = d ? d.label : '·';
      slot.className = 'slot' + (d ? (stale ? ' was' : ' on') : '');
    }
    $('visitsum').textContent = m.visit.length ? `this visit ${m.visitTotal}`
      : stale ? `last visit ${m.lastVisitTotal}` : ' ';

    const b = s.board || {};
    const foot = $('foot');
    if (b.state === 'connected') foot.innerHTML = '<span class="live">● board connected</span> — throw away';
    else if (b.state === 'scanning') foot.innerHTML = '<span class="warn">● looking for the board…</span>';
    else if (b.state === 'error' || b.state === 'off') foot.innerHTML = `<span class="warn">● ${b.detail || 'board problem'}</span>`;
    else foot.innerHTML = '<span class="warn">● board not connected</span> — scoring by tablet';
  }

  /* ------------------------------------------------------ celebrations -- */

  const CEL = {
    oneeighty: { text: 'ONE HUNDRED\nAND EIGHTY!', sub: (e) => e.player, big: true, boom: 160, sound: 'fanfare' },
    bigscore: { text: (e) => (e.tier >= 140 ? `${e.score}!` : `${e.score}`), sub: (e) => (e.tier >= 140 ? `${e.player} · big score` : `${e.player} · ton plus`), boom: 70, sound: 'rise' },
    checkout: { text: 'GAME SHOT!', sub: (e) => `${e.player} · ${e.from} in ${e.darts} dart${e.darts > 1 ? 's' : ''}`, boom: 200, sound: 'fanfare' },
    matchwin: { text: (e) => `${e.player}\nWINS!`, sub: () => 'match over', boom: 260, sound: 'fanfare', hold: 6000 },
    legwin: { text: 'LEG WON', sub: (e) => `${e.player} · ${e.legs}`, boom: 100, sound: 'rise' },
    bust: { text: 'BUST', sub: (e) => `${e.player} · ${e.reason}`, bust: true, shake: true, sound: 'thud', hold: 1800 },
    closed: { text: (e) => `${e.target} CLOSED`, sub: (e) => e.player, boom: 60, sound: 'rise' },
    cricketpoints: { text: (e) => `+${e.points}`, sub: (e) => `${e.player} · ${e.target}s`, boom: 40, sound: 'blip' },
    advance: { text: (e) => `NEXT: ${e.target}`, sub: (e) => e.player, sound: 'blip', hold: 1200 },
  };

  let celTimer = null;
  function celebrate(ev) {
    const spec = CEL[ev.type];
    if (!spec || !settings.celebrations) return;

    const cel = $('cel');
    const text = typeof spec.text === 'function' ? spec.text(ev) : spec.text;
    $('celtext').innerHTML = String(text).split('\n').map((l) => `<div>${l}</div>`).join('');
    $('celsub').textContent = typeof spec.sub === 'function' ? spec.sub(ev) : (spec.sub || '');

    const media = $('celmedia');
    const custom = celebrationFiles.find((f) => f.name === ev.type)
      || (ev.type === 'bigscore' && celebrationFiles.find((f) => f.name === String(ev.tier)));
    if (custom && /\.(gif|webp|png)$/i.test(custom.url)) {
      media.src = custom.url + '?t=' + Date.now();
      media.hidden = false;
    } else {
      media.hidden = true;
      media.removeAttribute('src');
    }

    cel.className = 'show' + (spec.bust ? ' bust' : '');
    if (spec.shake) {
      document.body.classList.remove('shake');
      void document.body.offsetWidth;
      document.body.classList.add('shake');
      setTimeout(() => document.body.classList.remove('shake'), 600);
    }
    if (spec.boom) boom(spec.boom, spec.bust);
    if (settings.sound && spec.sound) sound(spec.sound);

    clearTimeout(celTimer);
    celTimer = setTimeout(() => { cel.className = ''; }, spec.hold || 2600);
  }

  /* ---------------------------------------------------------- confetti -- */

  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  let bits = [];
  function fit() { canvas.width = innerWidth; canvas.height = innerHeight; }
  addEventListener('resize', fit); fit();

  function themeColour(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function boom(count, dark) {
    const colours = dark
      ? [themeColour('--red', '#E33A2E'), '#7A1F19', '#FF6A5C']
      : [themeColour('--pink', '#FF2E88'), themeColour('--teal', '#23E5D2'),
         themeColour('--amber', '#FFB921'), '#FFFFFF', themeColour('--ink', '#EEE')];
    for (let i = 0; i < count; i++) {
      bits.push({
        x: canvas.width / 2 + (Math.random() - .5) * canvas.width * .3,
        y: canvas.height * .45 + (Math.random() - .5) * 80,
        vx: (Math.random() - .5) * 22,
        vy: -Math.random() * 20 - 6,
        g: .55 + Math.random() * .3,
        s: 6 + Math.random() * 12,
        r: Math.random() * Math.PI,
        vr: (Math.random() - .5) * .35,
        c: colours[(Math.random() * colours.length) | 0],
        life: 120 + Math.random() * 90,
      });
    }
    if (bits.length && !raf) raf = requestAnimationFrame(tick);
  }

  let raf = null;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    bits = bits.filter((b) => b.life-- > 0 && b.y < canvas.height + 60);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.vy += b.g; b.vx *= .995; b.r += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.c;
      ctx.globalAlpha = Math.min(1, b.life / 40);
      ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      ctx.restore();
    }
    raf = bits.length ? requestAnimationFrame(tick) : null;
    if (!bits.length) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /* ------------------------------------------------------------- sound -- */

  let audio = null;
  function ac() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    if (audio && audio.state === 'suspended') audio.resume();
    return audio;
  }
  function note(freq, start, dur, type, gain) {
    const a = ac(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, a.currentTime + start);
    g.gain.setValueAtTime(0.0001, a.currentTime + start);
    g.gain.exponentialRampToValueAtTime(gain || .18, a.currentTime + start + .02);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
    o.connect(g); g.connect(a.destination);
    o.start(a.currentTime + start); o.stop(a.currentTime + start + dur + .05);
  }
  function sound(kind) {
    if (kind === 'fanfare') [523, 659, 784, 1047].forEach((f, i) => note(f, i * .1, .35, 'triangle', .2));
    else if (kind === 'rise') [440, 587, 784].forEach((f, i) => note(f, i * .07, .2, 'triangle', .15));
    else if (kind === 'blip') note(880, 0, .1, 'square', .08);
    else if (kind === 'thud') { note(120, 0, .3, 'sawtooth', .22); note(80, .05, .35, 'sine', .18); }
  }
  // Browsers block audio until a gesture; any click/key on the TV unlocks it.
  ['pointerdown', 'keydown'].forEach((e) => addEventListener(e, () => ac(), { once: true }));

  /* ------------------------------------------------------------ socket -- */

  socket.on('state', renderState);
  socket.on('dart', (d) => {
    DartBoard.flash(boardSvg, d, 'db-hit');
    $('hittext').textContent = DartBoard.label(d);
    const h = $('hit');
    h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
    if (settings.sound) sound('blip');
  });
  // A dart landed but there is nothing to score it into. Say so on the idle
  // screen and hold it there long enough to be read from the oche.
  let nogameTimer = null;
  socket.on('nogame', (ev) => {
    $('idlelivedart').textContent = ev.label || 'a dart';
    $('idlelive').hidden = false;
    clearTimeout(nogameTimer);
    nogameTimer = setTimeout(() => { $('idlelive').hidden = true; }, 20000);
  });
  socket.on('celebrate', celebrate);
  socket.on('newmatch', () => { $('cel').className = ''; bits = []; $('idlelive').hidden = true; });
  socket.on('disconnect', () => { $('foot').innerHTML = '<span class="warn">● lost contact with the hub — retrying…</span>'; });
})();
