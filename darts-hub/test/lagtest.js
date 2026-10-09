/*
 * lagtest.js - a dart and a typed name reach the screens straight away, even
 * when the PC's disk is slow, and nothing per dart makes the screens or the
 * hub do avoidable work.
 *
 * The hub runs with slowdisk.js: every flush to disk takes 400 ms (a busy
 * Windows PC: slow disk, Defender, OneDrive). Before the fix every dart and
 * every name waited for its save before any screen heard of it.
 *   - dart -> state at a screen, and addPlayer -> ack, well under the flush time;
 *   - the saves still land (match.json and players.json catch up), and a
 *     hub stopped straight after a dart has that dart on disk (exit flush);
 *   - the per-dart state is small (no games catalogue, no 50-game history)
 *     while a screen's first state still carries the catalogue;
 *   - the logo's address is the same in every state, and the real TV, iPad
 *     and staff pages do not download the logo again per dart;
 *   - the real leaderboard page reads /api/history when a game is recorded,
 *     not on every dart, and the served history is cached between changes;
 *   - the TV lights the hit bed (a plain fill) and clears it.
 * Ports TPORT (default 9570) and TPORT+1. Data under $DARTS_TEST_TMP/lag.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'lag');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 9570);
const URL = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const DATA = path.join(SP, 'hub');
const FLUSH_MS = 400;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

let hub = null;
process.on('exit', () => { try { if (hub && !hub.exited) hub.kill('SIGKILL'); } catch (_) {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 6 * 60000).unref();

function seedHistory() {
  // A venue after weeks: 5000 games on file.
  const out = [];
  const t0 = Date.now() - 40 * 86400000;
  for (let i = 0; i < 5000; i++) {
    out.push({ key: t0 + i * 60000, at: new Date(t0 + i * 60000).toISOString(), board: 'Board 1', game: 'x01', variant: '501',
      players: [`P${i % 37}`, `Q${i % 41}`], winner: `P${i % 37}`, darts: 40 + (i % 30), oneEighties: i % 3, bestVisit: 100 + (i % 80), high: null });
  }
  fs.writeFileSync(path.join(DATA, 'history.json'), JSON.stringify(out));
}
async function startHub(fresh) {
  if (fresh) {
    fs.rmSync(SP, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ adminPin: '1234', autoConnect: false }));
    seedHistory();
  }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_|SLOWDISK_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS', 'NODE_OPTIONS'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: path.join(SP, 'reports'),
    FAKE_FIRST_ABSENT: '1', FAKE_HOOK_PORT: String(PORT + 1), SLOWDISK_MS: String(FLUSH_MS),
  });
  const fd = fs.openSync(path.join(SP, 'hub.log'), 'a');
  const k = spawn(process.execPath, ['-r', path.join(HERE, 'slowdisk.js'), path.join(HERE, 'fakeboard.js')], { env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  k.on('exit', () => { k.exited = true; });
  const up = await until(async () => {
    const j = await (await fetch(`${URL}/api/hub-id`)).json();
    return j && j.pid === k.pid;
  }, 30000, 150);
  if (!up) throw new Error(`hub did not come up (see ${path.join(SP, 'hub.log')})`);
  return k;
}
const readData = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { return null; } };

function client() {
  const s = io(URL, { transports: ['websocket'] });
  const c = { s, st: null, states: [], first: null };
  s.on('state', (x) => { if (!c.first) c.first = x; c.st = x; c.states.push({ at: Date.now(), x, bytes: JSON.stringify(x).length }); });
  c.ready = () => until(() => c.st, 15000);
  return c;
}

(async () => {
  hub = await startHub(true);
  const staff = client();
  await staff.ready();
  await new Promise((r) => staff.s.emit('unlock', '1234', r));

  /* 1. the first state carries the catalogue; later ones do not */
  check('a screen\'s first state carries the games catalogue', Array.isArray(staff.first.games) && staff.first.games.length > 20, staff.first && Object.keys(staff.first));
  check('...and the history count and key the leaderboard watches', staff.first.historyCount === 5000 && typeof staff.first.historyKey === 'string', { n: staff.first.historyCount, k: staff.first.historyKey });

  /* 2. a typed name, with every flush taking 400 ms */
  const acks = [];
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    await new Promise((r) => staff.s.emit('addPlayer', `Name${i}`, r));
    acks.push(Date.now() - t0);
  }
  check(`a typed name is acknowledged without waiting for its save (median ${median(acks)} ms, flush ${FLUSH_MS} ms)`, median(acks) < FLUSH_MS / 2, acks);
  await until(() => { const p = readData('players.json'); return p && p.length === 6; }, 8000);
  check('...and the line-up still lands on disk', (readData('players.json') || []).length === 6, readData('players.json'));

  /* 3. darts, with every flush taking 400 ms */
  staff.s.emit('sessionStart', 60, 'Lag Test');
  await until(() => staff.st.session);
  staff.s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'A' }, { name: 'B' }] });
  await until(() => staff.st.match);
  await wait(300);
  const lat = [];
  const sizes = [];
  for (let i = 0; i < 12; i++) {
    const before = staff.st.match.dartsInLog;
    const n0 = staff.states.length;
    const t0 = Date.now();
    staff.s.emit('dart', { score: 1, multiplier: 1 });
    await until(() => staff.st.match && staff.st.match.dartsInLog > before, 5000, 5);
    lat.push(Date.now() - t0);
    const fresh = staff.states.slice(n0);
    if (fresh.length) sizes.push(fresh[fresh.length - 1].bytes);
    await wait(250);
  }
  check(`a dart reaches the screens without waiting for its save (median ${median(lat)} ms, flush ${FLUSH_MS} ms)`, median(lat) < FLUSH_MS / 2 && Math.max(...lat) < FLUSH_MS * 1.5, lat);
  check(`the per-dart state is small (median ${median(sizes)} bytes): no catalogue, no 50-game history`, median(sizes) < 9000
    && !staff.states.slice(-5).some((s) => s.x.games || s.x.history50), { sizes: sizes.slice(0, 5) });
  const darts = staff.st.match.dartsInLog;
  const landed = await until(() => { const m = readData('match.json'); return m && m.log && m.log.filter((e) => e.k === 'd').length === darts; }, 10000, 100);
  check('...and the game still lands on disk with every dart', !!landed, (readData('match.json') || {}).log && readData('match.json').log.length);

  /* 4. the logo address is stable */
  const logos = new Set(staff.states.map((s) => s.x.brand && s.x.brand.logoUrl));
  check('the logo address is the same in every state (no per-state cache-buster)', logos.size === 1 && [...logos][0] && !/v=\d{13}$/.test([...logos][0]), [...logos].slice(0, 3));

  /* 5. real pages: no logo re-download per dart; leaderboard reads history per game, not per dart */
  const b = await chromium.launch({ executablePath: CHROMIUM });
  const reqs = { logo: 0, history: 0 };
  const errors = [];
  const page = async (p, w, h) => {
    const pg = await b.newPage({ viewport: { width: w, height: h } });
    pg.on('pageerror', (e) => errors.push(`${p}: ${e.message}`));
    pg.on('request', (r) => {
      if (/\/brand\/logo/.test(r.url())) reqs.logo++;
      if (/\/api\/history/.test(r.url())) reqs.history++;
    });
    await pg.goto(`${URL}${p}`);
    return pg;
  };
  const tv = await page('/tv', 1280, 720);
  await page('/pad', 820, 1180);
  const st = await page('/staff', 820, 1400);
  await page('/board', 1280, 720);
  await wait(1500);
  await st.keyboard.type('1234');
  await wait(2500);
  const base = { ...reqs };
  for (let i = 0; i < 15; i++) { staff.s.emit('dart', { score: 1, multiplier: 1 }); await wait(250); }
  await wait(1000);
  check(`15 darts with the TV, iPad and staff pages open: the logo is not downloaded again (${reqs.logo - base.logo} requests)`, reqs.logo - base.logo === 0, reqs);
  check(`...and the leaderboard does not re-read the history on every dart (${reqs.history - base.history} reads)`, reqs.history - base.history <= 1, reqs);

  /* 6. a finished game IS read by the leaderboard, and /api/history is cached between changes */
  const h1 = await (await fetch(`${URL}/api/history`)).text();
  const h2 = await (await fetch(`${URL}/api/history`)).text();
  check('/api/history serves the same body until history changes', h1 === h2 && JSON.parse(h1).history.length === 5000);
  const hb = reqs.history;
  staff.s.emit('newMatch', { gameId: 'countup', variantId: 'r5', players: [{ name: 'Solo' }] });
  await until(() => staff.st.match && staff.st.match.gameId === 'countup');
  for (let i = 0; i < 15; i++) { staff.s.emit('dart', { score: 20, multiplier: 3 }); await wait(120); }
  await until(() => staff.st.match && staff.st.match.finished, 5000);
  await until(() => reqs.history > hb, 5000);
  check('a finished game: the leaderboard reads the history again', reqs.history > hb, { before: hb, after: reqs.history });
  const h3 = JSON.parse(await (await fetch(`${URL}/api/history`)).text());
  // The newest 5000 are kept, in memory as on disk: the new game in, the oldest out.
  const newest = (h) => h && h.length === 5000 && h[h.length - 1].game === 'countup';
  check('...and the served history has the new game (newest 5000 kept)', newest(h3.history), [h3.history.length, h3.history[h3.history.length - 1].game]);
  await until(() => newest(readData('history.json')), 10000, 100);
  check('history.json on disk has it too, written compact', newest(readData('history.json'))
    && !fs.readFileSync(path.join(DATA, 'history.json'), 'utf8').includes('\n  '), (readData('history.json') || []).length);

  /* 7. the TV lights the hit bed and clears it */
  staff.s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'A' }] });
  await until(() => staff.st.match && staff.st.match.gameId === 'x01');
  await wait(500);
  staff.s.emit('dart', { score: 19, multiplier: 3 });
  const lit = await until(() => tv.evaluate(() => {
    const n = document.querySelector('[data-id="t19"]');
    return n && n.classList.contains('db-hit') ? getComputedStyle(n).fill : null;
  }), 3000, 30);
  const amber = await tv.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--amber').trim());
  check('the TV lights the hit bed in amber', !!lit && lit !== 'none', { lit, amber });
  await wait(2000);
  check('...and clears it again', !(await tv.evaluate(() => document.querySelector('[data-id="t19"]').classList.contains('db-hit'))));
  check('no page errors on the TV, iPad, staff console or leaderboard', errors.length === 0, errors);
  await b.close();

  /* 8. a hub stopped straight after a dart has that dart on disk */
  const n0 = staff.st.match.dartsInLog;
  staff.s.emit('dart', { score: 5, multiplier: 1 });
  await until(() => staff.st.match.dartsInLog === n0 + 1, 3000, 5);
  hub.kill('SIGTERM');                           // no pause: its save is still queued or in flight
  await until(() => hub.exited, 15000);
  const m = readData('match.json');
  check('stopped straight after a dart: that dart is on disk (saves flushed on the way out)', m && m.log.filter((e) => e.k === 'd').length === n0 + 1, m && m.log.length);
  check('...and no background temporary file is left behind', !fs.readdirSync(DATA).some((f) => /\.tmp$/.test(f)), fs.readdirSync(DATA));

  staff.s.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
