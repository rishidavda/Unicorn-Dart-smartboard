/*
 * savertest.js - the TV screen saver from the "screen saver" folder.
 *
 * A real hub (fakeboard.js, board off air) with its screen saver folder
 * pointed at a scratch folder holding real files - PNG pictures, a WebM clip
 * recorded by Chromium itself, a broken JPG, a README and a hidden file - and
 * the real TV, players' iPad and staff console in Chromium. The idle time is
 * cut to 3 seconds and each picture to 1 second so a run takes minutes:
 *   - the folder is listed in name order (01, 2, 03, 10), pictures and videos
 *     only, and served; nothing outside it is;
 *   - the TV stays on the game until the oche has been quiet that long, then
 *     shows every file in turn - the video to its end - skipping the broken
 *     one, and goes round again;
 *   - a dart, a name typed on the iPad, a timer sold bring the game straight
 *     back (and the video is let go); settings saved elsewhere do not;
 *   - never while a timer's clock is running, never while powered off, never
 *     when switched off (0) on the staff console - whose Show button still
 *     puts it on the TV, until the next dart;
 *   - a file dropped in is picked up without a restart; with the folder
 *     emptied it stops, and does not flash back on;
 *   - a TV reloaded after a quiet spell goes straight to it;
 *   - the staff card says how many files that PC has; bad settings are refused;
 *   - no page errors.
 * Ports TPORT (default 9580). Data and logs under $DARTS_TEST_TMP/saver.
 */
const HERE = __dirname;
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SP = path.join(process.env.DARTS_TEST_TMP || path.join(require('os').tmpdir(), 'winchester-test'), 'saver');
const SERVER = process.env.SERVER_JS || path.join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 9580);
const URL = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const DATA = path.join(SP, 'hub');
const FOLDER = path.join(SP, 'screen saver');
const IDLE_MIN = 0.05;                 // 3 seconds

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

// A solid-colour PNG, written by hand (no image library in the test kit).
function png(w, h, [r, g, b]) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let hub = null;
process.on('exit', () => { try { if (hub && !hub.exited) hub.kill('SIGKILL'); } catch (_) {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
setTimeout(() => { console.log('FAIL  suite timed out'); process.exit(1); }, 8 * 60000).unref();

async function startHub() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
    adminPin: '1234', pricePerHour: 10, autoConnect: false,
    screensaverMinutes: IDLE_MIN, screensaverSlideSeconds: 1,
  }));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FAKE_|DARTS_|WINCHESTER_)/.test(k) || ['DARTBOARD', 'DAILY_RESTART', 'PORT', 'SERVER_JS'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: path.join(SP, 'reports'),
    DARTS_SCREENSAVER: FOLDER, FAKE_FIRST_ABSENT: '1' });
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
  fs.rmSync(SP, { recursive: true, force: true });
  fs.mkdirSync(FOLDER, { recursive: true });
  const b = await chromium.launch({ executablePath: CHROMIUM, args: ['--autoplay-policy=no-user-gesture-required'] });

  // A real 2-second WebM clip, recorded from a canvas by the browser itself.
  const maker = await b.newPage();
  const webm = await maker.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm;codecs=vp8' });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise((r) => {
      (function frame() {
        const t = performance.now() - t0;
        g.fillStyle = `hsl(${(t / 5) % 360},80%,50%)`; g.fillRect(0, 0, 160, 90);
        g.fillStyle = '#fff'; g.fillRect((t / 20) % 160, 30, 20, 30);
        if (t < 2000) requestAnimationFrame(frame); else r();
      })();
    });
    rec.stop();
    await done;
    const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await maker.close();
  const put = (name, data) => fs.writeFileSync(path.join(FOLDER, name), data);
  put('01-green.png', png(64, 36, [20, 200, 60]));
  put('2 red offer.png', png(64, 36, [220, 30, 30]));      // a space in the name, and 2 before 03/10
  put('03-clip.webm', Buffer.from(webm, 'base64'));
  put('04-broken.jpg', Buffer.from('this is not a picture at all'));
  put('10-blue.png', png(64, 36, [30, 60, 220]));
  put('README.txt', 'put pictures here');
  put('.hidden.png', png(8, 8, [0, 0, 0]));
  check('a real WebM clip was recorded for the test', fs.statSync(path.join(FOLDER, '03-clip.webm')).size > 1000);

  hub = await startHub();
  const ORDER = ['01-green.png', '2 red offer.png', '03-clip.webm', '04-broken.jpg', '10-blue.png'];

  /* ------------------------------------------------ the folder, served -- */
  const api = async () => (await fetch(`${URL}/api/screensaver`)).json();
  const a0 = await api();
  check('folder listed in name order, pictures and videos only (no README, no hidden file)',
    JSON.stringify(a0.files.map((f) => f.name)) === JSON.stringify(ORDER), a0.files.map((f) => f.name));
  check('pictures and the video told apart', a0.files.map((f) => f.kind).join() === 'image,image,video,image,image', a0.files.map((f) => f.kind));
  check('the settings come with the list', a0.minutes === IDLE_MIN && a0.slideSeconds === 1, a0);
  const red = await fetch(URL + a0.files[1].url);
  check('a file with a space in its name is served', red.status === 200 && /image\/png/.test(red.headers.get('content-type')), red.status);
  const vid = await fetch(URL + a0.files[2].url, { headers: { Range: 'bytes=0-99' } });
  check('the video is served in pieces (seekable)', vid.status === 206, vid.status);
  for (const bad of ['/screensaver/..%2fhub%2fsettings.json', '/screensaver/%2e%2e/hub/settings.json', '/screensaver/../hub/settings.json']) {
    const r = await fetch(URL + bad);
    const t = await r.text();
    check(`nothing outside the folder is served (${bad})`, !t.includes('adminPin'), r.status);
  }

  /* ------------------------------------------------------- the screens -- */
  const staff = io(URL, { transports: ['websocket'] });
  let staffToast = null;
  staff.on('toast', (t) => { staffToast = t; });
  await new Promise((r) => staff.emit('unlock', '1234', r));
  const pad = io(URL, { transports: ['websocket'] });
  let padState = null;
  pad.on('state', (s) => { padState = s; });
  await until(() => padState, 10000);
  check('the state carries the screen saver count', padState.saver && padState.saver.count === 5, padState.saver);
  const dart = () => pad.emit('dart', { score: 20, multiplier: 1 });

  const errors = [];
  const tv = await b.newPage({ viewport: { width: 1280, height: 720 } });
  tv.on('pageerror', (e) => errors.push(`tv: ${e.message}`));
  let saverFetches = 0;
  tv.on('request', (r) => { if (r.url().endsWith('/api/screensaver')) saverFetches++; });
  // What the TV shows, sampled every 50 ms: the file on screen, the box's
  // state, how far each video got.
  const watchTv = () => tv.evaluate(() => {
    window.__seen = []; window.__played = {}; window.__onEver = false;
    clearInterval(window.__w);
    window.__w = setInterval(() => {
      const box = document.getElementById('saver');
      const img = document.getElementById('saverimg');
      const v = document.getElementById('savervid');
      const on = box.classList.contains('on') && !box.hidden;
      if (on) window.__onEver = true;
      let cur = null;
      if (on && v.classList.contains('on') && v.getAttribute('src')) {
        cur = decodeURIComponent(v.getAttribute('src').split('/').pop());
        window.__played[cur] = Math.max(window.__played[cur] || 0, v.currentTime);
      } else if (on && img.classList.contains('on') && img.getAttribute('src')) {
        cur = decodeURIComponent(img.getAttribute('src').split('/').pop());
      }
      if (cur && window.__seen[window.__seen.length - 1] !== cur) window.__seen.push(cur);
    }, 50);
  });
  const tvOn = () => tv.evaluate(() => { const x = document.getElementById('saver'); return x.classList.contains('on') && !x.hidden; });
  const tvHidden = () => tv.evaluate(() => document.getElementById('saver').hidden);
  const seen = () => tv.evaluate(() => window.__seen);
  const onEver = () => tv.evaluate(() => window.__onEver);
  const resetOnEver = () => tv.evaluate(() => { window.__onEver = false; window.__seen = []; });
  const neverFor = async (ms) => { await resetOnEver(); await wait(ms); return !(await onEver()); };

  dart();                                    // the oche in use right now
  await tv.goto(`${URL}/tv`);
  await watchTv();
  await wait(1500);
  check('not before the oche has been quiet long enough', !(await onEver()));
  const t0 = Date.now();
  const came = await until(tvOn, 9000);
  check('after the quiet spell the TV shows the screen saver', !!came);
  check(`...within a couple of seconds of the idle time (${((Date.now() - t0) / 1000 + 1.5).toFixed(1)} s quiet)`, Date.now() - t0 < 6000);

  // One full round and back to the start: name order, the video played to
  // its end, the broken picture skipped.
  const round = await until(async () => { const x = await seen(); return x.length >= 5 ? x : null; }, 30000);
  check('shows every file in name order, skipping the broken one, then goes round again',
    JSON.stringify((round || []).slice(0, 5)) === JSON.stringify(['01-green.png', '2 red offer.png', '03-clip.webm', '10-blue.png', '01-green.png']), round);
  const played = await tv.evaluate(() => window.__played['03-clip.webm'] || 0);
  check(`the video played through (${played.toFixed(2)} s of 2 s)`, played > 1.5, played);

  // A dart brings the game back at once, and lets go of the pictures.
  await until(async () => (await seen()).slice(-1)[0] === '03-clip.webm', 20000);
  const d0 = Date.now();
  dart();
  const gone = await until(async () => !(await tvOn()), 3000, 20);
  check(`a dart brings the game straight back (${Date.now() - d0} ms)`, !!gone && Date.now() - d0 < 1000, Date.now() - d0);
  await until(tvHidden, 3000);
  const freed = await tv.evaluate(() => ({ v: document.getElementById('savervid').getAttribute('src'), i: document.getElementById('saverimg').getAttribute('src'), paused: document.getElementById('savervid').paused }));
  check('the video is stopped and let go when it closes', freed.v === null && freed.i === null && freed.paused, freed);
  check('...and it comes back after the next quiet spell', !!(await until(tvOn, 9000)));

  // A broadcast that is not someone playing (settings saved at the bar)
  // leaves it on.
  await until(async () => (await seen()).length >= 1, 5000);
  staff.emit('saveSettings', { venueTagline: 'Quiz night Thursday' });
  await until(async () => (await tv.evaluate(() => document.body.innerText)).includes('Quiz night Thursday') || true, 1500);
  await wait(1500);
  check('settings saved at the bar do not count as someone playing', await tvOn());

  // A name typed on the players' iPad brings the game back.
  const n0 = Date.now();
  pad.emit('addPlayer', 'Sam', padState.rosterEpoch, () => {});
  const ng = await until(async () => !(await tvOn()), 3000, 20);
  check(`a name typed on the iPad brings the game back (${Date.now() - n0} ms)`, !!ng && Date.now() - n0 < 1000);
  pad.emit('removePlayer', (padState.roster || []).find((p) => p.name === 'Sam')?.id);

  /* ------------------------------------------- a timer on the clock -- */
  await until(tvOn, 9000);
  staff.emit('sessionStart', 60, 'Test member');
  check('selling a timer brings the game back', !!(await until(async () => !(await tvOn()), 3000, 20)));
  pad.emit('newMatch', { gameId: 'x01', players: [{ name: 'Ash' }] });   // the first game starts the clock
  await until(() => padState.session && padState.session.started, 5000);
  check('the timer is running', !!(padState.session && padState.session.started));
  check('no screen saver while the clock is running, however quiet', await neverFor(9000));
  staff.emit('sessionEnd');
  await until(() => padState.session && padState.session.expired, 5000);
  check('...and it is back after the timer ends and a quiet spell', !!(await until(tvOn, 9000)));

  /* ------------------------------------------------------- powered off -- */
  staff.emit('powerOff');
  check('switching the oche off takes it away (standby instead)', !!(await until(async () => !(await tvOn()), 3000, 20)));
  check('never over the switched-off standby', await neverFor(8000));
  staffToast = null;
  staff.emit('saverShow');
  await until(() => staffToast, 3000);
  check('Show refuses while switched off, and says why', staffToast && staffToast.kind === 'error' && /switched off/.test(staffToast.text), staffToast);
  check('...and does not show it', await neverFor(2000));
  staff.emit('powerOn');
  await until(() => padState.powered === true, 5000);
  check('back after switching on and a quiet spell', !!(await until(tvOn, 12000)));

  /* --------------------------------------- the staff console: 0 = off -- */
  const sp = await b.newPage({ viewport: { width: 820, height: 1600 } });
  sp.on('pageerror', (e) => errors.push(`staff: ${e.message}`));
  await sp.goto(`${URL}/staff`);
  await wait(600);
  await sp.keyboard.type('1234');
  await until(() => sp.$('.card[data-hub="0"]'), 10000);
  await until(async () => (await sp.inputValue('#vsaver')) !== '', 5000);
  check('Venue settings show the screen saver minutes and seconds',
    (await sp.inputValue('#vsaver')) === String(IDLE_MIN) && (await sp.inputValue('#vslide')) === '1',
    [await sp.inputValue('#vsaver'), await sp.inputValue('#vslide')]);
  await sp.click('.card[data-hub="0"] details.more summary');
  const cardText = await sp.$eval('.card[data-hub="0"]', (el) => el.innerText);
  check('the board card says how many files that PC has', /5 pictures\/videos/.test(cardText), cardText.slice(0, 2000));
  await sp.fill('#vsaver', '0');
  await sp.fill('#vslide', '1');
  await sp.click('#vsave');
  await until(async () => (await api()).minutes === 0, 5000);
  check('0 saved from the console switches it off', (await api()).minutes === 0);
  check('...the TV drops it at once', !!(await until(async () => !(await tvOn()), 3000, 20)));
  check('...and it stays off however quiet', await neverFor(8000));
  const cardOff = await sp.$eval('.card[data-hub="0"]', (el) => el.innerText);
  check('the card says it is switched off', /switched off/.test(cardOff));

  // Show on TV still works when it is off: staff checking their pictures.
  await sp.click('.card[data-hub="0"] [data-act="saver"]');
  check('"Show screen saver on TV" puts it on the TV now', !!(await until(tvOn, 3000)));
  await wait(1500);
  check('...and keeps it there with no timer to it', await tvOn());
  dart();
  check('...until the next dart', !!(await until(async () => !(await tvOn()), 3000, 20)));
  check('...and, switched off, it does not come back by itself', await neverFor(8000));

  // Bad settings are refused; the old value stays.
  for (const bad of [{ screensaverMinutes: -5 }, { screensaverMinutes: 'abc' }, { screensaverMinutes: 999 },
    { screensaverSlideSeconds: 0 }, { screensaverSlideSeconds: 'x' }, { screensaverMinutes: '' }]) staff.emit('saveSettings', bad);
  await wait(500);
  const a1 = await api();
  check('nonsense screen saver settings are refused', a1.minutes === 0 && a1.slideSeconds === 1, a1);
  staff.emit('saveSettings', { screensaverMinutes: IDLE_MIN });
  await until(async () => (await api()).minutes === IDLE_MIN, 5000);
  check('switched back on, it returns after a quiet spell', !!(await until(tvOn, 9000)));

  /* ----------------------------- a TV reloaded after a quiet spell -- */
  dart();
  await until(async () => !(await tvOn()), 3000, 20);
  await wait(4000);                          // quiet for longer than the idle time
  const r0 = Date.now();
  await tv.reload();
  await watchTv();
  const back = await until(tvOn, 6000);
  check(`a TV reloaded after a quiet spell goes straight to it (${Date.now() - r0} ms)`, !!back && Date.now() - r0 < 4500, Date.now() - r0);

  /* ---------------------------------------- files dropped in, taken out -- */
  put('11-yellow.png', png(64, 36, [230, 220, 20]));
  const yellow = await until(async () => (await seen()).includes('11-yellow.png'), 45000, 200);
  check('a picture dropped into the folder is shown without a restart', !!yellow, await seen());
  const s2 = await seen();
  const yi = s2.indexOf('11-yellow.png');
  check('...in its place, after 10-blue', yi > 0 && s2[yi - 1] === '10-blue.png', s2);

  for (const f of fs.readdirSync(FOLDER)) if (f !== 'README.txt') fs.unlinkSync(path.join(FOLDER, f));
  const off = await until(async () => !(await tvOn()), 45000, 200);
  check('with the folder emptied the screen saver stops', !!off);
  const f0 = saverFetches;
  check('...and does not flash back on', await neverFor(9000));
  check(`...nor keep asking the hub (${saverFetches - f0} look(s) in 9 s)`, saverFetches - f0 <= 2, saverFetches - f0);
  staffToast = null;
  staff.emit('saverShow');
  await until(() => staffToast, 3000);
  check('Show with nothing in the folder says so', staffToast && staffToast.kind === 'error' && /No pictures or videos/.test(staffToast.text), staffToast);
  await until(() => padState.saver && padState.saver.count === 0, 3000);

  /* ---------------------------------------------------------- the rest -- */
  const tvTxt = await tv.evaluate(() => document.body.innerText);
  check('the TV is on its game screen, not stuck on black', !(await tvOn()) && tvTxt.length > 20);
  check('no page errors on the TV or the console', errors.length === 0, errors);

  staff.close(); pad.close();
  await b.close();
  hub.kill('SIGTERM');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
