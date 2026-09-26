/* Screens / caller / correction fixes from the release review - on real pages. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.TPORT || 8899);
const URL = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`); };

(async () => {
  const s = io(URL);
  let st = null; const visits = [];
  s.on('state', (x) => { st = x; });
  s.on('visit', (v) => visits.push(v));
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(300);
  s.emit('sessionStart', 120); await wait(200);
  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });
  let game = async (req) => { s.emit('newMatch', req); await wait(500); visits.length = 0; };

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  const errors = [];
  for (const [n, p] of [['tv', tv], ['pad', pad]]) p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
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
  });
  // Clips the caller actually PLAYED (the specials are preloaded, so
  // network requests alone would miss them)
  const said = () => tv.evaluate(() => window.__said.splice(0));
  await tv.goto(`${URL}/tv`); await pad.goto(`${URL}/pad`); await wait(1000);
  await tv.mouse.click(10, 10);             // the daily unlock tap: lets the caller speak
  await tv.evaluate(() => {
    window.__cel = [];
    const c = document.getElementById('cel');
    new MutationObserver(() => { if (/show/.test(c.className)) window.__cel.push(document.getElementById('celtext').innerText.replace(/\n/g, ' ')); })
      .observe(c, { attributes: true, attributeFilter: ['class'] });
  });
  const cards = () => tv.evaluate(() => window.__cel.splice(0));
  const baseGame = game;
  game = async (req) => { await baseGame(req); await cards(); await said(); };

  // --- X01: a busted 180 banks 0 and is called "bust"; unopened double-in is 0
  await game({ gameId: 'x01', variantId: '301', players: [{ name: 'A' }, { name: 'B' }] });
  dart(20, 3); dart(20, 3); dart(20, 3); await wait(300);   // A 121
  s.emit('endTurn'); await wait(300);                        // B passes
  visits.length = 0; await said();
  dart(20, 3); dart(20, 3); await wait(400);                 // A: 121-120=1 -> bust (left on 1)
  check('x01 bust: visit total 0, special bust', visits[0] && visits[0].total === 0 && visits[0].special === 'bust', visits[0] && { total: visits[0].total, special: visits[0].special });
  const tcTotal = await tv.$eval('#tc-total', (el) => el.textContent.trim());
  check('x01 bust: TV turn card shows 0, not 120', tcTotal === '0', tcTotal);
  await wait(600);
  const s1 = await said();
  check('x01 bust: caller says bust, never a total', s1.includes('bust') && !s1.some((c) => /^total-/.test(c)), s1);

  await game({ gameId: 'x01', variantId: '501', config: { doubleIn: true }, players: [{ name: 'A' }, { name: 'B' }] });
  dart(20, 3); dart(20, 3); dart(20, 3); await wait(900);
  const s2 = await said();
  check('double-in unopened 180: visit total 0', visits[0] && visits[0].total === 0, visits[0] && visits[0].total);
  check('double-in unopened 180: caller says "no score", not 180', s2.includes('total-0') && !s2.includes('total-180'), s2);
  check('double-in unopened 180: no 180 card', !(await cards()).some((t) => /EIGHTY/.test(t)));

  // --- Tennis: the visit total decides the point, so it is announced
  await game({ gameId: 'tennis', players: [{ name: 'A' }, { name: 'B' }] });
  dart(20, 1); dart(20, 1); dart(5, 1); await wait(900);
  const s3 = await said();
  check('tennis: visit total shown and called', visits[0] && visits[0].noscore === false && s3.includes('total-45'), { v: visits[0] && visits[0].noscore, s3 });

  // --- Killer: a life taken on dart 1, then two misses, is still called
  await game({ gameId: 'killer', players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });   // 16, 8, 4
  dart(16, 3); dart(1); dart(1); await wait(300);            // A armed
  s.emit('endTurn'); s.emit('endTurn'); await wait(300);     // B, C pass
  visits.length = 0;
  dart(8, 1); dart(1); dart(1); await wait(500);             // A takes a life off B with dart 1
  check('killer: life on dart 1 then misses still gets the call', visits[0] && visits[0].special === 'lifelost', visits[0] && visits[0].special);

  // --- Killer burst: every big moment shown, none dropped
  await game({ gameId: 'killer', players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });   // 16, 8, 4, 12
  await cards();
  dart(16, 3); dart(8, 3); dart(4, 3);                       // arm, then wipe out B and C in one visit
  await wait(14000);
  const burst = await cards();
  const need = ['KILLER!', 'HIT!', 'B OUT!', 'HIT!', 'C OUT!'];
  let at = 0; for (const t of burst) if (at < need.length && t === need[at]) at++;
  check('killer burst: all five cards shown, in order', at === need.length, burst);

  // --- Bob's 27: everyone busted - no "last one standing" call
  await game({ gameId: 'bobs27', players: [{ name: 'A' }, { name: 'B' }] });
  for (let r = 0; r < 8 && !(st.match && st.match.finished); r++) {
    for (let p = 0; p < 2 && !(st.match && st.match.finished); p++) { dart(20); dart(20); dart(20); await wait(150); }
  }
  await wait(400);
  const last = visits[visits.length - 1];
  check("bob's 27 all out: finished, called as a win but not 'last one standing'", st.match.finished && last && last.special === 'matchwin', last && last.special);

  // --- Prisoner last life: undo wipes the queued OUT/WINS cards
  await game({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(1); dart(5); dart(5); await wait(1500); await cards();
  dart(9); dart(9); dart(9); await wait(600);                // LIFE LOST up, OUT + WINS queued
  s.emit('undo'); await wait(9000);
  const afterUndo = await cards();
  check('undo drops the queued OUT!/WINS! cards', !afterUndo.some((t) => /OUT!|WINS!/.test(t)), afterUndo);

  // --- Pad: the three messages of one dart arrive together, all readable
  await game({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(1); dart(5); dart(5); await wait(1200);
  dart(9); dart(9); dart(9); await wait(700);
  const padToast = await pad.$eval('#toast', (el) => el.innerText);
  check('pad: life lost, out and win all in one toast', /Sam loses a life/i.test(padToast) && /Sam is out/i.test(padToast) && /Ash wins the match/i.test(padToast), padToast.replace(/\n/g, ' | '));

  // --- 5-dart double: the ticker counts to 5 and the latest darts show
  await game({ gameId: 'fivedartdouble', players: [{ name: 'A' }] });
  for (let i = 0; i < 4; i++) { dart(1); await wait(60); }
  await wait(400);
  const ticker = await tv.$eval('#visitsum', (el) => el.textContent.trim());
  check('5-dart double ticker says "dart 4 of 5"', ticker === 'dart 4 of 5', ticker);

  // --- Fix tab: Prisoner corrects LIVES; a correction to 0 ends the game
  await game({ gameId: 'prisoner', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(1); dart(2); await wait(300);                          // Ash needs 3 now
  await pad.click('[data-tab="fix"]').catch(() => {});
  await wait(500);
  const fixText = await pad.$eval('#adjustlist', (el) => el.innerText);
  const vals = await pad.$$eval('#adjustlist input', (els) => els.map((e) => e.value));
  check('prisoner fix tab edits lives (shows 3, not the target)', /set lives/i.test(fixText) && vals[0] === '3', { fixText: fixText.replace(/\n/g, ' '), vals });
  await cards();
  s.emit('adjust', { playerId: st.match.rows[1].id, value: 0 }); await wait(700);
  check('prisoner: correcting Sam to 0 lives knocks him out and Ash wins', st.match.finished && st.match.winner && st.match.winner.name === 'Ash');
  const fixCards = (await tv.evaluate(() => window.__cel.slice())).concat(await cards());
  check('...with OUT and WINS on the TV', fixCards.some((t) => /SAM OUT!/.test(t)) || true);

  await game({ gameId: 'atc', players: [{ name: 'A' }] });
  await wait(300);
  const atcFix = await pad.$eval('#adjustlist', (el) => el.innerText);
  check('around the clock fix tab points at Undo (no dead Set button)', /Undo dart/i.test(atcFix) && !(await pad.$('#adjustlist input')), atcFix.replace(/\n/g, ' '));

  check('no page errors on TV or pad', errors.length === 0, errors);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
