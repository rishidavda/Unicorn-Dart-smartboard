/* The Tapo smart plug follows the oche: on while time is sold and the board
 * is powered, off when the timer ends, is cleared, or the oche is powered
 * down; retries and re-logins when the plug misbehaves; both plug protocols
 * against fake plugs (test/fakeplug.js); the password never leaves the hub.
 * Boots its own hubs. */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const SP = process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test');
fs.mkdirSync(SP, { recursive: true });
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const BASE = Number(process.env.TPORT || 9310);
const KLAP_PORT = BASE + 20, LEGACY_PORT = BASE + 21;
const EMAIL = 'oche@example.com', PASSWORD = 'lights123';
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
const kids = [];
const kill = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } };
process.on('exit', kill);

async function getJson(url) { const r = await fetch(url); return r.json(); }
async function until(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await wait(step); }
}
function plugState(port) { return () => getJson(`http://127.0.0.1:${port}/state`); }

function startFakePlug(port, mode) {
  const k = spawn(process.execPath, [path.join(HERE, 'fakeplug.js')], {
    env: { ...process.env, FAKE_PLUG_PORT: String(port), FAKE_PLUG_MODE: mode, FAKE_PLUG_EMAIL: EMAIL, FAKE_PLUG_PASSWORD: PASSWORD },
    stdio: ['ignore', fs.openSync(path.join(SP, `fakeplug-${port}.log`), 'w'), 'inherit'],
  });
  kids.push(k);
  return until(plugState(port));
}
function startHub(name, port, files = {}) {
  const data = path.join(SP, name);
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(data, f), JSON.stringify(v));
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: data },
    stdio: ['ignore', fs.openSync(path.join(SP, `${name}.log`), 'w'), fs.openSync(path.join(SP, `${name}.log`), 'a')],
  });
  kids.push(k);
  return until(() => getJson(`http://127.0.0.1:${port}/api/history`).then(() => k), 15000).then((ok) => { if (!ok) throw new Error(`hub ${name} did not come up`); return k; });
}
function connect(port) {
  return new Promise((resolve) => {
    const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const state = { last: null, toasts: [] };
    s.on('state', (st) => { state.last = st; });
    s.on('toast', (t) => state.toasts.push(t.text));
    s.on('connect', () => s.emit('unlock', '1234', () => resolve({ s, state })));
  });
}
const plugOf = (st) => (st.last && st.last.plug) || {};

(async () => {
  await startFakePlug(KLAP_PORT, 'klap');
  await startFakePlug(LEGACY_PORT, 'legacy');
  const hubA = await startHub('plugHubA', BASE);
  const { s, state } = await connect(BASE);
  await wait(300);

  /* --- set up: the hub logs in and asserts "off" straight away --- */
  s.emit('saveSettings', { plug: { enabled: true, host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD } });
  let ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.sets >= 1 ? p : null; });
  check('plug configured: the hub logs in and asserts off with no timer', !!ps && ps.on === false && ps.logins >= 1, ps);
  await until(() => plugOf(state).ok);
  check('staff console sees the plug as reachable and off', plugOf(state).ok === true && plugOf(state).actual === false, plugOf(state));
  const sp = state.last.settings.plug;
  check('the password never reaches the browser', sp && sp.passwordSet === true && !('password' in sp) && sp.email === EMAIL, sp);
  const diag = await (await fetch(`http://127.0.0.1:${BASE}/api/board-diag.txt`)).text();
  check('the password is not in the diagnostics report either', !diag.includes(PASSWORD));

  /* --- a timer opens the oche: plug on; ending it: plug off --- */
  s.emit('sessionStart', 5);
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.on ? p : null; });
  check('timer set (waiting for their first game): plug ON', !!ps && ps.on === true, ps);
  s.emit('sessionEnd');
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; });
  check('End now: plug OFF', !!ps && ps.on === false, ps);

  s.emit('sessionStart', 5);
  await until(async () => (await plugState(KLAP_PORT)()).on);
  s.emit('sessionClear');
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; });
  check('Clear: plug OFF', !!ps && ps.on === false, ps);

  s.emit('sessionStopwatch');
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.on ? p : null; });
  check('stopwatch (pay at end): plug ON', !!ps && ps.on === true, ps);
  s.emit('powerOff');
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; });
  check('Power off: plug OFF', !!ps && ps.on === false, ps);
  s.emit('powerOn');
  await wait(1500);
  ps = await plugState(KLAP_PORT)();
  check('Power on with no timer: plug stays OFF until time is sold', ps.on === false, ps);
  s.emit('sessionStart', 5);
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.on ? p : null; });
  check('then a timer: plug ON again', !!ps && ps.on === true, ps);
  const setsBefore = ps.sets;
  s.emit('sessionExtend', 15);
  await wait(1200);
  ps = await plugState(KLAP_PORT)();
  check('extending a running timer does not touch the plug', ps.on === true && ps.sets === setsBefore, { before: setsBefore, now: ps.sets });

  /* --- a grace period before switching off, and a new timer inside it --- */
  s.emit('saveSettings', { plug: { offDelayMin: 0.05 } });   // 3 seconds
  await wait(400);
  s.emit('sessionEnd');
  await wait(1000);
  ps = await plugState(KLAP_PORT)();
  check('off delay: still ON a second after the session ends', ps.on === true, ps);
  check('staff console shows when it will switch off', !!plugOf(state).offDueAt, plugOf(state));
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; }, 8000);
  check('off delay: OFF once the grace period passes', !!ps && ps.on === false, ps);
  s.emit('sessionStart', 5);
  await until(async () => (await plugState(KLAP_PORT)()).on);
  const setsAtEnd = (await plugState(KLAP_PORT)()).sets;
  s.emit('sessionEnd');
  await wait(800);
  s.emit('sessionStart', 5);          // the next group arrives inside the grace period
  await wait(4500);
  ps = await plugState(KLAP_PORT)();
  check('a new timer inside the grace period cancels the switch-off (no flicker)', ps.on === true && ps.sets === setsAtEnd, { on: ps.on, sets: ps.sets, before: setsAtEnd });
  s.emit('saveSettings', { plug: { offDelayMin: 0 } });
  await wait(400);

  /* --- the plug goes off the network: the hub keeps working and retries --- */
  await fetch(`http://127.0.0.1:${KLAP_PORT}/fail?on=1`, { method: 'POST' });
  s.emit('sessionEnd');
  await until(() => !!plugOf(state).error, 10000);
  check('plug unreachable: the staff card says so', /503|unreachable|HTTP/i.test(plugOf(state).error || ''), plugOf(state).error);
  check('...and the session still ended normally', state.last.session === null || (state.last.session && state.last.session.expired), state.last.session);
  await fetch(`http://127.0.0.1:${KLAP_PORT}/fail?on=0`, { method: 'POST' });
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; }, 12000);
  check('plug back: the retry lands and it is OFF', !!ps && ps.on === false, ps);
  await until(() => plugOf(state).ok, 5000);
  check('...and the warning clears', plugOf(state).ok === true && !plugOf(state).error, plugOf(state));

  /* --- the plug rebooted (forgot the session): the hub logs in again --- */
  const loginsBefore = (await plugState(KLAP_PORT)()).logins;
  await fetch(`http://127.0.0.1:${KLAP_PORT}/forget`, { method: 'POST' });
  s.emit('sessionStart', 5);
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.on ? p : null; });
  check('plug rebooted: a fresh login, then ON', !!ps && ps.on === true && ps.logins === loginsBefore + 1, { logins: ps && ps.logins, before: loginsBefore });
  check('the fake plug never saw a bad sequence number or signature', ps.seqErrors === 0 && ps.sigErrors === 0, ps);
  s.emit('sessionEnd');
  await until(async () => !(await plugState(KLAP_PORT)()).on);

  /* --- Test on / Test off from the staff console --- */
  let ack = await new Promise((r) => s.emit('plugTest', true, r));
  ps = await plugState(KLAP_PORT)();
  check('Test on: the plug answers and is on', ack.ok === true && ack.protocol === 'klap' && ps.on === true, { ack, on: ps.on });
  ack = await new Promise((r) => s.emit('plugTest', false, r));
  ps = await plugState(KLAP_PORT)();
  check('Test off', ack.ok === true && ps.on === false, { ack, on: ps.on });

  /* --- an older plug that only speaks the legacy protocol --- */
  s.emit('saveSettings', { plug: { host: `127.0.0.1:${LEGACY_PORT}` } });
  await wait(300);
  ack = await new Promise((r) => s.emit('plugTest', true, r));
  ps = await plugState(LEGACY_PORT)();
  check('legacy plug: KLAP refused, securePassthrough login works, ON', ack.ok === true && ack.protocol === 'passthrough' && ps.on === true, { ack, ps });
  s.emit('sessionStart', 5);
  await wait(1200);
  s.emit('sessionEnd');
  ps = await until(async () => { const p = await plugState(LEGACY_PORT)(); return !p.on ? p : null; });
  check('legacy plug follows the timer too', !!ps && ps.on === false, ps);

  /* --- a wrong password is reported, not spun on --- */
  s.emit('saveSettings', { plug: { host: `127.0.0.1:${KLAP_PORT}`, password: 'wrong' } });
  await wait(300);
  ack = await new Promise((r) => s.emit('plugTest', true, r));
  check('wrong Tapo password: a plain error', ack.ok === false && /email or password/i.test(ack.error || ''), ack);
  s.emit('saveSettings', { plug: { password: PASSWORD } });
  await wait(300);
  s.emit('saveSettings', { plug: { password: '' } });   // a blank box must not wipe it
  await wait(300);
  ack = await new Promise((r) => s.emit('plugTest', false, r));
  check('a blank password box keeps the saved password', ack.ok === true, ack);

  /* --- restart with a timer that ran out while the PC was off: OFF at boot --- */
  await new Promise((r) => s.emit('plugTest', true, r));
  ps = await plugState(KLAP_PORT)();
  check('(set-up) plug left ON', ps.on === true);
  s.emit('saveSettings', { plug: { enabled: false } });
  await wait(400);
  const hubB = await startHub('plugHubB', BASE + 1, {
    'settings.json': { adminPin: '1234', plug: { enabled: true, host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 0 } },
    'session.json': { mode: 'timer', minutes: 5, startedAt: Date.now() - 6 * 60000, warned: false, names: [], rate: 10 },
  });
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; }, 15000);
  check('boot with an expired timer: the plug is switched OFF', !!ps && ps.on === false, ps);
  hubB.kill('SIGKILL');
  await wait(500);
  const hubC = await startHub('plugHubC', BASE + 2, {
    'settings.json': { adminPin: '1234', plug: { enabled: true, host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 0 } },
    'session.json': { mode: 'timer', minutes: 60, startedAt: Date.now() - 60000, warned: false, names: [], rate: 10 },
  });
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.on ? p : null; }, 15000);
  check('boot with a live timer (the 09:00 restart): the plug is ON', !!ps && ps.on === true, ps);
  hubC.kill('SIGKILL');

  console.log(`\n${pass} passed, ${fail} failed`);
  s.close();
  hubA.kill('SIGKILL');
  kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); kill(); process.exit(1); });
