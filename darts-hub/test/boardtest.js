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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); try { hub.kill(); } catch (_) {} process.exit(1); });
