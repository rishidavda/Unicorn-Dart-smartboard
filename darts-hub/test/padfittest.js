/*
 * padfittest.js - the players' iPad is one screen: nothing scrolls, nothing
 * can be dragged about, and every button is on the page and tappable.
 *
 * The real iPad page (Chromium, touch, the iPad's real CSS sizes with
 * Safari's toolbars taken off the height) against a real hub (fakeboard.js,
 * board off air), on every common iPad in portrait and landscape:
 *   iPad mini, iPad 10.2", iPad Air / 10th gen, iPad Pro 11", iPad Pro 12.9".
 * Every screen a group meets is visited: no game; names (none, 12, the full
 * 40); each game category, every one of the 25 games picked with its options
 * showing; the How to play sheet for the longest rules; a game with 2, 4 and
 * 8 players (Noughts & Crosses' grid included) and a finished one; the Fix
 * tab with 8 players and recent games; the Prize tab; Time's up; the
 * "oche closed" bar above the setup. In each:
 *   - the page itself cannot scroll, and no box on it scrolls either;
 *   - every button, card, chip, box and the tap board is fully on screen,
 *     not under anything else (its centre is what a finger would hit), and
 *     its label is not cut off;
 *   - nothing is cut off by a box that clips: every score row, game card
 *     title, name, Fix row, recent game and line of the rules or the prize.
 * Problems are listed per screen and device; FAIL_SHOTS=dir saves a
 * screenshot of each failing screen.
 * Ports TPORT (default 9600). Data and logs under $DARTS_TEST_TMP/padfit.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'padfit');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 9600);
const URL = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const DATA = path.join(SP, 'hub');
const SHOTS = process.env.FAIL_SHOTS || '';

// CSS size of the page as Safari shows it (screen less status bar and
// toolbars, about 74 px); a home-screen web app gets more, never less.
const DEVICES = [
  ['iPad mini', 744, 1133], ['iPad 10.2"', 810, 1080], ['iPad Air', 820, 1180],
  ['iPad Pro 11"', 834, 1194], ['iPad Pro 12.9"', 1024, 1366],
];
const SAFARI_CHROME = 74;
const VIEWS = process.env.PADFIT_ONLY ? DEVICES.filter((d) => d[0].includes(process.env.PADFIT_ONLY)) : DEVICES;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 60) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

let hub = null;
process.on('exit', () => { try { if (hub && !hub.exited) hub.kill('SIGKILL'); } catch (_) {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 14 * 60000).unref();

async function startHub() {
  fs.rmSync(SP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ adminPin: '1234', pricePerHour: 10, autoConnect: false, screensaverMinutes: 0 }));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: path.join(SP, 'reports'),
    DARTS_SCREENSAVER: path.join(SP, 'screen saver'), FAKE_FIRST_ABSENT: '1' });
  const fd = fs.openSync(path.join(SP, 'hub.log'), 'a');
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], { env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  k.on('exit', () => { k.exited = true; });
  const up = await until(async () => {
    const j = await (await fetch(`${URL}/api/hub-id`)).json();
    return j && j.pid === k.pid;
  }, 20000, 150);
  if (!up) throw new Error(`hub did not come up (see ${path.join(SP, 'hub.log')})`);
  return k;
}

// Everything that is wrong with what is on screen right now.
function audit() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const issues = [];
  const desc = (el) => {
    if (!el) return 'nothing';
    const t = (el.textContent || el.getAttribute('aria-label') || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 28);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].join('.') : ''}${t ? ` "${t}"` : ''}`;
  };
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const se = document.scrollingElement;
  if (se.scrollHeight > vh + 1 || se.scrollWidth > vw + 1) issues.push(`the page scrolls (${se.scrollWidth}x${se.scrollHeight} in ${vw}x${vh})`);
  for (const el of document.body.querySelectorAll('*')) {
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    const scrollY = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const scrollX = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (scrollY || scrollX) issues.push(`scrolls: ${desc(el)} (${el.scrollHeight} in ${el.clientHeight})`);
  }
  // With a sheet open, only its own controls are reachable - and must be.
  const overlay = ['poweroff', 'timeup', 'rulesheet'].map((id) => document.getElementById(id)).find((el) => el && shown(el));
  const root = overlay || document.body;
  const controls = [...root.querySelectorAll('button, .card, .chipbtn, input, label.toggle, select, #tapboard')].filter(shown);
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) { issues.push(`off screen: ${desc(el)} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`); continue; }
    if (el.disabled) continue;           // greyed out on purpose (Undo with nothing to undo): taps pass through
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit) || (hit.closest && hit.closest('button, .card, .chipbtn, label.toggle') === el))) issues.push(`covered: ${desc(el)} by ${desc(hit)}`);
    if (el.tagName === 'BUTTON' && (el.scrollWidth > el.clientWidth + 2)) issues.push(`label cut off: ${desc(el)} (${el.scrollWidth} in ${el.clientWidth})`);
    if (r.height < 36 && el.tagName !== 'INPUT' && !el.matches('label.toggle *')) issues.push(`too small to tap: ${desc(el)} (${Math.round(r.width)}x${Math.round(r.height)})`);
  }
  // Nothing cut off: every row, card, chip, box and line of text ends
  // inside every box around it that clips (a box that clips its overflow
  // hides it as surely as one that scrolls).
  const clipper = (el) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const q = a.getBoundingClientRect();
      if (r.top < q.top - 1 || r.bottom > q.bottom + 1 || r.left < q.left - 1 || r.right > q.right + 1) return a;
    }
    return null;
  };
  const items = [...root.querySelectorAll('button, .card, .chipbtn, input, label.toggle, .pl, #adjustlist .rowline, .oxocell, .vslot, '
    + '#gamecards .card h3, .rs-card p, .rs-card h2, #prize-pitch p, #prize-pitch li, #prize-pitch h2, .hist, #chosen, .banner, .gamehint, #gd-title, #closedbar')].filter(shown);
  for (const el of items) {
    const a = clipper(el);
    if (a) issues.push(`cut off: ${desc(el)} by ${desc(a)}`);
  }
  return issues;
}

(async () => {
  hub = await startHub();
  const s = io(URL, { transports: ['websocket'] });
  let st = null;
  s.on('state', (x) => { st = x; });
  await until(() => st, 10000);
  await new Promise((r) => s.emit('unlock', '1234', r));
  const games = st.games || [];
  check('the hub lists the games', games.length >= 20, games.length);
  const names = (n) => Array.from({ length: n }, (_, i) => ['Ash', 'Sam', 'Jo', 'Big Al', 'Mags', 'Trevor', 'Shaz', 'Gaz', 'Bev', 'Tony', 'Liz', 'Dean'][i % 12] + (i >= 12 ? ` ${Math.floor(i / 12) + 1}` : ''));
  const setRoster = async (n) => {
    s.emit('savePlayers', names(n).map((nm, i) => ({ id: `p${i}`, name: nm })), st.rosterEpoch);
    await until(() => st.roster.length === n, 5000);
  };
  const newMatch = async (req) => {
    s.emit('newMatch', req);
    await until(() => st.match && !st.match.finished && st.match.dartsInLog === 0 && st.match.rows.length === req.players.length, 5000);
  };
  const dart = async (sc, m) => { s.emit('dart', { score: sc, multiplier: m }); await wait(120); };

  s.emit('sessionStart', 240, 'Fit Test');
  await until(() => st.session && !st.session.expired, 5000);
  // Two finished games for "Recent games" (301 solo: 180, then T20 T19 D2).
  for (let g = 0; g < 2; g++) {
    await newMatch({ gameId: 'x01', variantId: '301', players: [{ name: 'Ash' }] });
    for (const [sc, m] of [[20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [2, 2]]) await dart(sc, m);
    await until(() => st.match && st.match.finished, 4000);
  }

  const b = await chromium.launch({ executablePath: CHROMIUM });
  const results = {};                  // screen -> device -> issues
  const note = (screen, dev, issues) => { (results[screen] = results[screen] || {})[dev] = issues; };

  for (const [name, w, h] of VIEWS) {
    for (const [orient, vw, vh] of [['portrait', w, h - SAFARI_CHROME], ['landscape', h, w - SAFARI_CHROME]]) {
      const dev = `${name} ${orient}`;
      const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const pg = await ctx.newPage();
      const errors = [];
      pg.on('pageerror', (e) => errors.push(e.message));
      const look = async (screen) => {
        await wait(250);
        const issues = await pg.evaluate(audit);
        note(screen, dev, issues);
        if ((issues.length || process.env.ALL_SHOTS) && SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await pg.screenshot({ path: path.join(SHOTS, `${screen.replace(/[^a-z0-9]+/gi, '_')}-${dev.replace(/[^a-z0-9]+/gi, '_')}.png`) });
        }
      };
      const tab = (t) => pg.evaluate((x) => document.querySelector(`nav.tabs button[data-tab="${x}"]`).click(), t);
      const click = (sel) => pg.evaluate((x) => document.querySelector(x).click(), sel);

      // No game on
      s.emit('endMatch'); await until(() => !st.match || st.match.finished, 3000);
      await pg.goto(`${URL}/pad`);
      await until(() => pg.evaluate(() => !!document.querySelector('nav.tabs')), 8000);
      await wait(700);
      await tab('play'); await look('Play: no game');

      // Names
      await setRoster(0);
      await tab('setup'); await click('#step1btn'); await look('Names: none yet');
      await setRoster(12); await look('Names: 12 on the list');
      await pg.evaluate(() => { for (const b2 of [...document.querySelectorAll('#playerpick .chipbtn')].slice(0, 8)) b2.click(); });
      await look('Names: 8 picked');
      await setRoster(40); await look('Names: the full 40');
      await setRoster(12);
      await pg.evaluate(() => { const sel = document.querySelectorAll('#playerpick .chipbtn.sel').length; if (!sel) for (const b2 of [...document.querySelectorAll('#playerpick .chipbtn')].slice(0, 8)) b2.click(); });

      // Game list, every category and every game picked
      await click('#step2btn');
      const cats = await pg.evaluate(() => [...document.querySelectorAll('#catpick .chipbtn')].map((x) => x.textContent));
      for (let ci = 0; ci < cats.length; ci++) {
        await pg.evaluate((i) => document.querySelectorAll('#catpick .chipbtn')[i].click(), ci);
        await look(`Games: ${cats[ci]}`);
        const n = await pg.evaluate(() => document.querySelectorAll('#gamecards .card').length);
        for (let gi = 0; gi < n; gi++) {
          const gname = await pg.evaluate((i) => { const c = document.querySelectorAll('#gamecards .card')[i]; c.click(); return (c.querySelector('h3') || c).textContent.replace('How to play', '').trim(); }, gi);
          await look(`Picked: ${gname}`);
        }
      }
      // How to play: the longest rules
      const longest = games.slice().sort((x, y) => (y.rules || '').length - (x.rules || '').length)[0];
      const lcat = (longest.category || 'party');
      await pg.evaluate((c) => { const map = { classics: 'Classics', party: 'Party', races: 'Score', practice: 'Practice' }; const want = map[c]; for (const x of document.querySelectorAll('#catpick .chipbtn')) if (x.textContent.startsWith(want)) x.click(); }, lcat);
      await pg.evaluate((label) => { for (const c of document.querySelectorAll('#gamecards .card')) if (c.textContent.startsWith(label)) c.querySelector('.info').click(); }, longest.label);
      await look(`How to play: ${longest.label}`);
      await click('#rs-close');

      // Games in progress
      const roster8 = st.roster.slice(0, 8).map((p) => ({ id: p.id, name: p.name }));
      await newMatch({ gameId: 'x01', variantId: '501', players: roster8.slice(0, 2) });
      await tab('play'); await look('Playing: 2 players');
      await newMatch({ gameId: 'x01', variantId: '501', players: roster8 });
      await dart(20, 3);
      await look('Playing: 8 players');
      await tab('fix'); await look('Fix: 8 players');
      await newMatch({ gameId: 'noughtscrosses', players: roster8.slice(0, 4) });
      await tab('play'); await look('Playing: Noughts & Crosses, 4');
      await newMatch({ gameId: 'x01', variantId: '301', players: roster8.slice(0, 1) });
      for (const [sc, m] of [[20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [2, 2]]) await dart(sc, m);
      await until(() => st.match && st.match.finished, 4000);
      await look('Playing: game won');

      // Prize
      await tab('prize'); await look('Prize');
      // Fix with recent games
      await tab('fix'); await look('Fix: finished game');

      check(`${dev}: no page errors`, errors.length === 0, errors);
      await ctx.close();
    }
  }

  // Time's up and the closed oche: once, on the smallest and the largest screens.
  s.emit('sessionEnd');
  await until(() => st.session && st.session.expired, 5000);
  for (const [name, w, h] of [VIEWS[0], VIEWS[VIEWS.length - 1]]) {
    for (const [orient, vw, vh] of [['portrait', w, h - SAFARI_CHROME], ['landscape', h, w - SAFARI_CHROME]]) {
      const dev = `${name} ${orient}`;
      const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const pg = await ctx.newPage();
      await pg.goto(`${URL}/pad`);
      await wait(1200);
      note("Time's up", dev, await pg.evaluate(audit));
      await ctx.close();
    }
  }
  s.emit('sessionClear');
  await until(() => !st.session, 5000);
  await setRoster(12);
  for (const [name, w, h] of [VIEWS[0], VIEWS[VIEWS.length - 1]]) {
    for (const [orient, vw, vh] of [['portrait', w, h - SAFARI_CHROME], ['landscape', h, w - SAFARI_CHROME]]) {
      const dev = `${name} ${orient}`;
      const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const pg = await ctx.newPage();
      await pg.goto(`${URL}/pad`);
      await wait(1200);
      await pg.evaluate(() => document.querySelector('nav.tabs button[data-tab="setup"]').click());
      await wait(300);
      note('Oche closed: names', dev, await pg.evaluate(audit));
      await pg.evaluate(() => { for (const b2 of [...document.querySelectorAll('#playerpick .chipbtn')].slice(0, 4)) b2.click(); document.getElementById('step2btn').click(); document.querySelector('#gamecards .card').click(); });
      await wait(300);
      note('Oche closed: game picked', dev, await pg.evaluate(audit));
      await ctx.close();
    }
  }

  // One line per screen: every device it fits, or what is wrong where.
  for (const screen of Object.keys(results)) {
    const bad = Object.entries(results[screen]).filter(([, iss]) => iss.length);
    check(`${screen}: fits on ${Object.keys(results[screen]).length} iPad screens`, bad.length === 0,
      bad.slice(0, 4).map(([d, iss]) => `${d}: ${iss.slice(0, 3).join('; ')}${iss.length > 3 ? ` (+${iss.length - 3})` : ''}`).join(' | '));
  }
  s.close();
  await b.close();
  hub.kill('SIGTERM');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
