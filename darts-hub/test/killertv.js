/* Browser check: Killer classic on the real TV - arming card, killer call,
 * multi-life take. Hub must be running on 8899. */
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
  await wait(300);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(300);
  s.emit('sessionStart', 60); await wait(200);

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await tv.goto(`http://127.0.0.1:${PORT}/tv`); await tv.waitForTimeout(800);

  s.emit('newMatch', { gameId: 'killer', players: [{ name: 'Ash' }, { name: 'Sam' }] }); // Ash=16 Sam=8
  await tv.waitForTimeout(600);
  const body = await tv.evaluate(() => document.body.innerText);
  check('TV hint explains 3-to-arm with ring counts', /3 more to become a killer/.test(body) && /double counts 2/.test(body));
  check('TV shows arming 0/3', /arming 0\/3/i.test(body));

  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });
  dart(16, 2); await tv.waitForTimeout(500);
  const cel1 = await tv.$eval('#celtext', (el) => el.innerText.replace(/\n/g, ' '));
  check('arming card 2 OF 3 on a double', /2 OF 3/.test(cel1), cel1);

  dart(16, 1); await tv.waitForTimeout(1800);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const t = await tv.$eval('#celtext', (el) => el.innerText.replace(/\n/g, ' ')).catch(() => '');
    if (t && (!seen.length || seen[seen.length - 1] !== t)) seen.push(t);
    await tv.waitForTimeout(350);
  }
  check('KILLER! card after the third hit', seen.some((t) => /KILLER!/.test(t)), seen.join(' | '));

  dart(8, 2); await tv.waitForTimeout(600);
  const sub = await tv.$eval('#celsub', (el) => el.textContent);
  check('double take says 2 lives off Sam', /took 2 lives off Sam/.test(sub) && /1 left/.test(sub), sub);

  const rows = await tv.evaluate(() => document.body.innerText);
  check('scoreboard shows KILLER status and 16 as the number', /KILLER/.test(rows) && /16/.test(rows));

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
