/* After Disconnect / Power off, packets from the released board must be ignored. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const port = process.env.TPORT || 8899;
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
(async () => {
  const s = io(`http://127.0.0.1:${port}`);
  let st = null; const nogame = [];
  s.on('state', (x) => { st = x; });
  s.on('nogame', (e) => nogame.push(e));
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  // cycle the connection a few times, like the power switch / Fix button do
  for (let i = 0; i < 3; i++) {
    s.emit('boardConnect'); await wait(1500);
    s.emit('boardDisconnect'); await wait(500);
  }
  check('board shows released', st.board.state !== 'connected', st.board.state);
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'A' }, { name: 'B' }] });
  await wait(300);
  const p0 = st.board.packets, d0 = st.match.dartsInLog;
  await wait(7000);                         // the fake board throws every 2 s
  check('no packets counted from a released board', st.board.packets === p0, { before: p0, after: st.board.packets });
  check('no darts scored from a released board', st.match.dartsInLog === d0, { before: d0, after: st.match.dartsInLog });
  // power off: nothing from the board may reach the hub at all
  s.emit('boardConnect'); await wait(1500);
  s.emit('powerOff'); await wait(500);
  const n0 = nogame.length, q0 = st.board.packets;
  await wait(7000);
  check('powered-off board is ignored', st.board.packets === q0 && nogame.length === n0, { packets: [q0, st.board.packets], nogame: nogame.length - n0 });
  s.emit('powerOn'); await wait(2500);
  const r0 = st.board.packets;
  await wait(5000);
  check('reconnected board still scores normally', st.board.state === 'connected' && st.board.packets > r0, { state: st.board.state, packets: [r0, st.board.packets] });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
