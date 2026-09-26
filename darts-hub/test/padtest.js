/* The players' iPad between groups and with no game on: the last group's
 * line-up never carries over to the next group, the closed banner shows on
 * every tab (not just New game), the Fix-tab game controls say "No game
 * running" instead of pretending, and a long toast fits the screen above
 * the tab bar. Real pad page, real taps. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Under a loaded machine (other suites/agents running alongside) a fixed
// wait after a socket round trip can come up short; poll instead.
async function untilTrue(fn, ms = 3000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await wait(100); }
  return last;
}
const PORT = Number(process.env.TPORT || 8877);
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`); };

(async () => {
  const s = io(`http://127.0.0.1:${PORT}`); let st = null; s.on('state', (x) => { st = x; }); await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); s.emit('endMatch'); s.emit('sessionClear'); s.emit('savePlayers', []); await wait(400);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  const errs = []; pad.on('pageerror', (e) => errs.push(e.message));
  await pad.goto(`http://127.0.0.1:${PORT}/pad`); await wait(1000);
  const vis = (sel) => pad.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0; });
  const rect = (sel) => pad.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width }; });
  const tab = () => pad.$eval('nav.tabs button.on', (el) => el.dataset.tab);
  const chosen = () => pad.$eval('#chosen', (el) => el.textContent);
  const names = (m) => ((m && m.rows) || []).map((r) => r.name).join(',');
  await pad.evaluate(() => { window.__t = []; const el = document.getElementById('toast'); new MutationObserver(() => { if (el.textContent) window.__t.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true }); });
  const toasts = () => pad.evaluate(() => window.__t.splice(0));

  // ---- the closed banner is visible on every tab except Play (which has the full sign)
  async function bannerOnEveryTab(label) {
    for (const [w, h] of [[820, 1180], [1180, 820], [375, 812]]) {
      await pad.setViewportSize({ width: w, height: h }); await wait(200);
      for (const t of ['prize', 'fix', 'setup']) {
        await pad.click(`nav.tabs button[data-tab="${t}"]`); await wait(250);
        const r = await rect('#closedbar');
        const content = await rect(`#v-${t}`);
        const ok = (await vis('#closedbar')) && !(await vis('#timeup')) && r.top >= 0 && r.left >= 0 && r.right <= w && r.bottom <= content.top + 1;
        check(`${label} ${w}x${h}: closed banner shown above the ${t} tab`, ok, { banner: r, content: content.top });
      }
      await pad.click('nav.tabs button[data-tab="play"]'); await wait(250);
      check(`${label} ${w}x${h}: Play tab has the full sign, no banner`, (await vis('#timeup')) && !(await vis('#closedbar')));
    }
    await pad.setViewportSize({ width: 820, height: 1180 }); await wait(200);
  }
  await bannerOnEveryTab('no timer');
  const barText = await pad.$eval('#closedbar', (el) => el.textContent);
  check('no timer: banner says see the bar to put time on the clock', /put time on the clock/i.test(barText), barText);

  // ---- no game on: the Fix-tab controls must not pretend
  await pad.click('nav.tabs button[data-tab="fix"]'); await wait(250); await toasts();
  const wrong = /restarted|ended|next game/i;
  for (const id of ['btn-restart', 'btn-end', 'btn-change', 'btn-next2', 'btn-undo2']) {
    await pad.click('#' + id); await wait(300);
    const t = await toasts();
    check(`no game: ${id} says "No game running" and stays on Fix`, t.some((x) => /No game running/i.test(x)) && !t.some((x) => wrong.test(x)) && (await tab()) === 'fix', { toasts: t, tab: await tab() });
  }
  const step1 = await pad.$eval('#step1btn', (el) => el.classList.contains('on'));
  check('no game: Pick another game did not bounce the wizard to step 2', step1);

  // ---- first group: type names, start a game from the pad
  s.emit('sessionStart', 60); await wait(400);
  await pad.click('nav.tabs button[data-tab="setup"]'); await wait(250);
  await pad.click('#newname'); await pad.keyboard.type('Ali'); await pad.click('#btn-addname'); await wait(200);
  await pad.click('#newname'); await pad.keyboard.type('Jord'); await pad.keyboard.press('Enter');
  const gotBoth = await untilTrue(async () => /Playing: Ali · Jord/.test(await chosen()));
  check('typed names are picked as soon as they land in the roster', !!gotBoth, gotBoth || await chosen());
  await pad.click('#btn-toGames'); await wait(300);
  await pad.click('#gamecards .card'); await wait(300);
  await pad.click('#btn-start'); await wait(700);
  check('first group plays: Ali and Jord', st.match && names(st.match) === 'Ali,Jord', names(st.match));

  // ---- a name deleted from the roster elsewhere leaves the line-up too
  s.emit('endMatch'); await wait(400);
  // ...and the game just ended (no dart thrown, so Undo was greyed out) must
  // not leave Undo last dart dead: it says "No game running" like the rest
  await pad.click('nav.tabs button[data-tab="fix"]'); await wait(250); await toasts();
  const undoDead = await pad.$eval('#btn-undo2', (el) => el.disabled);
  check('game ended: Undo last dart is not left greyed out', !undoDead);
  if (!undoDead) {
    await pad.click('#btn-undo2'); await wait(300);
    const tu = await toasts();
    check('game ended: Undo last dart says "No game running"', tu.some((x) => /No game running/i.test(x)), tu);
  }
  await pad.click('nav.tabs button[data-tab="setup"]'); await wait(200);
  await pad.click('#step1btn'); await wait(200);
  s.emit('savePlayers', st.roster.filter((p) => p.name !== 'Jord')); await wait(400);
  check('name removed from the roster drops out of the line-up', /Playing: Ali \(/.test(await chosen()), await chosen());

  // ---- Time's up: nothing carries over to the next group
  s.emit('sessionEnd'); await wait(800);
  check('session ended: roster and game cleared on the server', st.roster.length === 0 && !st.match);
  const afterEnd = await chosen();
  const selChips = await pad.$$eval('#playerpick .chipbtn.sel', (els) => els.length);
  check("Time's up: the pad forgets the last group's line-up", !/Playing/.test(afterEnd) && selChips === 0, afterEnd);
  await bannerOnEveryTab("time's up");
  check("time's up: banner says so", /Time's up/.test(await pad.$eval('#closedbar', (el) => el.textContent)));
  await pad.click('nav.tabs button[data-tab="setup"]'); await wait(250);
  await pad.click('#step1btn'); await wait(200);
  await pad.click('#newname'); await pad.keyboard.type('Kim'); await pad.click('#btn-addname');
  const gotKim = await untilTrue(async () => { const c = await chosen(); return /Playing: Kim \(/.test(c) && !/Ali|Jord/.test(c); });
  check('next group: only their name is picked', !!gotKim, gotKim || await chosen());
  s.emit('sessionStart', 60); await wait(400);
  await pad.click('#btn-toGames'); await wait(300);
  await pad.click('#gamecards .card'); await wait(300);
  await pad.click('#btn-start'); await wait(700);
  check('next group plays alone: Kim only, not Ali/Jord/Kim', st.match && names(st.match) === 'Kim', names(st.match));
  check('the pad went to Play for the new game', (await tab()) === 'play');

  // ---- staff sell a new timer over the live game: the names the next group
  //      just typed go with the old session, and the pad says why
  s.emit('savePlayers', st.roster.concat([{ id: 'rnext', name: 'Nextgroup' }])); await wait(400); await toasts();
  s.emit('sessionStart', 60); await wait(500);
  const tNew = await toasts();
  check('new timer over a live game: roster cleared and the pad explains it',
    st.roster.length === 0 && !st.match && tNew.some((x) => /New timer started/.test(x) && /names cleared/i.test(x)), { roster: st.roster.length, toasts: tNew });
  s.emit('sessionStart', 60); await wait(500);
  const tAgain = await toasts();
  check('a timer set with no session running says nothing about names', !tAgain.some((x) => /names cleared/i.test(x)), tAgain);

  // ---- a long toast fits the screen and sits above the tab bar
  const dart = (sc, m) => s.emit('dart', { score: sc, multiplier: m || 1 });
  async function bust() {
    // 501: 180, 180, 60+57+4 = 20 left, then a single 20 hits zero without a double
    s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Kim' }] }); await wait(400);
    for (const [sc, m] of [[20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [4, 1]]) { dart(sc, m); await wait(80); }
    await wait(300); await toasts();
    dart(20, 1); await wait(400);
    return pad.evaluate(() => {
      const el = document.getElementById('toast'); const r = el.getBoundingClientRect();
      const n = document.querySelector('nav.tabs').getBoundingClientRect();
      return { text: el.textContent, shown: el.classList.contains('show'), left: r.left, right: r.right, bottom: r.bottom, navTop: n.top, vw: innerWidth, vh: innerHeight, lines: Math.round(r.height / 24) };
    });
  }
  for (const [w, h] of [[820, 1180], [375, 812]]) {
    await pad.setViewportSize({ width: w, height: h }); await wait(200);
    const t = await bust();
    check(`${w}x${h}: the bust toast is the long one`, t.shown && /BUST/.test(t.text) && /LAST dart in a double/i.test(t.text), t.text);
    check(`${w}x${h}: toast fits inside the screen`, t.left >= 0 && t.right <= t.vw && t.right - t.left > 200, t);
    check(`${w}x${h}: toast sits above the tab bar`, t.bottom <= t.navTop, { bottom: t.bottom, navTop: t.navTop });
  }

  // ---- a finished game: Next player says so instead of doing nothing
  await pad.setViewportSize({ width: 820, height: 1180 }); await wait(200);
  dart(10, 2); await wait(500);                                          // Kim's 20 left: D10, game shot
  check('Kim checks out - game over', st.match && st.match.finished);
  await pad.click('nav.tabs button[data-tab="fix"]'); await wait(300); await toasts();
  await pad.click('#btn-next2'); await wait(300);
  const tNext = await toasts();
  check('Next player on a finished game: "Game over" toast, game still finished',
    tNext.some((x) => /Game over/.test(x) && /undo the last dart/i.test(x)) && st.match && st.match.finished, tNext);

  // ---- a Fix box held while the winning dart lands is stale: Set must not
  //      pretend, and the boxes catch up when the box is let go
  async function staleBox() {
    s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Kim' }] }); await wait(500);
    await pad.click('nav.tabs button[data-tab="fix"]'); await wait(300);
    await pad.click('#adjustlist input');                                // held while the game finishes
    for (const [sc, m] of [[20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [20, 3], [19, 3], [12, 2]]) { dart(sc, m); await wait(80); }
    await wait(500); await toasts();
    return { finished: !!(st.match && st.match.finished), box: !!(await pad.$('#adjustlist input')) };
  }
  let sb = await staleBox();
  check('box held through the win: game over, the box is still on screen', sb.finished && sb.box, sb);
  await pad.click('#adjustlist button'); await wait(400);
  const tSet = await toasts();
  const fixAfter = await pad.$eval('#adjustlist', (el) => el.innerText);
  check('Set on the stale box: "Game over" toast, no "set to"', tSet.some((x) => /Game over/.test(x) && /Undo last dart/.test(x)) && !tSet.some((x) => /set to/.test(x)), tSet);
  check('...and the boxes are redrawn as game over', /game over/i.test(fixAfter) && !(await pad.$('#adjustlist input')), fixAfter);
  sb = await staleBox();
  check('box held through the win again: still on screen', sb.finished && sb.box, sb);
  await pad.evaluate(() => document.activeElement.blur()); await wait(600);
  const fixBlur = await pad.$eval('#adjustlist', (el) => el.innerText);
  check('letting go of the box redraws it as game over', /game over/i.test(fixBlur) && !(await pad.$('#adjustlist input')), fixBlur);
  check('no page errors', errs.length === 0, errs);
  s.emit('endMatch'); s.emit('sessionClear'); await wait(300);
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
