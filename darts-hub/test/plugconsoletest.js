/*
 * plugconsoletest.js - setting up the Tapo smart plug on the real staff
 * console (Chromium), two boards, while a game is being played (so the
 * console keeps re-rendering, as it does during service):
 *   - the Smart plug fold-out stays open, and a typed address, a ticked
 *     In use and an Off after value survive the re-renders until Save;
 *   - Save, then the plug follows the board's timer; Test off/on switch it
 *     and the buttons stay where they were (never swapped for Disconnect);
 *   - the venue Tapo email box keeps a newly typed email while the password
 *     is typed: Save stores the NEW email with the new password on every board;
 *   - the card says what is wrong in plain words: the account turned down
 *     (with the capitals hint), the Tapo app's Third-Party Compatibility
 *     switch off;
 *   - two boards set to one plug address are both flagged;
 *   - a console that is not unlocked can't change the plug;
 *   - no page errors.
 * Ports TPORT (default 9660; uses TPORT..TPORT+1 and TPORT+10..+11).
 * Data and logs under $DARTS_TEST_TMP/plugconsole.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'plugconsole');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const BASE = Number(process.env.TPORT || 9660);
const A = BASE, B = BASE + 1, PLUG = BASE + 10, NEWFW = BASE + 11;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const EMAIL = 'Oche@Example.com', PASSWORD = 'lights123';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}
const kids = [];
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 6 * 60000).unref();

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_|TAPO_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  return env;
}
function startPlug(port, extra = {}) {
  const fd = fs.openSync(path.join(SP, `plug-${port}.log`), 'a');
  const k = spawn(process.execPath, [path.join(HERE, 'fakeplug.js')], {
    env: { ...cleanEnv(), FAKE_PLUG_PORT: String(port), FAKE_PLUG_MODE: 'klap', FAKE_PLUG_EMAIL: EMAIL, FAKE_PLUG_PASSWORD: PASSWORD, ...extra },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  kids.push(k);
  return until(() => fetch(`http://127.0.0.1:${port}/state`).then((r) => r.ok), 8000);
}
const plugState = (port) => fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
function startHub(name, port, settings) {
  const data = path.join(SP, name);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));
  const fd = fs.openSync(path.join(SP, `${name}.log`), 'a');
  const k = spawn(process.execPath, [path.join(HERE, 'fakeboard.js')], {
    env: { ...cleanEnv(), SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: data, DARTS_REPORTS: path.join(SP, `${name}-reports`) },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  kids.push(k);
  return until(() => fetch(`http://127.0.0.1:${port}/api/history`).then((r) => r.ok), 20000, 150).then((ok) => { if (!ok) throw new Error(`hub ${name} did not come up`); return k; });
}
const settingsOf = (name) => { try { return JSON.parse(fs.readFileSync(path.join(SP, name, 'settings.json'), 'utf8')); } catch (_) { return {}; } };

(async () => {
  fs.rmSync(SP, { recursive: true, force: true });
  fs.mkdirSync(SP, { recursive: true });
  await startPlug(PLUG);
  await startPlug(NEWFW, { FAKE_PLUG_COMPAT: '0' });
  const account = { enabled: false, host: '', email: EMAIL, password: PASSWORD, offDelayMin: 0 };
  await startHub('hubA', A, { adminPin: '1234', autoConnect: false, screensaverMinutes: 0, boardName: 'Board 1', peers: [`http://127.0.0.1:${B}`], plug: account });
  await startHub('hubB', B, { adminPin: '1234', autoConnect: false, screensaverMinutes: 0, boardName: 'Board 2', plug: account });

  // Board 1 in play: a dart every 400 ms keeps the console re-rendering
  const sa = io(`http://127.0.0.1:${A}`, { transports: ['websocket'] });
  let st = null;
  sa.on('state', (x) => { st = x; });
  await until(() => st, 8000);
  await new Promise((r) => sa.emit('unlock', '1234', r));
  sa.emit('sessionStart', 60, 'Console test');
  await until(() => st.session, 4000);
  sa.emit('newMatch', { gameId: 'countup', players: [{ name: 'Sam' }, { name: 'Ash' }] });
  await until(() => st.match, 4000);
  let playing = true;
  (async () => { while (playing) { sa.emit('dart', { score: 1 + Math.floor(Math.random() * 20), multiplier: 1 }); await wait(400); } })();

  const b = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const page = await b.newPage({ viewport: { width: 900, height: 1800 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${A}/staff`);
  await wait(600);
  await page.keyboard.type('1234');
  await until(() => page.$('.card[data-hub="1"] .bname'), 15000);
  await until(() => page.evaluate(() => [...document.querySelectorAll('.card[data-hub]')].every((c) => c.querySelector('details'))), 10000);

  const card = (i) => `.card[data-hub="${i}"]`;
  const plugFold = (i) => page.evaluate((sel) => { const d = [...document.querySelectorAll(`${sel} details`)].find((x) => /Smart plug/.test(x.querySelector('summary').textContent)); return d ? { open: d.open, otherOpen: [...document.querySelectorAll(`${sel} details`)].filter((x) => x !== d && x.open).length } : null; }, card(i));
  const openPlug = (i) => page.evaluate((sel) => { const d = [...document.querySelectorAll(`${sel} details`)].find((x) => /Smart plug/.test(x.querySelector('summary').textContent)); d.querySelector('summary').click(); }, card(i));
  const cardText = (i) => page.$eval(card(i), (el) => el.innerText);

  /* ------------------------------------------- typing through re-renders -- */
  await openPlug(0);
  await page.fill(`${card(0)} [data-in="plughost"]`, ` http://127.0.0.1:${PLUG}/ `);
  await page.check(`${card(0)} [data-in="plugon"]`);
  await page.fill(`${card(0)} [data-in="plugdelay"]`, '2');
  await page.click(`${card(0)} .bname`);                       // focus elsewhere: nothing protects the boxes but the fix
  const darts0 = st.match.dartsInLog;
  await wait(5000);
  const fold = await plugFold(0);
  const kept = await page.evaluate((sel) => ({ host: document.querySelector(`${sel} [data-in="plughost"]`).value,
    on: document.querySelector(`${sel} [data-in="plugon"]`).checked, delay: document.querySelector(`${sel} [data-in="plugdelay"]`).value }), card(0));
  check(`the Smart plug fold-out stays open through re-renders (${st.match.dartsInLog - darts0} darts thrown meanwhile), Board & sound not opened instead`,
    fold && fold.open && fold.otherOpen === 0 && st.match.dartsInLog - darts0 >= 5, fold);
  check('...and the unsaved address, In use tick and Off after survive them', kept.host.includes(`127.0.0.1:${PLUG}`) && kept.on && kept.delay === '2', kept);

  await page.click(`${card(0)} [data-act="plugsave"]`);
  const on = await until(async () => /Plug is ON/.test(await cardText(0)), 10000);
  check('Save: the plug follows the board\'s timer (time is sold: ON), the address cleaned of http:// and /', !!on
    && settingsOf('hubA').plug.host === `127.0.0.1:${PLUG}` && settingsOf('hubA').plug.offDelayMin === 2 && (await plugState(PLUG)).on === true,
    { plug: settingsOf('hubA').plug, text: (await cardText(0)).slice(0, 300) });
  check('...and the fold-out is still open after Save', !!(await plugFold(0)).open);

  await page.click(`${card(0)} [data-act="plugoff"]`);
  const off = await until(async () => /Plug is OFF/.test(await cardText(0)) && (await plugState(PLUG)).on === false, 6000);
  await wait(1500);
  const btns = await page.$$eval(`${card(0)} [data-act]`, (els) => els.map((e) => e.dataset.act));
  check('Test off: the plug is OFF, and Test on / Test off are still there (never swapped for Disconnect)', !!off
    && btns.includes('plugon') && btns.includes('plugoff') && (await plugFold(0)).open, btns);
  await page.click(`${card(0)} [data-act="plugon"]`);
  check('Test on: ON again', !!(await until(async () => (await plugState(PLUG)).on === true, 6000)));

  /* ------------------------------------- the venue Tapo account box -- */
  await page.fill('#tapoemail', 'someone.else@example.com');
  await page.click('#tapopass');
  await wait(4000);                                            // updates keep arriving meanwhile
  const stillTyped = await page.inputValue('#tapoemail');
  await page.fill('#tapopass', 'other-pass');
  await page.click('#taposave');
  const saved = await until(() => ['hubA', 'hubB'].every((n) => settingsOf(n).plug && settingsOf(n).plug.email === 'someone.else@example.com'
    && settingsOf(n).plug.password === 'other-pass'), 6000);
  check('the Tapo email box keeps a newly typed email while the password is typed: Save stores the NEW email and password on both boards',
    stillTyped === 'someone.else@example.com' && !!saved, { stillTyped, a: settingsOf('hubA').plug, b: settingsOf('hubB').plug });
  await page.click(`${card(0)} [data-act="plugon"]`);
  const turned = await until(async () => /turned down the Tapo email or password/.test(await cardText(0)), 8000);
  check('a wrong account: the card says the plug turned it down, with where to fix it and that capitals count', !!turned
    && /capitals count/.test(await cardText(0)) && !/Can't reach/.test(await cardText(0)), (await cardText(0)).slice(0, 400));
  // the right account back
  await page.fill('#tapoemail', EMAIL);
  await page.fill('#tapopass', PASSWORD);
  await page.click('#taposave');
  await until(() => settingsOf('hubB').plug.email === EMAIL && settingsOf('hubB').plug.password === PASSWORD, 6000);
  await page.click(`${card(0)} [data-act="plugon"]`);
  check('...the right account back: the warning goes', !!(await until(async () => /Plug is ON/.test(await cardText(0)), 8000)));

  /* ------------------------------ firmware 1.4+: the app switch is off -- */
  await openPlug(1);
  await page.fill(`${card(1)} [data-in="plughost"]`, `127.0.0.1:${NEWFW}`);
  await page.check(`${card(1)} [data-in="plugon"]`);
  await page.click(`${card(1)} [data-act="plugsave"]`);
  const fw = await until(async () => /Third-Party Compatibility/.test(await cardText(1)), 15000);
  check('a plug on new firmware with the app switch off: the card names the Tapo app switch to turn on', !!fw, (await cardText(1)).slice(0, 400));

  /* ------------------------------------------- two boards, one plug -- */
  await page.fill(`${card(1)} [data-in="plughost"]`, `127.0.0.1:${PLUG}`);
  await page.click(`${card(1)} [data-act="plugsave"]`);
  const clash = await until(async () => /Board 2 uses this same plug address/.test(await cardText(0)) && /Board 1 uses this same plug address/.test(await cardText(1)), 8000);
  check('two boards set to one plug address: both cards say so', !!clash, [(await cardText(0)).slice(0, 300), (await cardText(1)).slice(0, 300)]);
  await page.fill(`${card(1)} [data-in="plughost"]`, '');
  await page.uncheck(`${card(1)} [data-in="plugon"]`);
  await page.click(`${card(1)} [data-act="plugsave"]`);
  await until(async () => !/same plug address/.test(await cardText(0)), 6000);

  /* --------------------------------- a console that is not unlocked -- */
  const locked = io(`http://127.0.0.1:${A}`, { transports: ['websocket'] });
  await until(() => locked.connected, 4000);
  locked.emit('saveSettings', { plug: { host: '10.9.9.9', enabled: false } });
  await wait(1200);
  check('a console that is not unlocked can\'t change the plug', settingsOf('hubA').plug.host === `127.0.0.1:${PLUG}` && settingsOf('hubA').plug.enabled === true, settingsOf('hubA').plug);
  locked.close();

  check('no page errors on the staff console', errors.length === 0, errors);
  playing = false;
  sa.close();
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
