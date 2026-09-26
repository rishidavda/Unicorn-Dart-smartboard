/* TV celebration queue timing, measured on the real TV page. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.TPORT || 8899;
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`); };

(async () => {
  const s = io(`http://127.0.0.1:${PORT}`);
  await wait(300);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(300);
  s.emit('sessionStart', 60); await wait(200);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  tv.on('pageerror', (e) => errors.push(e.message));
  await tv.goto(`http://127.0.0.1:${PORT}/tv`); await tv.waitForTimeout(800);
  await tv.evaluate(() => {
    window.__cel = []; window.__t0 = performance.now();
    const c = document.getElementById('cel');
    new MutationObserver(() => window.__cel.push({ t: Math.round(performance.now() - window.__t0), on: /show/.test(c.className),
      text: document.getElementById('celtext').innerText.replace(/\n/g, ' ') })).observe(c, { attributes: true, attributeFilter: ['class'] });
  });
  const now = () => tv.evaluate(() => Math.round(performance.now() - window.__t0));
  const take = () => tv.evaluate(() => window.__cel.splice(0));
  const shows = (log) => log.filter((e) => e.on);
  const durations = (log) => {            // text -> how long it stayed up
    const out = []; let cur = null;
    for (const e of log) {
      if (e.on) { if (cur) out.push({ text: cur.text, ms: e.t - cur.t }); cur = e; }
      else if (cur) { out.push({ text: cur.text, ms: e.t - cur.t }); cur = null; }
    }
    return out;
  };
  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });

  // 1. Fast cricket: cards keep up with the board
  s.emit('newMatch', { gameId: 'cricket', variantId: 'standard', players: [{ name: 'A' }, { name: 'B' }] });
  await wait(1200); await take();
  dart(20, 3); await wait(800); dart(20, 3); await wait(800);
  const tLast = await now(); dart(20, 3);
  await wait(6000);
  let log = await take();
  const sh = shows(log);
  const lag = sh.length ? sh[sh.length - 1].t - tLast : null;
  check('fast cricket: every dart got its card', sh.map((e) => e.text).join(',') === '20 CLOSED,+60,+60', sh.map((e) => e.text));
  check('fast cricket: last card up within 1.2 s of its dart', lag !== null && lag < 1200, `${lag} ms`);
  check('fast cricket: commentary readable (each up >= 650 ms)', durations(log).every((d) => d.ms >= 650), durations(log));

  // 2. Prisoner last life: LIFE LOST -> OUT -> WINS, all in full, in order
  s.emit('newMatch', { gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(1200); await take();
  dart(1); dart(5); dart(5); await wait(1600);     // Ash hits (NEXT: 2 card)
  await take();
  dart(9); dart(9); dart(9);                       // Sam blanks on his last life
  await wait(13000);
  log = await take();
  const seq = shows(log).map((e) => e.text);
  check('prisoner: LIFE LOST, OUT, WINS in order', /LIFE LOST/.test(seq[0] || '') && /OUT!/.test(seq[1] || '') && /WINS!/.test(seq[2] || ''), seq);
  const d2 = durations(log);
  // with more waiting behind them, big moments hold 1.6 s; the win keeps its full 6 s
  check('prisoner: every big moment readable (>= 1.5 s) and the win in full', d2.length >= 3 && d2.slice(0, 2).every((d) => d.ms >= 1500) && d2[2].ms >= 5900, d2);

  // 3. Killer: arming (commentary) then KILLER (big) - both seen
  s.emit('newMatch', { gameId: 'killer', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(1200); await take();
  dart(16, 2); await wait(300); dart(16, 1);        // 2 of 3, then armed
  await wait(5000);
  log = await take();
  const k = shows(log).map((e) => e.text);
  check('killer: arming then KILLER both shown', k.includes('2 OF 3') && k.includes('KILLER!') && k.indexOf('2 OF 3') < k.indexOf('KILLER!'), k);

  // 4. A new game wipes the old game's queue
  s.emit('newMatch', { gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(1200);
  dart(1); dart(5); dart(5); await wait(600);
  dart(9); dart(9); dart(9); await wait(700);       // LIFE LOST showing, OUT + WINS queued
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(300); await take();
  await wait(9000);
  log = await take();
  check('new game: no old cards afterwards', shows(log).length === 0, shows(log).map((e) => e.text));

  // 5. No card ever plays twice: 180 then nothing - exactly one show
  dart(20, 3); dart(20, 3); dart(20, 3);
  await wait(6000);
  log = await take();
  check('180 shown exactly once', shows(log).filter((e) => /EIGHTY/.test(e.text)).length === 1, shows(log).map((e) => e.text));

  const celUp = () => tv.$eval('#cel', (el) => /show/.test(el.className));
  const cardUp = () => tv.$eval('#turncard', (el) => el.classList.contains('show'));
  // 6. The staff sound check (no game on) survives the state broadcasts that
  //    arrive every few seconds anyway - a scanning board, names being typed
  s.emit('endMatch'); await wait(500); await take();
  s.emit('testCaller'); await wait(300);
  check('sound check: 180 card and visit card up with no game on', (await celUp()) && (await cardUp()));
  for (let i = 0; i < 5; i++) { s.emit('savePlayers', [{ id: 'r' + i, name: 'Typing' + i }]); await wait(600); }
  check('sound check: the visit card is still up after 5 broadcasts', await cardUp());
  await wait(6200);
  check('sound check: the visit card holds its full 10 s', await cardUp());
  await wait(1500);
  check('sound check: ...and then goes by itself', !(await cardUp()));
  log = await take();
  const dsc = durations(log);
  check('sound check: the 180 card held its full time through the broadcasts', dsc.length === 1 && /EIGHTY/.test(dsc[0].text) && dsc[0].ms >= 2500, dsc);

  // 7. The game going (session ended with cards queued) still clears everything
  s.emit('newMatch', { gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(1200);
  dart(1); dart(5); dart(5); await wait(600);
  dart(9); dart(9); dart(9); await wait(700);       // LIFE LOST showing, OUT + WINS queued
  s.emit('sessionEnd'); await wait(300);
  check('session end: no card and no visit card within 300 ms', !(await celUp()) && !(await cardUp()));
  await take(); await wait(8000);
  log = await take();
  check('session end: nothing queued plays afterwards', shows(log).length === 0, shows(log).map((e) => e.text));

  // 8. A plain win: the WINS card plays its full 6 s with broadcasts landing
  s.emit('sessionStart', 60); await wait(300);
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Ann' }] });
  await wait(1200); await take();
  for (const [sc, m] of [[20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3]]) { dart(sc, m); await wait(80); }
  await wait(6000); await take();                   // the two 180 cards play out first
  dart(20, 3); dart(19, 3); dart(12, 2);            // 141 out: GAME SHOT then WINS
  await wait(2500);
  for (let i = 0; i < 5; i++) { s.emit('savePlayers', [{ id: 'r' + i, name: 'Typing' + i }]); await wait(1000); }
  check('plain win: the visit card is still up with broadcasts landing', await cardUp());
  await wait(4000);
  log = await take();
  const dw = durations(log).filter((d) => /WINS!/.test(d.text));
  check('plain win: WINS card plays 6 s uninterrupted', dw.length === 1 && dw[0].ms >= 5900, durations(log));

  check('no page errors on the TV', errors.length === 0, errors);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
