/* Customers can type their names before staff start the timer; the closed
 * sign covers the Play tab only. Real pad page, real taps. */
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
  s.emit('boardDisconnect'); await wait(300);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  const errs = []; pad.on('pageerror', (e) => errs.push(e.message));
  await pad.goto(`http://127.0.0.1:${PORT}/pad`); await wait(1000);
  const vis = (sel) => pad.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0; });
  const covered = (sel) => pad.$eval(sel, (el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t ? (t.id || t.tagName) : null; });

  // no game yet: the pad opens on New game with the banner; the Play tab shows the closed sign
  const startTab = await pad.$eval('nav.tabs button.on', (el) => el.dataset.tab);
  check('no timer: pad opens on New game with the banner, name box reachable', startTab === 'setup' && (await vis('#closedbar')) && (await covered('#newname')) === 'newname', { startTab });
  await pad.click('nav.tabs button[data-tab="play"]'); await wait(300);
  check('no timer: closed sign shown on the Play tab', await vis('#timeup'));
  check('no timer: the bottom tabs are not covered', (await covered('nav.tabs button[data-tab="setup"]')) === 'BUTTON', await covered('nav.tabs button[data-tab="setup"]'));
  const tuHint = await pad.$eval('#tu-hint', (el) => el.textContent);
  check('closed sign tells them to tap New game for names', /New game/.test(tuHint), tuHint);
  await pad.click('nav.tabs button[data-tab="setup"]'); await wait(300);
  check('New game tab: closed sign gone, banner shown', !(await vis('#timeup')) && (await vis('#closedbar')));
  const bar = await pad.$eval('#closedbar', (el) => el.textContent);
  check('banner explains: add names now, game starts when the timer is set', /add your names now/i.test(bar) && /timer is set/i.test(bar), bar);
  check('name box is reachable', (await covered('#newname')) === 'newname', await covered('#newname'));
  await pad.click('#newname'); await pad.keyboard.type('Rishi'); await pad.click('#btn-addname'); await wait(500);
  await pad.click('#newname'); await pad.keyboard.type('Sam'); await pad.keyboard.press('Enter'); await wait(500);
  check('two names added before any timer', st.roster.map((p) => p.name).join(',') === 'Rishi,Sam', st.roster);
  const chosen = await pad.$eval('#chosen', (el) => el.textContent);
  check('both selected for the game', /Rishi/.test(chosen) && /Sam/.test(chosen), chosen);
  // trying to start still needs the bar
  await pad.click('#btn-toGames'); await wait(300);
  await pad.click('#gamecards .gcard, #gamecards button, #gamecards [data-game]').catch(() => {});
  await wait(300);
  const toastsBefore = [];
  await pad.evaluate(() => { window.__t = []; const el = document.getElementById('toast'); new MutationObserver(() => window.__t.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: st.roster }); await wait(500);
  check('a game still cannot start without a timer', !st.match);
  // staff put time on the clock: everything opens, names kept
  s.emit('sessionStart', 60); await wait(500);
  check('timer set: banner and closed sign both gone', !(await vis('#timeup')) && !(await vis('#closedbar')));
  check('names survive the timer starting', st.roster.length === 2);
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: st.roster }); await wait(500);
  check('game starts now', !!st.match);
  // session ends: closed sign says time's up on Play; names for the next group still possible
  s.emit('sessionEnd'); await wait(700);
  await pad.click('nav.tabs button[data-tab="play"]'); await wait(300);
  const title = await pad.$eval('#tu-title', (el) => el.textContent);
  check("after the session: Time's up on the Play tab", (await vis('#timeup')) && /Time/.test(title), title);
  await pad.click('nav.tabs button[data-tab="setup"]'); await wait(300);
  await pad.click('#step1btn').catch(() => {}); await wait(300);   // back to "Who's playing?"
  await pad.click('#newname'); await pad.keyboard.type('Next Group'); await pad.click('#btn-addname'); await wait(500);
  check('next group can type their name straight away', st.roster.some((p) => p.name === 'Next Group'), st.roster);
  check('Staff link on the closed sign sits above the tabs', await pad.evaluate(() => { const a = document.getElementById('tu-staff').getBoundingClientRect(); const n = document.querySelector('nav.tabs').getBoundingClientRect(); return a.bottom <= n.top + 1; }));
  check('no page errors', errs.length === 0, errs);
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
