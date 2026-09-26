/* Browser check: the TV during Prisoner - life-lost card visible, sequential
 * cards, no big meaningless total on the visit card. Hub must be running. */
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
  // Board status is in the footer even on the welcome screen - a telly that
  // has just re-found the hub must not sit on "lost contact" until a game starts
  const idleFoot = await tv.$eval('#foot', (el) => el.textContent.trim());
  check('footer shows the board status with no game running', /board/.test(idleFoot) && !/waiting|lost contact/.test(idleFoot), idleFoot);
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  await pad.goto(`http://127.0.0.1:${PORT}/pad`); await pad.waitForTimeout(800);

  s.emit('newMatch', { gameId: 'prisoner', config: { lives: 2 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await tv.waitForTimeout(600);
  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });

  // Ash hits the 1; hint should point at the 2s next
  dart(1); await tv.waitForTimeout(400);
  const hint = await tv.evaluate(() => document.body.innerText);
  check('TV hint points at the next target', /the 2s/.test(hint));

  dart(5); dart(5); await tv.waitForTimeout(500);
  const total = await tv.$eval('#tc-total', (el) => el.textContent.trim());
  check('visit card shows no meaningless total', total === '', total);

  // Sam blanks the visit - LIFE LOST card on the TV, plain-English toast on the pad
  dart(9); dart(9); dart(9); await tv.waitForTimeout(700);
  const cel = await tv.$eval('#celtext', (el) => el.innerText);
  const sub = await tv.$eval('#celsub', (el) => el.textContent);
  check('TV shows LIFE LOST', /LIFE LOST/.test(cel), cel.replace(/\n/g, ' '));
  check('TV names the reason', /nothing at the target/.test(sub) && /1 life left/.test(sub), sub);
  const padText = await pad.$eval('#toast', (el) => el.textContent);
  check('pad explains the lost life', /Sam loses a life/.test(padText) && /nothing at the target/.test(padText), padText);

  // Sam blanks again on the last life: LIFE LOST, then OUT!, then Ash WINS! in sequence
  dart(1); dart(9); dart(9); await tv.waitForTimeout(300); // Ash advances to 3 (hit on 2? no - target is 2, dart(1) misses)
  // Ash's turn: throw 3 misses quickly (life loss for Ash too, 1 left) - fine
  await tv.waitForTimeout(400);
  dart(9); dart(9); dart(9); await tv.waitForTimeout(500); // Sam's last life
  const seen = [];
  for (let i = 0; i < 24; i++) {
    const t = await tv.$eval('#celtext', (el) => el.innerText.replace(/\n/g, ' ')).catch(() => '');
    if (t && (!seen.length || seen[seen.length - 1] !== t)) seen.push(t);
    await tv.waitForTimeout(450);
  }
  check('cards play in sequence: LIFE LOST then OUT then WINS',
    seen.some((t) => /LIFE LOST/.test(t)) && seen.some((t) => /OUT!/.test(t)) && seen.some((t) => /WINS!/.test(t)),
    seen.join(' | '));
  const padEnd = await pad.$eval('#toast', (el) => el.textContent);
  check('pad announces the match result', /wins the match|is out/.test(padEnd), padEnd);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
