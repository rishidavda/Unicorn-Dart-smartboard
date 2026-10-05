/*
 * membertest.js - every timer is sold to a member, and only staff see who.
 *
 * Drives the real staff console and the real players' iPad and TV (Chromium)
 * against a real hub (fakeboard.js, board off air):
 *   - 1 hour / 2 hours / custom / Stopwatch refuse to start without a member
 *     name, and say why; with one they start and the card shows the member
 *     and what to charge (stopwatch: so far);
 *   - a name typed and left (box not focused) survives the card re-rendering;
 *   - Set corrects the member on a running timer and on a bill already written;
 *   - the bill (sessions.json, /api/today, the Played today list, Last session
 *     and the PDF report) carries the member and the amount;
 *   - the member never reaches the TV, the players' iPad or any socket that
 *     has not been unlocked with the staff PIN - not once, not in any event;
 *   - the players' iPad has no way to the staff console;
 *   - an older console starting a timer without a name still works, and the
 *     card asks for the name.
 * Ports TPORT (default 9560). Data and logs under $DARTS_TEST_TMP/member.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'member');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 9560);
const URL = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const DATA = path.join(SP, 'hub');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`);
};
async function until(fn, ms = 8000, step = 120) {
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
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 6 * 60000).unref();

async function startHub() {
  fs.rmSync(SP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ adminPin: '1234', pricePerHour: 10, autoConnect: false }));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: path.join(SP, 'reports'), FAKE_FIRST_ABSENT: '1' });
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
const bills = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')); } catch (_) { return []; } };

(async () => {
  hub = await startHub();

  // A socket that never unlocks: what every TV and players' iPad receives.
  // Every event and payload it sees is kept, to prove no member leaks.
  const spy = io(URL, { transports: ['websocket'] });
  const heard = [];
  let st = null;
  spy.onAny((ev, ...args) => { heard.push(`${ev} ${JSON.stringify(args)}`); if (ev === 'state') st = args[0]; });
  await until(() => st, 10000);

  const b = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const page = async (p, w, h) => {
    const pg = await b.newPage({ viewport: { width: w, height: h } });
    pg.on('pageerror', (e) => errors.push(`${p}: ${e.message}`));
    await pg.goto(`${URL}${p}`);
    return pg;
  };
  const staffPg = await page('/staff', 820, 1600);
  const pad = await page('/pad', 820, 1180);
  const tv = await page('/tv', 1920, 1080);
  await wait(800);
  await staffPg.keyboard.type('1234');
  await until(() => staffPg.$('.card[data-hub="0"] [data-in="member"]'), 10000);
  const card = (sel) => `.card[data-hub="0"] ${sel}`;
  const cardText = () => staffPg.$eval('.card[data-hub="0"]', (el) => el.innerText);
  const staffToast = () => staffPg.$eval('#toast', (el) => el.textContent);
  const typeMember = async (name) => { await staffPg.fill(card('[data-in="member"]'), ''); await staffPg.type(card('[data-in="member"]'), name); };
  const leaked = (name) => heard.filter((h) => h.includes(name)).map((h) => h.slice(0, 120));
  const padText = () => pad.evaluate(() => document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join(' '));
  const tvText = () => tv.evaluate(() => document.body.innerText);

  /* 1. no name, no timer */
  for (const [act, sel] of [['1 hour', '[data-act="start"][data-m="60"]'], ['Stopwatch', '[data-act="stopwatch"]']]) {
    await staffPg.click(card(sel));
    await wait(500);
    const tt = await staffToast();
    const flagged = await staffPg.$eval(card('[data-in="member"]'), (el) => el.classList.contains('need') && document.activeElement === el);
    check(`${act} with no member name: refused, says why, and points at the box`, /member's name first/i.test(tt) && flagged && !st.session, { tt, flagged, session: st.session });
  }
  await staffPg.fill(card('[data-in="mins"]'), '45');
  await staffPg.click(card('[data-act="startcustom"]'));
  await wait(500);
  check('custom minutes with no member name: refused too', /member's name first/i.test(await staffToast()) && !st.session, st.session);

  /* 2. a typed name survives a re-render with the box no longer focused */
  await typeMember('Jo Bloggs');
  await staffPg.evaluate(() => document.activeElement && document.activeElement.blur());   // keyboard away: the box loses focus
  spy.emit('addPlayer', 'Rerender');                  // a state change re-renders the card
  await until(() => st.roster.some((p) => p.name === 'Rerender'));
  await wait(500);
  check('a member name typed and left survives the card re-rendering', await staffPg.$eval(card('[data-in="member"]'), (el) => el.value) === 'Jo Bloggs');

  /* 3. 1 hour for Jo Bloggs */
  await staffPg.click(card('[data-act="start"][data-m="60"]'));
  await until(() => st.session && st.session.minutes === 60);
  await until(async () => /Member: Jo Bloggs/.test(await cardText()));
  let ct = await cardText();
  check('1 hour with a member: the timer starts and the card shows who and what to charge', !!st.session && /Member: Jo Bloggs · £10\.00 to charge/.test(ct), (ct.match(/Member[^\n]*/) || [''])[0]);
  check('...the staff toast names the member', /Timer set: 60 minutes for Jo Bloggs/.test(await staffToast()), await staffToast());
  check('...the member box is cleared for the next sale', await staffPg.$eval(card('[data-in="member"]'), (el) => el.value) === '');

  /* 4. Set corrects it */
  await typeMember('Joanne Bloggs');
  await staffPg.click(card('[data-act="member"]'));
  await until(async () => /Member: Joanne Bloggs/.test(await cardText()));
  check('Set corrects the member on the running timer', /Member: Joanne Bloggs/.test(await cardText()), (await cardText()).match(/Member[^\n]*/));

  /* 5. play, then End now: the bill */
  spy.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Rerender' }] });
  await until(() => st.session && st.session.started);
  await staffPg.click(card('[data-act="end"]'));
  await until(() => bills().length === 1);
  let bl = bills();
  check('End now: the bill names the member and the amount', bl.length === 1 && bl[0].member === 'Joanne Bloggs' && bl[0].price === 10, bl);
  const today = await (await fetch(`${URL}/api/today?pin=1234`)).json();
  check('/api/today (staff PIN) carries the member and the price', today.sessions.some((r) => r.member === 'Joanne Bloggs' && r.price === 10), today.sessions);
  const locked = await fetch(`${URL}/api/today`);
  check('...and refuses without the PIN', locked.status === 401 || locked.status === 403, locked.status);
  const listed = await until(async () => {
    const t = await staffPg.$eval('#todaylist', (el) => el.innerText);
    return /Joanne Bloggs/.test(t) && /£10\.00/.test(t) ? t : null;
  }, 20000, 500);
  check('Played today (staff page, scroll down) lists the member and the amount', !!listed, await staffPg.$eval('#todaylist', (el) => el.innerText));
  ct = await cardText();
  check('the card\'s Last session line names the member and the amount', /Last session: Joanne Bloggs — £10\.00/.test(ct), (ct.match(/Last session[^\n]*/) || [''])[0]);

  /* 6. a bill already written: Set still corrects it */
  await typeMember('Jo Anne Bloggs');
  const setBtn = await staffPg.$(card('[data-act="member"]'));
  check('after End now the card offers no Set (nothing left to correct on the clock)', !setBtn);
  spy.emit('sessionMember', 'Hacker');                // an unlocked-nowhere socket
  await wait(400);
  check('a socket without the staff PIN cannot change the member', bills()[0].member === 'Joanne Bloggs', bills()[0]);
  await staffPg.fill(card('[data-in="member"]'), '');

  /* 7. Stopwatch for Sam Smith */
  await typeMember('Sam Smith');
  await staffPg.click(card('[data-act="stopwatch"]'));
  await until(() => st.session && st.session.mode === 'stopwatch');
  spy.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'Sam' }] });
  await until(() => st.session && st.session.started);
  await until(async () => /Member: Sam Smith · £10\.00 so far/.test(await cardText()));
  ct = await cardText();
  check('Stopwatch with a member: the card shows who and the charge so far (an hour minimum)', /Member: Sam Smith · £10\.00 so far/.test(ct), (ct.match(/Member[^\n]*/) || [''])[0]);
  await staffPg.click(card('[data-act="end"]'));
  await until(() => bills().length === 2);
  bl = bills();
  check('...End now bills Sam Smith', bl.length === 2 && bl[1].member === 'Sam Smith' && bl[1].mode === 'stopwatch' && bl[1].price === 10, bl[1]);

  /* 8. the PDF report */
  const pdf = Buffer.from(await (await fetch(`${URL}/api/report-today?pin=1234`)).arrayBuffer()).toString('latin1');
  check('today\'s PDF report lists each member', /Member/.test(pdf) && /Joanne Bloggs/.test(pdf) && /Sam Smith/.test(pdf));

  /* 9. an older console: a timer with no name still starts, and the card asks */
  const old = io(URL, { transports: ['websocket'] });
  await new Promise((r) => old.on('connect', r));
  await new Promise((r) => old.emit('unlock', '1234', r));
  old.emit('sessionStart', 30);
  await until(() => st.session && st.session.minutes === 30 && !st.session.started);
  await until(async () => /No member name on this timer/.test(await cardText()));
  check('a timer started without a name (older console) still runs, and the card asks for the name', /No member name on this timer/.test(await cardText()), (await cardText()).match(/[^\n]*member[^\n]*/i));
  old.close();

  /* 10. only staff ever see it */
  for (const n of ['Jo Bloggs', 'Joanne Bloggs', 'Sam Smith']) {
    check(`"${n}" never reached a socket without the staff PIN (every event, every payload)`, leaked(n).length === 0, leaked(n));
    check(`"${n}" never shown on the players' iPad or the TV`, !(await padText()).includes(n) && !(await tvText()).includes(n));
  }
  check('...but a staff-unlocked socket does get it', await (async () => {
    const s2 = io(URL, { transports: ['websocket'] });
    let got = null;
    s2.on('staff', (x) => { got = x; });
    await new Promise((r) => s2.on('connect', r));
    await new Promise((r) => s2.emit('unlock', '1234', r));
    await until(() => got, 3000);
    s2.close();
    return got && 'member' in got;
  })());

  /* 11. no staff view on the players' iPad */
  const routes = await pad.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /staff/.test(h)));
  check('the players\' iPad has no Staff button or link to the staff console', routes.length === 0 && !(await pad.$('#tu-staff')), routes);

  check('no page errors on the staff console, iPad or TV', errors.length === 0, errors);
  await b.close();
  spy.close();
  hub.kill('SIGTERM');
  await until(() => hub.exited, 8000);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
