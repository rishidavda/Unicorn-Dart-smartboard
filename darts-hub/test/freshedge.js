/* Fresh-start edge cases: single-instance lock, launcher gone, blank = off,
 * midnight rollover label/decision, supervisor-less hub, one fresh start a
 * day even when the relaunch lands on another port - or, at 23:59, when the
 * new port's stagger crosses midnight (that one runs under faketime, like
 * multiday.js); the card label after the day's restart. Uses short-lived hubs.
 * TPORT = first of four ports (the first must end in 0: it carries no stagger). */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js');
const P = Number(process.env.TPORT || 8960);
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
function start(name, port, env) {
  const out = [];
  const child = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: `${SP}/edge-${name}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  child.out = out;
  child.done = new Promise((r) => child.once('exit', (code) => r(code)));
  return child;
}
async function state(port) {
  const s = io(`http://127.0.0.1:${port}`, { reconnection: false, timeout: 1500 });
  const st = await new Promise((res) => { s.once('state', res); s.once('connect_error', () => res(null)); });
  s.close(); return st;
}
const hhmmOf = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
(async () => {
  for (const n of ['lock', 'l2', 'blank', 'gone', 'mid', 'once', 'late']) fs.rmSync(`${SP}/edge-${n}`, { recursive: true, force: true });

  // 1. single instance per folder
  const a = start('lock', P + 1, {});
  await wait(2200);
  const b = start('lock', P + 1, {});
  const bcode = await Promise.race([b.done, wait(8000).then(() => 'still running')]);
  check('second copy on the same folder refuses to run', bcode === 64, bcode);
  check('...with a clear message', /ALREADY RUNNING/.test(b.out.join('')));
  const ast = await state(P + 1);
  check('first copy unaffected', !!ast);
  a.kill('SIGINT'); await a.done;
  check('lock released on exit', !fs.existsSync(`${SP}/edge-lock/hub.lock`));
  // stale lock from a dead hub is taken over
  fs.writeFileSync(`${SP}/edge-lock/hub.lock`, JSON.stringify({ pid: 999999, at: 'x' }));
  const c = start('lock', P + 1, {});
  await wait(2200);
  check('stale lock (dead hub) is taken over', !!(await state(P + 1)));
  c.kill('SIGINT'); await c.done;

  // 2. blank DAILY_RESTART means off; missing means 09:00
  const d = start('blank', P + 2, { WINCHESTER_SUPERVISED: '1', DAILY_RESTART: '' });
  await wait(2200);
  const dst = await state(P + 2);
  check('blank DAILY_RESTART= is off', dst && dst.server.freshStart === null, dst && dst.server.freshStart);
  d.kill('SIGINT'); await d.done;
  const env2 = { ...process.env }; delete env2.DAILY_RESTART;
  const d2 = spawn('node', [`${HERE}/fakeboard.js`], { env: { ...env2, SERVER_JS: SERVER, PORT: String(P + 2), DARTS_DATA: `${SP}/edge-blank`, WINCHESTER_SUPERVISED: '1' }, stdio: 'ignore' });
  await wait(2200);
  const d2st = await state(P + 2);
  check('missing DAILY_RESTART defaults to 09:00', d2st && d2st.server.freshStart === `09:0${(P + 2) % 10}`, d2st && d2st.server.freshStart);
  d2.kill('SIGINT'); await new Promise((r) => d2.once('exit', r));

  // 3. launcher gone: no restart, staff told why
  const fakeLauncher = spawn('sleep', ['300']);
  const hhmm = hhmmOf(Date.now() + 70000);
  const e = start('gone', P, { WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(fakeLauncher.pid), DAILY_RESTART: hhmm });
  await wait(2500);
  const e1 = await state(P);
  check('launcher alive: restart scheduled', e1 && e1.server.freshStart === hhmm, e1 && e1.server.freshStart);
  fakeLauncher.kill('SIGKILL');
  await wait(12500);                          // launcher check is cached for 10 s
  const e2 = await state(P);
  check('launcher gone: staff card says paused and why', e2 && e2.server.freshStart === null && /WinchesterDarts\.exe was ended/.test(e2.server.freshStartNote || ''), e2 && e2.server.freshStartNote);
  const ecode = await Promise.race([e.done, wait(100000).then(() => 'still running')]);
  check('launcher gone: hub stays up through the restart time', ecode === 'still running', ecode);
  e.kill('SIGINT'); await e.done;

  // 4. one fresh start a day: the relaunch on an edited PORT gets a later
  //    stagger minute the same morning and must NOT restart again
  const launcher = spawn('sleep', ['300']);
  const base = Date.now() + 90000;   // target 30-90 s away: the hub must be up before it
  const time = hhmmOf(base);
  const f = start('once', P, { WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(launcher.pid), DAILY_RESTART: time });
  const fcode = await Promise.race([f.done, wait(150000).then(() => 'still running')]);
  check('fresh start fires (exit 75)', fcode === 75, fcode);
  const f2 = start('once', P + 1, { WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(launcher.pid), DAILY_RESTART: time });
  await wait(2500);
  const fst = await state(P + 1);
  const later = hhmmOf(new Date(base).setSeconds(0, 0) + 60000);
  check('relaunched on the new port, card shows tomorrow\'s stagger minute and that today\'s is done', fst && fst.server.port === P + 1 && fst.server.freshStart === `${later} (done for today)`, fst && [fst.server.port, fst.server.freshStart]);
  const until = new Date(base).setSeconds(0, 0) + 60000 + 45000 - Date.now();
  const f2code = await Promise.race([f2.done, wait(Math.max(0, until)).then(() => 'still running')]);
  check('...but the day\'s fresh start is done: no second restart', f2code === 'still running', f2code);
  f2.kill('SIGINT'); await f2.done;
  launcher.kill('SIGKILL');

  // 5. DAILY_RESTART=23:59 on a port with no stagger fires at 23:59; the
  //    relaunch on an edited port gets +3 min - 00:02, the NEXT calendar day -
  //    and must still count as that day's restart, not a new one. The hub's
  //    clock runs under faketime (x5) so the night takes seconds.
  const FAKELIB = ['/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1', '/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1', '/usr/lib/faketime/libfaketime.so.1'].find((f) => fs.existsSync(f));
  if (!FAKELIB) console.log('SKIP  23:59 + port change (libfaketime not installed: apt install faketime)');
  else {
    const SPEED = 5;
    const fakeStart = new Date(); fakeStart.setHours(23, 58, 30, 0);
    const t0 = Date.now();
    const fakeNow = () => fakeStart.getTime() + (Date.now() - t0) * SPEED;
    const p2 = (n) => String(n).padStart(2, '0');
    const fmt = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
    const launcher5 = spawn('sleep', ['300']);
    const night = () => ({ LD_PRELOAD: FAKELIB, FAKETIME: `@${fmt(fakeNow())} x${SPEED}`, FAKETIME_DONT_FAKE_MONOTONIC: '1', FAKETIME_NO_CACHE: '1',
      DARTS_SLEEP_GAP_MS: String(30000 * SPEED), WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(launcher5.pid), DAILY_RESTART: '23:59' });
    const g = start('late', P, night());
    const gcode = await Promise.race([g.done, wait(60000).then(() => 'still running')]);
    check('23:59 fresh start fires (exit 75)', gcode === 75, gcode);
    const g2 = start('late', P + 3, night());
    await wait(2500);
    const gst = await state(P + 3);
    check('relaunched past midnight on the new port: card shows tonight\'s staggered time', gst && gst.server.port === P + 3 && gst.server.freshStart === '00:02', gst && [gst.server.port, gst.server.freshStart]);
    // run the hub's clock past 00:02 (+ the minute-by-minute check) and see it stay up
    while (fakeNow() < fakeStart.getTime() + 6 * 60000 && g2.exitCode === null) await wait(1000);
    const g2code = await Promise.race([g2.done, wait(1000).then(() => 'still running')]);
    check('...and that night\'s fresh start is done: no second restart at 00:02', g2code === 'still running', g2code);
    g2.kill('SIGINT'); await g2.done;
    launcher5.kill('SIGKILL');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('FATAL', err); process.exit(1); });
