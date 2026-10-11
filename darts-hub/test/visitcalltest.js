/*
 * visitcalltest.js - a visit's score counts up on the TV dart by dart, and
 * the caller calls it once, after the visit: the third dart, or the bust,
 * checkout or pass that ends it early. Solo games too (they used to be
 * silent - the turn never passed, so nothing was ever called).
 *
 * Drives the real TV page (Chromium) against a real hub (fakeboard.js,
 * board off air) and records the clips the caller actually played:
 *   - solo X01: dart 1 and dart 2 are not called, the running total counts
 *     up on the TV (in-between values seen) and lands on the right number;
 *     after dart 3 the total is called once and the visit card shows it;
 *     the next visit starts again from that dart's score, not a count;
 *   - a bust on dart 2 is called at once; a pass after one dart is called
 *     as that dart's score; an undo calls nothing;
 *   - two players: one call per visit, as before;
 *   - solo Count-up is called too;
 *   - Cricket: "dart 1 of 3", no big total, no total called;
 *   - no page errors.
 * Ports TPORT (default 9590). Data and logs under $DARTS_TEST_TMP/visitcall.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'visitcall');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 9590);
const URL = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const DATA = path.join(SP, 'hub');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

let hub = null;
process.on('exit', () => { try { if (hub && !hub.exited) hub.kill('SIGKILL'); } catch (_) {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 5 * 60000).unref();

async function startHub() {
  fs.rmSync(SP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ adminPin: '1234', pricePerHour: 10, autoConnect: false, screensaverMinutes: 0 }));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: path.join(SP, 'reports'),
    DARTS_SCREENSAVER: path.join(SP, 'screen saver'), FAKE_FIRST_ABSENT: '1' });
  const fd = fs.openSync(path.join(SP, 'hub.log'), 'a');
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], { env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  k.on('exit', () => { k.exited = true; });
  const up = await until(async () => {
    const j = await (await fetch(`${URL}/api/hub-id`)).json();
    return j && j.pid === k.pid;
  }, 20000, 150);
  if (!up) throw new Error(`hub did not come up (see ${path.join(SP, 'hub.log')})`);
  return k;
}

(async () => {
  hub = await startHub();
  const s = io(URL, { transports: ['websocket'] });
  let st = null;
  const visits = [];
  s.on('state', (x) => { st = x; });
  s.on('visit', (v) => visits.push(v));
  await until(() => st, 10000);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('sessionStart', 120, 'Visit Test');
  await wait(300);

  const b = await chromium.launch({ executablePath: CHROMIUM, args: ['--autoplay-policy=no-user-gesture-required'] });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  tv.on('pageerror', (e) => errors.push(e.message));
  // The clips the caller actually played (preloaded ones included), and
  // every value the big running total showed.
  await tv.addInitScript(() => {
    window.__said = [];
    const tagOf = new WeakMap();
    const origFetch = window.fetch;
    window.fetch = function (url, ...rest) {
      return origFetch.call(this, url, ...rest).then((res) => {
        const m = /\/sounds\/([^/?]+)\.mp3/.exec(String(url));
        if (m) { const oab = res.arrayBuffer.bind(res); res.arrayBuffer = () => oab().then((ab) => { tagOf.set(ab, m[1]); return ab; }); }
        return res;
      });
    };
    const AC = window.AudioContext || window.webkitAudioContext;
    const origDecode = AC.prototype.decodeAudioData;
    AC.prototype.decodeAudioData = function (ab, ok, bad) {
      const tag = tagOf.get(ab);
      return origDecode.call(this, ab, (buf) => { if (tag) buf.__tag = tag; if (ok) ok(buf); }, bad);
    };
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      if (this.buffer && this.buffer.__tag) window.__said.push(this.buffer.__tag);
      return origStart.apply(this, a);
    };
    window.__nums = [];
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('visitnum');
      new MutationObserver(() => window.__nums.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
  });
  await tv.goto(`${URL}/tv`);
  await wait(1200);
  await tv.mouse.click(10, 10);                 // the daily unlock tap: lets the caller speak
  const said = () => tv.evaluate(() => window.__said.splice(0).filter((c) => c !== 'welcome'));
  const nums = () => tv.evaluate(() => window.__nums.splice(0));
  const num = () => tv.$eval('#visitnum', (el) => el.textContent);
  const label = () => tv.$eval('#visitlabel', (el) => el.textContent.trim());
  const card = () => tv.evaluate(() => ({ show: document.getElementById('turncard').classList.contains('show'), total: document.getElementById('tc-total').textContent, name: document.getElementById('tc-name').textContent }));
  const dart = async (sc, m = 1) => { s.emit('dart', { score: sc, multiplier: m }); await wait(450); };
  const game = async (req) => { s.emit('newMatch', req); await until(() => st && st.match && st.match.dartsInLog === 0 && !st.match.finished, 5000); await wait(500); await said(); await nums(); visits.length = 0; };

  /* ----------------------------------------------------------- solo X01 -- */
  await game({ gameId: 'x01', variantId: '501', players: [{ name: 'Solo' }] });
  await dart(20, 1);
  check('dart 1: the running total shows 20', (await num()) === '20' && (await label()) === 'this visit', [await num(), await label()]);
  check('...and nothing is called yet', (await said()).length === 0 && visits.length === 0);
  await nums();
  await dart(20, 3);
  const climb = await nums();
  check('dart 2: the total counts up to 80 (values in between shown)', (await num()) === '80' && climb.some((v) => Number(v) > 20 && Number(v) < 80), climb);
  check('...still nothing called', (await said()).length === 0 && visits.length === 0);
  await dart(20, 3);
  await until(() => tv.evaluate(() => window.__said.some((c) => /^total-/.test(c))), 3000);
  await wait(400);
  const all3 = await said();
  check('dart 3: the visit is called once, as its total ("140")', visits.length === 1 && visits[0].total === 140 && all3.filter((c) => /^total-/.test(c)).join() === 'total-140', { visits: visits.map((v) => v.total), said: all3 });
  const cd = await card();
  check('...and the visit card shows Solo 140', cd.show && cd.total === '140' && cd.name === 'Solo', cd);
  check('...the running total is now "last visit 140"', (await label()) === 'last visit' && (await num()) === '140');
  await nums();
  await dart(5, 1);
  const fresh = await nums();
  check('the next visit starts from that dart (5), not a count from 140', (await num()) === '5' && !fresh.some((v) => Number(v) > 5), fresh);
  check('...and the visit card goes away', !(await card()).show);

  // A pass after one dart: that dart's score is the visit, called at once.
  visits.length = 0;
  s.emit('endTurn'); await wait(600);
  const passSaid = await said();
  check('a pass after one dart is called as that score (5)', visits.length === 1 && visits[0].total === 5 && passSaid.includes('total-5'), { v: visits.map((x) => x.total), passSaid });

  // An undo is not a new visit: nothing called.
  visits.length = 0;
  s.emit('undo'); await wait(600);
  check('an undo calls nothing', visits.length === 0 && (await said()).length === 0, { v: visits.length });

  /* --------------------------------------------- a bust ends it early -- */
  await game({ gameId: 'x01', variantId: '301', players: [{ name: 'Solo' }] });
  for (let i = 0; i < 3; i++) await dart(20, 3);     // 301 -> 121
  await said(); visits.length = 0;
  await dart(20, 3);                                  // 61
  check('(61 left after one dart)', visits.length === 0);
  await dart(20, 3);                                  // 1 left: bust (left on 1) on dart 2
  await wait(300);
  const bustSaid = await said();
  check('a bust on dart 2 is called at once ("bust", no total)', visits.length === 1 && visits[0].special === 'bust' && bustSaid.includes('bust') && !bustSaid.some((c) => /^total-/.test(c)), { v: visits, bustSaid });

  /* ------------------------------------------------------ two players -- */
  await game({ gameId: 'x01', variantId: '501', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  for (let i = 0; i < 3; i++) await dart(19, 1);
  for (let i = 0; i < 3; i++) await dart(18, 1);
  await wait(400);
  const twoSaid = (await said()).filter((c) => /^total-/.test(c));
  check('two players: one call per visit (57, then 54)', visits.map((v) => `${v.player}:${v.total}`).join() === 'Ash:57,Sam:54' && twoSaid.join() === 'total-57,total-54', { v: visits.map((v) => `${v.player}:${v.total}`), twoSaid });

  /* ------------------------------------------------------ solo Count-up -- */
  await game({ gameId: 'countup', players: [{ name: 'Solo' }] });
  await dart(20, 1); await dart(20, 1);
  check('Count-up: not called mid-visit', visits.length === 0 && (await said()).length === 0);
  await dart(20, 1); await wait(300);
  check('Count-up solo: called after the third dart (60)', visits.length === 1 && visits[0].total === 60 && (await said()).includes('total-60'), visits.map((v) => v.total));

  /* ------------------------------------------- Cricket: no board total -- */
  await game({ gameId: 'cricket', variantId: 'standard', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await dart(20, 1);
  check('Cricket: "dart 1 of 3" and no big total', (await label()) === 'dart 1 of 3' && (await num()) === '', [await label(), await num()]);
  await dart(20, 1); await dart(20, 1); await wait(300);
  check('Cricket: the visit ends with no total called', visits.length === 1 && visits[0].noscore && !(await said()).some((c) => /^total-/.test(c)));

  check('no page errors on the TV', errors.length === 0, errors);
  s.close();
  await b.close();
  hub.kill('SIGTERM');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
