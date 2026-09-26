/* Browser check: Nearest the Bull tells the thrower straight away whether
 * their round scored anything - the running points total alone gives no
 * feedback on the round just thrown. Hub must be running on 8899. */
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
  await pad.evaluate(() => { window.__t = []; const el = document.getElementById('toast'); new MutationObserver(() => { if (el.textContent) window.__t.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true }); });
  const toasts = () => pad.evaluate(() => window.__t.splice(0));

  s.emit('newMatch', { gameId: 'nearestbull', variantId: 'r5', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await tv.waitForTimeout(500);
  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });

  // Ash: inner bull, then two misses - scored 2 points this round
  dart(50, 2); dart(1, 1); dart(1, 1); await tv.waitForTimeout(600);
  check('server tells Ash their round scored 2 points', cels.some((e) => e.type === 'roundscore' && e.player === 'Ash' && e.points === 2 && e.total === 2), cels.map((e) => e.type));
  const cel1 = await tv.$eval('#celtext', (el) => el.innerText.replace(/\n/g, ' '));
  check('TV shows +2 for the scoring round', /\+2/.test(cel1), cel1);
  const sub1 = await tv.$eval('#celsub', (el) => el.textContent);
  check('TV names Ash and the running total', /Ash/.test(sub1) && /2 points/.test(sub1), sub1);
  let t = await toasts();
  check('pad toasts Ash scored this round', t.some((x) => /Ash: \+2 this round.*2 points total/.test(x)), t);

  // Sam: three misses - no score this round
  cels.length = 0;
  dart(1, 1); dart(1, 1); dart(1, 1); await tv.waitForTimeout(600);
  check('server tells Sam their round scored nothing', cels.some((e) => e.type === 'roundmiss' && e.player === 'Sam' && e.total === 0), cels.map((e) => e.type));
  const cel2 = await tv.$eval('#celtext', (el) => el.innerText.replace(/\n/g, ' '));
  check('TV shows NO SCORE for the blank round', /NO SCORE/.test(cel2), cel2);
  t = await toasts();
  check('pad toasts Sam scored nothing this round', t.some((x) => /Sam: no score this round.*0 points total/.test(x)), t);

  // Ash: outer bull only - 1 point this round, on top of the earlier 2
  cels.length = 0;
  dart(25, 1); dart(1, 1); dart(1, 1); await tv.waitForTimeout(600);
  check('a later round scores independently of the running total', cels.some((e) => e.type === 'roundscore' && e.player === 'Ash' && e.points === 1 && e.total === 3), cels.map((e) => e.type));

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
