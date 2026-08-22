/*
 * The venue leaderboard, merged across every board.
 *
 * Reads /api/history from the hub serving the page and from each of its
 * configured peers. Shows: this month's top 50 by wins, the all-time top 10,
 * the record books (most 180s, best visit), and the latest results labelled
 * by board. Live: the local hub pushes over its socket; peers are re-read
 * every 30 seconds.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });

  function paintBrand(b) {
    if (!b) return;
    Brand.applyTheme(b.theme);
    Brand.title(b.name, 'Leaderboard');
    Brand.render($('lbbrand'), { name: b.name, tagline: b.tagline, logoUrl: b.logoUrl, logoWide: b.logoWide, size: 'md' });
  }
  fetch('/api/brand').then((r) => r.json()).then(paintBrand).catch(() => {});

  const GAME_NAMES = { x01: 'X01', cricket: 'Cricket', atc: 'Round the Clock', countup: 'Count-up',
                       killer: 'Killer', shanghai: 'Shanghai', halveit: 'Halve It' };
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  /* --------------------------------------------------------- data pool --- */

  let peers = [];                    // ['' = this hub, 'http://...' ...]
  const pool = new Map();            // url -> { name, history, ok }

  function refresh(url) {
    return fetch(`${url}/api/history`).then((r) => r.json())
      .then((d) => pool.set(url, { name: d.name, history: d.history || [], ok: true }))
      .catch(() => {
        const old = pool.get(url);
        pool.set(url, { name: (old && old.name) || url, history: (old && old.history) || [], ok: false });
      });
  }
  function refreshAll() {
    Promise.all(peers.map(refresh)).then(render);
  }

  fetch('/api/peers').then((r) => r.json()).then((p) => {
    peers = [''].concat(p.peers || []);
    refreshAll();
    setInterval(refreshAll, 30000);
  }).catch(() => { peers = ['']; refreshAll(); });

  // The local hub announces every finished game instantly.
  socket.on('state', () => { refresh('').then(render); });

  /* ------------------------------------------------------------ render --- */

  function standings(games) {
    const stats = new Map();
    for (const g of games) {
      for (const name of g.players || []) {
        if (!stats.has(name)) stats.set(name, { name, wins: 0, played: 0 });
        stats.get(name).played++;
      }
      if (stats.has(g.winner)) stats.get(g.winner).wins++;
    }
    return [...stats.values()]
      .sort((a, b) => b.wins - a.wins || (b.wins / b.played) - (a.wins / a.played) || a.played - b.played);
  }

  function render() {
    const all = [];
    let offline = [];
    for (const [url, entry] of pool) {
      for (const g of entry.history) if (g && g.winner) all.push({ ...g, board: g.board || entry.name });
      if (!entry.ok && url !== '') offline.push(entry.name);
    }
    all.sort((a, b) => new Date(a.at) - new Date(b.at));

    const now = new Date();
    const monthGames = all.filter((g) => {
      const d = new Date(g.at);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });

    const monthName = now.toLocaleString('en-GB', { month: 'long' });
    $('scope').textContent = `${monthName} · ${monthGames.length} game${monthGames.length === 1 ? '' : 's'} across ${pool.size} board${pool.size === 1 ? '' : 's'}`;

    /* this month: top 50 */
    const top = standings(monthGames).slice(0, 50);
    $('rows').innerHTML = top.map((p, i) =>
      `<tr class="${i === 0 && p.wins > 0 ? 'p1' : ''}">
        <td class="rank">${i + 1}</td><td class="name">${esc(p.name)}</td>
        <td class="num">${p.wins}</td><td class="num">${p.played}</td>
        <td class="pct">${p.played ? Math.round(100 * p.wins / p.played) : 0}%</td>
      </tr>`).join('');
    $('empty').hidden = top.length > 0;
    $('boardsnote').innerHTML = offline.length
      ? `Boards in this table: ${pool.size - offline.length} live · <span class="off">${offline.map(esc).join(', ')} unreachable — their games will appear when back on</span>`
      : '';

    /* all time: top 10 + records */
    const atTop = standings(all).slice(0, 10);
    $('atrows').innerHTML = atTop.map((p, i) =>
      `<tr class="${i === 0 && p.wins > 0 ? 'p1' : ''}">
        <td class="rank">${i + 1}</td><td class="name">${esc(p.name)}</td><td class="num">${p.wins}</td>
      </tr>`).join('');

    const most180Game = all.reduce((a, g) => ((g.oneEighties || 0) > ((a && a.oneEighties) || 0) ? g : a), null);
    const bestVisitGame = all.reduce((a, g) => ((g.bestVisit || 0) > ((a && a.bestVisit) || 0) ? g : a), null);
    const fastestWin = all.filter((g) => g.game === 'x01' && g.darts > 0)
      .reduce((a, g) => (!a || g.darts < a.darts ? g : a), null);
    const recs = [];
    if (bestVisitGame && bestVisitGame.bestVisit) {
      recs.push({ k: 'Best visit', v: bestVisitGame.bestVisit, d: `${esc(bestVisitGame.winner)} · ${esc(bestVisitGame.board || '')}` });
    }
    if (most180Game && most180Game.oneEighties) {
      recs.push({ k: 'Most 180s, one game', v: most180Game.oneEighties, d: esc(most180Game.winner) });
    }
    if (fastestWin) {
      recs.push({ k: 'Quickest X01 win', v: `${fastestWin.darts} darts`, d: esc(fastestWin.winner) });
    }
    $('records').innerHTML = recs.length
      ? recs.map((r) => `<div class="rec"><span class="k">${r.k}</span><span class="v">${r.v}</span><span class="d">${r.d}</span></div>`).join('')
      : '<div class="empty">Records appear as games are played.</div>';

    /* latest results, board-labelled */
    const recent = all.slice(-10).reverse();
    $('results').innerHTML = recent.map((g) => {
      const when = new Date(g.at);
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      const others = (g.players || []).filter((n) => n !== g.winner);
      return `<div class="r">
        <span class="who">${esc(g.winner)}</span>
        <span>beat ${others.length ? others.map(esc).join(', ') : 'the board'}</span>
        <span class="meta">${esc(GAME_NAMES[g.game] || g.game)} · ${esc(g.board || '')} · ${hh}:${mm}</span>
      </div>`;
    }).join('');
    $('rempty').hidden = recent.length > 0;
  }
})();
