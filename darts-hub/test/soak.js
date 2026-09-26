/*
 * Soak test: run the hub + a self-throwing fake board + all four screens
 * (TV, pad, leaderboard, staff) for SOAK_MIN minutes of continuous pub-like
 * activity - games back to back, sessions, power cycles - while sampling
 * hub memory, page JS heaps, page errors and socket health. Writes
 * soak.log (progress) and soak-results.json (verdict).
 */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const PORT = Number(process.env.TPORT || 8899);
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const SOAK_MIN = Number(process.env.SOAK_MIN || 25);
const URL = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  fs.appendFileSync(`${SP}/soak.log`, line + '\n');
};

const results = {
  startedAt: new Date().toISOString(),
  minutes: SOAK_MIN,
  samples: [],           // periodic {t, hubRssMb, heaps, packets, dartsInLog, connected}
  pageErrors: {},        // page -> [messages]
  consoleErrors: {},     // page -> [messages]
  driverDisconnects: 0,
  gamesFinished: 0,
  gamesStarted: 0,
  powerCycles: 0,
  billingToasts: 0,
  errorToasts: [],
  verdict: null,
};

(async () => {
  fs.writeFileSync(`${SP}/soak.log`, '');
  fs.rmSync(`${SP}/soakdata`, { recursive: true, force: true });

  // ---- hub with fake board -------------------------------------------------
  const hubOut = fs.openSync(`${SP}/soak-hub.log`, 'w');
  const hub = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, PORT: String(PORT), DARTS_DATA: `${SP}/soakdata` },
    stdio: ['ignore', hubOut, hubOut],
  });
  log(`hub spawned pid ${hub.pid}`);
  let hubExited = null;
  hub.on('exit', (code, sig) => { hubExited = { code, sig, at: new Date().toISOString() }; });
  await wait(3000);

  // ---- driver socket (the staff iPad, effectively) -------------------------
  let state = null;
  const sock = io(URL);
  sock.on('state', (s) => { state = s; });
  sock.on('disconnect', () => { results.driverDisconnects += 1; });
  sock.on('toast', (t) => {
    if (/billed £/.test(t.text)) results.billingToasts += 1;
    // "No time on the clock" right after a power cycle is the driver racing
    // itself, not the app; everything else lands in the report.
    if (t.kind === 'error' && !/No time on the clock|Game already finished|Dart received - start a game/.test(t.text)) results.errorToasts.push(t.text);
  });
  await wait(500);
  await new Promise((r) => sock.emit('unlock', '1234', r));
  sock.emit('boardConnect');
  await wait(3000);
  log(`board: ${state && state.board.state}`);

  // ---- the four screens ----------------------------------------------------
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--enable-precise-memory-info'],
  });
  const pages = {};
  const open = async (name, path, viewport) => {
    const p = await browser.newPage({ viewport });
    results.pageErrors[name] = [];
    results.consoleErrors[name] = [];
    p.on('pageerror', (e) => results.pageErrors[name].push(String(e.message).slice(0, 200)));
    p.on('console', (m) => { if (m.type() === 'error') results.consoleErrors[name].push(m.text().slice(0, 200)); });
    await p.goto(`${URL}${path}`);
    pages[name] = p;
  };
  await open('tv', '/tv', { width: 1920, height: 1080 });
  await open('pad', '/pad', { width: 820, height: 1180 });
  await open('board', '/board', { width: 1920, height: 1080 });
  await open('staff', '/staff', { width: 820, height: 1400 });
  await pages.staff.waitForTimeout(800);
  await pages.staff.keyboard.type('1234');
  log('four screens open, staff unlocked');

  // ---- activity loop -------------------------------------------------------
  const rotation = [
    { gameId: 'x01', variantId: '501' },
    { gameId: 'countup' },
    { gameId: 'atc' },
    { gameId: 'cricket' },
    { gameId: 'shanghai' },
    { gameId: 'halveit' },
    { gameId: 'highscore' },
    { gameId: 'prisoner' },
    { gameId: 'killer', variantId: 'standard' },
    { gameId: 'killer', variantId: 'doubles' },
    { gameId: 'cricket', variantId: 'cutthroat' },
    { gameId: 'legs' },
    { gameId: 'countup' },
  ];
  let rot = 0;
  let matchStartedAt = 0;
  let wasFinished = false;
  let poweringUntil = 0;

  const tick = setInterval(() => {
    if (!state || Date.now() < poweringUntil) return;
    try {
      if (state.powered === false) return; // power cycler owns this window
      if (!state.session) {
        sock.emit('savePlayers', [{ id: 'p1', name: 'Ash' }, { id: 'p2', name: 'Sam' }]);
        sock.emit('sessionStopwatch');
        return;
      }
      const m = state.match;
      if (m && m.finished && !wasFinished) { results.gamesFinished += 1; }
      wasFinished = !!(m && m.finished);
      const stale = m && !m.finished && Date.now() - matchStartedAt > 4 * 60 * 1000;
      if (!m || m.finished || stale) {
        const pick = rotation[rot++ % rotation.length];
        sock.emit('newMatch', { ...pick, players: [{ name: 'Ash' }, { name: 'Sam' }] });
        results.gamesStarted += 1;
        matchStartedAt = Date.now();
      }
    } catch (e) { log(`tick error: ${e.message}`); }
  }, 3000);

  // ---- power cycler: off for 20s every 6 minutes ---------------------------
  const cycler = setInterval(() => {
    poweringUntil = Date.now() + 30000;
    log('power cycle: OFF');
    sock.emit('powerOff');
    setTimeout(() => {
      log('power cycle: ON');
      sock.emit('powerOn');
      results.powerCycles += 1;
      poweringUntil = Date.now() + 8000; // let the board reconnect
    }, 20000);
  }, 6 * 60 * 1000);

  // ---- sampler -------------------------------------------------------------
  const heapOf = async (p) => p.evaluate(() =>
    (performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10) || null,
  ).catch(() => 'dead');
  const t0 = Date.now();
  const sampler = setInterval(async () => {
    try {
      const rss = (() => {
        try {
          const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${hub.pid}/status`, 'utf8'));
          return m ? Math.round(Number(m[1]) / 1024 * 10) / 10 : null;
        } catch (_) { return null; }
      })();
      const heaps = {};
      for (const [n, p] of Object.entries(pages)) heaps[n] = await heapOf(p);
      const sample = {
        min: Math.round((Date.now() - t0) / 6000) / 10,
        hubRssMb: rss,
        heapsMb: heaps,
        tvCel: await pages.tv.evaluate(() => { const c = document.getElementById('cel'); return c && /show/.test(c.className) ? document.getElementById('celtext').innerText.replace(/\n/g, ' ') : ''; }).catch(() => 'err'),
        packets: state && state.board.packets,
        powered: state && state.powered,
        boardState: state && state.board.state,
        connected: sock.connected,
      };
      results.samples.push(sample);
      log(`sample ${sample.min}m rss=${rss}MB heaps=${JSON.stringify(heaps)} packets=${sample.packets} board=${sample.boardState} games=${results.gamesFinished}/${results.gamesStarted}`);
    } catch (e) { log(`sampler error: ${e.message}`); }
  }, 30000);

  // ---- run -----------------------------------------------------------------
  await wait(SOAK_MIN * 60 * 1000);
  clearInterval(tick); clearInterval(cycler); clearInterval(sampler);

  // ---- end-of-soak checks --------------------------------------------------
  const finals = {};
  for (const [n, p] of Object.entries(pages)) {
    finals[n] = {
      alive: await p.evaluate(() => 1 + 1).then((v) => v === 2).catch(() => false),
      keepAwake: await p.evaluate(() => window.WinchesterAwake && WinchesterAwake()).catch(() => 'err'),
    };
  }
  results.finals = finals;
  results.hubExited = hubExited;
  results.endedAt = new Date().toISOString();

  const first = results.samples[0] || {};
  const last = results.samples[results.samples.length - 1] || {};
  results.hubRssGrowthMb = first.hubRssMb != null && last.hubRssMb != null
    ? Math.round((last.hubRssMb - first.hubRssMb) * 10) / 10 : null;

  const anyPageErr = Object.values(results.pageErrors).some((a) => a.length)
    || Object.values(results.consoleErrors).some((a) => a.length);
  let stuck = 0;
  for (let i = 2; i < results.samples.length; i++) {
    const a = results.samples[i - 2].tvCel, b2 = results.samples[i - 1].tvCel, c = results.samples[i].tvCel;
    if (a && a === b2 && b2 === c) stuck++;
  }
  results.stuckCelebrations = stuck;
  const allAlive = Object.values(finals).every((f) => f.alive && f.keepAwake !== 'off' && f.keepAwake !== 'err');
  results.verdict = !hubExited && !anyPageErr && allAlive && stuck === 0 && results.errorToasts.length === 0 && results.driverDisconnects === 0
    && results.gamesFinished > 0 ? 'PASS' : 'INVESTIGATE';

  fs.writeFileSync(`${SP}/soak-results.json`, JSON.stringify(results, null, 2));
  log(`verdict: ${results.verdict}`);
  await browser.close().catch(() => {});
  hub.kill();
  fs.writeFileSync(`${SP}/soak.done`, results.verdict);
  process.exit(0);
})().catch((e) => {
  log(`FATAL: ${e.stack}`);
  results.verdict = 'CRASHED: ' + e.message;
  fs.writeFileSync(`${SP}/soak-results.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${SP}/soak.done`, 'CRASHED');
  process.exit(1);
});
