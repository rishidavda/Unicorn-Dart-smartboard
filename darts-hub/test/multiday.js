/*
 * Three pub days in about two and a half hours: the hub runs under an
 * accelerated clock (faketime, 20x) beneath a launcher-style supervisor
 * (relaunch on exit code 75), with the fake board and all four screens open
 * the whole time. Timers inside the hub run at real speed; only the clock
 * (restart times, midnight, bills) is fast.
 *
 *   Day 1  hub booted 07:30 -> 09:00 fresh start -> open, play all day ->
 *          23:00 Power off (standby overnight; darts must be ignored)
 *   Day 2  09:00 fresh start WHILE ON STANDBY (board must stay released) ->
 *          11:00 Power on -> board connects, darts score -> play ->
 *          23:00 game ended, stopwatch left running, hub left on ->
 *          02:00 the PC "sleeps" for an hour (SIGSTOP) -> wakes: board back,
 *          the abandoned stopwatch billed up to the moment it went to sleep
 *   Day 3  09:00 fresh start with the board connected -> reconnects, darts
 *          score -> reports for day 1 and 2 on disk -> done
 *
 * Usage: node multiday.js        env: TPORT (8870), SPEED (20), SERVER_JS
 * Needs: faketime (apt install faketime), Chromium.
 */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TPORT || 8870);
const SPEED = Number(process.env.SPEED || 20);
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const URL = `http://127.0.0.1:${PORT}`;
const DIR = path.join(SP, 'multiday');
const DATA = path.join(DIR, 'data');
const REPORTS = path.join(DIR, 'reports');
const LOG = path.join(DIR, 'multiday.log');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const log = (m) => { const l = `[${new Date().toISOString().slice(11, 19)} | hub ${fmt(fakeNow())}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const results = { startedAt: new Date().toISOString(), speed: SPEED, checks: [], exits: [], samples: [], pageErrors: {}, consoleErrors: {} };
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); results.checks.push({ l, ok, x }); log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); save(); };
const save = () => fs.writeFileSync(path.join(DIR, 'multiday-results.json'), JSON.stringify({ ...results, pass, fail }, null, 2));

// ---- the fast clock -------------------------------------------------------
const realStart = Date.now();
const fakeStart = Date.parse('2026-09-27T07:30:00Z');       // container clock is UTC
const fakeNow = () => fakeStart + (Date.now() - realStart) * SPEED;
const fmt = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const at = (dayOffset, hh, mm = 0) => Date.parse(`2026-09-${27 + dayOffset}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
async function untilFake(t, label) {
  if (label) log(`waiting until hub time ${fmt(t)} (${label}) - ${Math.max(0, Math.round((t - fakeNow()) / SPEED / 1000))} s real`);
  while (fakeNow() < t) await wait(1000);
}

// ---- supervisor: what WinchesterDarts.exe does ----------------------------
let hub = null, hubPid = 0, spawns = 0, stopSupervising = false;
// Stopping the simulation must take the hub with it (the browser closes with the process)
process.on('SIGTERM', () => { stopSupervising = true; try { if (hub) hub.kill('SIGINT'); } catch (_) {} process.exit(1); });
function launch() {
  spawns += 1;
  const out = fs.openSync(path.join(DIR, `hub-${spawns}.log`), 'w');
  hub = spawn('faketime', ['-f', `@${fmt(fakeNow())} x${SPEED}`, 'node', path.join(HERE, 'fakeboard.js')], {
    env: { ...process.env, FAKETIME_DONT_FAKE_MONOTONIC: '1', FAKETIME_NO_CACHE: '1', SERVER_JS: SERVER, PORT: String(PORT),
      DARTS_DATA: DATA, DARTS_REPORTS: REPORTS, WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(process.pid), DAILY_RESTART: '09:00' },
    stdio: ['ignore', out, out],
  });
  hubPid = hub.pid;
  log(`launch #${spawns} (pid ${hubPid})`);
  hub.on('exit', (code) => {
    results.exits.push({ code, hubTime: fmt(fakeNow()), launch: spawns });
    log(`hub exited code ${code}`);
    if (stopSupervising) return;
    if (code === 75) setTimeout(launch, 1000);
    else { check(`unexpected hub exit (code ${code}) - relaunching`, false, code); setTimeout(launch, 5000); }
  });
}
const rss = () => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${hubPid}/status`, 'utf8'))[1]) / 1024); } catch (_) { return null; } };

// ---- staff socket -----------------------------------------------------------
let st = null;
const sock = io(URL, { reconnectionDelayMax: 1000 });
sock.on('state', (s) => { st = s; });
sock.on('connect', () => sock.emit('unlock', '1234', () => {}));
const sessions = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')); } catch (_) { return []; } };
async function untilState(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (st && pred(st)) return true; await wait(500); }
  log(`timed out waiting for: ${label}`);
  return false;
}
async function afterRelaunch(prevBoot) {
  return untilState((s) => s.server && s.server.bootedAt !== prevBoot, 60000, 'hub back after restart');
}
async function dartsScore(label) {
  const p0 = st.board.packets, d0 = st.match ? st.match.dartsInLog : 0;
  const ok = await untilState((s) => s.board.packets > p0 && s.match && s.match.dartsInLog > d0, 25000, 'darts scoring');
  check(`${label}: board packets and game darts both climb`, ok, { packets: [p0, st.board.packets], darts: [d0, st.match && st.match.dartsInLog] });
}
async function openUp(label) {
  sock.emit('savePlayers', [{ id: 'p1', name: 'Ash' }, { id: 'p2', name: 'Sam' }]);
  sock.emit('sessionStopwatch'); await wait(300);
  sock.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Ash' }, { name: 'Sam' }] }); await wait(500);
  check(`${label}: stopwatch session and a game running`, !!(st.session && st.match), { session: !!st.session, match: !!st.match });
  await dartsScore(label);
}
let keepPlaying = false;
setInterval(() => {   // like the soak: a new game whenever one ends
  if (!keepPlaying || !st || st.powered === false || !st.session) return;
  if (!st.match || st.match.finished) sock.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Ash' }, { name: 'Sam' }] });
}, 5000);
setInterval(() => { results.samples.push({ hubTime: fmt(fakeNow()), rssMb: rss(), board: st && st.board.state, powered: st && st.powered }); save(); }, 120000);

(async () => {
  launch();
  await wait(4000);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const pages = {};
  for (const [n, p] of [['tv', '/tv'], ['pad', '/pad'], ['board', '/board'], ['staff', '/staff']]) {
    pages[n] = await b.newPage({ viewport: { width: 1280, height: 900 } });
    results.pageErrors[n] = []; results.consoleErrors[n] = [];
    pages[n].on('pageerror', (e) => results.pageErrors[n].push(String(e.message).slice(0, 200)));
    pages[n].on('console', (m) => { if (m.type() === 'error') results.consoleErrors[n].push(m.text().slice(0, 200)); });
    await pages[n].goto(URL + p);
  }
  await wait(1500);
  await pages.staff.keyboard.type('1234');
  const mark = () => Promise.all(Object.values(pages).map((p) => p.evaluate(() => { window.__m = 1; }).catch(() => {})));
  const stillMarked = async () => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([n, p]) => [n, await p.evaluate(() => window.__m === 1).catch(() => false)])));
  const tvFoot = () => pages.tv.$eval('#foot', (el) => el.textContent).catch(() => '');
  const tvStandby = () => pages.tv.$eval('#standby', (el) => !el.hidden).catch(() => null);
  await mark();
  check('hub up with the fake board connected', await untilState((s) => s.board.state === 'connected', 30000, 'board'), st && st.board.state);
  check('staff card shows the 09:00 fresh start', st.server.freshStart === '09:00', st.server.freshStart);

  // ===================== Day 1 =====================
  let boot = st.server.bootedAt;
  await untilFake(at(0, 9, 0), 'day 1 fresh start');
  check('day 1: fresh start fires (exit 75) within 15 hub-minutes of 09:00', await (async () => { const t0 = Date.now(); while (fakeNow() < at(0, 9, 15)) { if (results.exits.length >= 1) return true; await wait(500); } return false; })(), results.exits);
  check('day 1: hub back', await afterRelaunch(boot));
  check('day 1: board reconnected after the fresh start', await untilState((s) => s.board.state === 'connected', 60000, 'board'), st.board.state);
  check('day 1: no screen reloaded on the restart', Object.values(await stillMarked()).every(Boolean), await stillMarked());
  const foot1 = await (async () => { for (let i = 0; i < 60; i++) { const f = await tvFoot(); if (/board connected/.test(f)) return f; await wait(500); } return tvFoot(); })();
  check('day 1: TV recovered (board connected in the footer)', /board connected/.test(foot1), foot1);
  await openUp('day 1');
  keepPlaying = true;
  await untilFake(at(0, 23, 0), 'day 1 closing time');
  keepPlaying = false;
  const bills0 = sessions().length;
  sock.emit('powerOff'); await wait(1500);
  check('day 1 23:00: Power off -> standby, board released, game gone', st.powered === false && st.board.state !== 'connected' && !st.match, { powered: st.powered, board: st.board.state });
  check('day 1: the day\'s stopwatch was billed on power off', sessions().length === bills0 + 1 && sessions().slice(-1)[0].price > 100, sessions().slice(-1)[0]);
  check('day 1: TV on standby', (await tvStandby()) === true);
  const pk = st.board.packets; await wait(12000);
  check('day 1 standby: darts from the released board are ignored', st.board.packets === pk, { before: pk, after: st.board.packets });

  // ===================== Day 2 =====================
  boot = st.server.bootedAt;
  await untilFake(at(1, 9, 0), 'day 2 fresh start (on standby)');
  check('day 2: fresh start fires while on standby', await (async () => { while (fakeNow() < at(1, 9, 15)) { if (results.exits.length >= 2) return true; await wait(500); } return false; })(), results.exits.length);
  check('day 2: hub back', await afterRelaunch(boot));
  await wait(20000);
  check('day 2: still powered off after the restart; board NOT grabbed', st.powered === false && st.board.state !== 'connected', { powered: st.powered, board: st.board.state });
  check('day 2: TV still on standby, not reloaded', (await tvStandby()) === true && (await stillMarked()).tv === true);
  await untilFake(at(1, 11, 0), 'day 2 opening');
  sock.emit('powerOn');
  check('day 2 11:00: Power on -> board connects', await untilState((s) => s.powered === true && s.board.state === 'connected', 60000, 'board after power on'), st.board.state);
  check('day 2: TV left standby', (await tvStandby()) === false);
  await openUp('day 2');
  keepPlaying = true;
  await untilFake(at(1, 23, 0), 'day 2 closing (left on, stopwatch running)');
  keepPlaying = false;
  sock.emit('endMatch'); await wait(500);
  const sessStart = st.session && st.session.startedAt;
  check('day 2: stopwatch still running overnight, hub left on', !!(st.session && st.session.mode === 'stopwatch' && st.powered), st.session && st.session.mode);
  // the PC sleeps 02:00 -> ~03:07 (200 s real = 66 hub-minutes)
  await untilFake(at(2, 2, 0), 'day 3 02:00 - PC goes to sleep');
  const bills1 = sessions().length;
  process.kill(hubPid, 'SIGSTOP'); log('hub SIGSTOP (PC asleep)');
  await wait(200000);
  process.kill(hubPid, 'SIGCONT'); log('hub SIGCONT (PC awake)');
  check('after sleep: hub noticed the wake-up and the board came back', await untilState((s) => s.board.state === 'connected', 90000, 'board after wake'), st.board.state);
  await wait(3000);
  const settled = sessions().length === bills1 + 1 ? sessions().slice(-1)[0] : null;
  const expectedMin = Math.round((at(2, 2, 0) - sessStart) / 60000);
  check('after sleep: the abandoned stopwatch was billed up to bedtime, not the wake-up', !!settled && Math.abs(settled.minutesPlayed - expectedMin) <= 25, { settled, expectedMin });
  check('after sleep: session closed so the next group cannot play on it', !st.session || st.session.expired === true, st.session);

  // ===================== Day 3 =====================
  boot = st.server.bootedAt;
  await untilFake(at(2, 9, 0), 'day 3 fresh start (board connected)');
  check('day 3: fresh start fires', await (async () => { while (fakeNow() < at(2, 9, 15)) { if (results.exits.length >= 3) return true; await wait(500); } return false; })(), results.exits.length);
  check('day 3: hub back', await afterRelaunch(boot));
  check('day 3: board reconnected after the fresh start', await untilState((s) => s.board.state === 'connected', 60000, 'board'), st.board.state);
  await openUp('day 3');
  await untilFake(at(2, 9, 40), 'reports settle');
  const rep = (d) => fs.existsSync(path.join(REPORTS, 'Sep', `${27 + d}-09-26-report.pdf`)) ? fs.readFileSync(path.join(REPORTS, 'Sep', `${27 + d}-09-26-report.pdf`), 'latin1') : '';
  check('day 1 report on disk with money taken', /MONEY TAKEN TODAY: £[1-9]/.test(rep(0)), (rep(0).match(/MONEY TAKEN TODAY: £[\d.]+/) || ['missing'])[0]);
  check('day 2 report on disk with the settled overnight bill', /MONEY TAKEN TODAY: £[1-9]/.test(rep(1)), (rep(1).match(/MONEY TAKEN TODAY: £[\d.]+/) || ['missing'])[0]);
  check('exactly three restarts over three days, all code 75', results.exits.length === 3 && results.exits.every((e) => e.code === 75), results.exits);
  check('hub always came back on its own port', st.server.port === PORT && !st.server.displaced, st.server);
  const rssVals = results.samples.map((s) => s.rssMb).filter(Boolean);
  check('hub memory stayed bounded (< 150 MB)', rssVals.length && Math.max(...rssVals) < 150, { max: Math.max(...rssVals), min: Math.min(...rssVals) });
  check('no page errors on any screen over three days', Object.values(results.pageErrors).every((a) => !a.length) && Object.values(results.consoleErrors).every((a) => !a.length), { page: results.pageErrors, console: results.consoleErrors });
  const awake = await Promise.all(Object.values(pages).map((p) => p.evaluate(() => window.WinchesterAwake && WinchesterAwake()).catch(() => 'err')));
  check('all four screens alive and held awake at the end', awake.every((a) => a === 'wake-lock' || a === 'video'), awake);

  stopSupervising = true;
  await b.close(); sock.close();
  try { hub.kill('SIGINT'); } catch (_) {}
  results.endedAt = new Date().toISOString();
  save();
  log(`\n${pass} passed, ${fail} failed`);
  fs.writeFileSync(path.join(DIR, 'multiday.done'), `${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { log(`FATAL ${e.stack}`); stopSupervising = true; try { hub.kill(); } catch (_) {} fs.writeFileSync(path.join(DIR, 'multiday.done'), 'CRASHED'); process.exit(1); });
