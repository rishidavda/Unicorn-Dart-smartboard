/*
 * twoboardtest.js - two boards on ONE PC (two copies of the folder, one
 * black window each), as the staff console and the folders show it:
 *   - two cards remembering the SAME dartboard both say so, name the other
 *     card and the button that fixes it - and the warning goes once one of
 *     them has its own board;
 *   - the players' iPad says "board not connected" (not "board off") and the
 *     longer pill still fits the header on every iPad, timer pill showing;
 *   - a board whose PC Bluetooth has not started: the card says so with what
 *     to do (no "press Connect"), and Fix board connection's outcome points
 *     at Windows Bluetooth, never at the board's batteries;
 *   - the folder's .url shortcuts follow the port the hub really runs on
 *     (Board 2's folder opens Board 2's screens); one edited by hand is left
 *     alone;
 *   - a board whose window is closed: its card says to double-click that
 *     board's desktop shortcut;
 *   - no page errors.
 * Ports TPORT (default 9690; uses TPORT..TPORT+3 and TPORT+10).
 * Data and logs under $DARTS_TEST_TMP/twoboard.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'twoboard');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const APP = path.join(path.dirname(SERVER), '..');
const BASE = Number(process.env.TPORT || 9690);
const A = BASE, B = BASE + 1, C = BASE + 2, F = BASE + 3, CHOOK = BASE + 10;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const BOARD = 'aabbccddeeff';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}
const kids = {};
process.on('exit', () => { for (const k of Object.values(kids)) { try { k.kill('SIGKILL'); } catch (_) {} } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
setTimeout(() => { console.log('FAIL  suite timed out'); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }, 5 * 60000).unref();

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_|TAPO_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  return env;
}
function startHub(name, port, settings, { script = 'fakeboard.js', server = SERVER, data = path.join(SP, name), env = {} } = {}) {
  fs.mkdirSync(data, { recursive: true });
  if (settings) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));
  const fd = fs.openSync(path.join(SP, `${name}.log`), 'a');
  const k = spawn(process.execPath, [path.join(HERE, script)], {
    env: { ...cleanEnv(), SERVER_JS: server, PORT: String(port), DARTS_DATA: data, DARTS_REPORTS: path.join(SP, `${name}-reports`), ...env },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  kids[name] = k;
  return until(() => fetch(`http://127.0.0.1:${port}/api/history`).then((r) => r.ok), 20000, 150).then((ok) => { if (!ok) throw new Error(`hub ${name} did not come up`); return k; });
}
async function stopHub(name) {
  const k = kids[name];
  if (!k || k.exitCode !== null) return;
  k.kill('SIGTERM');
  await until(() => k.exitCode !== null || k.signalCode !== null, 5000);
}
function sock(port) {
  return new Promise((resolve, reject) => {
    const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const w = { s, st: null, toasts: [] };
    s.on('state', (x) => { w.st = x; });
    s.on('toast', (t) => w.toasts.push(t.text));
    s.on('connect', () => s.emit('unlock', '1234', (r) => (r && r.ok ? resolve(w) : reject(new Error('PIN refused')))));
    setTimeout(() => reject(new Error(`no socket to ${port}`)), 10000);
  });
}
const base = (name, extra = {}) => ({ adminPin: '1234', autoConnect: true, screensaverMinutes: 0, boardName: name, ...extra });

(async () => {
  fs.rmSync(SP, { recursive: true, force: true });
  fs.mkdirSync(SP, { recursive: true });
  // A: the front oche, its board found at boot. B: the back oche, a copy that
  // still remembers the FRONT board (its own never shows up here).
  // C: a board whose PC Bluetooth never gets past "starting".
  await startHub('hubA', A, base('Front oche', { peers: [`http://127.0.0.1:${B}`, `http://127.0.0.1:${C}`] }));
  await startHub('hubB', B, base('Back oche', { boardUuid: BOARD }), { env: { FAKE_FIRST_ABSENT: '1' } });
  await startHub('hubC', C, base('Side oche'), { script: 'radioboard.js', env: { FAKE_RADIO: '300:unknown', FAKE_HOOK_PORT: String(CHOOK) } });
  const a = await sock(A), b = await sock(B), c = await sock(C);
  check('(set-up) the front board is connected; the back hub searches for the same board', !!(await until(() => a.st && a.st.board.state === 'connected'
    && a.st.settings.boardUuid === BOARD && b.st && b.st.settings.boardUuid === BOARD && b.st.board.state === 'scanning', 15000)),
  { a: a.st && a.st.board.state, b: b.st && b.st.board.state });

  const br = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const staff = await br.newPage({ viewport: { width: 1200, height: 1600 } });
  staff.on('pageerror', (e) => errors.push(`staff: ${e.message}`));
  await staff.goto(`http://127.0.0.1:${A}/staff`);
  await wait(800);
  await staff.keyboard.type('1234');
  const cards = async () => {
    await staff.evaluate(() => document.querySelectorAll('details.more').forEach((d) => { d.open = true; }));
    return staff.evaluate(() => [...document.querySelectorAll('#boards .card')].map((el) => el.textContent.replace(/\s+/g, ' ')));
  };
  const three = await until(async () => { const t = await cards(); return t.length === 3 && /Side oche/.test(t[2]) && t; }, 15000, 300);
  check('(set-up) the console shows all three boards', !!three, three && three.length);

  /* 1. Two cards, one dartboard */
  const twin = await until(async () => {
    const t = await cards();
    return /Back oche has this SAME dartboard/.test(t[0]) && /Front oche has this SAME dartboard/.test(t[1]) && t;
  }, 10000, 300);
  check('both cards remembering one dartboard say so, naming the other card', !!twin, twin ? undefined : (await cards()).map((x) => x.slice(0, 400)));
  check('...and say what to do: throw a dart, Choose a different board on the card whose TV does not score it',
    !!twin && /only one of them can ever have it/.test(twin[1]) && /card whose TV does not score it, press Choose a different board/.test(twin[1]), twin && twin[1].match(/[^.]*SAME dartboard[^]*?tap it\./));
  check('...and the other boards\' cards stay quiet', !!twin && !/SAME dartboard/.test(twin[2]));
  b.s.emit('saveSettings', { boardUuid: '112233445566' });
  const gone = await until(async () => { const t = await cards(); return !t.some((x) => /SAME dartboard/.test(x)) && t; }, 10000, 300);
  check('once the back oche has its own board, the warning goes from both cards', !!gone);
  // A copied folder that fixes the board in settings.ini (DARTBOARD=): that
  // card has no Choose button, so each card says what works for it.
  await stopHub('hubB');
  b.s.close();
  await startHub('hubB', B, null, { env: { FAKE_FIRST_ABSENT: '1', DARTBOARD: 'AA:BB:CC:DD:EE:FF' } });
  const b2 = await sock(B);
  Object.assign(b, b2);
  const fixedTwin = await until(async () => {
    const t = await cards();
    return /Back oche's board is fixed in settings\.ini: if THIS oche's TV does not score it, press Choose a different board here/.test(t[0])
      && /This card's board is fixed in settings\.ini: on the OTHER card press Choose a different board/.test(t[1]) && t;
  }, 20000, 300);
  check('the other card fixes it in settings.ini: this card is told to Choose here; the fixed card is told to use the OTHER card',
    !!fixedTwin, fixedTwin ? undefined : (await cards()).slice(0, 2).map((x) => (x.match(/[^.]*SAME dartboard[^]*?tap it\./) || [x.slice(0, 300)])[0]));

  /* 2. The players' iPad */
  a.s.emit('sessionStart', 60, 'Sam');
  await until(() => a.st.session && a.st.session.mode, 4000);
  a.s.emit('boardDisconnect');
  await until(() => a.st.board.state === 'idle', 4000);
  for (const [label, vw, vh] of [['iPad mini portrait', 744, 1133 - 74], ['iPad mini landscape', 1133, 744 - 74], ['iPad 10.2" portrait', 810, 1080 - 74]]) {
    const ctx = await br.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const pad = await ctx.newPage();
    pad.on('pageerror', (e) => errors.push(`pad: ${e.message}`));
    await pad.goto(`http://127.0.0.1:${A}/pad`);
    const got = await until(() => pad.evaluate(() => {
      const p = document.getElementById('boardpill');
      const s = document.getElementById('sesspill');
      return /board not connected/i.test(p.textContent) && s && !s.hidden && {
        text: p.textContent, sess: s.textContent,
        pillRight: p.getBoundingClientRect().right, pillH: p.getBoundingClientRect().height,
        hubRight: document.getElementById('hubpill').getBoundingClientRect().right,
        headerOver: document.querySelector('header').scrollWidth - document.querySelector('header').clientWidth,
        pageOver: document.documentElement.scrollWidth - innerWidth, vw: innerWidth,
      };
    }), 8000, 200);
    check(`${label}: the iPad says "board not connected" (not "board off") and it fits beside the timer`,
      !!got && got.headerOver <= 0 && got.pageOver <= 0 && got.hubRight <= got.vw && got.pillH < 40, got);
    await ctx.close();
  }
  a.s.emit('boardConnect');
  check('(the front board reconnects)', !!(await until(() => a.st.board.state === 'connected', 10000)));
  // Connected: board ready, battery and timer pills together are the widest
  // header - it used to push the connection pill off an upright iPad mini.
  for (const venue of ['The Winchester', 'The Winchester Arms Darts Club']) {
    a.s.emit('saveSettings', { venueName: venue });
    await until(() => a.st.settings.venueName === venue, 4000);
    for (const [label, vw, vh] of [['iPad mini portrait', 744, 1133 - 74], ['iPad 10.2" portrait', 810, 1080 - 74]]) {
      const ctx = await br.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      const pad = await ctx.newPage();
      pad.on('pageerror', (e) => errors.push(`pad: ${e.message}`));
      await pad.goto(`http://127.0.0.1:${A}/pad`);
      const got = await until(() => pad.evaluate(() => {
        const bp = document.getElementById('battpill');
        if (!/board ready/i.test(document.getElementById('boardpill').textContent) || bp.hidden || document.getElementById('sesspill').hidden) return null;
        const hub = document.getElementById('hubpill').getBoundingClientRect();
        // The venue's logo (a wide wordmark hides the name text) or crest + name.
        const brand = document.getElementById('padbrand').getBoundingClientRect();
        return { hubRight: hub.right, vw: innerWidth, pageOver: document.documentElement.scrollWidth - innerWidth,
          brandW: Math.round(brand.width), brandRight: Math.round(brand.right), sessLeft: Math.round(document.getElementById('sesspill').getBoundingClientRect().left) };
      }), 8000, 200);
      check(`${label}, "${venue}", board connected with battery and timer: every pill stays on screen, the venue's logo still shows`,
        !!got && got.hubRight <= got.vw && got.pageOver <= 0 && got.brandW > 40 && got.brandRight <= got.sessLeft, got);
      await ctx.close();
    }
  }
  a.s.emit('saveSettings', { venueName: 'The Winchester' });

  /* 3. This PC's Bluetooth has not started */
  const cardC = await until(async () => { const t = (await cards())[2]; return /waiting for Bluetooth to start/.test(t) && t; }, 10000, 300);
  check('Bluetooth still starting: the card says so, and does not say "press Connect"', !!cardC && !/press Connect/.test(cardC), cardC && cardC.slice(0, 500));
  check('...with the 💡 what to do if it lasts: Bluetooth OFF, wait 5 seconds, ON; then restart the PC',
    !!cardC && /has not started yet/.test(cardC) && /OFF, wait 5 seconds, ON/.test(cardC) && /restart the PC/.test(cardC), cardC && cardC.slice(0, 700));
  const n0 = c.toasts.length;
  c.s.emit('boardFix');
  const fixSaid = await until(() => c.toasts.slice(n0).find((t) => /still not connected/.test(t)), 20000, 200);
  check('Fix board connection on it: the outcome points at Windows Bluetooth, not at the board\'s batteries',
    !!fixSaid && /Bluetooth on this PC/.test(fixSaid) && /OFF, wait 5 seconds, ON/.test(fixSaid) && !/batter/i.test(fixSaid), c.toasts.slice(n0));

  /* 4. The folder's shortcuts follow the port */
  const folder = path.join(SP, 'Board 2 folder');
  fs.mkdirSync(path.join(folder, 'server'), { recursive: true });
  for (const f of fs.readdirSync(path.dirname(SERVER))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(path.dirname(SERVER), f), path.join(folder, 'server', f));
  }
  fs.symlinkSync(path.join(APP, 'public'), path.join(folder, 'public'));
  fs.symlinkSync(path.join(APP, 'node_modules'), path.join(folder, 'node_modules'));
  const url = (p) => `[InternetShortcut]\r\nURL=http://localhost:8080/${p}\r\n`;
  fs.writeFileSync(path.join(folder, '1 - Winchester Darts (open me).url'), url(''));
  fs.writeFileSync(path.join(folder, '2 - TV screen.url'), '[InternetShortcut]\r\nURL=http://192.168.1.20:8080/tv\r\n');   // edited by hand
  fs.writeFileSync(path.join(folder, '3 - Control panel.url'), url('pad'));
  await startHub('hubF', F, base('Board 2'), { server: path.join(folder, 'server', 'server.js'), data: path.join(folder, 'data') });
  const read = (f) => fs.readFileSync(path.join(folder, f), 'utf8');
  const fixed = await until(() => read('1 - Winchester Darts (open me).url').includes(`localhost:${F}/`), 6000, 200);
  check('the folder\'s "open me" and "Control panel" shortcuts now open THIS board\'s port',
    !!fixed && read('1 - Winchester Darts (open me).url') === `[InternetShortcut]\r\nURL=http://localhost:${F}/\r\n`
    && read('3 - Control panel.url') === `[InternetShortcut]\r\nURL=http://localhost:${F}/pad\r\n`,
    [read('1 - Winchester Darts (open me).url'), read('3 - Control panel.url')]);
  check('...and a shortcut edited by hand is left alone', read('2 - TV screen.url') === '[InternetShortcut]\r\nURL=http://192.168.1.20:8080/tv\r\n', read('2 - TV screen.url'));
  check('...and nothing else was created in the folder', !fs.readdirSync(folder).some((f) => f.endsWith('.url') && !/^[123] - /.test(f)), fs.readdirSync(folder));
  await stopHub('hubF');

  /* 5. A board whose black window is closed */
  await stopHub('hubB');
  const off = await until(async () => { const t = (await cards())[1]; return /offline/.test(t) && t; }, 20000, 500);
  check('a board whose window was closed: its card says to double-click that board\'s desktop shortcut',
    !!off && /reconnecting/.test(off) && /double-click that board's desktop shortcut/.test(off), off && off.slice(0, 300));

  check('no page errors', errors.length === 0, errors);
  await br.close();
  for (const w of [a, b, c]) w.s.close();
  for (const n of Object.keys(kids)) await stopHub(n);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
