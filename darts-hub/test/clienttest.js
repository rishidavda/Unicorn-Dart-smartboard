/* Upgrade auto-reload, staff taps during a restart, keep-awake self re-arm,
 * leaderboard board-list retry - against a private copy of the app. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright-core');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const APPSRC = process.env.APP_DIR || require('path').join(HERE, '..');
const APP = `${SP}/upg/app`;
const PORT = Number(process.env.TPORT || 8898);
const URL = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`); };

let hub = null;
async function boot() {
  hub = spawn('node', [`${HERE}/fakeboard.js`], { env: { ...process.env, SERVER_JS: `${APP}/server/server.js`, PORT: String(PORT), DARTS_DATA: `${SP}/upg/data` }, stdio: 'ignore' });
  await wait(2500);
}
async function halt() { hub.kill('SIGINT'); await new Promise((r) => hub.once('exit', r)); await wait(300); }

(async () => {
  fs.rmSync(`${SP}/upg`, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  for (const d of ['server', 'public']) execSync(`cp -r ${APPSRC}/${d} ${APP}/`);
  fs.copyFileSync(`${APPSRC}/package.json`, `${APP}/package.json`);
  fs.symlinkSync(fs.existsSync(`${APPSRC}/node_modules`) ? `${APPSRC}/node_modules` : require('path').join(HERE, '..', 'node_modules'), `${APP}/node_modules`);
  await boot();

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const pages = {};
  for (const [n, p] of [['tv', '/tv'], ['pad', '/pad'], ['staff', '/staff'], ['board', '/board']]) {
    pages[n] = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await pages[n].goto(URL + p);
  }
  await wait(1200);
  const mark = () => Promise.all(Object.values(pages).map((p) => p.evaluate(() => { window.__marker = 1; })));
  const marked = async () => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([n, p]) => [n, await p.evaluate(() => window.__marker === 1).catch(() => false)])));

  // 1. a plain restart (the daily fresh start) must NOT reload anything
  await mark();
  await halt(); await boot(); await wait(6000);
  const m1 = await marked();
  check('plain restart: no screen reloads', Object.values(m1).every(Boolean), m1);

  // 2. an upgrade (changed page files) reloads every screen, once
  fs.appendFileSync(`${APP}/public/js/build.js`, '\n// upgraded\n');
  await halt(); await boot(); await wait(8000);
  const m2 = await marked();
  check('upgrade: every screen reloaded itself', Object.values(m2).every((v) => v === false), m2);
  await mark(); await wait(8000);
  const m3 = await marked();
  check('upgrade: no reload loop afterwards', Object.values(m3).every(Boolean), m3);

  // 3. staff tap while the hub is down: told to wait, not silently refused
  const st = pages.staff;
  await st.keyboard.type('1234'); await wait(1200);
  await st.evaluate(() => {
    window.__toasts = [];
    const el = document.getElementById('toast');
    new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const toasts = () => st.evaluate(() => window.__toasts.splice(0));
  await halt();
  await wait(1500);
  const gap = await st.$eval('.card', (el) => ({ text: el.innerText, buttons: el.querySelectorAll('[data-act]').length }));
  check('during a restart the card says reconnecting and offers no taps to lose', /reconnecting/i.test(gap.text) && gap.buttons === 0, gap);
  await boot(); await wait(5000); await toasts();
  await st.locator('.card[data-hub="0"] [data-act="start"][data-m="60"]').click();
  await wait(800);
  const t2 = await toasts();
  check('after reconnect the same tap works (timer set, not refused)', t2.some((t) => /Timer set/i.test(t)) && !t2.some((t) => /locked/i.test(t)), t2);

  // 4. keep-awake: video fallback restarts itself if stopped
  const kp = await b.newPage();
  await kp.addInitScript(() => { Object.defineProperty(navigator, 'wakeLock', { get: () => undefined }); });
  await kp.goto(`${URL}/tv`); await wait(1500);
  await kp.mouse.click(5, 5); await wait(800);
  const before = await kp.evaluate(() => WinchesterAwake());
  await kp.evaluate(() => { const v = document.querySelector('video'); if (v) v.pause(); });
  await wait(300);
  const paused = await kp.evaluate(() => WinchesterAwake());
  await wait(4500);
  const after = await kp.evaluate(() => WinchesterAwake());
  check('keep-awake video fallback re-arms itself after stopping', before === 'video' && paused === 'off' && after === 'video', { before, paused, after });

  // 5. leaderboard: a failed board-list fetch is retried
  const lb = await b.newPage();
  let peersCalls = 0, failed = false;
  await lb.route('**/api/peers', (route) => { peersCalls++; if (!failed) { failed = true; return route.abort(); } return route.continue(); });
  await lb.goto(`${URL}/board`);
  await wait(33000);
  check('leaderboard retries the board list after a failure', peersCalls >= 2, { peersCalls });

  await b.close();
  await halt();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { hub.kill(); } catch (_) {} process.exit(1); });
