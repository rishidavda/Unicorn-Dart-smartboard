/* Reconnect troubleshooting: what the staff card says while the board is
 * missing, just released, or refusing. Hub on TPORT; FAKE_CONNECT_FAIL hub on TPORT2. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.TPORT || 8878), PORT2 = Number(process.env.TPORT2 || 8879);
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`); };

(async () => {
  const s = io(`http://127.0.0.1:${PORT}`); let st = null; s.on('state', (x) => { st = x; }); await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  await wait(2500);
  check('fake board connected at boot', st.board.state === 'connected', st.board.state);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const staff = await b.newPage({ viewport: { width: 820, height: 1400 } });
  await staff.goto(`http://127.0.0.1:${PORT}/staff`); await wait(800);
  await staff.keyboard.type('1234'); await wait(1000);
  await staff.evaluate(() => document.querySelectorAll('details.more').forEach((d) => { d.open = true; }));
  const card = () => staff.evaluate(() => document.querySelector('.card').innerText);

  // Disconnect, then Connect straight away: the "just released" advice, then it reconnects
  s.emit('boardDisconnect'); await wait(400);
  check('after Disconnect the pill says "not connected", not "board off"', /NOT CONNECTED/i.test(await card()) && !/BOARD OFF/i.test(await card()));
  s.emit('boardConnect'); await wait(800);
  const c1 = await card();
  check('reconnect right after release: waits and says why', /just released/i.test(c1), (c1.match(/[^\n]*released[^\n]*/) || [''])[0]);
  await wait(5000);
  check('...and reconnects by itself', st.board.state === 'connected', st.board.state);

  // Board that never shows up (locked to a uuid nobody broadcasts)
  s.emit('boardDisconnect'); await wait(300);
  s.emit('saveSettings', { boardUuid: 'deadbeef0001' }); await wait(300);
  s.emit('boardConnect'); await wait(4500);
  const c2 = await card();
  console.log('   state.board at 4.5 s:', JSON.stringify({ state: st.board.state, scanSeconds: st.board.scanSeconds, seen: st.board.seen }));
  check('missing board: live counter and devices seen', /Looking for the board… \d+ s · 1 Bluetooth device seen/.test(c2), (c2.match(/Looking[^\n]*/) || [''])[0]);
  await wait(16000);
  const c3 = await card();
  check('after 15 s: wake-the-board advice (rim button / dart), Bluetooth confirmed working', /WAKE THE BOARD/.test(c3) && /Bluetooth is working \(1 other device seen\)/.test(c3), (c3.match(/[^\n]*WAKE[^\n]*/) || [''])[0]);
  const secs1 = Number((c3.match(/Looking for the board… (\d+) s/) || [])[1]);
  await wait(10000);
  const secs2 = Number(((await card()).match(/Looking for the board… (\d+) s/) || [])[1]);
  check('the counter keeps climbing', secs2 > secs1, { secs1, secs2 });
  await wait(50000);
  const c4 = await card();
  check('after 75 s: escalated advice (one device at a time, battery out, Fix)', /ONE device/.test(c4) && /battery out/.test(c4) && /Fix board connection/.test(c4), (c4.match(/[^\n]*ONE device[^\n]*/) || [''])[0]);
  check('...and the hub is still searching, not given up', st.board.state === 'scanning', st.board.state);
  // put the real board back: it recovers
  s.emit('saveSettings', { boardUuid: '' }); s.emit('boardConnect'); await wait(5000);
  check('board found again once it broadcasts', st.board.state === 'connected', st.board.state);

  // A board that answers but refuses the link
  const s2 = io(`http://127.0.0.1:${PORT2}`); let st2 = null; s2.on('state', (x) => { st2 = x; }); await wait(400);
  await new Promise((r) => s2.emit('unlock', '1234', r));
  await wait(3000);
  check('refused link: error state with plain reason', st2.board.state === 'error' && /could not connect/.test(st2.board.detail), st2.board);
  check('refused link: advice names the likely cause and the fix', /still linked to another device/.test(st2.board.hint || '') && /battery/.test(st2.board.hint || ''), st2.board.hint);

  await b.close(); s.close(); s2.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
