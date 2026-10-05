/* Names leave with the group. Every way a session stops - time running out,
 * End now (started, or armed and never started), Clear, a new timer sold
 * over a running session, Power off - wipes the player names from the hub
 * (state.roster), from data/players.json and from every pad (name chips,
 * the name box, the hidden line-up rows), and nothing offers them again: a
 * pad holding the old list cannot write it back, a pad that slept through
 * the wipe wakes up clean and adds only the new name, the pad's "Recent
 * games" holds only the live session's games, session.json drops the names
 * once the bill has them, and a restart wipes leftover names unless a group
 * is still on the clock (or waiting on a timer sold this evening). Names
 * typed while a timer is only ARMED belong to the group about to play and
 * survive a second timer set over it. The first start after a night with an
 * open session (it used to crash with a ReferenceError) serves at once,
 * with one bill and no names.
 *
 * Self-contained: boots its own hubs (fakeboard.js, board kept off air so
 * only this suite's darts score), drives real pad pages in Chromium at
 * 820x1180. Ports TPORT..TPORT+9 (default 9540-9549); data and logs under
 * DARTS_TEST_TMP (nw-* folders). ~1 minute. */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { chromium } = require('playwright-core');

const SP = process.env.DARTS_TEST_TMP || path.join(os.tmpdir(), 'winchester-test');
fs.mkdirSync(SP, { recursive: true });
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const GAMES_JS = process.env.GAMES_JS || path.join(path.dirname(SERVER), 'games.js');
const { Match } = require(GAMES_JS);
const BASE = Number(process.env.TPORT || 9540);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const MIN = 60000, HOUR = 60 * MIN;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 120) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}
const withTimeout = (p, ms, fallback = null) => Promise.race([p, wait(ms).then(() => fallback)]);

/* ------------------------------------------------------------- hubs --- */
const kids = [];
process.on('exit', () => { for (const k of kids) { try { if (!k.exited) k.kill('SIGKILL'); } catch (_) {} } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

const dirOf = (name) => path.join(SP, `nw-${name}`);
const logOf = (name) => path.join(SP, `nw-${name}.log`);
function seed(name, files = {}) {
  const d = dirOf(name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(`${d}-reports`, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(v, null, 2));
  try { fs.unlinkSync(logOf(name)); } catch (_) {}
}
function hubEnv(name, port) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Nothing from the caller's shell may steer these hubs (a stray
    // DARTBOARD=, FAKE_ knob or supervised flag would change what they do).
    if (/^(FAKE_|DARTS_|WINCHESTER_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, {
    SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: dirOf(name),
    DARTS_REPORTS: `${dirOf(name)}-reports`,
    FAKE_FIRST_ABSENT: '1',            // the fake board stays off air: only this suite's darts score
  });
}
async function startHub(name, port) {
  const fd = fs.openSync(logOf(name), 'a');
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], { env: hubEnv(name, port), stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  k.exited = null;
  k.on('exit', (code, signal) => { k.exited = { code, signal }; });
  kids.push(k);
  const r = await until(async () => {
    if (k.exited) return 'dead';
    const j = await (await fetch(`http://127.0.0.1:${port}/api/hub-id`)).json();
    return j && j.pid === k.pid && j.port === port ? 'up' : null;
  }, 20000, 150);
  k.up = r === 'up';
  k.port = port;
  return k;
}
async function stopHub(k) {
  if (!k || k.exited) return;
  const gone = new Promise((r) => k.once('exit', r));
  k.kill('SIGTERM');
  await withTimeout(gone, 8000);
  if (!k.exited) { k.kill('SIGKILL'); await withTimeout(gone, 3000); }
}
function readData(name, file) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(name), file), 'utf8')); } catch (e) { return { readError: e.code || e.message }; }
}
const bills = (name) => { const b = readData(name, 'sessions.json'); return Array.isArray(b) ? b : []; };
const fileNames = (name) => { const p = readData(name, 'players.json'); return Array.isArray(p) ? p.map((x) => x.name) : p; };
const logText = (name) => { try { return fs.readFileSync(logOf(name), 'utf8'); } catch (_) { return ''; } };

/* ----------------------------------------------------- staff socket --- */
function staff(port) {
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnectionDelay: 300, reconnectionDelayMax: 1000 });
  const st = { s, last: null, toasts: [], admin: false, sessionover: 0 };
  s.on('state', (x) => { st.last = x; });
  s.on('toast', (t) => st.toasts.push(t.text));
  s.on('sessionover', () => { st.sessionover++; });
  s.on('disconnect', () => { st.admin = false; st.last = null; });
  // Every (re)connection is a fresh socket on the hub: unlock it again.
  s.on('connect', () => s.emit('unlock', '1234', (r) => { st.admin = !!(r && r.ok); }));
  st.ready = () => until(() => st.admin && st.last, 15000);
  return st;
}
// An ordering barrier: the hub handles one socket's events in order, so once
// this ack is back, everything sent before it on that socket has been handled
// (and its state broadcast to that socket delivered). A "was it refused?"
// check then cannot pass just because the hub was slow.
const barrier = (sock) => withTimeout(new Promise((r) => sock.emit('unlock', '1234', r)), 5000);
const rosterNames = (st) => ((st.last && st.last.roster) || []).map((p) => p.name);
const hasNames = (st, names) => !!st.last && names.every((n) => rosterNames(st).includes(n));
async function addPlayers(st, names) {
  const out = [];
  for (const n of names) out.push(await withTimeout(new Promise((r) => st.s.emit('addPlayer', n, r)), 5000, 'no ack'));
  await until(() => hasNames(st, names));
  return out;
}
async function sessionStart(st, mins = 5) {
  st.s.emit('sessionStart', mins);
  return until(() => st.last && st.last.session && !st.last.session.started && st.last.session.minutes === mins);
}
async function startGame(st, names) {
  st.s.emit('newMatch', { gameId: 'x01', variantId: '501', players: names.map((name) => ({ name })) });
  return until(() => st.last && st.last.match && !st.last.match.finished
    && st.last.match.rows.map((r) => r.name).join() === names.join() && st.last.session && st.last.session.started);
}
// 501 in nine darts (double out): a game that finishes - and is recorded - in a second.
async function nineDarter(st, name) {
  await startGame(st, [name]);
  const before = (st.last.history || []).length;
  for (const [score, multiplier] of [[20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [12, 2]]) st.s.emit('dart', { score, multiplier });
  return until(() => st.last && st.last.match && st.last.match.finished && (st.last.history || []).length > before);
}

/* ------------------------------------------------------------- pads --- */
// Before any page script: remember the pad's socket (so a test can make the
// iPad "sleep" through a wipe) and every event it sends (so a test can see
// an Add send only the new name), and collect its toasts.
const INIT = `(() => {
  window.__socks = []; window.__emits = []; window.__t = [];
  let real;
  Object.defineProperty(window, 'io', {
    configurable: true,
    get() { return real; },
    set(fn) {
      real = new Proxy(fn, { apply(t, self, args) {
        const s = Reflect.apply(t, self, args);
        window.__socks.push(s);
        const emit = s.emit;
        s.emit = function (ev, ...a) {
          try { window.__emits.push([ev].concat(JSON.parse(JSON.stringify(a.filter((x) => typeof x !== 'function'))))); } catch (_) {}
          return emit.call(this, ev, ...a);
        };
        return s;
      } });
    },
  });
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('toast');
    if (el) new MutationObserver(() => { if (el.textContent) window.__t.push(el.textContent); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
})();`;
const pageErrors = [];
async function openPad(browser, port, label) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.label = label;
  page.on('pageerror', (e) => pageErrors.push(`pad ${label}: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/pad`);
  page.ready = !!(await padOnline(page));
  return page;
}
const padOnline = (page, ms = 10000) => until(() => page.evaluate(() => document.getElementById('hubpill').textContent === 'connected'
  && document.querySelectorAll('#gamecards .card').length > 0 && window.__socks.length > 0), ms);
// A real tap where one can land; the power-off standby covers the page, so
// there the button is pressed from script (same handler, same result).
async function tap(page, sel) {
  const covered = await page.evaluate(() => { const p = document.getElementById('poweroff'); return !!p && !p.hidden; });
  if (!covered) {
    try { await page.click(sel, { timeout: 1500 }); return; } catch (_) {}
  }
  await page.evaluate((s) => document.querySelector(s).click(), sel);
}
const chipNames = (page) => page.evaluate(() => [...document.querySelectorAll('#playerpick .chipbtn')].map((b) => b.textContent));
// Get a pad the way a group leaves it mid-session: New game -> Players, the
// names picked, and (optionally) a name half-typed or the Game step open.
async function prime(page, names, { half, toGames } = {}) {
  await tap(page, 'nav.tabs button[data-tab="setup"]');
  await tap(page, '#step1btn');
  const shown = await until(async () => { const c = await chipNames(page); return names.every((n) => c.includes(n)); }, 8000);
  for (const n of names) {
    const sel = await page.evaluate((x) => { const b = [...document.querySelectorAll('#playerpick .chipbtn')].find((e) => e.textContent === x); return b ? b.classList.contains('sel') : null; }, n);
    if (sel === false) await page.locator('#playerpick .chipbtn', { hasText: n }).first().click({ timeout: 3000 }).catch(() => {});
  }
  const picked = await page.$eval('#chosen', (el) => el.textContent);
  if (half) { await page.click('#newname'); await page.keyboard.type(half); }
  if (toGames) await tap(page, '#btn-toGames');
  const stage2 = await page.evaluate(() => !document.getElementById('stage-games').hidden);
  return { shown: !!shown, picked, stage2, ok: !!shown && names.every((n) => picked.includes(n)) && (!toGames || stage2) };
}
// What a pad shows after a wipe: first whether it went back to the Players
// step by itself, then - on New game -> Players - its chips, its name box,
// and every old name anywhere in the page (hidden rows and inputs included;
// the transient toast line is left out, and so is the winner banner, which
// has checks of its own so that one stale banner does not fail every
// ending below).
async function padView(page, oldNames) {
  await until(() => page.evaluate(() => document.querySelectorAll('#playerpick .chipbtn').length === 0
    && document.getElementById('newname').value === ''), 4000);
  const before = await page.evaluate(() => ({
    stage1: !document.getElementById('stage-players').hidden,
    tab: (document.querySelector('nav.tabs button.on') || {}).dataset ? document.querySelector('nav.tabs button.on').dataset.tab : null,
  }));
  await tap(page, 'nav.tabs button[data-tab="setup"]');
  await tap(page, '#step1btn');
  const v = await page.evaluate((names) => {
    const body = document.body.cloneNode(true);
    for (const sel of ['#toast', '#winbanner']) { const e = body.querySelector(sel); if (e) e.remove(); }
    const text = body.textContent;
    const values = [...document.querySelectorAll('input, textarea, select')].map((i) => i.value).join('\n');
    return {
      chips: [...document.querySelectorAll('#playerpick .chipbtn')].map((b) => b.textContent),
      box: document.getElementById('newname').value,
      chosen: document.getElementById('chosen').textContent,
      rows: document.getElementById('players').children.length,
      leaked: names.filter((n) => text.includes(n) || values.includes(n)),
      winbanner: document.getElementById('winbanner').textContent,
    };
  }, oldNames);
  return { ...before, ...v };
}
const padClean = (v) => v.chips.length === 0 && v.box === '' && v.leaked.length === 0 && !/Playing:/.test(v.chosen) && v.rows === 0;
// The four-way proof after an ending: hub list, players.json, every pad.
async function assertClean(label, st, hub, pads, oldNames, { backToPlayers = [] } = {}) {
  const roster = st.last && st.last.roster;
  check(`${label}: the hub's player list (state.roster) is []`, Array.isArray(roster) && roster.length === 0, roster);
  const file = readData(hub, 'players.json');
  check(`${label}: data/players.json is []`, Array.isArray(file) && file.length === 0, file);
  const views = [];
  for (const p of pads) {
    const v = await padView(p, oldNames);
    views.push(v);
    check(`${label}: pad ${p.label} (New game -> Players) shows no name chips, an empty name box, no old name anywhere`, padClean(v), v);
    if (backToPlayers.includes(p)) check(`${label}: pad ${p.label}, left on the Game step, went back to the Players step by itself`, v.stage1 === true, v);
  }
  return views;
}
// Every file in the hub's data folder except the bills and the game records
// (which keep names by design): which of the given names does each hold?
function diskLeaks(hub, names) {
  const out = [];
  for (const f of fs.readdirSync(dirOf(hub))) {
    if (/^(sessions|history)\.json/.test(f)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dirOf(hub), f), 'utf8'); } catch (_) { continue; }
    const hit = names.filter((n) => text.includes(n));
    if (hit.length) out.push({ file: f, names: hit });
  }
  return out;
}
const padToasts = (page) => page.evaluate(() => window.__t.slice());
const sessionFileNames = (hub) => { const s = readData(hub, 'session.json'); return s && !s.readError ? (s.names || []) : []; };

/* ------------------------------------------------------------- boot --- */
const rosterOf = (names) => names.map((name, i) => ({ id: `r${1000 + i}`, name }));
function liveMatchJson(names) {
  const m = new Match({ gameId: 'x01', variantId: '501', config: {}, players: names.map((name, i) => ({ id: `p${i + 1}`, name })) });
  m.addDart({ score: 20, multiplier: 3 });
  return m.toJSON();
}

async function bootCases() {
  const now = Date.now();
  const base = { 'settings.json': { autoConnect: false, adminPin: '1234' } };
  const cases = [
    // Names typed hours ago and no time ever sold: wiped even by a quick
    // restart (names typed within the hour may wait across one - not asserted here).
    { name: 'B1', label: '10. boot: names left over (typed 10 h ago), NO session', names: ['Bootless', 'Nosession'], expect: 'wiped',
      files: { 'alive.json': { t: now - 30000 } }, playersAge: 10 * HOUR },
    { name: 'B2', label: '10. boot: a live STARTED, unexpired timer', names: ['Stillon', 'Clockwatch'], expect: 'kept',
      session: { mode: 'timer', minutes: 60, startedAt: now - 10 * MIN, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 30000 } } },
    { name: 'B3', label: '10. first start after a night: alive 2 h ago, open STARTED timer, game on', names: ['Lysander', 'Philippa'], expect: 'night',
      session: { mode: 'timer', minutes: 240, startedAt: now - 2.5 * HOUR, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 2 * HOUR } }, match: true },
    { name: 'B8', label: '10. first start after a night: alive 2 h ago, open STARTED timer (ran out in the night), game on', names: ['Octavia', 'Rupertus'], expect: 'night',
      session: { mode: 'timer', minutes: 60, startedAt: now - 2.5 * HOUR, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 2 * HOUR } }, match: true },
    { name: 'B4', label: '10. first start after a night: alive 2 h ago, open STOPWATCH, game on', names: ['Tobias', 'Seraphina'], expect: 'night',
      session: { mode: 'stopwatch', minutes: 0, startedAt: now - 3 * HOUR, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 2 * HOUR } }, match: true },
    { name: 'B5', label: '10. boot: a timer armed this evening, not started yet', names: ['Waitinggroup', 'Ataboard'], expect: 'kept',
      session: { mode: 'timer', minutes: 60, startedAt: null, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 30000 } } },
    { name: 'B6', label: '10. boot: a timer armed LAST night, never started', names: ['Lastnight', 'Neverplayed'], expect: 'wiped',
      session: { mode: 'timer', minutes: 60, startedAt: null, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 2 * HOUR } } },
    { name: 'B7', label: '1b. time ran out while the hub was down (expired at boot)', names: ['Expiredat', 'Bootclock'], expect: 'expired',
      session: { mode: 'timer', minutes: 5, startedAt: now - 6 * MIN, warned: false, rate: 10 },
      files: { 'alive.json': { t: now - 30000 } }, match: true },
  ];
  cases.forEach((c, i) => {
    c.port = BASE + 1 + i + (i >= 7 ? 1 : 0);      // BASE+8 is hub P's (8b)
    const files = { ...base, ...c.files, 'players.json': rosterOf(c.names) };
    if (c.session) files['session.json'] = { ...c.session, names: c.names.slice() };
    if (c.match) files['match.json'] = liveMatchJson(c.names);
    seed(c.name, files);
    if (c.playersAge) { const t = new Date(now - c.playersAge); fs.utimesSync(path.join(dirOf(c.name), 'players.json'), t, t); }
  });
  // All at once: each is its own folder and port.
  await Promise.all(cases.map(async (c) => { c.hub = await startHub(c.name, c.port); }));
  for (const c of cases) {
    const L = c.label;
    check(`${L}: the hub serves on its FIRST start`, c.hub.up && !c.hub.exited, { up: c.hub.up, exited: c.hub.exited, log: logText(c.name).slice(-600) });
    if (!c.hub.up) continue;
    const st = staff(c.port);
    await st.ready();
    await wait(300);
    const log = logText(c.name);
    check(`${L}: nothing failed during boot (no ReferenceError, no "boot settlement/expiry failed")`, !/ReferenceError|boot settlement failed|boot expiry failed|TypeError/.test(log), log.slice(-800));
    const r = rosterNames(st);
    const f = fileNames(c.name);
    const b = bills(c.name);
    if (c.expect === 'kept') {
      check(`${L}: the waiting/playing group's names are kept (hub list)`, r.join() === c.names.join(), r);
      check(`${L}: ...and in data/players.json`, Array.isArray(f) && f.join() === c.names.join(), f);
      check(`${L}: nothing billed at boot`, b.length === 0, b);
    } else {
      check(`${L}: names wiped at boot (hub list [])`, r.length === 0, r);
      check(`${L}: ...and data/players.json is []`, Array.isArray(f) && f.length === 0, f);
    }
    if (c.expect === 'wiped') check(`${L}: nothing billed at boot`, b.length === 0, b);
    if (c.name === 'B1') {
      const disk = diskLeaks(c.name, c.names);
      check(`${L}: not remembered: no file in data/ still holds the wiped names`, disk.length === 0, disk);
    }
    if (c.expect === 'night' || c.expect === 'expired') {
      check(`${L}: exactly one bill in sessions.json`, b.length === 1, b);
      const bill = b[0] || {};
      check(`${L}: the bill names the group (staff know who to charge)`, c.names.every((n) => (bill.names || []).includes(n)), bill.names);
      if (c.expect === 'night') {
        const alive = c.files['alive.json'].t;
        const end = c.session.mode === 'timer' ? Math.min(alive, c.session.startedAt + c.session.minutes * MIN) : alive;
        check(`${L}: billed up to when the PC was last alive (or the sold time ran out), not to this morning`, Math.abs((bill.endedAt || 0) - end) < 2000, { endedAt: bill.endedAt, expected: end });
        if (c.session.mode === 'stopwatch') check(`${L}: the stopwatch bill charges the hour played, not the night`, bill.mode === 'stopwatch' && Math.abs(bill.minutesPlayed - 60) <= 1, bill);
      } else {
        check(`${L}: billed for the 5 minutes sold`, bill.mode === 'timer' && bill.chargedMinutes === 5 && bill.endedAt === c.session.startedAt + 5 * MIN, bill);
      }
      const sj = readData(c.name, 'session.json');
      check(`11. ${L}: session.json no longer holds the names once the bill is written`, !sj || (!sj.readError && sj.recorded === true && !(sj.names || []).length), sj);
      check(`${L}: the game left on the board is ended (no match to play on)`, st.last.match === null, st.last.match && st.last.match.rows);
      // The session is billed and its names wiped: the clock must not run on
      // and let the next group play on it (unbilled - addPlayer skips a recorded session).
      const sess0 = st.last.session;
      st.s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Morningplayer' }] });
      await barrier(st.s);
      await wait(150);
      check(`${L}: the billed session is closed - no time left on the clock, a new game is refused`,
        (!sess0 || sess0.expired === true) && !st.last.match,
        { session: sess0, gameStarted: !!st.last.match, bills: bills(c.name).length });
    }
    st.s.close();
  }
  await Promise.all(cases.map((c) => stopHub(c.hub)));
}

/* ------------------------------------------------------------- main --- */
(async () => {
  const deadline = setTimeout(() => { check('suite finished inside 6 minutes', false); console.log(`${pass} passed, ${fail} failed`); process.exit(1); }, 6 * MIN);
  deadline.unref();
  const t0 = Date.now();

  await bootCases();

  /* --- hub A: one oche through every ending, two pads watching --- */
  const A = 'A';
  seed(A, {
    'settings.json': { autoConnect: false, adminPin: '1234' },
    // a game from yesterday: it never belongs in tonight's "Recent games"
    'history.json': [{ key: 'yday', at: new Date(Date.now() - 26 * HOUR).toISOString(), board: 'Board 1', game: 'x01', variant: '501',
      players: ['Yesterdayname'], winner: 'Yesterdayname', darts: 30, oneEighties: 0, bestVisit: 60, high: { name: 'Yesterdayname', value: 60 } }],
  });
  let hubA = await startHub(A, BASE);
  check('(set-up) hub A is up', hubA.up, logText(A).slice(-600));
  const st = staff(BASE);
  check('(set-up) staff socket unlocked', !!(await st.ready()));
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const padA = await openPad(browser, BASE, 'A');
  const padB = await openPad(browser, BASE, 'B');
  const pads = [padA, padB];
  check('(set-up) two pad pages connected', padA.ready && padB.ready);
  const resetToasts = async () => { st.toasts.length = 0; for (const p of pads) await p.evaluate(() => window.__t.splice(0)); };
  const allNames = ['Yesterdayname'];

  const attrs = await padA.$eval('#newname', (el) => ({ ac: el.getAttribute('autocomplete'), cor: el.getAttribute('autocorrect'), sc: el.getAttribute('spellcheck') }));
  check('the pad\'s name box asks the browser not to remember or suggest names', attrs.ac === 'off' && attrs.cor === 'off' && attrs.sc === 'false', attrs);
  check('no session yet: Recent games (state.history) is empty - yesterday\'s game is not offered', Array.isArray(st.last.history) && st.last.history.length === 0, st.last.history);

  /* --- 2. End now on a started session --- */
  {
    const L = '2. End now (started session)';
    const names = ['Zebedee', 'Quillon', 'Marigold'];
    allNames.push(...names, 'Zebed');
    await resetToasts();
    await sessionStart(st);
    await addPlayers(st, names.slice(0, 2));
    // the third name typed on the pad itself
    await padA.evaluate(() => window.__emits.splice(0));
    await tap(padA, 'nav.tabs button[data-tab="setup"]');
    await tap(padA, '#step1btn');
    await padA.click('#newname');
    await padA.keyboard.type('Marigold');
    await padA.click('#btn-addname');
    await until(() => hasNames(st, names));
    const em = await padA.evaluate(() => window.__emits.slice());
    check(`${L}: the pad's Add sends only the typed name (addPlayer), never its copy of the list`,
      em.some((e) => e[0] === 'addPlayer' && e[1] === 'Marigold') && !em.some((e) => e[0] === 'savePlayers'), em);
    await nineDarter(st, 'Zebedee');
    const h = st.last.history || [];
    check(`9. ${L}: Recent games (state.history) holds this session's finished game only`, h.length === 1 && h[0].players.join() === 'Zebedee', h.map((x) => x.players));
    await tap(padA, 'nav.tabs button[data-tab="fix"]');
    const ht = await padA.$eval('#history', (el) => el.textContent);
    check(`9. ${L}: the pad's Fix-tab Recent games shows it, not yesterday's game`, /Zebedee/.test(ht) && !/Yesterdayname/.test(ht), ht);
    await startGame(st, ['Quillon', 'Marigold']);      // a game still on when staff end it
    const pa = await prime(padA, names, { half: 'Zebed' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the group's names, picked`, pa.ok && pb.ok, { pa, pb });
    const nb = bills(A).length;
    await resetToasts();
    st.s.emit('sessionEnd');
    await until(() => st.last && st.last.roster.length === 0 && !st.last.match);
    const views = await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    check(`${L}: the pads' winner banner no longer holds the last group's winner ("Zebedee wins")`,
      views.every((v) => !/Zebedee/.test(v.winbanner)), views.map((v) => v.winbanner));
    const b = bills(A);
    check(`${L}: the session is billed once, with the group's names on the bill`, b.length === nb + 1 && names.every((n) => b[b.length - 1].names.includes(n)), b[b.length - 1]);
    check(`11. ${L}: session.json no longer holds the names once the bill is written`, sessionFileNames(A).length === 0, readData(A, 'session.json'));
    check(`9. ${L}: Recent games (state.history) is [] once the session is over`, Array.isArray(st.last.history) && st.last.history.length === 0, st.last.history);
    await tap(padA, 'nav.tabs button[data-tab="fix"]');
    const ht2 = await padA.$eval('#history', (el) => el.textContent);
    check(`9. ${L}: the pad's Fix-tab Recent games says none, no names`, /No games finished yet/.test(ht2) && !/Zebedee|Quillon|Marigold/.test(ht2), ht2);
  }

  /* --- 2b. what the stale banner does: the next group's game that ends with
   *     no winner (solo Prisoner, out of lives - "the board wins") --- */
  {
    const L = '2b. the next group: a solo game lost to the board';
    allNames.push('Soloist');
    await sessionStart(st);
    st.s.emit('newMatch', { gameId: 'prisoner', variantId: 'standard', config: { lives: 1 }, players: [{ name: 'Soloist' }] });
    await until(() => st.last && st.last.match && st.last.match.gameId === 'prisoner');
    for (let i = 0; i < 3; i++) st.s.emit('dart', { score: 20, multiplier: 1 });   // a blank visit: the only life goes
    await until(() => st.last && st.last.match && st.last.match.finished);
    check(`${L}: (set-up) finished with no winner`, !!st.last.match && st.last.match.finished && !st.last.match.winner, st.last.match && st.last.match.winner);
    await tap(padA, 'nav.tabs button[data-tab="play"]');
    await wait(300);
    const wb = await padA.evaluate(() => { const e = document.getElementById('winbanner'); return { shown: !e.hidden && e.getBoundingClientRect().width > 0, text: e.textContent }; });
    check(`${L}: the pad's Play tab never shows the last group's winner`, !(wb.shown && /Zebedee|Quillon|Marigold/.test(wb.text)), wb);
    st.s.emit('sessionEnd');
    await until(() => st.last && st.last.roster.length === 0 && !st.last.match);
  }

  /* --- 3. End now on an armed, never-started timer --- */
  {
    const L = '3. End now on an armed timer ("Timer cancelled")';
    const names = ['Ottoline', 'Percival'];
    allNames.push(...names, 'Ottol');
    await sessionStart(st);
    await addPlayers(st, names);
    const pa = await prime(padA, names, { half: 'Ottol' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the group's names, picked`, pa.ok && pb.ok, { pa, pb });
    const nb = bills(A).length;
    await resetToasts();
    st.s.emit('sessionEnd');
    await until(() => st.last && st.last.roster.length === 0 && st.last.session === null);
    check(`${L}: staff are told "Timer cancelled"`, st.toasts.some((t) => /Timer cancelled/.test(t)), st.toasts);
    await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    check(`${L}: no session left and nothing billed (it never started)`, st.last.session === null && bills(A).length === nb && readData(A, 'session.json') === null, { session: st.last.session, bills: bills(A).length - nb });
    const disk = diskLeaks(A, names);
    check(`${L}: not remembered: no file in data/ still holds the cancelled group's names`, disk.length === 0, disk);
  }

  /* --- 7. a second timer over an ARMED timer keeps the names; 4b. Clear on an armed timer --- */
  {
    const L = '7. a second timer set over an ARMED timer';
    const names = ['Wilhelmina', 'Barnaby'];
    allNames.push(...names, 'Wilhe');
    await sessionStart(st);
    await addPlayers(st, names);
    const pa = await prime(padA, names, { half: 'Wilhe' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the group's names, picked`, pa.ok && pb.ok, { pa, pb });
    await resetToasts();
    const so = st.sessionover;
    st.s.emit('sessionStart', 10);
    await until(() => st.toasts.some((t) => /Timer set: 10/.test(t)));
    await wait(700);
    check(`${L}: the waiting group's names are kept on the hub (no wipe)`, rosterNames(st).join() === names.join() && st.sessionover === so, { roster: rosterNames(st), wipes: st.sessionover - so });
    check(`${L}: ...and in data/players.json`, (fileNames(A) || []).join() === names.join(), fileNames(A));
    const ca = await chipNames(padA), cb = await chipNames(padB);
    const boxA = await padA.$eval('#newname', (el) => el.value);
    const stillGames = await padB.evaluate(() => !document.getElementById('stage-games').hidden);
    check(`${L}: ...and on both pads (chips, picks, the half-typed name, pad B still on the Game step)`,
      ca.join() === names.join() && cb.join() === names.join() && boxA === 'Wilhe' && stillGames, { ca, cb, boxA, stillGames });
    const pt = (await padToasts(padA)).concat(await padToasts(padB), st.toasts);
    check(`${L}: nobody is told "names cleared"`, !pt.some((t) => /names cleared/i.test(t)), pt);
    check(`${L}: the names go on the new timer's tab (session.json)`, names.every((n) => sessionFileNames(A).includes(n)), sessionFileNames(A));

    const L4 = '4b. Clear on an armed timer';
    const nb = bills(A).length;
    await resetToasts();
    st.s.emit('sessionClear');
    await until(() => st.last && st.last.roster.length === 0 && st.last.session === null);
    check(`${L4}: staff are told "Timer cleared"`, st.toasts.some((t) => /Timer cleared/.test(t)), st.toasts);
    await assertClean(L4, st, A, pads, allNames, { backToPlayers: [padB] });
    check(`${L4}: no session left and nothing billed`, st.last.session === null && bills(A).length === nb && readData(A, 'session.json') === null);
  }

  /* --- 4a. Clear on a started session (and 9: a new session's Recent games) --- */
  {
    const L = '4a. Clear on a started session';
    const names = ['Fenella', 'Horatio'];
    allNames.push(...names, 'Fenel');
    await sessionStart(st);
    check(`9. ${L}: a new timer, not started yet: Recent games is still []`, st.last.history.length === 0, st.last.history);
    await addPlayers(st, names);
    await nineDarter(st, 'Fenella');
    const h = st.last.history || [];
    check(`9. ${L}: Recent games holds this session's game only, not the last session's`, h.length === 1 && h[0].players.join() === 'Fenella', h.map((x) => x.players));
    await tap(padA, 'nav.tabs button[data-tab="fix"]');
    const ht = await padA.$eval('#history', (el) => el.textContent);
    check(`9. ${L}: the pad's Fix-tab Recent games: Fenella's game, not Zebedee's or yesterday's`, /Fenella/.test(ht) && !/Zebedee|Yesterdayname/.test(ht), ht);
    await startGame(st, names);
    const pa = await prime(padA, names, { half: 'Fenel' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the group's names, picked`, pa.ok && pb.ok, { pa, pb });
    const nb = bills(A).length;
    await resetToasts();
    st.s.emit('sessionClear');
    await until(() => st.last && st.last.roster.length === 0 && st.last.session === null && !st.last.match);
    check(`${L}: staff are told the session was billed and the players cleared`, st.toasts.some((t) => /Timer cleared - session billed/.test(t)), st.toasts);
    await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    const b = bills(A);
    check(`${L}: billed once, with this group's names only`, b.length === nb + 1 && b[b.length - 1].names.slice().sort().join() === names.slice().sort().join(), b[b.length - 1]);
    check(`9. ${L}: Recent games is [] again`, st.last.history.length === 0, st.last.history);
    check(`11. ${L}: no names left in session.json`, sessionFileNames(A).length === 0, readData(A, 'session.json'));
  }

  /* --- 5. a new timer over a running session --- */
  {
    const L = '5. a new timer sold over a running session';
    const names = ['Cressida', 'Ignatius'];
    allNames.push(...names, 'Leopold', 'Leopo');
    await sessionStart(st);
    await addPlayers(st, names);
    await startGame(st, names);
    // the next group types a name on the pad while the last game is still on
    await tap(padA, 'nav.tabs button[data-tab="setup"]');
    await tap(padA, '#step1btn');
    await padA.click('#newname');
    await padA.keyboard.type('Leopold');
    await padA.click('#btn-addname');
    await until(() => hasNames(st, [...names, 'Leopold']));
    const pa = await prime(padA, [...names, 'Leopold'], { half: 'Leopo' });
    const pb = await prime(padB, [...names, 'Leopold'], { toGames: true });
    check(`${L}: (set-up) both pads show the names, picked`, pa.ok && pb.ok, { pa, pb });
    const nb = bills(A).length;
    await resetToasts();
    st.s.emit('sessionStart', 5);
    await until(() => st.last && st.last.roster.length === 0 && st.last.session && !st.last.session.started);
    await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    for (const p of pads) {
      const t = await until(async () => { const x = await padToasts(p); return x.some((s) => /New timer started - names cleared, type them again/.test(s)) ? x : null; }, 3000);
      check(`${L}: pad ${p.label} says "New timer started - names cleared, type them again"`, !!t, await padToasts(p));
    }
    check(`${L}: staff are told the previous session was closed`, st.toasts.some((t) => /previous session closed/.test(t)), st.toasts);
    const b = bills(A);
    check(`${L}: the old session is billed once, names and all`, b.length === nb + 1 && [...names, 'Leopold'].every((n) => b[b.length - 1].names.includes(n)), b[b.length - 1]);
    check(`${L}: the new timer's tab starts with no names (session.json)`, sessionFileNames(A).length === 0, readData(A, 'session.json'));
    st.s.emit('sessionEnd');
    await until(() => st.last && st.last.session === null);
  }

  /* --- 6. Power off --- */
  {
    const L = '6a. Power off with names typed and NO session';
    const names = ['Rosalind', 'Thaddeus'];
    allNames.push(...names, 'Rosal');
    check(`${L}: (set-up) no session`, st.last.session === null, st.last.session);
    await addPlayers(st, names);
    const pa = await prime(padA, names, { half: 'Rosal' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the names, picked`, pa.ok && pb.ok, { pa, pb });
    st.s.emit('powerOff');
    await until(() => st.last && st.last.powered === false && st.last.roster.length === 0);
    await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    st.s.emit('powerOn');
    await until(() => st.last && st.last.powered === true);
    await wait(500);
    await assertClean(`${L}, then Power on`, st, A, pads, allNames);
  }
  {
    const L = '6b. Power off with an armed timer';
    const names = ['Gwendolyn', 'Augustus'];
    allNames.push(...names, 'Gwend');
    await sessionStart(st);
    await addPlayers(st, names);
    const pa = await prime(padA, names, { half: 'Gwend' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the names, picked`, pa.ok && pb.ok, { pa, pb });
    const nb = bills(A).length;
    st.s.emit('powerOff');
    await until(() => st.last && st.last.powered === false && st.last.roster.length === 0);
    await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    check(`${L}: the armed timer is gone and nothing billed`, st.last.session === null && readData(A, 'session.json') === null && bills(A).length === nb);
    st.s.emit('powerOn');
    await until(() => st.last && st.last.powered === true);
    await wait(500);
    await assertClean(`${L}, then Power on`, st, A, pads, allNames);
  }

  /* --- 8. a pad holding the old list / a pad that slept through the wipe --- */
  {
    const L = '8. a pad holding the old list';
    const names = ['Evangeline', 'Montague'];
    allNames.push(...names, 'Evang', 'Legacyclient', 'Currentepoch');
    await sessionStart(st);
    await addPlayers(st, names);
    const pa = await prime(padA, names, { half: 'Evang' });
    check(`${L}: (set-up) pad A shows the names, picked, one half-typed`, pa.ok, pa);
    const oldEpoch = st.last.rosterEpoch;
    const oldList = st.last.roster.map((p) => ({ ...p }));
    check(`${L}: (set-up) the hub publishes its wipe counter (state.rosterEpoch)`, typeof oldEpoch === 'number', oldEpoch);
    // pad A's iPad goes to sleep: its socket drops while the session ends
    await padA.evaluate(() => window.__socks[0].disconnect());
    await until(() => padA.evaluate(() => document.getElementById('hubpill').textContent !== 'connected'), 3000);
    st.s.emit('sessionEnd');
    await until(() => st.last && st.last.roster.length === 0 && st.last.session === null);
    check(`${L}: (set-up) wiped while pad A was asleep`, st.last.rosterEpoch !== oldEpoch && rosterNames(st).length === 0, st.last.rosterEpoch);
    // an older client still holding the old list writes it back with the epoch it read it under
    const old = io(`http://127.0.0.1:${BASE}`, { transports: ['websocket'] });
    await until(() => old.connected, 5000);
    old.emit('savePlayers', oldList, oldEpoch);
    await barrier(old);
    await wait(300);
    check(`${L}: savePlayers with the pre-wipe epoch is refused (hub list stays [])`, rosterNames(st).length === 0, rosterNames(st));
    check(`${L}: ...and data/players.json stays []`, Array.isArray(fileNames(A)) && fileNames(A).length === 0, fileNames(A));
    old.emit('savePlayers', [{ name: 'Legacyclient' }]);
    await until(() => hasNames(st, ['Legacyclient']), 3000);
    check(`${L}: savePlayers with no epoch (older clients/tests) is accepted`, rosterNames(st).join() === 'Legacyclient' && (fileNames(A) || []).join() === 'Legacyclient', { hub: rosterNames(st), file: fileNames(A) });
    old.emit('savePlayers', [{ name: 'Legacyclient' }, { name: 'Currentepoch' }], st.last.rosterEpoch);
    await until(() => hasNames(st, ['Currentepoch']), 3000);
    check(`${L}: savePlayers with the current epoch is accepted`, rosterNames(st).join() === 'Legacyclient,Currentepoch', rosterNames(st));
    old.close();
    st.s.emit('sessionClear');                       // Clear with no session at all still wipes
    await until(() => st.last && st.last.roster.length === 0);
    check('4c. Clear with no session running still wipes the names (hub list and players.json)', rosterNames(st).length === 0 && Array.isArray(fileNames(A)) && fileNames(A).length === 0, { hub: rosterNames(st), file: fileNames(A) });

    // pad A wakes up
    await padA.evaluate(() => window.__emits.splice(0));
    await padA.evaluate(() => window.__socks[0].connect());
    check(`${L}: (set-up) pad A reconnects`, !!(await padOnline(padA, 8000)));
    const v = await padView(padA, allNames);
    check(`${L}: the pad that slept through the wipe wakes with no chips, an empty name box and no old name anywhere`, padClean(v), v);
    await padA.click('#newname');
    await padA.keyboard.type('Newbie');
    await padA.click('#btn-addname');
    await until(() => hasNames(st, ['Newbie']), 4000);
    const em = await padA.evaluate(() => window.__emits.slice());
    check(`${L}: the woken pad's Add sends only the new name`, em.filter((e) => e[0] === 'addPlayer').map((e) => e[1]).join() === 'Newbie'
      && !em.some((e) => e[0] === 'savePlayers' || e[0] === 'removePlayer'), em);
    check(`${L}: the hub list is exactly [Newbie] (hub and players.json)`, rosterNames(st).join() === 'Newbie' && (fileNames(A) || []).join() === 'Newbie', { hub: rosterNames(st), file: fileNames(A) });
    const chosen = await until(async () => { const c = await padA.$eval('#chosen', (el) => el.textContent); return /^Playing: Newbie \(/.test(c) ? c : null; }, 3000);
    check(`${L}: the woken pad's line-up is Newbie alone`, !!chosen, await padA.$eval('#chosen', (el) => el.textContent));
    await sessionStart(st);
    await tap(padA, '#btn-toGames');
    await tap(padA, '#gamecards .card');
    await tap(padA, '#btn-start');
    await until(() => st.last && st.last.match, 4000);
    const rows = st.last.match ? st.last.match.rows.map((r) => r.name).join() : null;
    check(`${L}: the game started from the woken pad has Newbie alone`, rows === 'Newbie', rows);
    const nb = bills(A).length;
    st.s.emit('sessionEnd');
    await until(() => st.last && st.last.roster.length === 0 && !st.last.match);
    const b = bills(A);
    check(`${L}: Newbie's bill names Newbie alone - no earlier group comes back`, b.length === nb + 1 && b[b.length - 1].names.join() === 'Newbie', b[b.length - 1]);
    allNames.push('Newbie');
    await assertClean(`${L} (Newbie's session ended)`, st, A, pads, allNames);
  }

  /* --- 1. time runs out --- */
  {
    const L = '1. time runs out';
    const names = ['Clementine', 'Benedikt'];
    allNames.push(...names, 'Cleme');
    await sessionStart(st, 5);
    await addPlayers(st, names);
    await startGame(st, names);
    const s0 = st.last.session;
    check(`${L}: (set-up) a 5-minute timer is running (a game started the clock)`, s0 && s0.started && s0.remainingMs > 4 * MIN && s0.remainingMs <= 5 * MIN, s0);
    // The minimum timer is 5 minutes: take the hub down and wind its clock
    // on so the time runs out ~35 s after it comes back, with the pads watching.
    await stopHub(hubA);
    await until(() => !st.s.connected, 3000);
    const sess = readData(A, 'session.json');
    sess.startedAt = Date.now() - 5 * MIN + 35000;
    sess.warned = false;
    fs.writeFileSync(path.join(dirOf(A), 'session.json'), JSON.stringify(sess, null, 2));
    hubA = await startHub(A, BASE);
    check(`${L}: (set-up) hub A back up`, hubA.up, logText(A).slice(-600));
    await st.ready();
    check(`${L}: after a restart the group still on the clock keeps its names`, rosterNames(st).join() === names.join(), rosterNames(st));
    check(`${L}: (set-up) both pads reconnected`, !!(await padOnline(padA)) && !!(await padOnline(padB)));
    const pa = await prime(padA, names, { half: 'Cleme' });
    const pb = await prime(padB, names, { toGames: true });
    check(`${L}: (set-up) both pads show the names, picked, before the time is up`, pa.ok && pb.ok && st.last.session && !st.last.session.expired, { pa, pb, session: st.last.session });
    const nb = bills(A).length;
    await resetToasts();
    await until(() => st.last && st.last.roster.length === 0, 50000, 250);
    check(`${L}: the clock ran out by itself (no staff action)`, !!st.last.session && st.last.session.expired === true, st.last.session);
    await assertClean(L, st, A, pads, allNames, { backToPlayers: [padB] });
    for (const p of pads) {
      const t = await until(async () => { const x = await padToasts(p); return x.some((s) => /Time is up/.test(s)) ? x : null; }, 3000);
      check(`${L}: pad ${p.label} says "Time is up"`, !!t, await padToasts(p));
    }
    const b = bills(A);
    check(`${L}: billed once, with the group's names`, b.length === nb + 1 && names.every((n) => b[b.length - 1].names.includes(n)), b[b.length - 1]);
    check(`11. ${L}: session.json no longer holds the names`, sessionFileNames(A).length === 0, readData(A, 'session.json'));
    check(`9. ${L}: Recent games is []`, st.last.history.length === 0, st.last.history);
  }

  /* --- never offered again: a pad opened fresh on this oche --- */
  {
    const fresh = await openPad(browser, BASE, 'C (fresh)');
    const v = await padView(fresh, allNames);
    check('never offered again: a pad opened afterwards shows none of the evening\'s names anywhere', fresh.ready && padClean(v), v);
    await fresh.context().close();
    const disk = diskLeaks(A, allNames.filter((n) => n !== 'Yesterdayname'));
    check('not remembered: no wiped name is left in any file in data/ (bills and game records aside)', disk.length === 0, disk);
  }

  /* --- 8b. a pad left open across a restart that wipes the names --- */
  {
    const L = '8b. a pad left open while the PC was off 2 h (the restart wipes the names)';
    const P = 'P', port = BASE + 8;
    seed(P, { 'settings.json': { autoConnect: false, adminPin: '1234' } });
    let hubP = await startHub(P, port);
    const sp = staff(port);
    await sp.ready();
    const pad = await openPad(browser, port, 'P');
    const names = ['Nightowl', 'Latecomer'];
    await addPlayers(sp, names);                    // typed with no timer sold yet
    const pr = await prime(pad, names, { half: 'Nighto' });
    check(`${L}: (set-up) the pad shows the names, one half-typed`, pr.ok && hubP.up, pr);
    const oldEpoch = sp.last.rosterEpoch;
    const oldList = sp.last.roster.map((p) => ({ ...p }));
    await stopHub(hubP);
    await until(() => pad.evaluate(() => document.getElementById('hubpill').textContent !== 'connected'), 3000);
    // the PC was off for two hours: last alive then, names typed before that
    const off = Date.now() - 2 * HOUR;
    fs.writeFileSync(path.join(dirOf(P), 'alive.json'), JSON.stringify({ t: off }));
    fs.utimesSync(path.join(dirOf(P), 'players.json'), new Date(off), new Date(off));
    hubP = await startHub(P, port);
    await sp.ready();
    check(`${L}: (set-up) the pad reconnects`, !!(await padOnline(pad, 10000)));
    check(`${L}: wiped at boot (no session): hub list [] and players.json []`, rosterNames(sp).length === 0 && Array.isArray(fileNames(P)) && fileNames(P).length === 0, { hub: rosterNames(sp), file: fileNames(P) });
    const v = await padView(pad, [...names, 'Nighto']);
    check(`${L}: the pad shows no chips, an empty name box, no old name anywhere`, padClean(v), v);
    // a client still holding the list it read before the restart saves it back under that epoch
    const old = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await until(() => old.connected, 5000);
    old.emit('savePlayers', oldList, oldEpoch);
    await barrier(old);
    await wait(300);
    check(`${L}: savePlayers with the epoch read before the restart is refused (hub list and players.json stay [])`,
      rosterNames(sp).length === 0 && Array.isArray(fileNames(P)) && fileNames(P).length === 0,
      { epochBefore: oldEpoch, epochNow: sp.last && sp.last.rosterEpoch, hub: rosterNames(sp), file: fileNames(P) });
    old.close();
    sp.s.close();
    await stopHub(hubP);
  }

  check('no script errors on the pad pages', pageErrors.length === 0, pageErrors);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  st.s.close();
  await browser.close();
  await stopHub(hubA);
})().catch((e) => { check('suite ran to the end', false, e && e.stack); }).finally(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
