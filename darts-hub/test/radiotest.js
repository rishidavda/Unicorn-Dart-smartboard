/*
 * The dartboard comes up WITHOUT anyone pressing anything in every radio
 * situation a Windows pub PC produces: the radio reporting unknown /
 * unsupported / off before on straight after logon, a radio that says
 * nothing for 10 s, Bluetooth switched off and on under a live link (twice
 * "off" in a row, as WinRT's Off and Disabled both read poweredOff), the
 * radio cycling mid-scan, a scan the adapter aborts, a Bluetooth stack
 * that refuses to start, and a slow connect that completes after the radio
 * dropped and came back. Staff Disconnect and Power off still win over all
 * of it. Every case boots its own hub (fresh data dir) on radioboard.js - the
 * REAL noble Noble class over a scripted WinRT-like binding - and watches it
 * over socket.io and radioboard's /stats hook.
 *
 *   TPORT (default 9500)  case n's hub on TPORT + n%10, its radioboard hook on TPORT + 10 + n%10
 *                         (TPORT..TPORT+19; case 9 is the summary, so 9 and 19 stay free)
 *   DARTS_TEST_TMP        hub data dirs (radioN/) and logs (radioN.log)
 *   SERVER_JS             the server under test
 *   RADIO_CASES="4,8"     run only these cases (default: all)
 * ~1.5 minutes (case 8 runs beside the others: it sits through two of the hub's
 * 30 s watchdog ticks).
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const SP = process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test');
fs.mkdirSync(SP, { recursive: true });
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const BASE = Number(process.env.TPORT || 9500);
const BOARD = 'aabbccddeeff';
const T_START = Date.now();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await wait(step); }
}
async function getJson(url) { const r = await fetch(url); return r.json(); }

/* ------------------------------------------------------------- hubs --- */
const hubs = [];
process.on('exit', () => { for (const h of hubs) { if (!h.exit) { try { h.k.kill('SIGKILL'); } catch (_) {} } } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

// A busy port would make the hub step to the next one - outside this suite's range.
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}
// The board this PC already knows - written exactly as setBoard() would have
// on this very folder, so the hub takes it as "remembered here".
const remembered = (data) => ({
  boardUuid: BOARD,
  boardMeta: {
    name: 'Unicorn Darts', address: 'AA:BB:CC:DD:EE:FF', addressType: 'public', source: 'tap',
    at: Date.now() - 86400000,
    folder: crypto.createHash('sha1').update(path.resolve(data)).digest('hex').slice(0, 16),
    path: path.resolve(data),
  },
});

async function startHub(n, { env = {}, settings = null } = {}) {
  const port = BASE + (n % 10), hook = BASE + 10 + (n % 10);
  for (const p of [port, hook]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is busy - not starting a hub that would wander outside ${BASE}-${BASE + 19}`);
  }
  const data = path.join(SP, `radio${n}`);
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data, { recursive: true });
  if (settings) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings(data)));
  const logFile = path.join(SP, `radio${n}.log`);
  const out = fs.openSync(logFile, 'w');
  // Nothing from the caller's shell may leak into the scripted radio.
  const base = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^FAKE_|^DARTBOARD$|^DARTS_BROWSE_MS$|^PORT$|^DARTS_DATA$/.test(key)));
  const k = spawn(process.execPath, [path.join(HERE, 'radioboard.js')], {
    env: { ...base, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: data, DARTS_REPORTS: path.join(data, 'reports'), FAKE_HOOK_PORT: String(hook), ...env },
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  const h = { n, port, hook, data, logFile, k, t0: Date.now(), exit: null, stopping: false, samples: [], sock: null };
  k.on('exit', (code, sig) => { h.exit = { code, sig, afterMs: Date.now() - h.t0, byUs: h.stopping }; });
  hubs.push(h);
  const up = await until(() => getJson(`http://127.0.0.1:${port}/api/history`).then(() => true), 15000);
  if (!up) throw new Error(`hub ${n} did not come up (exit ${JSON.stringify(h.exit)}) - see ${logFile}`);
  // /stats every 100 ms: the radio, the scans and connects the binding saw,
  // and how many stateChange listeners noble carries.
  (async () => {
    while (!h.stopping && !h.exit) {
      try {
        const s = await stats(h);
        h.samples.push({ t: Date.now(), radio: s.radio, scans: s.scansStarted, connects: s.connects, listeners: s.stateChangeListeners, instances: s.instances });
      } catch (_) {}
      await wait(100);
    }
  })();
  return h;
}
const stats = (h) => getJson(`http://127.0.0.1:${h.hook}/stats`);
const radio = (h, state) => getJson(`http://127.0.0.1:${h.hook}/radio?state=${encodeURIComponent(state)}`);
const alive = (h) => { if (h.exit) return false; try { process.kill(h.k.pid, 0); return true; } catch (_) { return false; } };

async function stopHub(h) {
  if (h.sock) { try { h.sock.s.close(); } catch (_) {} }
  h.stopping = true;
  if (h.exit) return;
  h.k.kill('SIGTERM');
  if (!(await until(() => h.exit, 5000))) { h.k.kill('SIGKILL'); await until(() => h.exit, 3000); }
}

/* The hub as staff see it: every board status, in order, with when it landed. */
function watch(h) {
  return new Promise((resolve, reject) => {
    const s = io(`http://127.0.0.1:${h.port}`, { transports: ['websocket'] });
    const w = { s, last: null, b: {}, log: [], toasts: [], packets: [] };
    s.on('state', (st) => {
      w.last = st;
      const b = st.board || {};
      const p = w.b;
      w.b = b;
      if (!w.log.length || p.state !== b.state || p.detail !== b.detail || p.hint !== b.hint) {
        w.log.push({ t: Date.now(), state: b.state, detail: b.detail || '', hint: b.hint || '' });
      }
    });
    s.on('toast', (t) => w.toasts.push(t.text));
    s.on('boardpacket', () => w.packets.push(Date.now()));      // every packet the board sends
    s.on('connect', () => s.emit('unlock', '1234', (r) => {
      if (r && r.ok) { h.sock = w; resolve(w); } else reject(new Error('the staff PIN 1234 was refused'));
    }));
    setTimeout(() => reject(new Error(`no socket.io connection to hub ${h.n}`)), 10000);
  });
}
const connected = (w) => () => w.b.state === 'connected';
// The statuses on screen between t1 and t2, each with how long it stayed there.
function shown(w, t1, t2 = Date.now()) {
  const out = [];
  for (let i = 0; i < w.log.length; i++) {
    const start = w.log[i].t, end = i + 1 < w.log.length ? w.log[i + 1].t : Infinity;
    if (end <= t1 || start > t2) continue;
    out.push({ ...w.log[i], dwell: Math.min(end, t2) - Math.max(start, t1) });
  }
  return out;
}
const brief = (e) => `${e.state}: ${e.detail}`.slice(0, 110);

/* radioboard's own console lines: "[radio +1.3s] binding start() ..." */
function radioLog(h) {
  return fs.readFileSync(h.logFile, 'utf8').split('\n').map((l) => {
    const m = /^\[radio \+([\d.]+)s\] (.*)$/.exec(l);
    return m ? { at: Number(m[1]) * 1000, msg: m[2] } : null;
  }).filter(Boolean);
}
function crashLines(h) {
  return fs.readFileSync(h.logFile, 'utf8').split('\n')
    .filter((l) => /Uncaught|TypeError|ReferenceError|RangeError|SyntaxError|^\s+at .+:\d+:\d+\)?$/.test(l)).slice(0, 6);
}

/* Every case: its own hub(s); afterwards the invariants every hub must hold. */
async function runCase(n, title, fn) {
  const tag = `[${n}]`;
  const ok = (l, good, x) => check(`${tag} ${l}`, good, x);
  const t = Date.now();
  try {
    await fn(ok);
  } catch (e) {
    ok(`ran to the end (${title})`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  for (const h of hubs.filter((x) => x.n === n)) {
    ok('the hub process stayed up for the whole case', alive(h), h.exit);
    const max = Math.max(0, ...h.samples.map((s) => s.listeners));
    ok('never more than one stateChange listener on noble (no leak)', max === 1, { max, samples: h.samples.length });
    await stopHub(h);
    const bad = crashLines(h);
    ok('no uncaught error or stack trace in the hub\'s console', bad.length === 0, bad.length ? bad : undefined);
  }
  console.log(`      ${tag} ${title}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

/* Shared shape of the boot cases: the radio script runs, nobody touches anything. */
async function bootCase(ok, n, { radioScript, settings, env = {}, expectWhileWaiting, connectWithinMs }) {
  const h = await startHub(n, { settings, env: { FAKE_RADIO: radioScript, ...env } });
  const w = await watch(h);
  const got = await until(connected(w), connectWithinMs);
  const st = await stats(h);
  ok(`connected by itself, nothing pressed (${((Date.now() - h.t0) / 1000).toFixed(1)} s after start)`, !!got && st.connected.includes(BOARD),
    got ? undefined : { board: brief(w.b), radio: st.radio, scans: st.scansStarted });
  ok('connected to THIS oche\'s board', w.last.board.uuid === BOARD, w.last.board.uuid);
  // Scans: the binding only ever asked while the radio was on, and the
  // first one only after the radio came on.
  const L = radioLog(h);
  const onAt = (L.find((e) => /emits stateChange poweredOn$/.test(e.msg)) || {}).at;
  const scans = L.filter((e) => /^binding startScanning/.test(e.msg));
  ok('scanning started only once the radio was on',
    scans.length > 0 && onAt !== undefined && scans.every((e) => /radio poweredOn\)/.test(e.msg) && e.at >= onAt),
    { radioOnAt: onAt, scans: scans.map((e) => `${e.at}:${e.msg}`) });
  const preOn = h.samples.filter((s) => s.radio !== 'poweredOn');
  ok('no scan and no connect while the radio was not on (sampled /stats)',
    preOn.length > 0 && preOn.every((s) => s.scans === 0 && s.connects === 0), { samplesBeforeOn: preOn.length, bad: preOn.filter((s) => s.scans || s.connects).slice(0, 2) });
  // What staff saw while waiting: a plain "waiting / Bluetooth off" - never
  // an error, never a search that cannot work.
  const firstOn = (h.samples.find((s) => s.radio === 'poweredOn') || {}).t || Date.now();
  const before = shown(w, 0, firstOn);
  ok('while the radio was not on the card said waiting / Bluetooth off - no error, no searching',
    before.length > 0 && before.every((e) => e.state === 'idle' || e.state === 'off') && before.every((e) => !/error|could not/i.test(e.detail)),
    before.map(brief));
  if (expectWhileWaiting) {
    ok(`...and said so in words: ${expectWhileWaiting.label}`, before.some((e) => expectWhileWaiting.re.test(`${e.state}: ${e.detail}`)), before.map(brief));
  }
  ok('exactly one stateChange listener from the hub on noble', st.stateChangeListeners === 1, st.stateChangeListeners);
  return { h, w, st };
}

/* ------------------------------------------------------------ cases --- */
const CASES = {
  1: ['boot: radio unknown -> poweredOff -> poweredOn', async (ok) => {
    await bootCase(ok, 1, {
      radioScript: '300:unknown,1200:poweredOff,4000:poweredOn',
      settings: remembered,
      expectWhileWaiting: { label: '"Bluetooth is off" while it was off', re: /^off: Bluetooth is off/ },
      connectWithinMs: 15000,
    });
  }],

  2: ['boot: radio unknown -> unsupported -> poweredOn (first start, no board remembered yet)', async (ok) => {
    const { h, w } = await bootCase(ok, 2, {
      radioScript: '300:unknown,1200:unsupported,4000:poweredOn',
      settings: null,
      expectWhileWaiting: { label: '"no Bluetooth adapter yet" while unsupported', re: /^off: no Bluetooth adapter yet/ },
      connectWithinMs: 18000,
    });
    // The only board in range was picked by the hub - and is remembered.
    const saved = await until(() => {
      const s = JSON.parse(fs.readFileSync(path.join(h.data, 'settings.json'), 'utf8'));
      return s.boardUuid === BOARD ? s : null;
    }, 3000);
    ok('the board it picked by itself is remembered for every restart (settings.json)',
      !!saved && saved.boardMeta && saved.boardMeta.source === 'auto', saved && { boardUuid: saved.boardUuid, meta: saved.boardMeta });
    ok('...and the staff console shows it as this oche\'s board', w.last.settings.boardUuid === BOARD, w.last.settings.boardMeta);
  }],

  3: ['boot: radio says nothing for 10 s, then poweredOn (board hard-coded with DARTBOARD=)', async (ok) => {
    const { h, w } = await bootCase(ok, 3, {
      radioScript: '10000:poweredOn',
      settings: null,
      env: { DARTBOARD: 'AA:BB:CC:DD:EE:FF' },
      expectWhileWaiting: { label: '"waiting for Bluetooth to start" all along', re: /^idle: waiting for Bluetooth to start/ },
      connectWithinMs: 25000,
    });
    const L = radioLog(h);
    const startAt = (L.find((e) => /binding start\(\)/.test(e.msg)) || {}).at;
    const onAt = (L.find((e) => /emits stateChange poweredOn$/.test(e.msg)) || {}).at;
    ok('(precondition) the radio really stayed silent for ~10 s', startAt !== undefined && onAt - startAt >= 9500, { startAt, onAt });
    const waited = shown(w, 0, h.samples.find((s) => s.radio === 'poweredOn').t);
    ok('the hub never gave up or went to an error while it waited', waited.every((e) => e.state === 'idle'), waited.map(brief));
    ok('board fixed by settings.ini', w.last.settings.boardFixed === true && w.last.settings.boardUuid === BOARD, w.last.settings.boardMeta);
  }],

  4: ['Bluetooth off (twice) and on under a live link', async (ok) => {
    const h = await startHub(4, { settings: remembered, env: { FAKE_RADIO: '300:poweredOn' } });
    const w = await watch(h);
    ok('(set-up) connected', !!(await until(connected(w), 15000)), brief(w.b));
    ok('(set-up) darts arriving', !!(await until(() => w.packets.length > 0, 6000)));
    const s0 = await stats(h);
    await radio(h, 'poweredOff');
    const tOff = Date.now();      // the hook answers once the binding has emitted the change
    const off = await until(() => w.b.state === 'off', 3000);
    ok('the card goes to "Bluetooth off" at once', !!off && /Bluetooth is off/.test(w.b.detail), brief(w.b));
    await wait(1200);
    const sAgain = await radio(h, 'poweredOff!');       // WinRT: Off then Disabled, both "poweredOff"
    ok('(precondition) the radio reported poweredOff a second time', sAgain.states.filter((x) => x.s === 'poweredOff').length === 2, sAgain.states);
    await wait(Math.max(0, tOff + 5500 - Date.now())); // past the 3 s retry a dropped link schedules
    const s1 = await stats(h);
    const tOn = Date.now();
    const during = shown(w, tOff, tOn);
    const settled = during.filter((e) => e.t >= tOff + 300 || e.dwell >= 250);
    ok('Bluetooth off the whole time the radio was off (state "off" on the card)',
      settled.length > 0 && settled.every((e) => e.state === 'off'), during.map((e) => `${brief(e)} [${e.dwell} ms]`));
    const blame = during.filter((e) => e.dwell >= 250 && /dropped the link|batter/i.test(`${e.detail} ${e.hint}`));
    ok('never "the board dropped the link" / batteries on the card or the TV footer (it prints the detail when off) while it was only the radio',
      blame.length === 0, blame.map((e) => `${brief(e)} [${e.dwell} ms]`));
    const offEntry = settled[settled.length - 1] || {};
    ok('the hint says it reconnects by itself when Bluetooth is back',
      /connects by itself/.test(offEntry.hint || '') && !/batter/i.test(offEntry.hint || ''), offEntry.hint);
    ok('no connect attempts and no scans while the radio was off', s1.connects === s0.connects && s1.scansStarted === s0.scansStarted,
      { connects: [s0.connects, s1.connects], scans: [s0.scansStarted, s1.scansStarted] });
    ok('the hub survived the repeated poweredOff', alive(h));
    await radio(h, 'poweredOn');
    const back = await until(connected(w), 12000);
    ok(`reconnects by itself when Bluetooth is back on (${((Date.now() - tOn) / 1000).toFixed(1)} s)`, !!back, brief(w.b));
    const tBack = Date.now();
    ok('...and darts arrive again', !!(await until(() => w.packets.some((t) => t > tBack), 6000)), { packets: w.packets.length });
    const s2 = await stats(h);
    ok('one stateChange listener after the radio cycled', s2.stateChangeListeners === 1, s2.stateChangeListeners);
  }],

  5: ['radio off/on (and a quick flap) while still SCANNING for a board not advertising yet', async (ok) => {
    const h = await startHub(5, { settings: remembered, env: { FAKE_RADIO: '300:poweredOn', FAKE_ADVERTISE_FROM_MS: '16000' } });
    const w = await watch(h);
    ok('(set-up) scanning', !!(await until(() => w.b.state === 'scanning', 10000)), brief(w.b));
    let s = await stats(h);
    const scans0 = s.scansStarted;
    await radio(h, 'poweredOff');
    ok('radio off mid-scan: the card says Bluetooth off', !!(await until(() => w.b.state === 'off', 3000)), brief(w.b));
    await wait(1500);
    ok('...and the hub is still running', alive(h));
    await radio(h, 'poweredOn');
    const rescan = await until(async () => w.b.state === 'scanning' && (await stats(h)).scansStarted > scans0, 6000);
    ok('radio back: the search starts again by itself', !!rescan, brief(w.b));
    s = await stats(h);
    const scans1 = s.scansStarted;
    // A flap, and a second one landing inside the hub's 1.5 s "radio just
    // came on" pause before it scans.
    await radio(h, 'poweredOff');
    await wait(150);
    await radio(h, 'poweredOn');
    await wait(600);
    await radio(h, 'poweredOff');
    await wait(150);
    await radio(h, 'poweredOn');
    const rescan2 = await until(async () => w.b.state === 'scanning' && (await stats(h)).scansStarted > scans1, 6000);
    ok('off/on flaps of 150 ms (one inside the pause before the scan): the search starts again too', !!rescan2, brief(w.b));
    ok('(precondition) the board was not advertising yet through all of that', w.b.state !== 'connected' && !w.log.some((e) => e.state === 'connected'));
    const got = await until(connected(w), 20000);
    ok(`connects once the board advertises (${((Date.now() - h.t0) / 1000).toFixed(1)} s after start)`, !!got, brief(w.b));
    const errs = w.log.filter((e) => e.state === 'error');
    ok('no error status at any point', errs.length === 0, errs.map(brief));
  }],

  6: ['a scan the adapter aborts at boot (radio "on" but not really up)', async (ok) => {
    const h = await startHub(6, { settings: remembered, env: { FAKE_RADIO: '300:poweredOn', FAKE_SCAN_ABORT_UNTIL_MS: '3000' } });
    const w = await watch(h);
    const got = await until(connected(w), 30000);
    const secs = (Date.now() - h.t0) / 1000;
    const L = radioLog(h);
    const aborted = L.filter((e) => /ABORTED/.test(e.msg));
    ok('(precondition) the first scan really was aborted by the adapter', aborted.length >= 1, L.filter((e) => /Scanning|ABORTED/.test(e.msg)).map((e) => `${e.at}:${e.msg}`));
    ok(`connected ${secs.toFixed(1)} s after start - well before the old 45 s scan restart`, !!got && secs < 20, brief(w.b));
    const st = await stats(h);
    ok('the aborted scan was restarted by the hub', st.scansStarted >= 2, { scans: st.scansStarted, stops: st.scanStops });
    const errs = w.log.filter((e) => e.state === 'error');
    ok('no error status at any point', errs.length === 0, errs.map(brief));
  }],

  7: ['the Bluetooth stack refuses to start once (binding start() throws)', async (ok) => {
    const h = await startHub(7, { settings: remembered, env: { FAKE_RADIO: '300:poweredOn', FAKE_START_THROW: '1', FAKE_START_THROW_TIMES: '1' } });
    const w = await watch(h);
    const got = await until(connected(w), 25000);
    ok(`connected by itself (${((Date.now() - h.t0) / 1000).toFixed(1)} s after start)`, !!got, brief(w.b));
    const L = radioLog(h);
    ok('(precondition) start() really threw', L.some((e) => /start\(\) THROWS/.test(e.msg)), L.slice(0, 4).map((e) => e.msg));
    const st = await stats(h);
    ok('took a FRESH noble instance and started it', st.instances === 2 && st.startCalls === 2, { instances: st.instances, startCalls: st.startCalls });
    ok('...on which it holds exactly one stateChange listener', st.stateChangeListeners === 1, st.stateChangeListeners);
    ok('the card said Bluetooth was not ready yet (and that it is trying again)',
      w.log.some((e) => /not ready yet/.test(e.detail)), w.log.slice(0, 4).map(brief));
    ok('the hub stayed up through the throw', alive(h));
  }],

  8: ['staff Disconnect / Power off win over the radio coming back', async (ok) => {
    const h = await startHub(8, { settings: remembered, env: { FAKE_RADIO: '300:poweredOn' } });
    const w = await watch(h);
    const emit = (ev, ...a) => w.s.emit(ev, ...a);
    ok('(set-up) connected', !!(await until(connected(w), 15000)), brief(w.b));
    // The hub's 30 s watchdog is armed by its first connect - the moment the
    // binding is started. Each hold below runs past one of its ticks.
    const startAt = (radioLog(h).find((e) => /binding start\(\)/.test(e.msg)) || { at: 1500 }).at;
    const tick = (k) => h.t0 + startAt + k * 30000 + 2500;
    const hold = async (label, untilT) => {
      const s0 = await stats(h);
      const t1 = Date.now();
      await radio(h, 'poweredOff');
      await wait(1000);
      await radio(h, 'poweredOn');
      await wait(Math.max(6000, untilT - Date.now()));
      const s1 = await stats(h);
      const during = shown(w, t1);
      ok(`${label}: no scan and no connect attempt after the radio came back (held ${((Date.now() - t1) / 1000).toFixed(0)} s, past the watchdog)`,
        s1.scansStarted === s0.scansStarted && s1.connects === s0.connects && s1.connected.length === 0,
        { scans: [s0.scansStarted, s1.scansStarted], connects: [s0.connects, s1.connects], linked: s1.connected });
      ok(`${label}: the card stayed "not connected" all along`,
        during.every((e) => e.state === 'idle' || e.state === 'off') && w.b.state === 'idle', during.map(brief));
    };

    emit('boardDisconnect');
    ok('Disconnect: board released', !!(await until(async () => w.b.state === 'idle' && (await stats(h)).connected.length === 0, 4000)), brief(w.b));
    await hold('after Disconnect', tick(1));

    emit('boardConnect');
    ok('Connect brings it back', !!(await until(connected(w), 12000)), brief(w.b));
    emit('powerOff');
    ok('Power off: board released, oche off',
      !!(await until(async () => w.last.powered === false && w.b.state === 'idle' && (await stats(h)).connected.length === 0, 4000)), brief(w.b));
    await hold('after Power off', tick(2));

    const tOn = Date.now();
    emit('powerOn');
    const back = await until(connected(w), 12000);
    ok(`Power on reconnects the board (${((Date.now() - tOn) / 1000).toFixed(1)} s)`, !!back && w.last.powered === true, brief(w.b));

    // Opening time: staff press Power on while Windows' Bluetooth is still off.
    emit('powerOff');
    await until(() => w.last.powered === false && w.b.state === 'idle', 4000);
    await radio(h, 'poweredOff');
    await wait(300);
    emit('powerOn');
    const waiting = await until(() => w.last.powered === true && w.b.state === 'off', 4000);
    ok('Power on while Bluetooth is still off: the card says Bluetooth off (no error)', !!waiting && /Bluetooth is off/.test(w.b.detail), brief(w.b));
    await wait(1500);
    const tRadio = Date.now();
    await radio(h, 'poweredOn');
    const late = await until(connected(w), 12000);
    ok(`...and the board connects by itself once Bluetooth comes on (${((Date.now() - tRadio) / 1000).toFixed(1)} s)`, !!late, brief(w.b));
  }],

  10: ['the radio drops while a slow (WinRT) connect is pending, and that connect completes after the radio is back', async (ok) => {
    // WinRT's FromBluetoothAddressAsync takes seconds and is not cancelled by
    // the radio dropping. noble forgets the board when the radio goes
    // ("cleanup"), so the late answer is "unknown peripheral ... connected!" -
    // and the real binding still opens a GattSession with
    // MaintainConnection(true): Windows holds the board, which stops
    // advertising. The hub must get its board back by itself.
    const h = await startHub(10, { settings: remembered, env: { FAKE_RADIO: '300:poweredOn', FAKE_CONNECT_DELAY_MS: '1500', FAKE_LATE_CONNECT_EVENT: '1' } });
    const w = await watch(h);
    ok('(set-up) the first link is being made', !!(await until(() => w.b.state === 'connecting', 15000, 10)), brief(w.b));
    await radio(h, 'poweredOff');
    await wait(400);
    await radio(h, 'poweredOn');
    const tOn = Date.now();
    const got = await until(connected(w), 20000);
    const st = await stats(h);
    const lines = fs.readFileSync(h.logFile, 'utf8').split('\n');
    const lastOn = lines.map((l, i) => (/emits stateChange poweredOn$/.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const lateAt = lines.findIndex((l) => /unknown peripheral \S+ connected!/.test(l));
    ok('(precondition) the pending connect completed after the radio was back (noble: "unknown peripheral ... connected!")',
      lateAt > lastOn && lastOn >= 0, { lastOn, lateAt, warnings: st.warnings });
    ok(`connects by itself after the radio is back (${got ? `${((Date.now() - tOn) / 1000).toFixed(1)} s` : 'never, in 20 s'})`,
      !!got && w.b.state === 'connected',
      got ? undefined : { card: brief(w.b), bindingStillHoldsBoard: st.connected, hubScanning: st.scanning, scans: st.scansStarted, connects: st.connects });
    if (got) {
      const tBack = Date.now();
      ok('...and darts arrive', !!(await until(() => w.packets.some((t) => t > tBack), 6000)));
    }
  }],
};

(async () => {
  const guard = setTimeout(() => { check('suite finished inside 6 minutes', false); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }, 6 * 60000);
  const only = String(process.env.RADIO_CASES || '').split(',').map(Number).filter(Boolean);
  const want = (n) => !only.length || only.includes(n);
  // Case 8 sits through two watchdog ticks: run it beside the others.
  const long = want(8) ? runCase(8, ...CASES[8]) : null;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 10]) if (want(n)) await runCase(n, ...CASES[n]);
  await long;

  /* 9. The hub never exited by itself, in any case. */
  const exits = hubs.map((h) => ({ hub: h.n, ...h.exit }));
  check('[9] no hub ever exited by itself - every one ran until the suite stopped it',
    hubs.length === Object.keys(CASES).filter((n) => want(Number(n))).length && exits.every((e) => e.byUs), exits.filter((e) => !e.byUs));
  check('[9] every hub shut down cleanly when stopped (exit code 0)', exits.every((e) => e.code === 0), exits.map((e) => `${e.hub}:${e.code}${e.sig ? '/' + e.sig : ''}`));
  clearTimeout(guard);
  console.log(`      total ${((Date.now() - T_START) / 1000).toFixed(0)} s`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
