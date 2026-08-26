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

  /* ------------------------------------------------------------- caller -- */

  /*
   * The referee. Short clips generated offline and shipped with the app:
   * total-0.mp3 .. total-180.mp3 plus the specials.
   *
   * Played through WebAudio, NOT an <audio> element. TV and kiosk browsers
   * gate the two separately, and the practical symptom of using elements was
   * "I can hear the beeps but not the voice": the synth's AudioContext was
   * unlocked by the first tap while every element stayed muted. Decoding the
   * mp3 into the same context the beeps use means one unlock covers both -
   * if a beep can sound, so can the caller.
   */
  const clipBufs = {};
  function fetchClip(name) {
    if (clipBufs[name]) return clipBufs[name];
    clipBufs[name] = fetch(`/sounds/${name}.mp3`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => {
        // Callback form: some TV webviews still lack the promise variant.
        const a = ac(); if (!a) return rej(new Error('no audio'));
        a.decodeAudioData(ab, res, rej);
      }))
      .catch((err) => { delete clipBufs[name]; throw err; });
    return clipBufs[name];
  }
  function say(name) {
    if (!settings.sound) return;
    const a = ac(); if (!a) return;
    fetchClip(name).then((buf) => {
      const src = a.createBufferSource();
      const g = a.createGain();
      g.gain.value = 1.0;
      src.buffer = buf;
      src.connect(g); g.connect(a.destination);
      src.start();
    }).catch(() => {});
  }
  // Decode ahead of need - decoding is allowed even before the unlock tap.
  // Deferred a tick: ac() reads state declared further down this file.
  setTimeout(() => {
    ['total-180', 'gameshot', 'bust', 'matchwin', 'legwin', 'welcome'].forEach((n) => {
      fetchClip(n).catch(() => {});
    });
  }, 0);

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

    // What the thrower needs right now - "hit treble 14", "141 to win: ..."
    const activeRow = (m.rows || []).find((r) => r.active);
    const strip = $('ghint');
    if (m.hint && !m.finished) {
      strip.hidden = false;
      strip.textContent = '';
      if (activeRow) {
        const who = document.createElement('b');
        who.textContent = activeRow.name;
        strip.appendChild(who);
      }
      strip.appendChild(document.createTextNode(m.hint));
    } else strip.hidden = true;

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
    killer: { text: 'KILLER!', sub: (e) => `${e.player} armed on D${e.number}`, boom: 110, sound: 'rise', hold: 2200 },
    lifelost: { text: (e) => (e.own ? 'OWN GOAL!' : 'HIT!'),
                sub: (e) => (e.own ? `${e.player} took their own life · ${e.left} left`
                                   : `${e.player} took a life off ${e.victim} · ${e.left} left`),
                boom: 80, sound: 'thud', hold: 2200 },
    eliminated: { text: (e) => `${e.player}\nOUT!`, sub: () => '', bust: true, shake: true, sound: 'thud', hold: 2400 },
    shanghai: { text: 'SHANGHAI!', sub: (e) => `${e.player} · single, double and treble ${e.target}`,
                boom: 220, sound: 'fanfare', hold: 5000 },
    halved: { text: 'HALVED!', sub: (e) => `${e.player} · down to ${e.score}`,
              bust: true, shake: true, sound: 'thud', hold: 2200 },
    gotcha: { text: 'GOTCHA!', sub: (e) => `${e.player} sent ${e.victim} back to nought`,
              boom: 120, sound: 'thud', hold: 2600 },
    prizewin: { text: 'CASH PRIZE WON!', sub: (e) => `${e.player} · £${e.amount} · a PERFECT run`,
                boom: 260, sound: 'fanfare', hold: 5000 },
    prizefail: { text: 'SO CLOSE!', sub: (e) => `${e.player} · ${e.hits} perfect dart${e.hits === 1 ? '' : 's'} · the £${e.amount} stays behind the bar`,
                 boom: 120, sound: 'thud', hold: 3200 },
    homerun: { text: 'HOME RUN!', sub: (e) => e.player, boom: 120, sound: 'rise', hold: 2200 },
    holeinone: { text: 'HOLE IN ONE!', sub: (e) => `${e.player} · hole ${e.hole}`,
                 boom: 160, sound: 'fanfare', hold: 2600 },
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
  // Browsers block audio until a gesture; any click/key on the TV unlocks the
  // AudioContext, and everything - beeps and the caller - plays through it.
  ['pointerdown', 'keydown'].forEach((e) => addEventListener(e, () => ac(), { once: true }));

  /* --------------------------------------------------------- visit card -- */

  const TC_HOLD = 10000;              // long enough to actually read
  let tcTimer = null;
  function showVisit(v) {
    $('tc-name').textContent = v.player || '';
    $('tc-total').textContent = v.total;
    $('tc-darts').innerHTML = (v.darts && v.darts.length)
      ? v.darts.map((d) => `<b>${d.label}</b>`).join(' · ')
      : 'no darts';
    const card = $('turncard');
    card.style.setProperty('--tc-hold', `${TC_HOLD}ms`);
    card.classList.remove('show');
    void card.offsetWidth;            // restart the drain bar
    card.classList.add('show');
    clearTimeout(tcTimer);
    tcTimer = setTimeout(hideVisit, TC_HOLD);
  }
  function hideVisit() {
    clearTimeout(tcTimer);
    tcTimer = null;
    $('turncard').classList.remove('show');
  }

  socket.on('visit', (v) => {
    showVisit(v);
    // The caller: the big moments get their own words, everything else gets
    // the total, exactly like the man at the oche.
    if (v.special === 'matchwin') say('matchwin');
    else if (v.special === 'legwin') say('legwin');
    else if (v.special === 'checkout') say('gameshot');
    else if (v.special === 'bust') say('bust');
    else say(`total-${Math.max(0, Math.min(180, v.total | 0))}`);
  });

  /* ------------------------------------------------------------ socket -- */

  /* ------------------------------------------------------ session clock -- */

  let sess = null;
  let sessOffset = 0;
  function fmtLeft(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0');
  }
  function renderClock() {
    const el = $('sessclock');
    const idle = $('idlesess');
    if (sess && sess.mode === 'stopwatch') {
      const on = sess.started;
      el.hidden = !on;
      idle.hidden = false;
      idle.className = '';
      if (on) {
        const up = fmtLeft(Date.now() + sessOffset - sess.startedAt);
        el.className = ''; el.textContent = `⏱ ${up}`;
        idle.textContent = `⏱ ${up} on the clock`;
      } else {
        idle.textContent = '⏱ On the stopwatch — starts with your first game';
      }
      return;
    }
    if (!sess || !sess.started) {
      el.hidden = true;
      if (sess && !sess.started) { idle.hidden = false; idle.className = ''; idle.textContent = `⏱ ${sess.minutes} minutes on the clock — starts with your first game`; }
      else idle.hidden = true;
      return;
    }
    const left = sess.endsAt - (Date.now() + sessOffset);
    el.hidden = false;
    idle.hidden = false;
    if (left <= 0) {
      el.className = 'up'; el.textContent = '⏱ TIME UP';
      idle.className = 'up'; idle.textContent = '⏱ Time is up — see the bar to add more';
    } else {
      el.className = left < 5 * 60000 ? 'low' : '';
      el.textContent = `⏱ ${fmtLeft(left)}`;
      idle.className = '';
      idle.textContent = `⏱ ${fmtLeft(left)} left on the clock`;
    }
  }
  setInterval(renderClock, 1000);
  socket.on('sessionover', () => { renderClock(); });

  socket.on('state', (s) => {
    sess = s.session || null;
    if (sess && sess.serverNow) sessOffset = sess.serverNow - Date.now();
    renderClock();
    renderState(s);
  });
  socket.on('dart', (d) => {
    hideVisit();                      // play has moved on - back to live scores
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
  socket.on('newmatch', () => {
    $('cel').className = ''; bits = []; $('idlelive').hidden = true;
    hideVisit();
    say('welcome');                   // "Game on!"
  });
  socket.on('disconnect', () => { $('foot').innerHTML = '<span class="warn">● lost contact with the hub — retrying…</span>'; });
})();
