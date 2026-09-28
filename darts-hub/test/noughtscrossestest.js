/* Browser check: Noughts & Crosses claims cells on the shared grid, colours
 * them distinctly per player, keeps the grid beside the rows on both screens,
 * and wins/deciders show up correctly. Hub must be running on 8899. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const PORT = Number(process.env.TPORT || 8899);
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };

(async () => {
  const s = io(`http://127.0.0.1:${PORT}`);
  const cels = [];
  const visits = [];
  s.on('celebrate', (e) => cels.push(e));
  s.on('visit', (v) => visits.push(v));
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
  const cellBorder = (page, i) => page.$eval(`.oxogrid > div:nth-child(${i + 1})`, (el) => getComputedStyle(el).borderColor);
  const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; });

  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });

  s.emit('newMatch', { gameId: 'noughtscrosses', variantId: 'classic', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await tv.waitForTimeout(500);

  // grid starts with plain numbers, top row 7 8 9
  check('TV grid opens with 7 8 9 across the top', (await Promise.all([0, 1, 2].map((i) => cellText(tv, i)))).join(',') === '7,8,9');
  check('pad grid matches the TV grid', (await Promise.all([0, 1, 2].map((i) => cellText(pad, i)))).join(',') === '7,8,9');

  // Layout: the grid sits beside the rows, not under them, on both screens
  const tvRows = await box(tv, '#rows'); const tvGrid = await box(tv, '.oxogrid'); const tvFoot = await box(tv, '#foot');
  check('TV grid is beside the rows (starts right of them, same top)', tvGrid.x >= tvRows.r - 1 && Math.abs(tvGrid.y - tvRows.y) < 8, { rows: tvRows, grid: tvGrid });
  check('TV grid stays clear of the footer', tvGrid.b <= tvFoot.y, { grid: tvGrid, foot: tvFoot });
  const padPlayers = await box(pad, '#players'); const padGrid = await box(pad, '.oxogrid'); const padTap = await box(pad, '#tapboard');
  check('pad grid is beside the player list and full size', padGrid.x >= padPlayers.r - 1 && padGrid.w >= 200, { players: padPlayers, grid: padGrid });
  check('pad tap board still usable with the grid up (iPad portrait, 2 players)', padTap.h >= 300, padTap);

  // Ash claims 7 (index 0) - server event, TV card, pad toast, grid colour
  dart(7, 1); dart(20, 1); dart(20, 1); await tv.waitForTimeout(700);
  check('server fires a claim event', cels.some((e) => e.type === 'claim' && e.player === 'Ash' && e.number === 7), cels.map((e) => e.type));
  const cel1 = await tv.$eval('#celtext', (el) => el.textContent);
  check('TV celebration shows the claimed number', cel1.trim() === '7', cel1);
  check('claimed cell shows the name, not just an initial', await cellText(tv, 0) === 'ASH', await cellText(tv, 0));
  check('claimed cell is coloured for seat 0', /\bp0\b/.test(await cellClass(tv, 0)), await cellClass(tv, 0));
  let t = await toasts();
  check('pad toasts the claim', t.some((x) => /Ash claims 7/.test(x)), t);
  check('pad grid also shows the claim', await cellText(pad, 0) === 'ASH');

  // Sam's turn: re-hitting Ash's cell does nothing (no new claim event, no toast)
  cels.length = 0;
  dart(7, 3); dart(4, 1); dart(20, 1); await tv.waitForTimeout(700);
  check('hitting an already-claimed cell fires no claim event', !cels.some((e) => e.type === 'claim' && e.number === 7), cels.map((e) => e.type));
  check('but a genuinely open cell still claims', cels.some((e) => e.type === 'claim' && e.player === 'Sam' && e.number === 4), cels.map((e) => e.type));
  check('Sam\'s cell is a different colour to Ash\'s', await cellBorder(tv, 3) !== await cellBorder(tv, 0), [await cellBorder(tv, 3), await cellBorder(tv, 0)]);

  // Ash has 7 (idx0); 8 and 9 complete the top row on dart 2 of this visit
  cels.length = 0; visits.length = 0;
  dart(8, 1); dart(9, 1); await tv.waitForTimeout(700);
  check('matchwin fires on the completing dart', cels.some((e) => e.type === 'matchwin' && e.player === 'Ash'), cels.map((e) => e.type));
  const winVisit = visits.find((v) => v.special === 'matchwin');
  check('the winning visit card carries the winner and THEIR darts, not the previous visit',
    !!winVisit && winVisit.player === 'Ash' && (winVisit.darts || []).map((x) => x.label).join(',') === '8,9', winVisit);
  await tv.waitForTimeout(2600);
  check('the winning line is highlighted on the TV', /\bwon\b/.test(await cellClass(tv, 1)) && /\bwon\b/.test(await cellClass(tv, 2)));
  const tcName = await tv.$eval('#tc-name', (el) => el.textContent);
  const tcDarts = await tv.$eval('#tc-darts', (el) => el.textContent);
  check('TV turn card names the winner over the winning darts', /Ash/i.test(tcName) && /8/.test(tcDarts) && /9/.test(tcDarts) && !/20/.test(tcDarts), { tcName, tcDarts });
  t = await toasts();
  check('pad toasts the match win', t.some((x) => /Ash wins the match/.test(x)), t);

  // Four players: four distinct colours, every claimed cell distinct from an open one
  cels.length = 0;
  s.emit('newMatch', { gameId: 'noughtscrosses', variantId: 'classic', players: [{ name: 'Ash' }, { name: 'Sam' }, { name: 'Steve' }, { name: 'Kim' }] });
  await tv.waitForTimeout(500);
  dart(7, 1); dart(20, 1); dart(20, 1);   // Ash 7
  dart(8, 1); dart(20, 1); dart(20, 1);   // Sam 8
  dart(9, 1); dart(20, 1); dart(20, 1);   // Steve 9
  dart(4, 1); await tv.waitForTimeout(600);   // Kim 4
  const borders = await Promise.all([0, 1, 2, 3].map((i) => cellBorder(tv, i)));
  const open = await cellBorder(tv, 4);
  check('four players get four different colours', new Set(borders).size === 4, borders);
  check('every claimed cell differs from an open cell', borders.every((c) => c !== open), { borders, open });
  check('Sam and Steve are told apart by name', (await cellText(tv, 1)) === 'SAM' && (await cellText(tv, 2)) === 'STE');
  const rowsBox = await box(tv, '#rows');
  const lastRow = await tv.$$eval('#rows .row', (els) => { const r = els[els.length - 1].getBoundingClientRect(); return { b: r.bottom, n: els.length }; });
  check('all four player rows fit on the TV beside the grid', lastRow.n === 4 && lastRow.b <= rowsBox.b + 1, { lastRow, rowsBox });

  // Sharpshooters variant: only a double claims
  cels.length = 0;
  s.emit('newMatch', { gameId: 'noughtscrosses', variantId: 'sharp', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await tv.waitForTimeout(500);
  dart(7, 1); await tv.waitForTimeout(300);   // single - should not claim
  check('sharpshooters: a single does not claim', !cels.some((e) => e.type === 'claim'), cels.map((e) => e.type));
  check('cell still shows the plain number', await cellText(tv, 0) === '7');
  dart(7, 2); await tv.waitForTimeout(300);   // double - claims
  check('sharpshooters: a double claims', cels.some((e) => e.type === 'claim' && e.number === 7), cels.map((e) => e.type));

  // Phone-width pad: the grid must not eat the tap board
  const phone = await b.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`http://127.0.0.1:${PORT}/pad`); await phone.waitForTimeout(800);
  await phone.click('[data-tab="play"]'); await phone.waitForTimeout(300);
  const phoneTap = await box(phone, '#tapboard'); const phoneGrid = await box(phone, '.oxogrid');
  check('phone pad: grid is compact and the tap board is still tappable', phoneGrid.w <= 160 && phoneTap.h >= 150, { grid: phoneGrid, tap: phoneTap });

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
