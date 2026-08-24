/* iPad control panel. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });

  let state = null;
  let games = [];
  let pick = { gameId: 'x01', variantId: null, config: {}, players: [] };
  let editingAdjust = false;

  let brandKey = '';
  function paintBrand(b) {
    if (!b) return;
    Brand.applyTheme(b.theme);
    Brand.title(b.name, 'Control');
    Brand.render($('padbrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'sm' });
    Brand.render($('tu-brand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'md' });
  }
  fetch('/api/brand').then((r) => r.json()).then(paintBrand).catch(() => {});

  DartBoard.render($('tapboard'), {
    numbers: true,
    interactive: true,
    onHit: (d) => socket.emit('dart', d),
  });

  /* ------------------------------------------------------------- tabs -- */

  function showTab(name) {
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === 'v-' + name);
    for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
    renderTimeUp();          // hoisted; leaving Settings brings the closed sign back
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) showTab(t.dataset.tab);
  });

  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'show' + (kind === 'error' ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 2200);
  }

  /* ------------------------------------------------------------ setup -- */
  /*
   * Two easy steps: 1) who's playing, 2) pick a game. Every game card has a
   * "How to play" button opening the rules sheet, and games are grouped so
   * thirty of them never feel like thirty.
   */
  const CATS = [
    ['classics', 'Classics'],
    ['party', 'Party games'],
    ['races', 'Score races'],
    ['practice', 'Practice'],
  ];
  let stage = 1;
  let cat = 'classics';

  function setStage(n) {
    if (n === 2 && !pick.players.length) { toast('Add at least one player first', 'error'); n = 1; }
    stage = n;
    $('stage-players').hidden = n !== 1;
    $('stage-games').hidden = n !== 2;
    $('step1btn').classList.toggle('on', n === 1);
    $('step2btn').classList.toggle('on', n === 2);
  }
  $('step1btn').addEventListener('click', () => setStage(1));
  $('step2btn').addEventListener('click', () => setStage(2));
  $('btn-toGames').addEventListener('click', () => setStage(2));
  $('btn-backPlayers').addEventListener('click', () => setStage(1));

  function renderCats() {
    const host = $('catpick');
    host.innerHTML = '';
    for (const [id, labelTxt] of CATS) {
      const b = document.createElement('button');
      b.className = 'chipbtn' + (id === cat ? ' sel' : '');
      b.textContent = labelTxt;
      b.addEventListener('click', () => { cat = id; renderCats(); renderGames(); });
      host.appendChild(b);
    }
  }

  function openRules(g) {
    $('rs-title').textContent = g.label;
    const pr = g.players || { min: 1, max: 8 };
    $('rs-players').textContent = pr.min === pr.max
      ? `For exactly ${pr.min} players` : `For ${pr.min}–${pr.max} players`;
    $('rs-rules').textContent = g.rules || g.blurb;
    $('rulesheet').hidden = false;
    $('rs-pick').onclick = () => { $('rulesheet').hidden = true; selectGame(g); };
  }
  $('rs-close').addEventListener('click', () => { $('rulesheet').hidden = true; });

  function selectGame(g) {
    pick.gameId = g.id;
    pick.variantId = (g.variants[0] || {}).id || null;
    pick.config = {};
    $('gamedetail').hidden = false;
    const pr = g.players || { min: 1, max: 8 };
    $('gd-title').textContent = `${g.label} · ${pr.min === pr.max ? `${pr.min} players` : `${pr.min}–${pr.max} players`}`;
    renderGames(); renderVariants(); renderOptions();
    $('gamedetail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderGames() {
    const host = $('gamecards');
    host.innerHTML = '';
    for (const g of games.filter((x) => (x.category || 'party') === cat)) {
      const card = document.createElement('div');
      card.className = 'card' + (g.id === pick.gameId ? ' sel' : '');
      card.innerHTML = `<h3>${g.label}<span class="info">How to play</span></h3><p>${g.blurb}</p>`;
      card.querySelector('.info').addEventListener('click', (e) => { e.stopPropagation(); openRules(g); });
      card.addEventListener('click', () => selectGame(g));
      host.appendChild(card);
    }
    // Hide the variant/start block when the chosen game lives in another tab
    const sel = games.find((x) => x.id === pick.gameId);
    $('gamedetail').hidden = !sel || (sel.category || 'party') !== cat;
  }

  function currentGame() { return games.find((g) => g.id === pick.gameId) || games[0]; }

  function renderVariants() {
    const g = currentGame();
    const host = $('variants');
    host.innerHTML = '';
    if (!g) return;
    if (!pick.variantId && g.variants.length) pick.variantId = g.variants[0].id;
    for (const v of g.variants) {
      const b = document.createElement('button');
      b.className = 'chipbtn' + (v.id === pick.variantId ? ' sel' : '');
      b.textContent = v.label;
      b.addEventListener('click', () => { pick.variantId = v.id; pick.config = {}; renderVariants(); renderOptions(); });
      host.appendChild(b);
    }
  }

  function renderOptions() {
    const g = currentGame();
    const host = $('options');
    host.innerHTML = '';
    if (!g) return;
    const variant = g.variants.find((v) => v.id === pick.variantId);
    const base = Object.assign({}, g.defaults, variant ? variant.config : {}, pick.config);
    for (const o of g.options || []) {
      if (o.type === 'bool') {
        const l = document.createElement('label');
        l.className = 'toggle';
        l.innerHTML = `${o.label}<input type="checkbox" ${base[o.key] ? 'checked' : ''}>`;
        l.querySelector('input').addEventListener('change', (e) => { pick.config[o.key] = e.target.checked; });
        host.appendChild(l);
      } else if (o.type === 'number') {
        const l = document.createElement('div');
        l.className = 'rowline';
        l.innerHTML = `<span class="pill">${o.label}</span>`;
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = o.min || 1; inp.max = o.max || 99; inp.value = base[o.key];
        inp.addEventListener('change', () => { pick.config[o.key] = Number(inp.value); });
        l.appendChild(inp);
        host.appendChild(l);
      }
    }
  }

  function renderPlayerPick() {
    const host = $('playerpick');
    host.innerHTML = '';
    for (const p of (state && state.roster) || []) {
      const chosen = pick.players.some((x) => x.id === p.id);
      const b = document.createElement('button');
      b.className = 'chipbtn' + (chosen ? ' sel' : '');
      b.textContent = p.name;
      b.addEventListener('click', () => {
        if (chosen) pick.players = pick.players.filter((x) => x.id !== p.id);
        else if (pick.players.length < 8) pick.players.push({ id: p.id, name: p.name });
        renderPlayerPick();
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const list = state.roster.filter((x) => x.id !== p.id);
        socket.emit('savePlayers', list);
        pick.players = pick.players.filter((x) => x.id !== p.id);
      });
      host.appendChild(b);
    }
    if (!((state && state.roster) || []).length) {
      host.innerHTML = '<span class="hint">No players yet — type a name below and press Add.</span>';
    }
    $('chosen').textContent = pick.players.length
      ? `Playing: ${pick.players.map((p) => p.name).join(' · ')} (tap again to remove, long-press a name to delete it)`
      : (((state && state.roster) || []).length ? 'Tap names to add them to the game.' : '');
  }

  $('btn-addname').addEventListener('click', addName);
  $('newname').addEventListener('keydown', (e) => { if (e.key === 'Enter') addName(); });
  function addName() {
    const v = $('newname').value.trim();
    if (!v) return;
    const list = ((state && state.roster) || []).concat([{ id: 'r' + Date.now(), name: v }]);
    socket.emit('savePlayers', list);
    $('newname').value = '';
    setTimeout(() => {
      const added = (state.roster || []).find((p) => p.name === v);
      if (added && !pick.players.some((x) => x.id === added.id)) pick.players.push(added);
      renderPlayerPick();
    }, 220);
  }

  $('btn-clearsel').addEventListener('click', () => { pick.players = []; renderPlayerPick(); });

  $('btn-start').addEventListener('click', () => {
    if (!pick.players.length) return toast('Pick at least one player', 'error');
    const g = games.find((x) => x.id === pick.gameId);
    const pr = (g && g.players) || { min: 1, max: 8 };
    if (pick.players.length < pr.min || pick.players.length > pr.max) {
      return toast(pr.min === pr.max
        ? `${g.label} needs exactly ${pr.min} players`
        : `${g.label} takes ${pr.min}–${pr.max} players`, 'error');
    }
    socket.emit('newMatch', {
      gameId: pick.gameId, variantId: pick.variantId,
      config: pick.config, players: pick.players,
    });
    showTab('play');
  });

  /* -------------------------------------------------------------- play -- */

  $('btn-next').addEventListener('click', () => socket.emit('endTurn'));
  $('btn-next2').addEventListener('click', () => socket.emit('endTurn'));
  $('btn-undo').addEventListener('click', () => socket.emit('undo'));
  $('btn-undo2').addEventListener('click', () => socket.emit('undo'));
  $('btn-miss').addEventListener('click', () => socket.emit('dart', { score: 0, multiplier: 1 }));
  for (const b of document.querySelectorAll('[data-dart]')) {
    const [s, m] = b.dataset.dart.split(',').map(Number);
    b.addEventListener('click', () => socket.emit('dart', { score: s, multiplier: m }));
  }
  $('btn-restart').addEventListener('click', () => { socket.emit('restart'); toast('Game restarted'); showTab('play'); });
  $('btn-end').addEventListener('click', () => { socket.emit('endMatch'); toast('Game ended'); showTab('setup'); setStage(1); });
  // Same players, different game: straight to the game list.
  $('btn-change').addEventListener('click', () => {
    socket.emit('endMatch');
    showTab('setup');
    setStage(2);
    toast('Pick the next game');
  });

  function renderMatch(m) {
    $('nogame').hidden = !!m;
    $('game').hidden = !m;
    if (!m) return;

    $('winbanner').hidden = !m.finished;
    if (m.finished && m.winner) $('winbanner').textContent = `🏆 ${m.winner.name} wins — restart or set up a new game`;

    $('padhint').hidden = !(m.hint && !m.finished);
    if (m.hint && !m.finished) $('padhint').textContent = '\u{1F3AF} ' + m.hint;

    const host = $('players');
    host.innerHTML = '';
    for (const r of m.rows) {
      const div = document.createElement('div');
      div.className = 'pl' + (r.active ? ' on' : '');
      const sub = (r.chips || []).slice(0, 2).map((c) => `${c.label} ${c.value}`).join(' · ');
      div.innerHTML =
        `<div><div class="nm">${r.name}</div><div class="sub">${sub}</div>` +
        (r.checkout ? `<div class="co">out: ${r.checkout.join(' ')}</div>` : '') + '</div>' +
        `<div class="sc">${r.primary}</div>`;
      host.appendChild(div);
    }

    for (let i = 0; i < 3; i++) {
      const s = $('v' + i);
      const d = m.visit[i];
      s.textContent = d ? d.label : '·';
      s.className = 'vslot' + (d ? ' on' : '');
    }
    $('btn-undo').disabled = !m.canUndo;
    $('btn-undo2').disabled = !m.canUndo;
  }

  function renderAdjust(m) {
    if (editingAdjust) return;
    const host = $('adjustlist');
    host.innerHTML = '';
    if (!m) { host.innerHTML = '<p class="hint">No game running.</p>'; return; }
    for (const r of m.rows) {
      const row = document.createElement('div');
      row.className = 'rowline';
      row.innerHTML = `<span class="pill" style="min-width:110px">${r.name}</span>`;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.value = typeof r.primary === 'number' ? r.primary : 0;
      inp.addEventListener('focus', () => { editingAdjust = true; });
      inp.addEventListener('blur', () => { editingAdjust = false; });
      const set = document.createElement('button');
      set.textContent = 'Set';
      set.addEventListener('click', () => {
        socket.emit('adjust', { playerId: r.id, value: Number(inp.value) });
        editingAdjust = false;
        toast(`${r.name} set to ${inp.value}`);
      });
      row.appendChild(inp); row.appendChild(set);
      host.appendChild(row);
    }
  }

  /* ---- countdown pill: ticks locally between server snapshots ---- */
  let sess = null;
  let sessOffset = 0;               // serverNow - our now, so drift cannot lie
  function fmtMs(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
  }
  function renderSession() {
    const pill = $('sesspill');
    const info = $('sessinfo');
    if (!sess) {
      pill.hidden = true;
      if (info) info.textContent = 'No timer set. The countdown starts when their first game starts and shows on both screens; when it runs out, no new game can begin.';
      return;
    }
    pill.hidden = false;
    if (sess.mode === 'stopwatch') {
      pill.className = 'pill ok';
      pill.textContent = sess.started ? `⏱ ${fmtMs(Date.now() + sessOffset - sess.startedAt)}` : '⏱ ready';
      return;
    }
    if (!sess.started) {
      pill.className = 'pill warn';
      pill.textContent = `⏱ ${sess.minutes} min ready`;
      if (info) info.textContent = `Timer armed for ${sess.minutes} minutes - it starts counting when their first game starts.`;
      return;
    }
    const left = sess.endsAt - (Date.now() + sessOffset);
    if (left <= 0) {
      pill.className = 'pill bad';
      pill.textContent = '⏱ TIME UP';
      if (info) info.textContent = 'Time is up - no new games can start. Set a new timer to sell more time.';
      return;
    }
    pill.className = 'pill ' + (left < 5 * 60000 ? 'bad' : 'ok');
    pill.textContent = `⏱ ${fmtMs(left)}`;
    if (info) info.textContent = `Counting down: ${fmtMs(left)} left of ${sess.minutes} minutes.`;
  }
  setInterval(renderSession, 1000);

  function renderBoard(b, s) {
    const pill = $('boardpill');
    const map = {
      connected: ['ok', 'board ready'],
      scanning: ['warn', 'searching…'],
      connecting: ['warn', 'connecting…'],
      error: ['bad', 'board error'],
      off: ['bad', 'bluetooth off'],
      idle: ['warn', 'board off'],
    };
    const [cls, text] = map[b.state] || ['warn', b.state];
    pill.className = 'pill ' + cls;
    pill.textContent = text;

    // Board battery, always in view - not buried in Settings. Red when it is
    // low enough to start eating darts.
    const bp = $('battpill');
    if (b.battery === null || b.battery === undefined || b.state !== 'connected') {
      bp.hidden = true;
    } else {
      bp.hidden = false;
      bp.className = 'pill ' + (b.batteryLow ? 'bad' : b.battery <= 60 ? 'warn' : 'ok');
      bp.textContent = `🔋 ${b.battery}%`;
    }
  }

  function renderHistory(list) {
    const host = $('history');
    host.innerHTML = '';
    if (!list || !list.length) { host.innerHTML = '<p class="hint">No games finished yet.</p>'; return; }
    for (const h of list) {
      const d = document.createElement('div');
      d.className = 'hist';
      const when = new Date(h.at).toLocaleString();
      d.textContent = `${when} · ${h.game}${h.variant ? ' ' + h.variant : ''} · ${h.players.join(' v ')} · winner ${h.winner || '—'}`;
      host.appendChild(d);
    }
  }

  /* ------------------------------------------------------------ socket -- */

  socket.on('connect', () => { $('hubpill').className = 'pill ok'; $('hubpill').textContent = 'connected'; });
  socket.on('disconnect', () => { $('hubpill').className = 'pill bad'; $('hubpill').textContent = 'no hub'; });

  /*
   * Time's up: the whole panel closes behind an overlay until staff start a
   * new timer, so the oche is genuinely ready for the next group rather than
   * showing the last group's leftovers. Settings stay reachable through the
   * Staff button (PIN as usual) - the overlay never gets in the way of the
   * person who can fix it.
   */
  function renderTimeUp() {
    const closed = !sess || sess.expired;
    $('timeup').hidden = !closed;
    if (!closed) return;
    const expired = !!(sess && sess.expired);
    $('tu-title').textContent = expired ? "Time's up!" : 'Ready when you are';
    $('tu-msg').textContent = expired
      ? 'Thanks for playing — see the bar to add more time.'
      : 'See the bar to get started — staff will put time on the clock.';
    $('tu-hint').textContent = expired
      ? 'Ready for the next group as soon as a new timer starts.'
      : 'Games unlock the moment a timer is set.';
  }

  socket.on('state', (s) => {
    const first = !state;
    state = s;
    games = s.games;
    sess = s.session || null;
    if (sess && sess.serverNow) sessOffset = sess.serverNow - Date.now();
    renderSession();
    renderTimeUp();
    const bkey = JSON.stringify(s.brand || {});
    if (s.brand && bkey !== brandKey) { brandKey = bkey; paintBrand(s.brand); }
    if (first) {
      renderCats(); renderGames(); renderVariants(); renderOptions();
      if (s.match) {
        pick.gameId = s.match.gameId;
        pick.variantId = s.match.variantId;
      } else {
        showTab('setup');
      }
    }
    renderPlayerPick();
    renderMatch(s.match);
    renderAdjust(s.match);
    renderBoard(s.board || {}, s);
    renderHistory(s.history);
  });

  socket.on('toast', (t) => toast(t.text, t.kind));
  socket.on('celebrate', (ev) => {
    if (ev.type === 'bust') toast(`Bust — ${ev.reason}`, 'error');
    if (ev.type === 'checkout') toast(`Game shot, ${ev.player}!`);
    if (ev.type === 'matchwin') toast(`${ev.player} wins the match!`);
  });
})();
