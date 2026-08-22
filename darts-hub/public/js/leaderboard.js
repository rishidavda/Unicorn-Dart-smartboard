/* Leaderboard: top 20 players from the last 50 finished games, plus the tape. */
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

  function render(hist) {
    const games = (hist || []).filter((h) => h && h.winner);
    $('scope').textContent = `last ${games.length || 0} game${games.length === 1 ? '' : 's'}`;

    // Standings: a win is a win; played counts every game your name was in.
    const stats = new Map();
    for (const g of games) {
      for (const name of g.players || []) {
        if (!stats.has(name)) stats.set(name, { name, wins: 0, played: 0 });
        stats.get(name).played++;
      }
      if (stats.has(g.winner)) stats.get(g.winner).wins++;
    }
    const top = [...stats.values()]
      .sort((a, b) => b.wins - a.wins || (b.wins / b.played) - (a.wins / a.played) || a.played - b.played)
      .slice(0, 20);

    const rows = $('rows');
    rows.innerHTML = top.map((p, i) =>
      `<tr class="${i === 0 && p.wins > 0 ? 'p1' : ''}">
        <td class="rank">${i + 1}</td>
        <td class="name">${esc(p.name)}</td>
        <td class="num">${p.wins}</td>
        <td class="num">${p.played}</td>
        <td class="pct">${p.played ? Math.round(100 * p.wins / p.played) : 0}%</td>
      </tr>`).join('');
    $('empty').hidden = top.length > 0;

    const recent = games.slice(-10).reverse();
    $('results').innerHTML = recent.map((g) => {
      const when = new Date(g.at);
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      const others = (g.players || []).filter((n) => n !== g.winner);
      return `<div class="r">
        <span class="who win">${esc(g.winner)}</span>
        <span>beat ${others.length ? others.map(esc).join(', ') : 'the board'}</span>
        <span class="meta">${esc(GAME_NAMES[g.game] || g.game)} · ${hh}:${mm}</span>
      </div>`;
    }).join('');
    $('rempty').hidden = recent.length > 0;
  }

  socket.on('state', (s) => render(s.history50 || []));
})();
