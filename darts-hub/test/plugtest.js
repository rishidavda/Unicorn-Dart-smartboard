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
const TPAP_PORT = BASE + 22, SLEEP_PORT = BASE + 23, SLEEP_UDP = BASE + 24, WEB_PORT = BASE + 25, SOLO_PORT = BASE + 26;
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

function startFakePlug(port, mode, extra = {}) {
  const k = spawn(process.execPath, [path.join(HERE, 'fakeplug.js')], {
    env: { ...process.env, FAKE_PLUG_PORT: String(port), FAKE_PLUG_MODE: mode, FAKE_PLUG_EMAIL: EMAIL, FAKE_PLUG_PASSWORD: PASSWORD, ...extra },
    stdio: ['ignore', fs.openSync(path.join(SP, `fakeplug-${port}.log`), 'w'), 'inherit'],
  });
  kids.push(k);
  return until(plugState(port));
}
function startHub(name, port, files = {}, env = {}) {
  const data = path.join(SP, name);
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(data, f), JSON.stringify(v));
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: data, ...env },
    stdio: ['ignore', fs.openSync(path.join(SP, `${name}.log`), 'w'), fs.openSync(path.join(SP, `${name}.log`), 'a')],
  });
  kids.push(k);
  return until(() => getJson(`http://127.0.0.1:${port}/api/history`).then(() => k), 15000).then((ok) => { if (!ok) throw new Error(`hub ${name} did not come up`); return k; });
}
function connect(port) {
  return new Promise((resolve) => {
    const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const state = { last: null, staff: null, toasts: [] };
    s.on('state', (st) => { state.last = st; });
    s.on('staff', (x) => { state.staff = x; });      // staff-only: the plug's set-up and status
    s.on('toast', (t) => state.toasts.push(t.text));
    s.on('connect', () => s.emit('unlock', '1234', () => resolve({ s, state })));
  });
}
const plugOf = (st) => (st.staff && st.staff.plug) || {};

(async () => {
  await startFakePlug(KLAP_PORT, 'klap');
  await startFakePlug(LEGACY_PORT, 'legacy');
  await startFakePlug(TPAP_PORT, 'klap', { FAKE_PLUG_COMPAT: '0' });
  await startFakePlug(SLEEP_PORT, 'klap', { FAKE_PLUG_SLEEP_UDP: String(SLEEP_UDP) });
  await startFakePlug(SOLO_PORT, 'klap');
  // Some other device's web page at the address typed (a router, a PC)
  const web = require('http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><head><title>Router</title></head><body>Welcome to your router login page</body></html>'); });
  await new Promise((r) => web.listen(WEB_PORT, '127.0.0.1', r));
  process.on('exit', () => { try { web.close(); } catch (_) {} });
  const hubA = await startHub('plugHubA', BASE);
  const { s, state } = await connect(BASE);
  await wait(300);

  /* --- set up: the hub logs in and asserts "off" straight away --- */
  s.emit('saveSettings', { plug: { enabled: true, host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD } });
  let ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.sets >= 1 ? p : null; });
  check('plug configured: the hub logs in and asserts off with no timer', !!ps && ps.on === false && ps.logins >= 1, ps);
  await until(() => plugOf(state).ok);
  check('staff console sees the plug as reachable and off', plugOf(state).ok === true && plugOf(state).actual === false, plugOf(state));
  const sp = state.staff.plugSettings;
  check('the password never reaches the browser', sp && sp.passwordSet === true && !('password' in sp) && sp.email === EMAIL, sp);
  // The TVs, players' iPads and customers' phones get the public state only:
  // no Tapo account, no plug address, no plug status.
  const pub = await new Promise((resolve) => {
    const p = io(`http://127.0.0.1:${BASE}`, { transports: ['websocket'] });
    let got = null, staffMsg = false;
    p.on('staff', () => { staffMsg = true; });
    p.on('state', (st) => { got = st; });
    setTimeout(() => { p.close(); resolve({ got, staffMsg }); }, 1500);
  });
  const pubText = JSON.stringify(pub.got || {});
  check('a screen that is not unlocked gets no Tapo account, plug address or plug status', !!pub.got && !pub.staffMsg
    && !('plug' in pub.got) && !('plug' in (pub.got.settings || {})) && !pubText.includes(EMAIL) && !pubText.includes(`127.0.0.1:${KLAP_PORT}`),
    { keys: pub.got && Object.keys(pub.got), staffMsg: pub.staffMsg });
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
  /* --- Power off at closing: off at once, never after the grace period --- */
  s.emit('saveSettings', { plug: { offDelayMin: 5 } });
  await wait(400);
  const tOff = Date.now();
  s.emit('powerOff');
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; }, 5000, 100);
  await until(() => plugOf(state).offDueAt === null, 3000);
  check(`Power off with "Off after" set to 5 min: the plug is OFF at once (${Date.now() - tOff} ms), no grace period`, !!ps && ps.on === false && !plugOf(state).offDueAt, { ps, plug: plugOf(state) });
  s.emit('powerOn');
  s.emit('saveSettings', { plug: { offDelayMin: 0 } });
  await wait(400);
  s.emit('sessionStart', 5);
  await until(async () => (await plugState(KLAP_PORT)()).on);

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

  /* --- firmware 1.4+: the Tapo app's Third-Party Compatibility switch is off --- */
  s.emit('saveSettings', { plug: { host: `127.0.0.1:${TPAP_PORT}` } });
  await wait(300);
  ack = await new Promise((r) => s.emit('plugTest', true, r));
  await until(() => plugOf(state).forbidden, 5000);
  check('new firmware, app switch off: staff are told exactly which switch to turn on', ack.ok === false
    && /Third-Party Compatibility/.test(ack.error || '') && plugOf(state).forbidden === true && !plugOf(state).authFailed, { ack, plug: plugOf(state) });
  await fetch(`http://127.0.0.1:${TPAP_PORT}/compat?on=1`, { method: 'POST' });
  ack = await new Promise((r) => s.emit('plugTest', true, r));
  ps = await plugState(TPAP_PORT)();
  check('...switch it on in the app and the plug works', ack.ok === true && ps.on === true, { ack, ps });
  await until(() => !plugOf(state).forbidden, 3000);
  check('...and the warning goes', !plugOf(state).forbidden && !plugOf(state).error, plugOf(state));

  /* --- an address that is some other device's web page --- */
  s.emit('saveSettings', { plug: { host: `127.0.0.1:${WEB_PORT}` } });
  await wait(300);
  ack = await new Promise((r) => s.emit('plugTest', true, r));
  check('an address that is a router\'s web page: "not like a Tapo plug - check the address", not a password error',
    ack.ok === false && /not like a Tapo plug/.test(ack.error || '') && !/password/i.test(ack.error || '') && !plugOf(state).authFailed, ack);

  /* --- a wrong password says so plainly, with the capitals hint --- */
  s.emit('saveSettings', { plug: { host: `127.0.0.1:${KLAP_PORT}`, password: 'Lights123' } });
  await wait(300);
  ack = await new Promise((r) => s.emit('plugTest', true, r));
  await until(() => plugOf(state).authFailed, 3000);
  check('wrong password: "turned down" (not "can\'t reach"), with the capitals hint', ack.ok === false && /capitals/.test(ack.error || '')
    && plugOf(state).authFailed === true, { ack, plug: plugOf(state) });
  s.emit('saveSettings', { plug: { password: PASSWORD } });
  await wait(300);

  /* --- an address pasted from a browser, and one that is not an address --- */
  state.toasts.length = 0;
  s.emit('saveSettings', { plug: { host: ` http://127.0.0.1:${KLAP_PORT}/ ` } });
  await until(() => state.staff && state.staff.plugSettings && state.staff.plugSettings.host === `127.0.0.1:${KLAP_PORT}`, 3000);
  check('an address pasted as "http://.../" is kept as the plug\'s address', state.staff.plugSettings.host === `127.0.0.1:${KLAP_PORT}`, state.staff.plugSettings);
  s.emit('saveSettings', { plug: { host: '192 168 1 60' } });
  await until(() => state.toasts.some((t) => /not a plug address/.test(t)), 3000);
  check('...and "192 168 1 60" is refused out loud, the saved address kept', state.toasts.some((t) => /not a plug address/.test(t))
    && state.staff.plugSettings.host === `127.0.0.1:${KLAP_PORT}`, { toasts: state.toasts, host: state.staff.plugSettings.host });

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
  await wait(500);

  /* --- the commonest ending of all: a timer simply running out, hub left alone --- */
  const hubD = await startHub('plugHubD', BASE + 3, {
    'settings.json': { adminPin: '1234', plug: { enabled: true, host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 0 } },
    'session.json': { mode: 'timer', minutes: 5, startedAt: Date.now() - 5 * 60000 + 8000, warned: false, names: [], rate: 10 },
  });
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return p.on ? p : null; }, 8000, 100);
  check('a timer with seconds left: the plug is ON', !!ps && ps.on === true, ps);
  const endsAt = Date.now() + Math.max(0, 8000 - 1500);      // roughly when the time runs out
  ps = await until(async () => { const p = await plugState(KLAP_PORT)(); return !p.on ? p : null; }, 25000, 100);
  const late = Math.round((Date.now() - endsAt) / 1000);
  check(`the time runs out with nobody touching anything: the plug switches OFF by itself (${late} s after)`, !!ps && ps.on === false && late <= 12, { late, ps });
  hubD.kill('SIGKILL');
  await wait(500);

  /* --- next morning after an evening left open (PC shut down mid-stopwatch) --- */
  await fetch(`http://127.0.0.1:${SOLO_PORT}/state`);
  const soloBefore = await plugState(SOLO_PORT)();
  const hubE = await startHub('plugHubE', BASE + 4, {
    'settings.json': { adminPin: '1234', plug: { enabled: true, host: `127.0.0.1:${SOLO_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 1 } },
    'session.json': { mode: 'stopwatch', minutes: 0, startedAt: Date.now() - 12 * 3600000, warned: false, names: [], rate: 10 },
    'alive.json': { t: Date.now() - 10 * 3600000 },
  });
  ps = await until(async () => { const p = await plugState(SOLO_PORT)(); return p.sets > soloBefore.sets ? p : null; }, 10000, 100);
  await wait(2500);
  const soloAfter = await plugState(SOLO_PORT)();
  check('boot after an evening left open: the plug goes straight OFF - never a flash ON, never the 1 min grace',
    soloAfter.on === false && soloAfter.sets === soloBefore.sets + 1, { before: soloBefore.sets, after: soloAfter.sets, on: soloAfter.on });
  hubE.kill('SIGKILL');
  await wait(500);

  /* --- a folder copied from another PC brings no plug with it --- */
  const { TapoPlug } = require(path.join(path.dirname(SERVER), 'plug.js'));
  await new TapoPlug({ host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD }).setOn(true);   // the other board's lights ON
  const shared = await plugState(KLAP_PORT)();
  const hubF = await startHub('plugHubF', BASE + 5, {
    'settings.json': { adminPin: '1234', plug: { enabled: true, host: `127.0.0.1:${KLAP_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 0 },
      plugHome: { host: 'bar-pc-1', folder: 'abc123', path: 'C:\\Darts\\WinchesterDarts\\data' } },
  });
  const f = await connect(BASE + 5);
  await until(() => f.state.staff && f.state.last, 5000);
  await wait(2500);
  const sharedAfter = await plugState(KLAP_PORT)();
  const fw = (f.state.last.warnings || []).join(' ');
  check('a folder copied from another PC: its plug set-up is dropped (with a warning) and the other board\'s plug is left alone',
    f.state.staff.plugSettings.enabled === false && !f.state.staff.plugSettings.host && /copied from another PC \(bar-pc-1\)/.test(fw)
    && sharedAfter.on === true && sharedAfter.sets === shared.sets,
    { plug: f.state.staff.plugSettings, warn: fw.slice(0, 120), on: sharedAfter.on, sets: [shared.sets, sharedAfter.sets] });
  check('...but the venue\'s Tapo account comes with it', f.state.staff.plugSettings.email === EMAIL && f.state.staff.plugSettings.passwordSet === true, f.state.staff.plugSettings);
  f.s.close();
  hubF.kill('SIGKILL');
  await wait(500);
  const hubG = await startHub('plugHubG', BASE + 5, {}, {});   // the same folder restarted (its stamp is its own now)
  hubG.kill('SIGKILL');
  await wait(300);

  /* --- a plug asleep after a power cut: the hub wakes it --- */
  const hubH = await startHub('plugHubH', BASE + 6, {
    'settings.json': { adminPin: '1234', plug: { enabled: true, host: `127.0.0.1:${SLEEP_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 0 } },
    'session.json': { mode: 'timer', minutes: 60, startedAt: Date.now() - 60000, warned: false, names: [], rate: 10 },
  }, { TAPO_TDP_PORT: String(SLEEP_UDP) });
  const tSleep = Date.now();
  ps = await until(async () => { const p = await plugState(SLEEP_PORT)(); return p.on ? p : null; }, 20000, 200);
  check(`a plug asleep after a power cut: the hub sends the discovery probe, the plug wakes and is ON (${Math.round((Date.now() - tSleep) / 1000)} s)`,
    !!ps && ps.on === true && ps.probes >= 1 && ps.badProbes === 0, ps);
  hubH.kill('SIGKILL');

  /* --- a switch asked for while the minute check is waiting on the plug --- */
  {
    const { PlugController } = require(path.join(path.dirname(SERVER), 'plug.js'));
    const c = new PlugController();
    c.configure({ enabled: true, host: `127.0.0.1:${SOLO_PORT}`, email: EMAIL, password: PASSWORD, offDelayMin: 0 });
    c.set(false);
    await until(() => c.actual === false, 8000, 50);
    await fetch(`http://127.0.0.1:${SOLO_PORT}/fail?on=1`, { method: 'POST' });
    const h = c._heal();
    c.set(true);                          // staff sell time while the check is out
    await h;
    await fetch(`http://127.0.0.1:${SOLO_PORT}/fail?on=0`, { method: 'POST' });
    const tBack = Date.now();
    ps = await until(async () => { const p = await plugState(SOLO_PORT)(); return p.on ? p : null; }, 15000, 100);
    const took = Math.round((Date.now() - tBack) / 1000);
    check(`a sale during a failed minute check is retried in seconds, not left for the next minute (${took} s)`, !!ps && ps.on === true && took <= 12, { on: ps && ps.on, took });
    c.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  s.close();
  hubA.kill('SIGKILL');
  kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); kill(); process.exit(1); });
