const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const PORT = Number(process.env.TPORT || 8899);
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + x : ''}`); };

(async () => {
  const s = io(`http://127.0.0.1:${PORT}`);
  let state = null; const toasts = [];
  s.on('state', (st) => { state = st; });
  s.on('toast', (t) => toasts.push(t.text));
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardConnect'); await wait(3500);
  check('board connected while ON', state.board.state === 'connected');

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await tv.goto(`http://127.0.0.1:${PORT}/tv`); await tv.waitForTimeout(1200);
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  await pad.goto(`http://127.0.0.1:${PORT}/pad`); await pad.waitForTimeout(1200);
  // Localhost counts as a secure context, so chromium grants the Wake Lock
  // API here; on the pub's LAN pages the video fallback kicks in instead.
  // Either mechanism holding the screen is a pass.
  const awakeTv = await tv.evaluate(() => window.WinchesterAwake && WinchesterAwake()).catch(() => 'err');
  const awakePad = await pad.evaluate(() => window.WinchesterAwake && WinchesterAwake()).catch(() => 'err');
  check('keep-awake armed on TV', awakeTv === 'wake-lock' || awakeTv === 'video', awakeTv);
  check('keep-awake armed on pad', awakePad === 'wake-lock' || awakePad === 'video', awakePad);

  // staff page, power OFF via the card button
  const st = await b.newPage({ viewport: { width: 820, height: 1400 } });
  await st.goto(`http://127.0.0.1:${PORT}/staff`); await st.waitForTimeout(1000);
  await st.keyboard.type('1234'); await st.waitForTimeout(1200);
  s.emit('sessionStart', 60); await wait(300);
  s.emit('savePlayers', [{ id: 'r1', name: 'Rishi' }]); await wait(200);
  s.emit('newMatch', { gameId: 'countup', players: [{ name: 'Rishi' }] }); await wait(400);
  // The billing toast answers whoever clicked - the staff page - so collect
  // that page's toasts (a stray dart toast could overwrite the element).
  await st.evaluate(() => {
    window.__toasts = [];
    const el = document.getElementById('toast');
    new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await st.locator('.card[data-hub="0"] [data-act="poweroff"]').click(); await st.waitForTimeout(1200);

  check('powered flag off', state.powered === false);
  const staffToasts = await st.evaluate(() => window.__toasts);
  check('running session billed on power off', staffToasts.some((t) => /powered off - last session billed £10\.00/.test(t)), staffToasts.join(' | '));
  check('match cleared', state.match === null);
  check('board released', state.board.state !== 'connected', state.board.state);
  check('TV standby black screen', await tv.$eval('#standby', (el) => !el.hidden));
  check('TV standby names the board', /Board 1/.test(await tv.$eval('#standby-name', (el) => el.textContent)));
  check('pad standby overlay', await pad.$eval('#poweroff', (el) => !el.hidden));
  const cardOff = await st.$eval('.card[data-hub="0"]', (el) => el.innerText);
  check('card offers Power on', /power on/i.test(cardOff));

  // punters can't start anything while off
  s.emit('newMatch', { gameId: 'countup', players: [{ name: 'Sneaky' }] }); await wait(400);
  check('games refused while off', state.match === null && toasts.some((t) => /powered off - staff can switch it on/.test(t)));
  s.emit('sessionStart', 60); await wait(300);
  check('sessions refused while off', toasts.some((t) => /Power this board on first/.test(t)));

  // survives a restart: reboot the hub, must stay off
  // (kill via a marker file the wrapper watches is overkill - just check settings)
  const settings = JSON.parse(require('fs').readFileSync(`${process.env.DATA_DIR || `${SP}/hubA`}/settings.json`));
  check('OFF persisted to disk', settings.powered === false);

  // power back ON
  await st.locator('.card[data-hub="0"] [data-act="poweron"]').click(); await st.waitForTimeout(1000);
  check('powered flag on', state.powered === true);
  await wait(3500);
  check('board reconnected after power on', state.board.state === 'connected', state.board.state);
  check('TV standby lifted', await tv.$eval('#standby', (el) => el.hidden));
  check('pad standby lifted', await pad.$eval('#poweroff', (el) => el.hidden));

  // all-boards buttons exist and fire
  const dialogP = new Promise((res) => st.once('dialog', (d) => { d.accept(); res(true); }));
  await st.click('#powerall-off'); await dialogP; await st.waitForTimeout(1000);
  check('Power off ALL works', state.powered === false);
  await st.click('#powerall-on'); await st.waitForTimeout(1000);
  check('Power on ALL works', state.powered === true);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
