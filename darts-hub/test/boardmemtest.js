/* This oche's dartboard: the hub remembers the board it is meant to use and
 * always reconnects to exactly that one - after a restart, after the link
 * drops, with another oche's board in range, with its own board's batteries
 * out. Covers the first start (auto-pick, or "tap one" with two in range),
 * a tap from the staff console, DARTBOARD= in settings.ini (fixed, refusals,
 * nonsense, removed), "Choose a different board" (tap / time out / cancel /
 * double press), a copied versus a moved folder, legacy and malformed
 * settings, and autoConnect off.
 *
 * Boots its own hubs with fakeboard.js (board 1 aabbccddeeff "Unicorn Darts",
 * FAKE_SECOND_BOARD=1 adds 112233445566 "Unicorn Darts 2"). Independent
 * chains run side by side; a chain about restarts reuses one data dir.
 * TPORT = first of 20 ports (hub port + fake-board hook port per chain).
 * Prints "N passed, M failed" last; exit 1 on any failure. ~40 s. */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'boardmem');
fs.mkdirSync(SP, { recursive: true });
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const BASE = Number(process.env.TPORT || 9520);
const A = 'aabbccddeeff';          // this oche's board (fakeboard's first)
const B = '112233445566';          // another oche's board (FAKE_SECOND_BOARD)
const A_ADDR = 'AA:BB:CC:DD:EE:FF';
const B_ADDR = '11:22:33:44:55:66';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const tagged = (tag) => (label, ok, detail) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${label}${!ok && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
};

const kids = new Set();
const killAll = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(1); });

async function until(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    if (Date.now() > end) return null;
    await wait(step);
  }
}
const getJson = (url) => new Promise((res, rej) => {
  const req = http.get(url, (r) => {
    let t = '';
    r.on('data', (d) => { t += d; });
    r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.setTimeout(3000, () => req.destroy(new Error('timeout')));
});
// The hub's own folder identity (server.js FOLDER_ID, as on Linux).
const folderId = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16);
const dirOf = (name) => path.join(SP, name);
function freshDir(name, files = {}) {
  const d = dirOf(name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(v, null, 2));
  try { fs.unlinkSync(path.join(SP, `${name}.log`)); } catch (_) {}
  return d;
}
const readSettings = (name) => JSON.parse(fs.readFileSync(path.join(dirOf(name), 'settings.json'), 'utf8'));
// A board remembered by a tap in THIS folder (what the hub itself writes).
const remembered = (name, id, extra = {}) => ({
  boardUuid: id,
  boardMeta: {
    name: id === A ? 'Unicorn Darts' : 'Unicorn Darts 2', address: id === A ? A_ADDR : B_ADDR, addressType: 'public',
    source: 'tap', at: Date.now() - 86400000, folder: folderId(dirOf(name)), path: path.resolve(dirOf(name)),
  },
  ...extra,
});

/*
 * Boot the real hub on a data dir (fake noble), with a socket that is
 * already knocking before the hub listens - so a toast sent the moment the
 * board is ready is not missed - and unlocked with the staff PIN.
 */
async function boot(name, slot, env = {}) {
  const port = BASE + slot * 2;
  const hook = port + 1;
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTBOARD$|DARTS_BROWSE_MS$|WINCHESTER_|DAILY_RESTART$|PORT$|DARTS_DATA$)/.test(k)) continue;
    childEnv[k] = v;
  }
  Object.assign(childEnv, { SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: dirOf(name), FAKE_HOOK_PORT: String(hook) });
  for (const [k, v] of Object.entries(env)) childEnv[k] = String(v);
  const logFd = fs.openSync(path.join(SP, `${name}.log`), 'a');
  fs.writeSync(logFd, `\n==== boot ${new Date().toISOString()} ${JSON.stringify(env)}\n`);
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], { env: childEnv, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  kids.add(k);
  k.on('exit', () => kids.delete(k));
  const h = { name, port, hook, k, st: null, toasts: [], exited: false, bootAt: Date.now() };
  k.on('exit', () => { h.exited = true; });
  h.s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnectionDelay: 100, reconnectionDelayMax: 250, timeout: 3000 });
  h.s.on('state', (x) => { h.st = x; });
  h.s.on('toast', (t) => h.toasts.push(t && t.text));
  h.s.on('connect', () => h.s.emit('unlock', '1234', () => { h.unlocked = true; }));
  const up = await until(() => h.st && h.unlocked, 15000, 50);
  if (!up) throw new Error(`hub ${name} did not come up on ${port} (see ${path.join(SP, name + '.log')})`);
  return h;
}
async function halt(h) {
  try { h.s.close(); } catch (_) {}
  if (h.exited) return;
  const gone = new Promise((r) => h.k.once('exit', r));
  h.k.kill('SIGINT');
  const t = setTimeout(() => { try { h.k.kill('SIGKILL'); } catch (_) {} }, 6000);
  await gone;
  clearTimeout(t);
  await wait(200);
}
const stats = (h) => getJson(`http://127.0.0.1:${h.hook}/stats`);
const on = (h, id) => !!h.st && h.st.board.state === 'connected' && h.st.board.uuid === id;
const bd = (h) => (h.st ? { state: h.st.board.state, detail: h.st.board.detail, uuid: h.st.board.uuid, hint: h.st.board.hint, browsing: h.st.board.browsing } : null);
const seenIds = (h) => ((h.st && h.st.board.discovered) || []).map((d) => d.uuid);
const toast = (h, re) => h.toasts.find((t) => re.test(t || ''));
const ack = (h, ev, ...args) => new Promise((r) => {
  const t = setTimeout(() => r({ timeout: true }), 4000);
  h.s.emit(ev, ...args, (x) => { clearTimeout(t); r(x); });
});

/* ---------- 1-4: the board picked at first start, kept for good ---------- */
async function chainOwn() {
  const N = 'bm-own';
  freshDir(N);
  let check = tagged(1);
  let h = await boot(N, 0);
  check('first start, one board in range: connects to it', !!(await until(() => on(h, A), 12000)), bd(h));
  const sf = await until(() => { const s = readSettings(N); return s.boardUuid === A ? s : null; }, 3000);
  check('settings.json remembers it: boardUuid aabbccddeeff', !!sf, sf && sf.boardUuid);
  const m = (sf && sf.boardMeta) || {};
  check('...with boardMeta.source "auto"', m.source === 'auto', m);
  check('...name, address, and this data dir stamped on disk', m.name === 'Unicorn Darts' && m.address === A_ADDR
    && m.path === path.resolve(dirOf(N)) && m.folder === folderId(dirOf(N)), m);
  check('a toast says it was remembered', !!(await until(() => toast(h, /DD:EE:FF remembered/), 3000)), h.toasts);
  await until(() => h.st.settings.boardMeta, 2000);
  const vm = h.st.settings.boardMeta || {};
  check('state.settings.boardMeta: name, address AA:BB:CC:DD:EE:FF, source', vm.name === 'Unicorn Darts' && vm.address === A_ADDR && vm.source === 'auto', vm);
  check('...and no "path" (or folder) sent to the screens', vm && !('path' in vm) && !('folder' in vm), Object.keys(vm));
  check('state.settings.boardUuid and boardFixed false', h.st.settings.boardUuid === A && h.st.settings.boardFixed === false, h.st.settings);
  await halt(h);

  check = tagged(2);
  h = await boot(N, 0, { FAKE_SECOND_BOARD: 1 });
  check('restart with another board in range: reconnects to aabbccddeeff', !!(await until(() => on(h, A), 10000)), bd(h));
  await wait(3000);
  let f = await stats(h);
  check('the other board saw 0 connect attempts', f.boards[1].attempts === 0 && !f.boards[1].connected, f.boards[1]);
  check('still on its own board 3 s later', on(h, A) && f.boards[0].connected, bd(h));
  check('remembered as before (source still auto), no second "remembered" toast',
    h.st.settings.boardMeta && h.st.settings.boardMeta.source === 'auto' && !toast(h, /remembered/), { meta: h.st.settings.boardMeta, toasts: h.toasts });
  await halt(h);

  check = tagged(3);
  h = await boot(N, 0, { FAKE_FIRST_ABSENT: 1, FAKE_SECOND_BOARD: 1 });
  const t0 = Date.now();
  let everOn = null;
  while (Date.now() - t0 < 20000) {
    if (h.st && (h.st.board.state === 'connected' || h.st.board.state === 'connecting' || h.st.board.uuid)) everOn = everOn || bd(h);
    await wait(200);
  }
  f = await stats(h);
  check('own board batteries out, another in range: never connects to anything for 20 s', !everOn && f.connectAttempts === 0, { everOn, connectAttempts: f.connectAttempts });
  check('...never touches 112233445566', f.boards[1].attempts === 0 && !f.boards[1].connected, f.boards[1]);
  check('...the other board WAS seen (so it really was left alone)', seenIds(h).includes(B), seenIds(h));
  check('still searching for its own board (…DD:EE:FF)', h.st.board.state === 'scanning' && /…DD:EE:FF/.test(h.st.board.detail || ''), bd(h));
  const hint = await until(() => (/other dartboard/.test(h.st.board.hint || '') ? h.st.board.hint : null), 6000);
  check('staff hint mentions the other dartboard in range', !!hint, bd(h));
  check('...and "Choose a different board"', /Choose a different board/.test(hint || ''), hint);
  check('...and names its own board', /…DD:EE:FF/.test(hint || ''), hint);
  check('settings.json still remembers aabbccddeeff', readSettings(N).boardUuid === A, readSettings(N).boardUuid);
  await halt(h);

  check = tagged(4);
  h = await boot(N, 0, { FAKE_SECOND_BOARD: 1 });
  check('(set-up) connected to its own board, second in range', !!(await until(() => on(h, A), 10000)), bd(h));
  await getJson(`http://127.0.0.1:${h.hook}/drop?board=0`);
  check('the board drops the link: the hub notices', !!(await until(() => !on(h, A), 3000, 50)), bd(h));
  check('...and comes back to aabbccddeeff', !!(await until(() => on(h, A), 12000)), bd(h));
  await wait(1500);
  f = await stats(h);
  check('...never trying 112233445566', f.boards[1].attempts === 0 && f.boards[0].attempts === 2, f.boards.map((b) => ({ uuid: b.uuid, attempts: b.attempts })));
  await halt(h);
}

/* 4b: a board picked by itself THIS run is the one a drop goes back to,
 * even when another board shows up later. */
async function chainAutoDrop(slot) {
  const N = 'bm-autodrop';
  freshDir(N);
  const check = tagged('4b');
  const h = await boot(N, slot, { FAKE_SECOND_BOARD: 1, FAKE_SECOND_AFTER_MS: 7000 });
  check('first start: the only board on air is picked', !!(await until(() => on(h, A), 10000)), bd(h));
  await until(() => Date.now() - h.bootAt > 8000, 10000, 200);
  await getJson(`http://127.0.0.1:${h.hook}/drop?board=0`);
  await until(() => !on(h, A), 3000, 50);
  check('a drop after another board came on air: back to aabbccddeeff', !!(await until(() => on(h, A), 12000)), bd(h));
  await wait(1500);
  const f = await stats(h);
  check('...the newcomer was seen but never tried', seenIds(h).includes(B) && f.boards[1].attempts === 0, { seen: seenIds(h), b: f.boards[1] });
  await halt(h);
}

/* ---------- 5, 7, 6b: two boards at first start; a tap; ini over a tap ---------- */
async function chainTwo() {
  const N = 'bm-two';
  freshDir(N);
  let check = tagged(5);
  let h = await boot(N, 1, { FAKE_SECOND_BOARD: 1 });
  check('first start, two boards, nothing remembered: says to tap one',
    !!(await until(() => /2 dartboards in range/.test(h.st.board.detail || ''), 9000)), bd(h));
  check('...staff hint: tap THIS oche\'s board', /Tap THIS oche's board/.test(h.st.board.hint || ''), bd(h));
  await wait(3000);
  let f = await stats(h);
  check('...connects to neither', f.connectAttempts === 0 && h.st.board.state === 'scanning' && !h.st.board.uuid, { f, b: bd(h) });
  check('...remembers nothing', !readSettings(N).boardUuid && !h.st.settings.boardUuid, readSettings(N).boardUuid);
  const r = await ack(h, 'boardChoose', B_ADDR);
  check('boardChoose("11:22:33:44:55:66") is accepted', r && r.ok === true, r);
  check('...connects to 112233445566', !!(await until(() => on(h, B), 8000)), bd(h));
  const sf = readSettings(N);
  check('...remembered with source "tap"', sf.boardUuid === B && sf.boardMeta && sf.boardMeta.source === 'tap'
    && sf.boardMeta.address === B_ADDR && sf.boardMeta.name === 'Unicorn Darts 2', sf.boardMeta);
  check('...toast: chosen and remembered', !!toast(h, /chosen and remembered/), h.toasts);
  f = await stats(h);
  check('...board 1 never tried', f.boards[0].attempts === 0, f.boards[0]);
  await halt(h);
  h = await boot(N, 1, { FAKE_SECOND_BOARD: 1 });
  check('restart: reconnects to the tapped board 112233445566', !!(await until(() => on(h, B), 10000)), bd(h));
  await wait(1500);
  f = await stats(h);
  check('...board 1 never tried', f.boards[0].attempts === 0, f.boards[0]);
  await halt(h);

  check = tagged(7);
  h = await boot(N, 1, { FAKE_SECOND_BOARD: 1, DARTBOARD: 'nonsense' });
  const w = (h.st.warnings || []).find((x) => /DARTBOARD=nonsense/.test(x));
  check('DARTBOARD=nonsense: a staff warning in state.warnings', !!w, h.st.warnings);
  check('...the remembered board is still used', !!(await until(() => on(h, B), 10000)), bd(h));
  f = await stats(h);
  check('...board 1 never tried; not fixed; still "tap" on disk', f.boards[0].attempts === 0 && h.st.settings.boardFixed === false
    && readSettings(N).boardUuid === B && readSettings(N).boardMeta.source === 'tap', { b0: f.boards[0], fixed: h.st.settings.boardFixed, meta: readSettings(N).boardMeta });
  await halt(h);
  h = await boot(N, 1, { FAKE_SECOND_BOARD: 1, DARTBOARD: 'auto' });
  check('DARTBOARD=auto: no warning, not fixed, the remembered board used', !(h.st.warnings || []).some((x) => /DARTBOARD/.test(x))
    && h.st.settings.boardFixed === false && !!(await until(() => on(h, B), 10000)), { w: h.st.warnings, b: bd(h) });
  await halt(h);

  check = tagged('6b');
  h = await boot(N, 1, { FAKE_SECOND_BOARD: 1, DARTBOARD: 'aa-bb-cc-dd-ee-ff' });
  check('DARTBOARD= wins over a tapped board: connects to aabbccddeeff', !!(await until(() => on(h, A), 10000)), bd(h));
  f = await stats(h);
  check('...112233445566 not tried this run; settings.json now holds the ini board',
    f.boards[1].attempts === 0 && readSettings(N).boardUuid === A && readSettings(N).boardMeta.source === 'ini',
    { b1: f.boards[1], s: readSettings(N).boardMeta });
  check('...no warning about the DARTBOARD line', !(h.st.warnings || []).some((x) => /DARTBOARD/.test(x)), h.st.warnings);
  await halt(h);
}

/* ---------- 6, 8: DARTBOARD= fixes the board; removed, it stays remembered ---------- */
async function chainIni() {
  const N = 'bm-ini';
  freshDir(N);
  let check = tagged(6);
  let h = await boot(N, 2, { FAKE_SECOND_BOARD: 1, DARTBOARD: 'AA:BB:CC:DD:EE:FF ; trailing comment' });
  check('DARTBOARD with a trailing comment: connects to aabbccddeeff', !!(await until(() => on(h, A), 10000)), bd(h));
  check('state.settings.boardFixed true, boardMeta.source "ini"', h.st.settings.boardFixed === true
    && h.st.settings.boardMeta && h.st.settings.boardMeta.source === 'ini' && h.st.settings.boardMeta.address === A_ADDR, h.st.settings.boardMeta);
  let sf = readSettings(N);
  check('settings.json holds it', sf.boardUuid === A && sf.boardMeta && sf.boardMeta.source === 'ini', { u: sf.boardUuid, m: sf.boardMeta });
  check('no warning for a good DARTBOARD line', !(h.st.warnings || []).some((x) => /DARTBOARD/.test(x)), h.st.warnings);
  h.toasts.length = 0;
  const r = await ack(h, 'boardChoose', B);
  check('boardChoose("112233445566") refused: ack {ok:false, fixed:true}', r && r.ok === false && r.fixed === true, r);
  check('...with a toast pointing at settings.ini', !!(await until(() => toast(h, /fixed in settings\.ini/), 2000)), h.toasts);
  h.toasts.length = 0;
  h.s.emit('saveSettings', { boardUuid: B });
  check('saveSettings {boardUuid:"112233445566"} refused with a toast', !!(await until(() => toast(h, /fixed in settings\.ini/), 2000)), h.toasts);
  h.toasts.length = 0;
  h.s.emit('boardBrowse');
  check('boardBrowse refused with a toast', !!(await until(() => toast(h, /fixed in settings\.ini/), 2000)), h.toasts);
  await wait(2500);
  const f = await stats(h);
  sf = readSettings(N);
  check('...after all three: still on aabbccddeeff, not browsing, 112233445566 never tried',
    on(h, A) && !h.st.board.browsing && f.boards[1].attempts === 0 && f.boards[0].attempts === 1, { b: bd(h), b1: f.boards[1], b0: f.boards[0] });
  check('...settings.json and the screens unchanged', sf.boardUuid === A && sf.boardMeta.source === 'ini'
    && h.st.settings.boardUuid === A && h.st.settings.boardFixed === true, { u: sf.boardUuid, m: sf.boardMeta });
  await halt(h);

  check = tagged(8);
  h = await boot(N, 2, { FAKE_SECOND_BOARD: 1 });
  check('DARTBOARD line removed: still reconnects to aabbccddeeff', !!(await until(() => on(h, A), 10000)), bd(h));
  sf = readSettings(N);
  check('...still remembered on disk, source no longer "ini"', sf.boardUuid === A && sf.boardMeta && sf.boardMeta.source !== 'ini', sf.boardMeta);
  check('...boardFixed false on the screens', h.st.settings.boardFixed === false && h.st.settings.boardUuid === A
    && h.st.settings.boardMeta && h.st.settings.boardMeta.source !== 'ini', h.st.settings);
  await wait(1000);
  const f8 = await stats(h);
  check('...112233445566 never tried', f8.boards[1].attempts === 0, f8.boards[1]);
  await halt(h);
}

/* ---------- 9: Choose a different board ---------- */
async function chainBrowse() {
  const N = 'bm-browse';
  freshDir(N, { 'settings.json': remembered(N, A) });
  let check = tagged('9c');
  const h = await boot(N, 3, { FAKE_SECOND_BOARD: 1, DARTS_BROWSE_MS: 8000 });
  check('(set-up) on the remembered board', !!(await until(() => on(h, A), 10000)), bd(h));
  let f = await stats(h);
  const c0 = f.connectAttempts;
  let tb = Date.now();
  h.s.emit('boardBrowse');
  check('boardBrowse: browsing, the board released', !!(await until(() => h.st.board.browsing && !h.st.board.uuid, 2000, 50)), bd(h));
  f = await stats(h);
  check('...the fake board really let go', !f.boards[0].connected, f.boards[0]);
  check('...lists both devices', !!(await until(() => seenIds(h).includes(A) && seenIds(h).includes(B), 6000)), seenIds(h));
  const lst = (h.st.board.discovered || []).find((d) => d.uuid === B) || {};
  check('...with name, signal and address type', lst.name === 'Unicorn Darts 2' && lst.rssi === -60 && lst.addressType === 'public', lst);
  check('...staff hint says tap THIS oche\'s dartboard', /Tap THIS oche's dartboard/.test(h.st.board.hint || ''), bd(h));
  await until(() => Date.now() - tb > 5000, 6000, 100);
  f = await stats(h);
  check('...connects to nothing while choosing', f.connectAttempts === c0 && !h.st.board.uuid, { c0, now: f.connectAttempts, b: bd(h) });
  h.s.emit('boardBrowseCancel');
  const tc = Date.now();
  check('boardBrowseCancel: back to aabbccddeeff at once', !!(await until(() => on(h, A), 2500, 50)), { b: bd(h), ms: Date.now() - tc });
  check('...well before the 8 s choosing time ran out', Date.now() - tb < 7900 && !h.st.board.browsing, { ms: Date.now() - tb });

  check = tagged('9a');
  await wait(3000);                   // past the "just released" pause
  tb = Date.now();
  h.s.emit('boardBrowse');
  check('(set-up) choosing again, other board listed', !!(await until(() => h.st.board.browsing && seenIds(h).includes(B), 6000)), bd(h));
  const r = await ack(h, 'boardChoose', B);
  check('boardChoose of the second board accepted', r && r.ok === true, r);
  check('...connects to 112233445566', !!(await until(() => on(h, B), 8000)), bd(h));
  const sf = readSettings(N);
  check('...and remembers it (source tap, its name)', sf.boardUuid === B && sf.boardMeta.source === 'tap' && sf.boardMeta.name === 'Unicorn Darts 2', sf.boardMeta);
  check('...choosing is over', !h.st.board.browsing && h.st.settings.boardUuid === B, bd(h));
  await until(() => Date.now() - tb > 9500, 11000, 200);
  check('...still on it after the old 8 s choosing time has passed', on(h, B), bd(h));

  check = tagged('9d');
  await wait(1000);
  tb = Date.now();
  h.s.emit('boardBrowse');
  await wait(150);
  h.s.emit('boardBrowse');            // a double tap, or a second staff screen
  await until(() => h.st.board.browsing, 2000, 50);
  check('Choose pressed twice, nothing tapped: back to the remembered 112233445566 when time runs out',
    !!(await until(() => on(h, B), 16000)), { b: bd(h), ms: Date.now() - tb });
  await halt(h);
}

async function chainBrowseTimeout(slot) {
  const N = 'bm-browse2';
  freshDir(N, { 'settings.json': remembered(N, A) });
  const check = tagged('9b');
  const h = await boot(N, slot, { FAKE_SECOND_BOARD: 1, DARTS_BROWSE_MS: 8000 });
  check('(set-up) on the remembered board', !!(await until(() => on(h, A), 10000)), bd(h));
  const c0 = (await stats(h)).connectAttempts;
  const tb = Date.now();
  h.s.emit('boardBrowse');
  await until(() => h.st.board.browsing, 2000, 50);
  let early = null;
  while (Date.now() - tb < 7500) {
    if (h.st.board.uuid || h.st.board.state === 'connected' || h.st.board.state === 'connecting') early = early || { ...bd(h), ms: Date.now() - tb };
    await wait(100);
  }
  const f = await stats(h);
  check('nothing tapped: connects to nothing for the 8 s', !early && f.connectAttempts === c0, { early, c0, now: f.connectAttempts });
  check('...while listing both boards', seenIds(h).includes(A) && seenIds(h).includes(B), seenIds(h));
  check('...then returns to the remembered aabbccddeeff', !!(await until(() => on(h, A), 6000, 50)), bd(h));
  const ms = Date.now() - tb;
  check('...once the 8 s are up (not before)', ms >= 7900 && ms < 12000 && !h.st.board.browsing, { ms });
  const f2 = await stats(h);
  check('...112233445566 never tried', f2.boards[1].attempts === 0, f2.boards[1]);
  await halt(h);

  // The same double press while this oche's own board is off air and the
  // other oche's board is the only one in range: it must not be taken.
  const N2 = 'bm-browse3';
  freshDir(N2, { 'settings.json': remembered(N2, A) });
  const check2 = tagged('9e');
  const h2 = await boot(N2, slot, { FAKE_FIRST_ABSENT: 1, FAKE_SECOND_BOARD: 1, DARTS_BROWSE_MS: 4000 });
  await until(() => /…DD:EE:FF/.test(h2.st.board.detail || ''), 5000);
  h2.s.emit('boardBrowse');
  await wait(150);
  h2.s.emit('boardBrowse');
  await wait(4000 + 6000);            // choosing time out, then well past the 2.5 s auto-pick
  const f3 = await stats(h2);
  check2('Choose pressed twice, own board off air, nothing tapped: the other oche\'s board is NOT taken',
    f3.boards[1].attempts === 0 && !h2.st.board.uuid, { b: bd(h2), b1: f3.boards[1], remembered: h2.st.settings.boardUuid });
  check2('...it goes back to looking for its own board (…DD:EE:FF)', h2.st.board.state === 'scanning' && /…DD:EE:FF/.test(h2.st.board.detail || ''), bd(h2));
  await halt(h2);
}

/* ---------- 10: copied folder vs moved folder ---------- */
async function chainCopy(slot) {
  const N = 'bm-copy';
  const orig = dirOf('bm-original');
  fs.mkdirSync(orig, { recursive: true });          // the folder it was copied from, still on this PC
  freshDir(N, { 'settings.json': { boardUuid: A, boardMeta: { name: 'Unicorn Darts', address: A_ADDR, addressType: 'public', source: 'tap', at: Date.now() - 86400000, folder: folderId(orig), path: path.resolve(orig) } } });
  let check = tagged('10');
  let h = await boot(N, slot, { FAKE_SECOND_BOARD: 1 });
  const w = (h.st.warnings || []).find((x) => /copy of another/.test(x));
  check('copied folder: a warning explains', !!w && w.includes(path.resolve(orig)), h.st.warnings);
  let sf = readSettings(N);
  check('...the inherited board is dropped (settings.json and screens)', !sf.boardUuid && !sf.boardMeta && !h.st.settings.boardUuid, { u: sf.boardUuid, m: sf.boardMeta });
  // The original's board is never picked by itself; the only OTHER
  // dartboard in range is - it is this copy's own.
  await until(() => on(h, B), 9000);
  const f = await stats(h);
  check('...and it does not connect to the original\'s board (it takes the other one, its own)',
    f.boards[0].attempts === 0 && on(h, B), { a: f.boards[0], b: bd(h) });
  await halt(h);

  // The original's board alone on air (the original hub closed, or not
  // connected yet): never picked by itself - not after a restart either -
  // but staff can still tap it.
  const NS = 'bm-copy-solo';
  freshDir(NS, { 'settings.json': { boardUuid: A, boardMeta: { name: 'Unicorn Darts', address: A_ADDR, addressType: 'public', source: 'auto', at: Date.now() - 86400000, folder: folderId(orig), path: path.resolve(orig) } } });
  check = tagged('10s');
  h = await boot(NS, slot, {});
  await wait(7000);
  let f2 = await stats(h);
  check('copied folder, only the original\'s board on air: never picked by itself', f2.connectAttempts === 0 && !h.st.board.uuid
    && seenIds(h).includes(A) && readSettings(NS).boardAvoid === A, { f: f2.connectAttempts, b: bd(h), avoid: readSettings(NS).boardAvoid });
  await halt(h);
  h = await boot(NS, slot, {});
  await wait(7000);
  f2 = await stats(h);
  check('...nor after a restart', f2.connectAttempts === 0 && !h.st.board.uuid, { f: f2.connectAttempts, b: bd(h) });
  const r2 = await ack(h, 'boardChoose', A);
  await until(() => on(h, A), 8000);
  const sf2 = readSettings(NS);
  check('...staff can still tap it: remembered as this oche\'s, no longer avoided', r2 && r2.ok && on(h, A) && sf2.boardUuid === A && !sf2.boardAvoid, { r2, b: bd(h), sf2 });
  await halt(h);

  // The folder used on ANOTHER PC and copied here at the same path (every PC
  // installs at C:\WinchesterDarts): same path, same folder id - only the
  // PC's name tells. The other PC's board is dropped and never auto-picked.
  const N3 = 'bm-otherpc';
  freshDir(N3, { 'settings.json': { boardUuid: A, boardMeta: { name: 'Unicorn Darts', address: A_ADDR, addressType: 'public', source: 'auto', at: Date.now() - 86400000, folder: folderId(dirOf(N3)), path: path.resolve(dirOf(N3)), host: 'bar-pc-1' } } });
  check = tagged('10p');
  h = await boot(N3, slot, {});
  await wait(7000);
  const f3 = await stats(h);
  const w3 = (h.st.warnings || []).find((x) => /copied from another PC \(bar-pc-1\)/.test(x));
  const sf3 = readSettings(N3);
  check('folder copied from another PC: warning names that PC, its board dropped and never picked by itself',
    !!w3 && !sf3.boardUuid && sf3.boardAvoid === A && f3.connectAttempts === 0 && !h.st.board.uuid, { w: h.st.warnings, sf3, f: f3.connectAttempts, b: bd(h) });
  await halt(h);
  // ...and a board remembered on THIS PC is stamped with it and kept
  const N4 = 'bm-thispc';
  freshDir(N4, { 'settings.json': { boardUuid: A, boardMeta: { name: 'Unicorn Darts', address: A_ADDR, addressType: 'public', source: 'auto', at: Date.now() - 86400000, folder: folderId(dirOf(N4)), path: path.resolve(dirOf(N4)) } } });
  h = await boot(N4, slot, {});
  await until(() => on(h, A), 9000);
  const sf4 = readSettings(N4);
  check('a board remembered before PCs were stamped: kept, reconnected and stamped with this PC', on(h, A) && sf4.boardUuid === A
    && sf4.boardMeta.host === require('os').hostname().toLowerCase() && !(h.st.warnings || []).some((x) => /copied from another PC/.test(x)), { b: bd(h), m: sf4.boardMeta });
  await halt(h);

  // On Windows the folder id ignores letter case and so does the disk: the
  // SAME folder reached as C:\WinchesterDarts and c:\winchesterdarts has one
  // folder id and both spellings "exist". Simulated here with the hub's own
  // folder id and a differently-cased path that exists.
  const N2 = 'bm-case';
  const other = dirOf('BM-CASE');
  fs.mkdirSync(other, { recursive: true });
  freshDir(N2, { 'settings.json': { boardUuid: A, boardMeta: { name: 'Unicorn Darts', address: A_ADDR, addressType: 'public', source: 'tap', at: Date.now() - 86400000, folder: folderId(dirOf(N2)), path: path.resolve(other) } } });
  check = tagged('10w');
  h = await boot(N2, slot, { FAKE_SECOND_BOARD: 1 });
  sf = readSettings(N2);
  check('same folder id, path differs only in letter case (Windows): NOT a copy - board kept', sf.boardUuid === A
    && !(h.st.warnings || []).some((x) => /copy of another/.test(x)), { u: sf.boardUuid, warnings: h.st.warnings });
  check('...and it reconnects to it', !!(await until(() => on(h, A), 8000)), bd(h));
  await halt(h);
}

async function chainMoved(slot) {
  const N = 'bm-moved';
  const gone = dirOf(`bm-gone-${process.pid}`);
  fs.rmSync(gone, { recursive: true, force: true });
  const at = Date.now() - 3 * 86400000;
  freshDir(N, { 'settings.json': { boardUuid: A, boardMeta: { name: 'Unicorn Darts', address: A_ADDR, addressType: 'public', source: 'tap', at, folder: folderId(gone), path: gone } } });
  const check = tagged('10m');
  const h = await boot(N, slot, { FAKE_SECOND_BOARD: 1 });
  check('moved folder (old path gone): board kept, reconnects to it', !!(await until(() => on(h, A), 10000)), bd(h));
  const sf = readSettings(N);
  const m = sf.boardMeta || {};
  check('...re-stamped with this data dir', sf.boardUuid === A && m.path === path.resolve(dirOf(N)) && m.folder === folderId(dirOf(N)), m);
  check('...keeping its source, name and date', m.source === 'tap' && m.name === 'Unicorn Darts' && m.at === at, m);
  check('...no copy warning', !(h.st.warnings || []).some((x) => /copy of another/.test(x)), h.st.warnings);
  const f = await stats(h);
  check('...112233445566 never tried', f.boards[1].attempts === 0, f.boards[1]);
  await halt(h);
}

/* ---------- 11: settings from an older version ---------- */
async function chainLegacy(slot) {
  let check = tagged('11');
  const N = 'bm-legacy';
  freshDir(N, { 'settings.json': { boardUuid: A } });
  let h = await boot(N, slot, { FAKE_SECOND_BOARD: 1 });
  let sf = readSettings(N);
  check('legacy boardUuid with no boardMeta: kept, source "tap"', sf.boardUuid === A && sf.boardMeta && sf.boardMeta.source === 'tap'
    && sf.boardMeta.path === path.resolve(dirOf(N)), sf.boardMeta);
  check('...reconnects to it with another board in range', !!(await until(() => on(h, A), 10000)), bd(h));
  let f = await stats(h);
  check('...112233445566 never tried', f.boards[1].attempts === 0, f.boards[1]);
  await halt(h);

  const N2 = 'bm-legacy2';
  freshDir(N2, { 'settings.json': { boardUuid: A_ADDR } });
  h = await boot(N2, slot, { FAKE_SECOND_BOARD: 1 });
  sf = readSettings(N2);
  check('legacy boardUuid written as AA:BB:CC:DD:EE:FF: normalised and kept', sf.boardUuid === A && sf.boardMeta && sf.boardMeta.source === 'tap', { u: sf.boardUuid, m: sf.boardMeta });
  check('...reconnects to it', !!(await until(() => on(h, A), 10000)), bd(h));
  await halt(h);
}

async function chainMalformed(slot) {
  const check = tagged('11');
  const N = 'bm-bad';
  freshDir(N, { 'settings.json': { boardUuid: 'xyz' } });
  const h = await boot(N, slot, { FAKE_SECOND_BOARD: 1 });
  const sf = readSettings(N);
  check('malformed boardUuid "xyz": dropped', !sf.boardUuid && !sf.boardMeta && !h.st.settings.boardUuid, { u: sf.boardUuid, m: sf.boardMeta });
  check('...and the hub asks to tap one (two in range)', !!(await until(() => /2 dartboards in range/.test(h.st.board.detail || ''), 9000)), bd(h));
  await halt(h);
}

/* ---------- 12: autoConnect off, but a board remembered ---------- */
async function chainNoAuto(slot) {
  let check = tagged('12');
  const N = 'bm-noauto';
  freshDir(N, { 'settings.json': remembered(N, A, { autoConnect: false }) });
  let h = await boot(N, slot, { FAKE_SECOND_BOARD: 1 });
  check('autoConnect false but a board remembered: connects at boot', !!(await until(() => on(h, A), 10000)), bd(h));
  check('...autoConnect itself left false', h.st.settings.autoConnect === false && readSettings(N).autoConnect === false, h.st.settings.autoConnect);
  const f = await stats(h);
  check('...to the remembered one only', f.boards[1].attempts === 0, f.boards[1]);
  await halt(h);

  const N2 = 'bm-noauto0';
  freshDir(N2, { 'settings.json': { autoConnect: false } });
  h = await boot(N2, slot);
  await wait(5000);
  const f2 = await stats(h);
  check('(control) autoConnect false and nothing remembered: no scan, no connect', f2.scans === 0 && f2.connectAttempts === 0 && h.st.board.state !== 'connected', { f2, b: bd(h) });
  await halt(h);
}

/* ---------- 12: things that must not bring the wrong board back ---------- */
// Powered off at closing, then the hub restarts and the PC sleeps: the wake
// rebuild must leave the board released behind the standby screen.
async function chainPoweredOffWake(slot) {
  const check = tagged('12p');
  const N = 'bm-poweredoff';
  freshDir(N, { 'settings.json': remembered(N, A, { powered: false }) });
  const h = await boot(N, slot, { DARTS_SLEEP_GAP_MS: 8000 });
  await wait(2000);
  h.k.kill('SIGSTOP');
  await wait(12000);
  h.k.kill('SIGCONT');
  await wait(9000);
  const f = await stats(h);
  check('powered off at the last close, then a PC sleep/wake: the board stays released', f.connectAttempts === 0 && f.scans === 0
    && !!h.st && h.st.powered === false && h.st.board.state !== 'connected', { f, b: bd(h) });
  await halt(h);
}
// Fix board connection schedules a rebuild of the board it has; a different
// board tapped inside that window must not be undone when the rebuild fires.
async function chainStaleRebuild(slot) {
  const check = tagged('12r');
  const N = 'bm-rebuild';
  freshDir(N, { 'settings.json': remembered(N, A) });
  const h = await boot(N, slot, { FAKE_SECOND_BOARD: 1 });
  await until(() => on(h, A), 9000);
  h.s.emit('boardFix');
  await wait(500);
  const r = await ack(h, 'boardChoose', B);
  await until(() => on(h, B), 9000);
  await wait(8000);                    // past the rebuild's own attempt
  const sf = readSettings(N);
  const f = await stats(h);
  check('Fix pressed, then another board tapped before the rebuild ran: the tapped board wins and stays', r && r.ok && on(h, B) && sf.boardUuid === B,
    { r, b: bd(h), remembered: sf.boardUuid, boards: f.boards });
  await halt(h);
}

/* ---------- 13: the Bluetooth driver refuses to load at first (logon) ---------- */
async function chainLoadFail(slot) {
  const check = tagged('13');
  const N = 'bm-loadfail';
  freshDir(N, { 'settings.json': remembered(N, A) });
  const h = await boot(N, slot, { FAKE_LOAD_FAIL: 2 });
  await until(() => h.st && h.st.board.state === 'error' && /did not load/.test(h.st.board.detail || ''), 5000);
  check('driver refuses to load: the card says so and that it tries again', /did not load/.test(h.st.board.detail || '') && /trying again/.test(h.st.board.detail || ''), bd(h));
  const t1 = Date.now();
  await until(() => on(h, A), 20000);
  const f = await stats(h);
  check('...the hub retries by itself and connects (no second start of the exe)', on(h, A) && f.loadAttempts === 3 && Date.now() - t1 < 15000, { b: bd(h), loads: f.loadAttempts, ms: Date.now() - t1 });
  await halt(h);
}

(async () => {
  const t0 = Date.now();
  const chains = [
    chainOwn(),                 // slot 0
    chainTwo(),                 // slot 1
    chainIni(),                 // slot 2
    chainBrowse(),              // slot 3
    chainBrowseTimeout(4),
    chainCopy(5),
    chainMoved(6).then(() => chainLoadFail(6)),
    chainLegacy(7).then(() => chainPoweredOffWake(7)),
    chainMalformed(8).then(() => chainStaleRebuild(8)),
    chainNoAuto(9).then(() => chainAutoDrop(9)),
  ];
  const results = await Promise.allSettled(chains);
  for (const r of results) if (r.status === 'rejected') { fail++; console.log(`FAIL  chain crashed: ${r.reason && (r.reason.stack || r.reason)}`); }
  console.log(`\n(${Math.round((Date.now() - t0) / 1000)} s; hub logs in ${SP})`);
  console.log(`${pass} passed, ${fail} failed`);
  killAll();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); killAll(); process.exit(1); });
