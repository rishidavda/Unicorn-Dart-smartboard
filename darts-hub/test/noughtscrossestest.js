/* Browser check: Noughts & Crosses claims cells on the shared grid, colours
 * them distinctly per player, and wins/deciders show up correctly on both
 * screens. Hub must be running on 8899. */
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
  const cels = [];
  s.on('celebrate', (e) => cels.push(e));
  await wait(300);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(300);
  s.emit('sessionStart', 60); await wait(200);

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await tv.goto(`http://127.0.0.1:${PORT}/tv`); await tv.waitForTimeout(800);
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  await pad.goto(`http://127.0.0.1:${PORT}/pad`); await pad.waitForTimeout(800);
  await pad.click('[data-tab="play"]');
  await pad.evaluate(() => { window.__t = []; const el = document.getElementById('toast'); new MutationObserver(() => { if (el.textContent) window.__t.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true }); });
  const toasts = () => pad.evaluate(() => window.__t.splice(0));
  const cellText = (page, i) => page.$eval(`.oxogrid > div:nth-child(${i + 1})`, (el) => el.textContent);
  const cellClass = (page, i) => page.$eval(`.oxogrid > div:nth-child(${i + 1})`, (el) => el.className);

  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });

  s.emit('newMatch', { gameId: 'noughtscrosses', variantId: 'classic', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await tv.waitForTimeout(500);

  // grid starts with plain numbers, top row 7 8 9
  check('TV grid opens with 7 8 9 across the top', (await Promise.all([0, 1, 2].map((i) => cellText(tv, i)))).join(',') === '7,8,9');
  check('pad grid matches the TV grid', (await Promise.all([0, 1, 2].map((i) => cellText(pad, i)))).join(',') === '7,8,9');

  // Ash claims 7 (index 0) - server event, TV card, pad toast, grid colour
  dart(7, 1); dart(20, 1); dart(1, 1); await tv.waitForTimeout(700);
  check('server fires a claim event', cels.some((e) => e.type === 'claim' && e.player === 'Ash' && e.number === 7), cels.map((e) => e.type));
  const cel1 = await tv.$eval('#celtext', (el) => el.textContent);
  check('TV celebration shows the claimed number', cel1.trim() === '7', cel1);
  check('claimed cell now shows Ash\'s initial', await cellText(tv, 0) === 'A');
  check('claimed cell is coloured for seat 0', /\bp0\b/.test(await cellClass(tv, 0)), await cellClass(tv, 0));
  let t = await toasts();
  check('pad toasts the claim', t.some((x) => /Ash claims 7/.test(x)), t);
  check('pad grid also shows the claim', await cellText(pad, 0) === 'A');

  // Sam's turn: re-hitting Ash's cell does nothing (no new claim event, no toast)
  cels.length = 0;
  dart(7, 3); dart(4, 1); dart(20, 1); await tv.waitForTimeout(700);
  check('hitting an already-claimed cell fires no claim event', !cels.some((e) => e.type === 'claim' && e.number === 7), cels.map((e) => e.type));
  check('but a genuinely open cell still claims', cels.some((e) => e.type === 'claim' && e.player === 'Sam' && e.number === 4), cels.map((e) => e.type));
  check('Sam\'s cell is a different colour to Ash\'s', await cellClass(tv, 3) !== await cellClass(tv, 0));

  // Ash: complete the left column (7, 4 already taken by Ash/Sam - use a fresh line instead)
  // Ash has 7 (idx0). Give Ash 8 (idx1) and 9 (idx2) to complete the top row.
  cels.length = 0;
  dart(8, 1); dart(9, 1); dart(1, 1); await tv.waitForTimeout(700);
  check('matchwin fires on the completing dart', cels.some((e) => e.type === 'matchwin' && e.player === 'Ash'), cels.map((e) => e.type));
  await tv.waitForTimeout(2600);
  check('the winning line is highlighted on the TV', /\bwon\b/.test(await cellClass(tv, 1)) && /\bwon\b/.test(await cellClass(tv, 2)));
  t = await toasts();
  check('pad toasts the match win', t.some((x) => /Ash wins the match/.test(x)), t);

  // Sharpshooters variant: only a double claims
  cels.length = 0;
  s.emit('newMatch', { gameId: 'noughtscrosses', variantId: 'sharp', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await tv.waitForTimeout(500);
  dart(7, 1); await tv.waitForTimeout(300);   // single - should not claim
  check('sharpshooters: a single does not claim', !cels.some((e) => e.type === 'claim'), cels.map((e) => e.type));
  check('cell still shows the plain number', await cellText(tv, 0) === '7');
  dart(7, 2); await tv.waitForTimeout(300);   // double - claims
  check('sharpshooters: a double claims', cels.some((e) => e.type === 'claim' && e.number === 7), cels.map((e) => e.type));

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
