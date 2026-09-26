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
  for (const id of ['btn-restart', 'btn-end', 'btn-change', 'btn-next2']) {
    await pad.click('#' + id); await wait(300);
    const t = await toasts();
    check(`no game: ${id} says "No game running" and stays on Fix`, t.some((x) => /No game running/i.test(x)) && !t.some((x) => wrong.test(x)) && (await tab()) === 'fix', { toasts: t, tab: await tab() });
  }
  const step1 = await pad.$eval('#step1btn', (el) => el.classList.contains('on'));
  check('no game: Pick another game did not bounce the wizard to step 2', step1);

  // ---- first group: type names, start a game from the pad
  s.emit('sessionStart', 60); await wait(400);
  await pad.click('nav.tabs button[data-tab="setup"]'); await wait(250);
  await pad.click('#newname'); await pad.keyboard.type('Ali'); await pad.click('#btn-addname'); await wait(500);
  await pad.click('#newname'); await pad.keyboard.type('Jord'); await pad.keyboard.press('Enter'); await wait(500);
  check('typed names are picked as soon as they land in the roster', /Playing: Ali · Jord/.test(await chosen()), await chosen());
  await pad.click('#btn-toGames'); await wait(300);
  await pad.click('#gamecards .card'); await wait(300);
  await pad.click('#btn-start'); await wait(700);
  check('first group plays: Ali and Jord', st.match && names(st.match) === 'Ali,Jord', names(st.match));

  // ---- a name deleted from the roster elsewhere leaves the line-up too
  s.emit('endMatch'); await wait(400);
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
  await pad.click('#newname'); await pad.keyboard.type('Kim'); await pad.click('#btn-addname'); await wait(500);
  check('next group: only their name is picked', /Playing: Kim \(/.test(await chosen()) && !/Ali|Jord/.test(await chosen()), await chosen());
  s.emit('sessionStart', 60); await wait(400);
  await pad.click('#btn-toGames'); await wait(300);
  await pad.click('#gamecards .card'); await wait(300);
  await pad.click('#btn-start'); await wait(700);
  check('next group plays alone: Kim only, not Ali/Jord/Kim', st.match && names(st.match) === 'Kim', names(st.match));
  check('the pad went to Play for the new game', (await tab()) === 'play');

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
  check('no page errors', errs.length === 0, errs);
  s.emit('endMatch'); s.emit('sessionClear'); await wait(300);
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
