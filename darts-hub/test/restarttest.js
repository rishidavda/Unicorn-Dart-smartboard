/*
 * Daily fresh start, end to end. A supervisor mirroring WinchesterDarts.exe
 * (relaunch on exit code 75) runs the real hub with a fake board; the
 * restart time is set a couple of minutes ahead. Checks: a live game defers
 * it, it then fires, the hub comes back on the same port with the game,
 * session and power state intact, the board reconnects, an open TV page
 * recovers by itself, and it does not restart a second time.
 */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = `${SP}/restarttest.log`;
fs.writeFileSync(LOG, '');
const log = (m) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };

const PORT = Number(process.env.TPORT || 8890);                       // % 10 = 0: no per-port stagger
const URL = `http://127.0.0.1:${PORT}`;

// Restart target: the first whole minute at least 100 s away
const now = Date.now();
const T = new Date(Math.ceil((now + 100000) / 60000) * 60000);
const hhmm = `${String(T.getHours()).padStart(2, '0')}:${String(T.getMinutes()).padStart(2, '0')}`;

// ---- supervisor: the launcher's loop, in node ---------------------------
const exits = [];
let spawns = 0;
let stopSupervising = false;
let current = null;
function launch() {
  spawns += 1;
  const out = fs.openSync(`${SP}/restart-hub-${spawns}.log`, 'w');
  const child = current = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, SERVER_JS: process.env.SERVER_JS, PORT: String(PORT), DARTS_DATA: `${SP}/hubR`,
           WINCHESTER_SUPERVISED: '1', DAILY_RESTART: hhmm },
    stdio: ['ignore', out, out],
  });
  child.on('exit', (code) => {
    exits.push({ code, at: Date.now() });
    log(`supervisor: hub exited with code ${code}`);
    if (!stopSupervising && code === 75) setTimeout(launch, 1000);
  });
  return child;
}

(async () => {
  fs.rmSync(`${SP}/hubR`, { recursive: true, force: true });
  log(`restart time set to ${hhmm} (T = ${T.toISOString()})`);
  launch();
  await wait(3500);

  let state = null;
  const s = io(URL, { reconnectionDelayMax: 2000 });
  s.on('state', (st) => { state = st; });
  await wait(500);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(500);   // only our darts count as play
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(400);
  check('staff snapshot announces the fresh start time', state.server.freshStart === hhmm, state.server.freshStart);
  const boot1 = state.server.bootedAt;

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await tv.goto(`${URL}/tv`); await tv.waitForTimeout(800);
  // The TV shows names in capitals (CSS), so compare case-insensitively
  const tvShowsPlayers = () => tv.evaluate(() => /ash/i.test(document.body.innerText) && /sam/i.test(document.body.innerText));
  check('baseline: TV shows the game before the restart', await tvShowsPlayers());
  const st = await b.newPage({ viewport: { width: 820, height: 1400 } });
  await st.goto(`${URL}/staff`); await st.waitForTimeout(800);
  await st.keyboard.type('1234'); await st.waitForTimeout(1000);
  await st.evaluate(() => document.querySelectorAll('details.more').forEach((d) => { d.open = true; }));
  const staffText = await st.evaluate(() => document.body.innerText);
  check('staff card shows the daily fresh start line', new RegExp(`Daily fresh start: ${hhmm}`).test(staffText)
    && /Running since/.test(staffText));

  // ---- deferral: keep a live game going through T+110 s ------------------
  const dart = () => s.emit('dart', { score: 1, multiplier: 1 });
  const throwUntil = T.getTime() + 110000;
  let thrown = 0;
  let lastDartAt = 0;
  while (Date.now() < throwUntil) { dart(); lastDartAt = Date.now(); thrown++; await wait(25000); }
  log(`threw ${thrown} darts through T+110s`);
  await wait(Math.max(0, T.getTime() + 150000 - Date.now()));
  check('live game defers the restart (no exit by T+150s)', exits.length === 0, exits);

  const dartsBefore = state.match.dartsInLog;
  const sessionBefore = state.session && state.session.startedAt;
  log(`waiting for the deferred restart (due ~5 min after the last dart)...`);
  const deadline = Date.now() + 7 * 60000;
  while (!exits.length && Date.now() < deadline) await wait(2000);
  check('restart fires once play stops', exits.length === 1 && exits[0].code === 75, exits);
  check('it waited out the quiet period', exits[0] && exits[0].at - lastDartAt >= 5 * 60000,
    exits[0] && Math.round((exits[0].at - lastDartAt) / 1000) + 's after last dart');

  // ---- after the relaunch ------------------------------------------------
  const back = Date.now() + 30000;
  while (Date.now() < back && !(state && state.server && state.server.bootedAt !== boot1)) await wait(500);
  check('supervisor relaunched the hub', spawns === 2);
  check('hub is back on the same port', state && state.server.port === PORT, state && state.server.port);
  check('new run (fresh boot time)', state && state.server.bootedAt > boot1);
  check('game survived the restart', state && state.match && state.match.dartsInLog === dartsBefore,
    state && state.match && state.match.dartsInLog);
  check('session survived the restart', state && state.session && state.session.startedAt === sessionBefore);
  check('power switch still on', state && state.powered === true);
  await wait(4000);
  check('board reconnected by itself', state.board.state === 'connected', state.board.state);

  await tv.waitForTimeout(2000);
  const foot = await tv.$eval('#foot', (el) => el.textContent);
  const tvRows = await tvShowsPlayers();
  check('open TV page recovered by itself', !/lost contact/.test(foot) && /board connected/.test(foot) && tvRows, { foot, tvRows });
  const awake = await tv.evaluate(() => window.WinchesterAwake && WinchesterAwake());
  check('TV still held awake', awake === 'wake-lock' || awake === 'video', awake);

  log('watching for an unwanted second restart (90 s)...');
  await wait(90000);
  check('no second restart the same day', exits.length === 1 && spawns === 2, { exits: exits.length, spawns });

  stopSupervising = true;
  await b.close();
  s.close();
  log(`\n${pass} passed, ${fail} failed`);
  fs.writeFileSync(`${SP}/restarttest.done`, `${pass} passed, ${fail} failed`);
  // stop only the hub this test launched
  try { current && current.kill(); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  log(`FATAL ${e.stack}`);
  fs.writeFileSync(`${SP}/restarttest.done`, 'CRASHED');
  process.exit(1);
});
