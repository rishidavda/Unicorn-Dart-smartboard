/* Board connection robustness: Connect/Disconnect/Power off racing the link,
 * a refused link recovering by itself, switching boards, a dropped link.
 * Starts its own hubs (fakeboard knobs + hook port). TPORT = first of ten ports. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js');
const BASE = Number(process.env.TPORT || 8960);
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };

let hub = null, sock = null, st = null, HOOK = 0;
async function boot(name, port, env) {
  fs.rmSync(`${SP}/board-${name}`, { recursive: true, force: true });
  HOOK = port + 1;
  hub = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: `${SP}/board-${name}`, FAKE_HOOK_PORT: String(HOOK), ...env },
    stdio: ['ignore', fs.openSync(`${SP}/board-${name}.log`, 'w'), fs.openSync(`${SP}/board-${name}.log`, 'a')] });
  await wait(2500);
  sock = io(`http://127.0.0.1:${port}`, { reconnection: false });
  st = null; sock.on('state', (x) => { st = x; });
  await wait(400);
  await new Promise((r) => sock.emit('unlock', '1234', r));
}
async function halt() {
  sock.close();
  hub.kill('SIGINT'); await new Promise((r) => hub.once('exit', r)); await wait(300);
}
const fake = (path = '/stats') => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${HOOK}${path}`, (r) => { let t = ''; r.on('data', (d) => { t += d; }); r.on('end', () => res(JSON.parse(t))); }).on('error', rej);
});
// Poll the board state (as every screen sees it) until a condition holds.
async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (st && pred(st.board)) return true; await wait(150); }
  return !!(st && pred(st.board));
}
const bd = () => ({ state: st.board.state, detail: st.board.detail, uuid: st.board.uuid, scanSeconds: st.board.scanSeconds });
async function quiet(label, ms) {
  const p0 = st.board.packets;
  await wait(ms);
  check(`${label}: no darts heard from the released board`, st.board.packets === p0, { before: p0, after: st.board.packets });
}

(async () => {
  /* ---- plain board, with noble's 'disconnect' event on release ---- */
  await boot('plain', BASE, { FAKE_DISCONNECT_EVENT: '1' });
  check('plain hub: connected at boot', await until((b) => b.state === 'connected', 4000), bd());
  let f = await fake();
  check('A6: one disconnect listener on the live link', f.boards[0].disconnectListeners === 1, f.boards[0]);

  // A1: Connect then Disconnect inside the "just released" pause
  sock.emit('boardDisconnect'); await wait(300);
  sock.emit('boardConnect'); await wait(300);
  check('A1: Connect right after release waits ("just released")', /just released/.test(st.board.detail), bd());
  sock.emit('boardDisconnect'); await wait(4000);
  check('A1: Disconnect inside that pause sticks - card says not connected', st.board.state === 'idle' && st.board.uuid === null, bd());
  f = await fake();
  check('A1: ...and the board is really released', !f.boards[0].connected && f.boards[0].disconnectListeners === 0, f.boards[0]);
  await quiet('A1', 4000);

  // A1 again with Power off
  sock.emit('boardConnect');
  check('A1: Connect afterwards works', await until((b) => b.state === 'connected', 6000), bd());
  sock.emit('boardDisconnect'); await wait(300);
  sock.emit('boardConnect'); await wait(300);
  sock.emit('powerOff'); await wait(4000);
  check('A1: Power off inside the pause sticks - powered OFF and no board', st.powered === false && st.board.state !== 'connected' && st.board.uuid === null, bd());
  await quiet('A1 power off', 4000);
  sock.emit('powerOn');
  check('A1: Power on reconnects', await until((b) => b.state === 'connected', 8000), bd());

  // A5: Fix board connection says what it is doing
  sock.emit('boardFix'); await wait(300);
  check('A5: Fix says "rebuilding the board link", not "PC woke up"', st.board.state === 'connecting' && /rebuilding the board link/.test(st.board.detail) && !/woke up/.test(st.board.detail), bd());
  check('A5: ...and the board comes back', await until((b) => b.state === 'connected', 10000), bd());

  // A8: the board drops the link by itself
  const packetsBefore = st.board.packets;
  await fake('/drop'); await wait(400);
  check('A8: dropped link: button-free wording', st.board.state === 'idle' && /dropped the link/.test(st.board.detail) && !/Reconnect/.test(st.board.detail), bd());
  check('A8: dropped link: advice (batteries / range / reconnects by itself)', /batter/i.test(st.board.hint || '') && /reconnects on its own/i.test(st.board.hint || ''), st.board.hint);
  check('A8: dropped link: countdown to the retry in the detail', /trying again in \d+ s/.test(st.board.detail), st.board.detail);
  f = await fake();
  check('A8: nothing left listening on the dropped link', f.boards[0].dataListeners === 0, f.boards[0]);
  check('A8: reconnects by itself', await until((b) => b.state === 'connected', 8000), bd());
  await wait(4500);
  check('A8: ...and scores again', st.board.packets > packetsBefore, { before: packetsBefore, after: st.board.packets });
  // A8 with the board switched off on purpose: nothing may bring it back
  sock.emit('boardDisconnect'); await wait(300);
  await fake('/drop'); await wait(4500);
  check('A8: a drop after Disconnect does not start a search', st.board.state === 'idle' && st.board.detail === 'disconnected', bd());
  await halt();

  /* ---- a link that takes 1.5 s to come up, like WinRT ---- */
  await boot('slow', BASE + 2, { FAKE_CONNECT_DELAY_MS: '1500', FAKE_DISCONNECT_EVENT: '1' });
  check('slow hub: connected at boot', await until((b) => b.state === 'connected', 6000), bd());

  // A2: Disconnect while "Connecting..." (auto-pick waits 2.5 s before the link)
  sock.emit('boardDisconnect'); await wait(3000);
  sock.emit('boardConnect');
  check('A2: link in flight ("Connecting...")', await until((b) => b.state === 'connecting', 5000), bd());
  sock.emit('boardDisconnect'); await wait(2500);
  check('A2: Disconnect during Connecting sticks', st.board.state === 'idle' && st.board.detail === 'disconnected' && st.board.uuid === null, bd());
  f = await fake();
  check('A2: the link that came up afterwards was dropped, nothing listening', !f.boards[0].connected && f.boards[0].dataListeners === 0 && f.boards[0].disconnectListeners === 0, f.boards[0]);
  await quiet('A2', 4000);

  // A2 with Power off
  sock.emit('boardConnect');
  check('A2: link in flight again', await until((b) => b.state === 'connecting', 5000), bd());
  sock.emit('powerOff'); await wait(2500);
  check('A2: Power off during Connecting sticks', st.powered === false && st.board.state !== 'connected' && st.board.uuid === null, bd());
  f = await fake();
  check('A2: ...board really released', !f.boards[0].connected && f.boards[0].dataListeners === 0, f.boards[0]);
  await quiet('A2 power off', 4000);
  sock.emit('powerOn');
  check('A2: Power on reconnects', await until((b) => b.state === 'connected', 8000), bd());

  // A4: a second Connect press while Connecting
  sock.emit('boardDisconnect'); await wait(3000);
  const attempts0 = (await fake()).connectAttempts;
  sock.emit('boardConnect');
  check('A4: link in flight', await until((b) => b.state === 'connecting', 5000), bd());
  sock.emit('boardConnect'); await wait(200);
  check('A4: second Connect does not start a scan on top', st.board.state === 'connecting', bd());
  check('A4: ...link comes up', await until((b) => b.state === 'connected', 4000), bd());
  const scans0 = (await fake()).scans;
  await wait(6000);
  f = await fake();
  check('A4: connected, scan clock stays at 0, one connect attempt, no scans on the live link',
    st.board.state === 'connected' && st.board.scanSeconds === 0 && f.connectAttempts === attempts0 + 1 && f.scans === scans0,
    { ...bd(), attempts: [attempts0, f.connectAttempts], scans: [scans0, f.scans] });
  await halt();

  /* ---- a board that always refuses the link (held by a phone) ---- */
  await boot('refuse', BASE + 4, { FAKE_CONNECT_FAIL: '1' });
  // locked to the board, as a pub's hub is once staff tapped it in the list
  sock.emit('saveSettings', { boardUuid: 'aabbccddeeff' }); sock.emit('boardConnect');
  check('refused: error state with the reason', await until((b) => b.state === 'error' && /could not connect/.test(b.detail), 4000), bd());
  check('refused: the detail counts down to a retry', /trying again in \d+ s/.test(st.board.detail), st.board.detail);
  check('refused: advice points at Fix board connection, not Connect', /Fix board connection/.test(st.board.hint || '') && !/press Connect/.test(st.board.hint || ''), st.board.hint);
  f = await fake();
  check('A6: no listener left on the refused peripheral', f.boards[0].disconnectListeners === 0, f.boards[0]);
  // A3: retries by itself, with backoff
  const a0 = f.connectAttempts;
  await wait(12000);
  f = await fake();
  check('A3: keeps trying by itself (3 s, 6 s, ...)', f.connectAttempts >= a0 + 2, { before: a0, after: f.connectAttempts });
  // Disconnect ends the retries
  sock.emit('boardDisconnect'); await wait(500);
  const a1 = (await fake()).connectAttempts;
  await wait(7000);
  f = await fake();
  check('A3: Disconnect stops the retries', f.connectAttempts === a1 && st.board.state === 'idle', { before: a1, after: f.connectAttempts, ...bd() });
  // A3: Connect after a refusal attempts the link again instead of scanning for ever
  sock.emit('boardConnect');
  check('A3: Connect after a refusal tries the link again (not "Looking..." for ever)', await until((b) => b.state === 'error', 4000), bd());
  f = await fake();
  check('A3: ...a connect attempt was made', f.connectAttempts > a1, { before: a1, after: f.connectAttempts });
  // Fix board connection from the error state also gets an attempt in
  const a2 = f.connectAttempts;
  sock.emit('boardFix'); await wait(300);
  check('A5: Fix from an error state says "rebuilding the board link"', st.board.state === 'connecting' && /rebuilding the board link/.test(st.board.detail), bd());
  await wait(6000);
  f = await fake();
  check('A3: Fix retried the link, and the hub is still on the case', f.connectAttempts > a2 && ['error', 'scanning', 'connecting'].includes(st.board.state), { before: a2, after: f.connectAttempts, ...bd() });
  // Fix's own follow-ups must not restart the backoff: after the first
  // minute the loop settles at one attempt every 30 s, not ten a minute.
  const a3 = f.connectAttempts;
  await wait(60000);
  f = await fake();
  check('Fix on a refusing board: the retry backoff is not restarted (at most 6 attempts in the next minute)', f.connectAttempts - a3 <= 6, { attemptsInAMinute: f.connectAttempts - a3 });
  await halt();

  /* ---- Fix board connection then Power off within its 4 s rebuild window ---- */
  await boot('fixoff', BASE + 5, { FAKE_DISCONNECT_EVENT: '1' });
  check('fix/off: connected at boot', await until((b) => b.state === 'connected', 4000), bd());
  sock.emit('boardFix'); await wait(1000);
  sock.emit('powerOff'); await wait(6000);
  check('Fix then Power off: the rebuild does not bring the board back', st.powered === false && st.board.state !== 'connected' && st.board.uuid === null, { powered: st.powered, ...bd() });
  f = await fake();
  check('Fix then Power off: the board is really released', !f.boards[0].connected && f.boards[0].dataListeners === 0, f.boards[0]);
  await quiet('Fix then Power off', 4000);
  await wait(10000);   // past Fix's 14 s follow-up
  check('Fix then Power off: still off after the follow-up', st.powered === false && st.board.state !== 'connected', { powered: st.powered, ...bd() });
  sock.emit('powerOn');
  check('Fix then Power off: Power on reconnects', await until((b) => b.state === 'connected', 8000), bd());
  sock.emit('boardFix'); await wait(1000);
  sock.emit('boardDisconnect'); await wait(6000);
  check('Fix then Disconnect: stays disconnected', st.board.state === 'idle' && st.board.uuid === null, bd());
  f = await fake();
  check('Fix then Disconnect: the board is really released', !f.boards[0].connected, f.boards[0]);
  await halt();

  /* ---- the board drops while a slow connect is still pending ---- */
  await boot('dropslow', BASE + 7, { FAKE_CONNECT_DELAY_MS: '4000', FAKE_DISCONNECT_EVENT: '1' });
  check('drop/slow: connected at boot', await until((b) => b.state === 'connected', 8000), bd());
  const armWrites = (b) => b.writes.filter((w) => w === 3).length;
  f = await fake(); const w0 = armWrites(f.boards[0]);
  await fake('/drop'); await wait(200);
  check('drop/slow: retry pending', await until((b) => b.state === 'idle' && /trying again/.test(b.detail), 2000), bd());
  check('drop/slow: reconnects', await until((b) => b.state === 'connected', 15000), bd());
  await wait(6000);   // let any late callback from the first attempt land
  f = await fake();
  check('drop/slow: the handshake ran once on the new link (one listening-mode write)', armWrites(f.boards[0]) - w0 === 1 && f.boards[0].dataListeners === 1 && st.board.state === 'connected', { armWrites: armWrites(f.boards[0]) - w0, dataListeners: f.boards[0].dataListeners, ...bd() });
  await halt();

  /* ---- a board briefly held by another device: refuses twice, then accepts ---- */
  await boot('brief', BASE + 6, { FAKE_CONNECT_FAIL_TIMES: '2' });
  check('brief refusal: first attempt refused', await until((b) => b.state === 'error' && /trying again/.test(b.detail), 3000), bd());
  check('A3: comes back on its own, nobody pressed anything', await until((b) => b.state === 'connected', 15000), bd());
  f = await fake();
  check('A3: took exactly the two refusals plus one success', f.connectAttempts === 3, f.connectAttempts);
  const pb = st.board.packets; await wait(4500);
  check('A3: ...and scores', st.board.packets > pb, { before: pb, after: st.board.packets });
  await halt();

  /* ---- two boards in range: tapping the other one in the list ---- */
  await boot('two', BASE + 8, { FAKE_SECOND_BOARD: '1' });
  check('two boards: hub asks staff to tap one', await until((b) => /2 dartboards in range/.test(b.detail), 6000), bd());
  sock.emit('saveSettings', { boardUuid: 'aabbccddeeff' }); sock.emit('boardConnect');
  check('two boards: tapped board connects', await until((b) => b.state === 'connected' && b.uuid === 'aabbccddeeff', 6000), bd());
  // A7: tap the other board while connected
  sock.emit('saveSettings', { boardUuid: '112233445566' }); sock.emit('boardConnect');
  check('A7: tapping the other board lets the old one go', await until((b) => b.uuid !== 'aabbccddeeff', 2000), bd());
  check('A7: ...and connects to the new one', await until((b) => b.state === 'connected' && b.uuid === '112233445566', 8000), bd());
  f = await fake();
  check('A7: old board released, new one held', !f.boards[0].connected && f.boards[1].connected, f.boards.map((b) => [b.uuid, b.connected]));
  const p2 = st.board.packets; await wait(4500);
  check('A7: the new board scores', st.board.packets > p2, { before: p2, after: st.board.packets });
  await halt();

  /* ---- Power off in the first half-second after a relaunch (the boot auto-connect) ---- */
  // Supervisor-style: the hub is relaunched and Power off is sent the moment
  // it answers, ahead of its 800 ms auto-connect. A late socket (the hub's
  // scan already started) proves nothing, so the relaunch is repeated.
  let toasts = [];
  let bootMs = 0;
  for (let go = 0; go < 5; go++) {
    fs.rmSync(`${SP}/board-bootoff`, { recursive: true, force: true });
    HOOK = BASE + 3;
    const t0 = Date.now();
    hub = spawn('node', [`${HERE}/fakeboard.js`], {
      env: { ...process.env, SERVER_JS: SERVER, PORT: String(BASE + 2), DARTS_DATA: `${SP}/board-bootoff`, FAKE_HOOK_PORT: String(HOOK), FAKE_DISCONNECT_EVENT: '1' },
      stdio: ['ignore', fs.openSync(`${SP}/board-bootoff.log`, 'w'), fs.openSync(`${SP}/board-bootoff.log`, 'a')] });
    sock = io(`http://127.0.0.1:${BASE + 2}`, { reconnectionDelay: 40, reconnectionDelayMax: 40, timeout: 500 });
    st = null; sock.on('state', (x) => { st = x; });
    toasts = []; sock.on('toast', (t) => toasts.push(t.text));
    await new Promise((r) => sock.once('connect', r));
    sock.emit('unlock', '1234'); sock.emit('powerOff');
    bootMs = Date.now() - t0;
    await new Promise((r) => { const p = () => (toasts.length ? r() : setTimeout(p, 20)); p(); });
    f = await fake();
    if (f.scans === 0) break;                       // in time: the hub had not started looking yet
    await halt();
  }
  check('boot race: Power off landed before the hub started looking', f.scans === 0, { msAfterLaunch: bootMs, scans: f.scans });
  await wait(5000); await until(() => true, 2000);
  f = await fake();
  check('boot race: the auto-connect does not override it - powered OFF, no board', st.powered === false && st.board.state !== 'connected' && st.board.uuid === null, { powered: st.powered, ...bd() });
  check('boot race: the board was never touched', f.scans === 0 && f.connectAttempts === 0 && !f.boards[0].connected && f.boards[0].dataListeners === 0, f);
  check('boot race: no darts heard behind the standby screen', st.board.packets === 0, st.board.packets);
  // a second Power off answers a board that got grabbed anyway: it lets it go
  toasts = [];
  sock.emit('powerOff'); await wait(1000);
  f = await fake();
  check('second Power off: says the board is released', toasts.some((t) => /already off - board released/.test(t)), toasts);
  check('second Power off: the board is released and stays off', st.powered === false && st.board.state !== 'connected' && !f.boards[0].connected && f.boards[0].dataListeners === 0, { powered: st.powered, ...bd(), fake: f.boards[0] });
  // the card's other buttons are refused while off, like Start timer is
  toasts = [];
  sock.emit('boardConnect'); await wait(300);
  check('Connect while off: refused with the toast', toasts.some((t) => /Power this board on first/.test(t)), toasts);
  toasts = [];
  sock.emit('boardFix'); await wait(300);
  check('Fix while off: refused with the toast', toasts.some((t) => /Power this board on first/.test(t)) && !toasts.some((t) => /Rebuilding/.test(t)), toasts);
  await wait(5000);
  f = await fake();
  check('Connect/Fix while off: the board stays released', st.powered === false && st.board.state !== 'connected' && !f.boards[0].connected && f.connectAttempts === 0, { ...bd(), fake: f.boards[0], attempts: f.connectAttempts });
  sock.emit('powerOn');
  check('boot race: Power on afterwards connects', await until((b) => b.state === 'connected', 8000), bd());
  await halt();

  /* ---- noble's stale-handle warning: the rebuild pause vs Power off / Disconnect ---- */
  await boot('warn', BASE + 2, { FAKE_DISCONNECT_EVENT: '1' });
  check('warn hub: connected at boot', await until((b) => b.state === 'connected', 4000), bd());
  await fake('/warn'); await wait(200);
  check('warning: the hub drops the link to rebuild it', st.board.state === 'connecting' && /lost track/.test(st.board.detail), bd());
  await wait(300);
  sock.emit('powerOff'); await wait(5000);
  f = await fake();
  check('warning then Power off: the rebuild does not bring the board back', st.powered === false && st.board.state !== 'connected' && st.board.uuid === null && !f.boards[0].connected, { powered: st.powered, ...bd(), fake: f.boards[0] });
  await quiet('warning then Power off', 4000);
  sock.emit('powerOn');
  check('warning then Power off: Power on reconnects', await until((b) => b.state === 'connected', 8000), bd());
  await fake('/warn'); await wait(500);
  sock.emit('boardDisconnect'); await wait(5000);
  f = await fake();
  check('warning then Disconnect: stays disconnected', st.board.state === 'idle' && st.board.detail === 'disconnected' && !f.boards[0].connected, { ...bd(), fake: f.boards[0] });
  sock.emit('boardConnect');
  check('warning then Disconnect: Connect afterwards works', await until((b) => b.state === 'connected', 8000), bd());
  const pw = st.board.packets;
  await fake('/warn');
  check('warning alone: rebuilds the link by itself', await until((b) => b.state === 'connected' && b.packets > pw, 12000), bd());
  await halt();

  /* ---- Disconnect during Connecting, then Connect: noble's "already connecting" ---- */
  await boot('twice', BASE + 2, { FAKE_CONNECT_DELAY_MS: '8000', FAKE_DOUBLE_CONNECT_ERR: '1', FAKE_DISCONNECT_EVENT: '1' });
  check('twice hub: connected at boot', await until((b) => b.state === 'connected', 16000), bd());
  sock.emit('boardDisconnect'); await wait(3000);
  sock.emit('boardConnect');
  check('twice: link in flight', await until((b) => b.state === 'connecting', 6000), bd());
  sock.emit('boardDisconnect'); await wait(300);
  sock.emit('boardConnect');
  const seen = new Set(); let neutral = false;
  for (const end = Date.now() + 30000; Date.now() < end && st.board.state !== 'connected';) {
    seen.add(st.board.state);
    if (st.board.state === 'connecting' && /trying again/.test(st.board.detail)) neutral = true;
    await wait(100);
  }
  f = await fake();
  check('twice: the second connect was refused as "already connecting"', f.doubleConnects >= 1, f.doubleConnects);
  check('twice: never shown as a board error - stays "connecting" while the retry is scheduled', !seen.has('error') && neutral, [...seen]);
  check('twice: the link converges', st.board.state === 'connected' && f.boards[0].connected && f.boards[0].dataListeners === 1, { ...bd(), fake: f.boards[0] });
  await halt();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); try { hub.kill(); } catch (_) {} process.exit(1); });
