/*
 * broadcasttest.js - the Broadcast pack on the real TV and players' iPad
 * (Chromium) against a real hub (fakeboard.js, board off air):
 *   - graphics tiers: a 180 takes the whole screen (backdrop, no strap); a
 *     Cricket "20 CLOSED" is a slim strap with no backdrop and no shake; a
 *     bust strap never overlaps the visit card; a player's name on a card is
 *     text, never markup; the empty visit card never peeks over the edge;
 *   - walk-on: a new game shows the game, the throwing order and who throws
 *     first, and goes with the first dart; a rematch says REMATCH;
 *   - scoreboard: "LEG 1 · FIRST TO 3", pips, "THROWING" on the thrower, the
 *     leg card's "LEADS 1-0", the gold DECIDING LEG bug and exactly one
 *     DECIDING LEG card at 2-2, "strokes" under Golf's number, nobody
 *     "throwing" once the game is won;
 *   - full time: the stats board after the WINS card's six seconds (winner
 *     in gold, the rematch prompt), gone again on an undo;
 *   - the iPad's end card: Rematch with the next player throwing first (and
 *     "Game on - X throws first"), tonight's score after two games, the tap
 *     board and quick buttons refusing a finished game, Restart needing a
 *     second tap; the Tennis game won is a GAME card and is still called;
 *   - fixes from review: a full-screen card hides the header's venue mark
 *     (one logo, not two); a strap's subtitle is whole (wraps, never "…");
 *     five players' rows all fit with the pips and labels on the score line;
 *     the clock stays in view over the stats board; a rematch gets its own
 *     DECIDING LEG card; a second Rematch never restarts the live rematch;
 *     the 8-player walk-on on a rematch stays on screen; a players' iPad
 *     can't re-arm the cash-prize attempt; two players with one name keep
 *     their own places on "Pick another game"; Restart's line-up warning
 *     isn't wiped by "Game on";
 *   - no page errors.
 * Ports TPORT (default 9610). Data and logs under $DARTS_TEST_TMP/broadcast.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'broadcast');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 9610);
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
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 8 * 60000).unref();

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
  const cels = [], visits = [];
  let dartsSeen = 0;
  s.on('state', (x) => { st = x; });
  s.on('celebrate', (c) => cels.push(c));
  s.on('visit', (v) => visits.push(v));
  s.on('dart', () => { dartsSeen++; });
  let newmatches = 0;
  s.on('newmatch', () => { newmatches++; });
  await until(() => st, 10000);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('sessionStart', 240, 'Broadcast Test');
  await until(() => st.session, 5000);

  const b = await chromium.launch({ executablePath: CHROMIUM, args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  tv.on('pageerror', (e) => errors.push(`tv: ${e.message}`));
  await tv.addInitScript(() => {
    window.__cards = [];
    document.addEventListener('DOMContentLoaded', () => {
      const c = document.getElementById('cel');
      new MutationObserver(() => {
        if (/show/.test(c.className)) {
          const sub = document.getElementById('celsub');
          window.__cards.push({ cls: c.className, text: document.getElementById('celtext').innerText.replace(/\n/g, ' '),
            sub: sub.textContent, shake: document.body.classList.contains('shake'),
            backdrop: getComputedStyle(c.querySelector('.backdrop')).display,
            bb: getComputedStyle(document.getElementById('brandbar')).visibility,
            subWhole: sub.scrollHeight <= sub.clientHeight + 1 && sub.scrollWidth <= sub.clientWidth + 1 });
        }
      }).observe(c, { attributes: true, attributeFilter: ['class'] });
    });
  });
  await tv.goto(`${URL}/tv`);
  const ctx = await b.newContext({ viewport: { width: 1080, height: 736 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => errors.push(`pad: ${e.message}`));
  await pad.addInitScript(() => {
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('toast');
      new MutationObserver(() => { if (el.textContent) window.__toasts.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
  });
  await pad.goto(`${URL}/pad`);
  await wait(1200);
  const cards = () => tv.evaluate(() => window.__cards.splice(0));
  // Cards play one after another: wait for the one wanted to come round
  const seen = [];
  async function cardUntil(re, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
      seen.push(...await cards());
      const i = seen.findIndex((c) => re.test(c.text));
      if (i >= 0) return seen.splice(0, i + 1).pop();
      if (Date.now() > end) return null;
      await wait(100);
    }
  }
  const toasts = () => pad.evaluate(() => window.__toasts.splice(0));
  const dart = async (sc, m = 1) => { s.emit('dart', { score: sc, multiplier: m }); await wait(140); };
  const newMatch = async (req) => {
    s.emit('newMatch', req);
    await until(() => st.match && !st.match.finished && st.match.dartsInLog === 0 && st.match.gameId === req.gameId && st.match.rows.length === req.players.length, 5000);
  };
  const shown = (sel) => tv.evaluate((x) => { const e = document.querySelector(x); return !!e && !e.hidden && e.getClientRects().length > 0; }, sel);

  /* --------------------------------------------- walk-on + graphics tiers -- */
  await cards();
  await newMatch({ gameId: 'x01', variantId: '501', players: [{ name: 'Sam' }, { name: 'Ash' }, { name: 'Jo' }] });
  const intro = await until(() => shown('#intro'), 1500, 30);
  const introText = await tv.evaluate(() => ({ order: [...document.querySelectorAll('#in-order .plate')].map((p) => p.innerText.replace(/\s+/g, '')),
    first: document.getElementById('in-first').innerText, title: document.getElementById('in-title').innerText }));
  check('walk-on: shown as the game starts', !!intro);
  check('walk-on: the throwing order and who throws first', introText.order.join(',') === '1SAM,2ASH,3JO' && /SAM TO THROW FIRST/i.test(introText.first), introText);
  const thr = await tv.evaluate(() => [...document.querySelectorAll('.row')].map((r) => !!r.querySelector('.thr')));
  check('scoreboard: "THROWING" on the thrower only', thr.join() === 'true,false,false', thr);
  await dart(20, 3);
  check('walk-on: gone with the first dart', !!(await until(async () => !(await shown('#intro')), 400, 20)));
  await dart(20, 3); await dart(20, 3); await wait(500);
  const c180 = (await cards()).find((c) => /HUNDRED/.test(c.text));
  check('a 180 takes the whole screen (backdrop, no strap)', c180 && !/strap/.test(c180.cls) && c180.backdrop !== 'none', c180);
  check('...with one venue mark: the header\'s is hidden under the card', c180 && c180.bb === 'hidden', c180);
  const bbBack = await until(() => tv.evaluate(() => !/show/.test(document.getElementById('cel').className) && getComputedStyle(document.getElementById('brandbar')).visibility === 'visible'), 8000, 100);
  check('...and back once the card has gone', !!bbBack);

  await newMatch({ gameId: 'cricket', variantId: 'standard', players: [{ name: 'Sam' }, { name: 'Ash' }] });
  await cards();
  await dart(20, 1); await dart(20, 1); await dart(20, 1); await wait(600);
  const closed = (await cards()).find((c) => /CLOSED/.test(c.text));
  check('"20 CLOSED" is a slim strap: no backdrop, no shake', closed && /strap/.test(closed.cls) && /minor/.test(closed.cls) && closed.backdrop === 'none' && !closed.shake, closed);
  const peek = await tv.evaluate(() => document.getElementById('turncard').getBoundingClientRect().top);
  await until(async () => !(await tv.evaluate(() => document.getElementById('turncard').classList.contains('show'))), 12000, 200);
  await wait(500);
  const hiddenCard = await tv.evaluate(() => { const t = document.getElementById('turncard'); return { top: t.getBoundingClientRect().top, vis: getComputedStyle(t).visibility, h: innerHeight }; });
  check('the empty visit card is out of sight (not peeking over the edge)', hiddenCard.vis === 'hidden' || hiddenCard.top >= hiddenCard.h, { peek, ...hiddenCard });

  // A bust: a red strap, clear of the visit card that shows at the same time
  await newMatch({ gameId: 'x01', variantId: '301', players: [{ name: 'Sam' }, { name: 'Ash' }] });
  await dart(20, 3); await dart(20, 3); await dart(20, 3);      // Sam 121
  await dart(0); await dart(0); await dart(0);                   // Ash
  await cards();
  await dart(20, 3); await dart(20, 3);                          // Sam 1 left: bust
  const both = await until(() => tv.evaluate(() => {
    const c = document.getElementById('cel'), t = document.getElementById('turncard');
    if (!/strap/.test(c.className) || !t.classList.contains('show')) return null;
    const a = c.getBoundingClientRect(), q = t.getBoundingClientRect();
    return { overlap: !(a.right <= q.left || q.right <= a.left || a.bottom <= q.top || q.bottom <= a.top), cls: c.className };
  }), 3000, 30);
  check('a bust is a red strap clear of the visit card', both && /bust/.test(both.cls) && !both.overlap, both);
  const bustCard = (await cards()).find((c) => /BUST/.test(c.text));
  check('...with no screen shake', bustCard && !bustCard.shake, bustCard);
  check('...and its subtitle whole (the reason is never cut off)', bustCard && bustCard.subWhole, bustCard);

  // A name is text on every card
  const evil = '<img src=x onerror=window.__x=1>';
  await newMatch({ gameId: 'x01', variantId: '301', players: [{ name: evil }] });
  for (const [sc, m] of [[20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [2, 2]]) await dart(sc, m);
  await until(() => st.match.finished, 3000);
  const winsCard = await cardUntil(/WINS/);
  const x = await tv.evaluate(() => window.__x);
  check('a player\'s name on a card is text, never markup', !!winsCard && x === undefined && /<img/i.test(winsCard.text), { x, card: winsCard });

  /* ---------------------------------------------- five players still fit -- */
  const five = ['Samantha', 'Alexander', 'Priyanka', 'Christopher', 'Elizabeth'].map((name) => ({ name }));
  for (const g of [{ gameId: 'killer' }, { gameId: 'golf' }, { gameId: 'x01', variantId: '501', config: { legsToWin: 3 } }]) {
    await newMatch({ ...g, players: five });
    await wait(300);
    const fit = await tv.evaluate(() => { const box = document.getElementById('rows').getBoundingClientRect();
      return [...document.querySelectorAll('#rows .row')].map((r) => r.getBoundingClientRect().bottom <= box.bottom + 1); });
    check(`five players: every row whole on the TV (${g.gameId}${g.config ? ', first to 3' : ''})`, fit.length === 5 && fit.every(Boolean), fit);
  }

  /* ------------------------------------------------- legs and the decider -- */
  await cards(); cels.length = 0;
  await newMatch({ gameId: 'x01', variantId: '301', config: { legsToWin: 3 }, players: [{ name: 'Sam' }, { name: 'Ash' }] });
  const bug1 = await tv.evaluate(() => document.getElementById('gbug').innerText);
  check('the score bug: "LEG 1 · FIRST TO 3"', /LEG 1 · FIRST TO 3/i.test(bug1), bug1);
  const head2 = await tv.evaluate(() => { const t = document.getElementById('gtitle'), g = document.getElementById('gsub');
    return { title: t.innerText, oneLine: t.getClientRects().length === 1 && t.getBoundingClientRect().height < parseFloat(getComputedStyle(t).fontSize) * 1.6, subWhole: g.scrollWidth <= g.clientWidth + 1 }; });
  check('...and the title doesn\'t say it again: "301", on one line, the subtitle whole', /^301$/.test(head2.title.trim()) && head2.oneLine && head2.subWhole, head2);
  const pips = await tv.evaluate(() => document.querySelector('.row .pips') && document.querySelector('.row .pips').textContent);
  check('leg pips beside each score (none won of three)', pips === '○○○', pips);
  const WIN = [[20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [2, 2]];
  async function legTo(name) {
    const leg = st.match.legNumber;
    let k = 0;
    for (let guard = 0; guard < 40 && st.match.legNumber === leg && !st.match.finished; guard++) {
      const active = st.match.rows.find((r) => r.active);
      if (active && active.name === name) { const [sc, m] = WIN[k++]; await dart(sc, m); } else { await dart(0); }
      await until(() => true, 10);
    }
  }
  seen.length = 0;
  await legTo('Sam');
  const leg1 = await cardUntil(/LEG WON/);
  check('the leg card says who leads: "SAM LEADS 1-0"', leg1 && /SAM LEADS 1-0/i.test(leg1.sub) && /strap/.test(leg1.cls), leg1);
  await legTo('Ash'); await legTo('Sam'); await wait(200);
  await legTo('Ash'); await wait(600);
  const dec = await tv.evaluate(() => ({ cls: document.getElementById('gbug').className, text: document.getElementById('gbug').innerText }));
  check('at 2-2 the bug turns gold: DECIDING LEG', /decider/.test(dec.cls) && /DECIDING LEG/i.test(dec.text), dec);
  const decCard = await cardUntil(/DECIDING LEG/, 20000);
  await wait(3000);
  seen.push(...await cards());
  check('...and one DECIDING LEG card (a strap)', !!decCard && /strap/.test(decCard.cls) && !seen.some((c) => /DECIDING LEG/.test(c.text)), { decCard, more: seen.filter((c) => /DECIDING/.test(c.text)) });
  await legTo('Sam');
  await until(() => st.match.finished, 4000);
  check('nobody is "throwing" once the game is won', !(await tv.evaluate(() => !!document.querySelector('.row.on'))) && st.match.rows.every((r) => !r.active));

  /* --------------------------------------------------------- full time -- */
  await wait(3000);
  check('full time: not over the WINS card (nothing at 3 s)', !(await shown('#final')));
  const fin = await until(() => shown('#final'), 30000, 100);
  const finTxt = await tv.evaluate(() => ({ head: document.getElementById('fn-head').innerText, win: !!document.querySelector('.fn-col.win'), winName: document.querySelector('.fn-col.win .fn-nm') && document.querySelector('.fn-col.win .fn-nm').innerText, prompt: document.getElementById('fn-prompt').innerText }));
  check('full time: the stats board after the WINS card', !!fin && /SAM WINS/i.test(finTxt.head) && finTxt.win && /SAM/i.test(finTxt.winName) && /Rematch/i.test(finTxt.prompt), finTxt);
  check('...with no visit card over it', !(await tv.evaluate(() => document.getElementById('turncard').classList.contains('show'))));
  const clockSeen = await tv.evaluate(() => { const c = document.getElementById('sessclock'); if (c.hidden) return 'hidden';
    const r = c.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === c || c.contains(e)); });
  check('...and the session clock still in view over it', clockSeen === true, clockSeen);
  s.emit('undo');
  check('an undo of the winning dart takes the board away', !!(await until(async () => !(await shown('#final')), 600, 20)));
  await legTo('Sam');
  await until(() => st.match.finished, 4000);

  /* ------------------------------------------------- the iPad's end card -- */
  await pad.evaluate(() => document.querySelector('nav.tabs button[data-tab="play"]').click());
  const ec = await until(() => pad.evaluate(() => { const e = document.getElementById('winbanner'); return !e.hidden && e.getClientRects().length ? { head: document.getElementById('ec-head').innerText, btn: document.getElementById('btn-rematch').innerText } : null; }), 4000);
  check('iPad: the end card with the winner and Rematch (Ash first)', ec && /Sam wins/i.test(ec.head) && /Ash/i.test(ec.btn), ec);
  const d0 = dartsSeen;
  await toasts();
  await pad.evaluate(() => document.querySelector('[data-dart="20,3"]').click());
  await wait(500);
  const t1 = await toasts();
  check('iPad: a quick button on a finished game says so and sends nothing', dartsSeen === d0 && t1.some((t) => /Game over/i.test(t)), { sent: dartsSeen - d0, t1 });
  await pad.evaluate(() => document.getElementById('btn-rematch').click());
  const re = await until(() => st.match && !st.match.finished && st.match.dartsInLog === 0 && st.match.rows[0].name === 'Ash', 4000);
  check('Rematch: the same game, Ash throws first', !!re && st.match.rows.find((r) => r.active).name === 'Ash', st.match && st.match.rows.map((r) => `${r.name}${r.active ? '*' : ''}`));
  const reIntro = await until(() => tv.evaluate(() => { const e = document.getElementById('intro'); return !e.hidden && document.getElementById('in-extra').innerText; }), 1500, 30);
  check('the walk-on says REMATCH and tonight\'s score', reIntro && /REMATCH/i.test(reIntro) && /TONIGHT/i.test(reIntro), reIntro);
  const t2 = await until(async () => { const t = await toasts(); return t.find((x) => /Ash throws first/i.test(x)); }, 2000);
  check('iPad: "Game on - Ash throws first"', !!t2, t2);
  await wait(300);
  const nm0 = newmatches;
  await dart(0);
  s.emit('restart', { rotate: true });              // a second device's late Rematch
  await wait(600);
  check('a second Rematch never restarts the live rematch', newmatches === nm0 && st.match.dartsInLog === 1 && st.match.rows[0].name === 'Ash',
    { extra: newmatches - nm0, darts: st.match.dartsInLog });
  // A second finish, by way of 2-2: the rematch gets its own DECIDING LEG card
  await legTo('Ash'); await legTo('Sam'); await legTo('Ash'); await wait(200);
  seen.length = 0; await cards();
  await legTo('Sam');
  const dec2 = await cardUntil(/DECIDING LEG/, 20000);
  check('the rematch gets its own DECIDING LEG card', !!dec2, dec2);
  await legTo('Ash');
  await until(() => st.match.finished, 4000);
  await until(() => (st.history || []).length >= 2, 4000);
  const tally = await until(() => pad.evaluate(() => document.getElementById('ec-tally').innerText), 3000);
  check('iPad: tonight\'s score after two games', tally && /Tonight/i.test(tally) && /1-1/.test(tally), tally);
  check('...counted by the hub over the whole session', st.tonight && st.tonight.games === 2, st.tonight);
  const tvTally = await until(() => tv.evaluate(() => { const e = document.getElementById('fn-tally'); return !document.getElementById('final').hidden && !e.hidden && e.innerText; }), 30000, 200);
  check('TV: tonight\'s score on the stats board', tvTally && /TONIGHT/i.test(tvTally) && /1-1/.test(tvTally), tvTally);

  // Restart needs a second tap
  await pad.evaluate(() => document.querySelector('nav.tabs button[data-tab="fix"]').click());
  await toasts();
  const k0 = st.match.dartsInLog;
  await pad.evaluate(() => document.getElementById('btn-restart').click());
  await wait(500);
  const t3 = await toasts();
  check('Restart asks for a second tap first', st.match.dartsInLog === k0 && st.match.finished && t3.some((t) => /Tap again/i.test(t)), { t3 });
  await pad.evaluate(() => document.getElementById('btn-restart').click());
  check('...and restarts on the second', !!(await until(() => st.match && !st.match.finished && st.match.dartsInLog === 0, 3000)));

  /* ----------------------------------------------- labels and Tennis -- */
  await newMatch({ gameId: 'golf', players: [{ name: 'Sam' }] });
  const lbl = await until(() => tv.evaluate(() => document.querySelector('.row .plabel') && document.querySelector('.row .plabel').innerText), 3000);
  check('Golf: "strokes" beside the big number', /STROKES/i.test(lbl || ''), lbl);
  await newMatch({ gameId: 'tennis', players: [{ name: 'Sam' }, { name: 'Ash' }] });
  cels.length = 0; visits.length = 0; await cards();
  for (let i = 0; i < 40 && !cels.some((c) => c.type === 'gamewin'); i++) {
    const active = st.match.rows.find((r) => r.active);
    if (active.name === 'Sam') { await dart(20, 3); await dart(20, 3); await dart(20, 3); } else { await dart(1); await dart(1); await dart(1); }
  }
  const gw = cels.find((c) => c.type === 'gamewin');
  check('Tennis: a game won is a GAME, not a leg', !!gw && !cels.some((c) => c.type === 'legwin'), cels.map((c) => c.type));
  await wait(400);
  check('...and it is still called', visits.some((v) => v.special === 'legwin'), visits.map((v) => v.special));

  /* ------------------------------------------ eight players, a rematch -- */
  const eight = ['Samantha Jones', 'Alexander Smith', 'Jo', 'Priyanka Patel', 'Bob', 'Christopher Moore', 'Mo', 'Elizabeth Moore'].map((name) => ({ name }));
  await newMatch({ gameId: 'x01', variantId: '301', players: eight });
  for (const [sc, m] of [[20, 3], [20, 3], [20, 3]]) await dart(sc, m);
  for (let i = 0; i < 21; i++) await dart(0);
  for (const [sc, m] of [[20, 3], [19, 3], [2, 2]]) await dart(sc, m);
  await until(() => st.match.finished, 4000);
  s.emit('restart', { rotate: true });
  await until(() => tv.evaluate(() => !document.getElementById('intro').hidden), 3000, 30);
  await wait(600);                                   // settled after sliding in
  const in8 = await until(() => tv.evaluate(() => { const e = document.getElementById('intro'); if (e.hidden) return null;
    const r = e.getBoundingClientRect(), f = document.getElementById('in-first'), o = document.getElementById('in-order').getBoundingClientRect();
    return { on: r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, tall: Math.round(r.height / innerHeight * 100),
      firstWhole: f.scrollWidth <= f.clientWidth + 1 && f.scrollHeight <= f.clientHeight + 1, orderW: Math.round(o.width / r.width * 100), first: f.innerText, extra: document.getElementById('in-extra').innerText }; }), 3000, 30);
  check('8 players, rematch: the walk-on is on screen, "X to throw first" whole, the order not squeezed',
    in8 && in8.on && in8.firstWhole && in8.orderW >= 30 && in8.tall <= 30 && /ALEXANDER SMITH TO THROW FIRST/i.test(in8.first) && /REMATCH/i.test(in8.extra), in8);

  /* ------------------------------------------------ the cash prize -- */
  s.emit('prizeStart', { name: 'Pat' });
  await until(() => st.match && st.match.prize && st.match.dartsInLog === 0, 4000);
  await dart(1);                                     // not a perfect dart: the attempt has failed
  await until(() => st.match.prize && st.match.prize.failed, 3000);
  await pad.evaluate(() => document.querySelector('nav.tabs button[data-tab="fix"]').click());
  await toasts();
  await pad.evaluate(() => document.getElementById('btn-restart').click());
  await pad.evaluate(() => document.getElementById('btn-restart').click());
  await wait(500);
  const tp = await toasts();
  const p2 = io(URL, { transports: ['websocket'] });   // any other players' device, not unlocked
  await until(() => p2.connected, 3000);
  p2.emit('restart');
  await wait(600);
  check('the players\' iPad can\'t re-arm a failed cash-prize attempt', st.match.prize && st.match.prize.failed && st.match.dartsInLog === 1
    && tp.some((t) => /started by staff/i.test(t)), { prize: st.match.prize, darts: st.match.dartsInLog, tp });
  p2.close();
  s.emit('endMatch');
  await until(() => !st.match, 3000);

  /* ------------------------------------ two players with the same name -- */
  const add = (n) => new Promise((r) => s.emit('addPlayer', n, r));
  const r1 = await add('Sam'), r2 = await add('Sam'), r3 = await add('Ash');
  await newMatch({ gameId: 'x01', variantId: '301', players: [r1, r2, r3].map((p) => ({ id: p.id, name: p.name })) });
  await pad.evaluate(() => document.querySelector('nav.tabs button[data-tab="fix"]').click());
  await pad.evaluate(() => document.getElementById('btn-change').click());
  const sel = await until(() => pad.evaluate(() => { const b = [...document.querySelectorAll('#playerpick .chipbtn.sel')]; return b.length ? b.map((x) => x.textContent) : null; }), 3000);
  check('"Pick another game" keeps both Sams (each by their own place)', sel && sel.length === 3, sel);

  /* ----------------------------- Restart's line-up warning stays readable -- */
  await newMatch({ gameId: 'x01', variantId: '301', players: [r1, r3].map((p) => ({ id: p.id, name: p.name })) });
  await pad.evaluate(() => document.querySelector('nav.tabs button[data-tab="setup"]').click());
  await pad.evaluate(() => { const b = [...document.querySelectorAll('#playerpick .chipbtn')].find((x) => x.textContent === 'Ash' && x.classList.contains('sel')); if (b) b.click(); });
  await pad.evaluate(() => document.querySelector('nav.tabs button[data-tab="fix"]').click());
  await toasts();
  await pad.evaluate(() => document.getElementById('btn-restart').click());
  await pad.evaluate(() => document.getElementById('btn-restart').click());
  const kept = await until(async () => { const t = await pad.evaluate(() => document.getElementById('toast').textContent); return /SAME line-up/.test(t) && /throws first/.test(t) ? t : null; }, 3000);
  check('Restart\'s "SAME line-up" warning isn\'t wiped by "Game on"', !!kept, await toasts());

  check('no page errors on the TV or the iPad', errors.length === 0, errors);
  s.close();
  await b.close();
  hub.kill('SIGTERM');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
