'use strict';
/*
 * Darts Hub - one service, two screens.
 *   /tv    big-screen scoreboard + live dartboard   (the 40" TV)
 *   /pad   touch control panel                       (the iPad)
 * The board talks Bluetooth to this machine; every screen is just a browser.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Match, catalogue, label } = require('./games');
const till = require('./till');
const { Board } = require('./board');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DARTS_DATA || path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const CELEBRATIONS = path.join(ROOT, 'celebrations');
let PORT = Number(process.env.PORT || 8080);

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(CELEBRATIONS, { recursive: true });

/* ------------------------------------------------------------ storage --- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch (_) { return fallback; }
}
function writeJson(file, value) {
  try { fs.writeFileSync(path.join(DATA, file), JSON.stringify(value, null, 2)); }
  catch (err) { console.error(`could not save ${file}:`, err.message); }
}

const settings = Object.assign({
  boardUuid: '',
  buttonNumber: 20,
  autoConnect: true,
  celebrations: true,
  sound: true,
  venueName: 'The Winchester',
  venueTagline: 'Darts',
  venueLocation: 'Wigston · Leicester',
  theme: 'green',
  adminPin: '1234',     // gate on the Settings tab; changeable from Settings
  pricePerHour: 10,     // what an hour on the oche costs; the till does the rest
  prizeAmount: 1000,    // the perfect-run cash prize (ATC triples, no misses)
  leaderboardResetAt: 0, // staff can restart the top-50 table; all-time keeps everything
  boardName: 'Board 1', // label for this oche when several run in one venue
  peers: [],            // other hubs' addresses, e.g. ["http://192.168.1.51:8080"]
}, readJson('settings.json', {}));

// A stable identity for this hub on the venue network (board discovery).
// Generated once and kept, so the same PC stays the same board across
// restarts and DHCP address changes.
if (!settings.discoveryId) {
  settings.discoveryId = require('crypto').randomBytes(8).toString('hex');
  writeJson('settings.json', settings);
}

// Starts empty on purpose: names people typed themselves beat "Player 1"
// on the telly every time. The filter also clears the placeholders out of
// rosters saved by earlier versions.
let roster = readJson('players.json', []).filter((p) => p && !/^Player \d+$/i.test(p.name || ''));
let history = readJson('history.json', []);
let sessionsLog = readJson('sessions.json', []);
function saveSessions() { writeJson('sessions.json', sessionsLog); }

/*
 * The customer timer. Staff arm it from the locked Settings tab with a number
 * of minutes; the countdown starts when the customers' FIRST game starts (or
 * immediately, if a game is already running) and shows on both screens. While
 * it runs they can play as many games as they like; once it hits zero no new
 * game can begin. Survives a restart - time sold is time owed.
 */
let session = readJson('session.json', null);
function saveSession() { writeJson('session.json', session); }
function sessionInfo() {
  if (!session) return null;
  // Stopwatch sessions count up and never expire - pay-at-the-end time.
  if (session.mode === 'stopwatch') {
    return {
      mode: 'stopwatch',
      started: !!session.startedAt,
      startedAt: session.startedAt || null,
      elapsedMs: session.startedAt ? Date.now() - session.startedAt : 0,
      endsAt: null,
      serverNow: Date.now(),
      remainingMs: null,
      expired: false,
    };
  }
  const endsAt = session.startedAt ? session.startedAt + session.minutes * 60000 : null;
  return {
    mode: 'timer',
    minutes: session.minutes,
    started: !!session.startedAt,
    endsAt,
    serverNow: Date.now(),
    remainingMs: endsAt ? Math.max(0, endsAt - Date.now()) : null,
    expired: !!endsAt && Date.now() >= endsAt,
  };
}

function saveSettings() { writeJson('settings.json', settings); }
function saveRoster() { writeJson('players.json', roster); }
function saveHistory() { writeJson('history.json', history.slice(-5000)); }
function saveMatch() { writeJson('match.json', match ? match.toJSON() : null); }

/* -------------------------------------------------------------- match --- */

let match = null;
const saved = readJson('match.json', null);
if (saved && saved.gameId) {
  try { match = Match.fromJSON(saved); } catch (err) { console.error('could not restore match:', err.message); }
}

/*
 * A cash attempt that never reached the bull still belongs in the day's
 * paperwork - however the game ends (abandoned, replaced, session over).
 * Called just before a match is discarded; finished matches are handled by
 * recordIfFinished instead.
 */
function retirePrizeAttempt() {
  if (!match || match.state.finished) return;
  if (!match.config || !match.config.prize || !match.state.prize) return;
  history.push({
    at: new Date().toISOString(),
    board: settings.boardName,
    game: match.gameId, variant: match.variantId,
    players: match.roster.map((p) => p.name),
    winner: null,
    darts: match.log.filter((e) => e.k === 'd').length,
    oneEighties: 0, bestVisit: 0, high: null,
    prize: { outcome: 'failed', hits: match.state.prize.hits || 0, player: match.roster[0] && match.roster[0].name },
  });
  saveHistory();
}

let lastRecorded = null;
function recordIfFinished() {
  if (!match || !match.state.finished) return;
  const key = match.startedAt + (match.state.winner ? match.state.winner.id : '');
  if (key === lastRecorded) return;
  lastRecorded = key;
  // Notable numbers for the all-time records - only the games that track them.
  const ps = match.state.players || [];
  const oneEighties = ps.reduce((a, q) => a + (q.oneEighties || 0), 0);
  const bestVisit = ps.reduce((a, q) => Math.max(a, q.bestVisit || 0), 0);
  // The venue high-score tables: the match's standout number and who threw
  // it. X01 keeps its biggest visit; Around the Clock keeps the furthest run
  // (numbers completed, 21 = finished, fewest darts breaks ties).
  let high = null;
  if (match.gameId === 'x01') {
    const b = ps.reduce((a, q) => ((q.bestVisit || 0) > a.value ? { name: q.name, value: q.bestVisit } : a), { name: null, value: 0 });
    if (b.name) high = b;
  } else if (match.gameId === 'atc') {
    const win = match.state.winner;
    const b = ps.reduce((a, q) => {
      const done = win && win.id === q.id ? 21 : Math.min(20, (q.target || 1) - 1);
      const qd = q.darts || 0;
      return (done > a.value || (done === a.value && qd < a.darts)) ? { name: q.name, value: done, darts: qd } : a;
    }, { name: null, value: -1, darts: Infinity });
    if (b.name) high = b;
  }
  history.push({
    at: new Date().toISOString(),
    board: settings.boardName,
    game: match.gameId, variant: match.variantId,
    prize: match.config && match.config.prize
      ? (match.state.prize && !match.state.prize.failed && match.state.winner
        ? { outcome: 'won', amount: settings.prizeAmount, player: match.state.winner.name }
        : { outcome: 'failed', hits: (match.state.prize && match.state.prize.hits) || 0,
            player: match.roster[0] && match.roster[0].name })
      : undefined,
    players: match.roster.map((p) => p.name),
    winner: match.state.winner ? match.state.winner.name : null,
    darts: match.log.filter((e) => e.k === 'd').length,
    oneEighties, bestVisit, high,
  });
  saveHistory();
}

/* --------------------------------------------------------------- app ---- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
// The combined staff console and leaderboard are served by one hub but read
// every hub - the browser needs these read-only APIs reachable cross-origin.
app.use('/api', (_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.static(PUBLIC, { maxAge: 0, etag: false }));
app.use('/celebrations', express.static(CELEBRATIONS, { maxAge: 0 }));

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'connect.html')));
app.get('/tv', (_req, res) => res.sendFile(path.join(PUBLIC, 'tv.html')));
app.get('/pad', (_req, res) => res.sendFile(path.join(PUBLIC, 'pad.html')));
app.get(['/board', '/leaderboard'], (_req, res) => res.sendFile(path.join(PUBLIC, 'leaderboard.html')));
app.get('/staff', (_req, res) => res.sendFile(path.join(PUBLIC, 'staff.html')));
app.get('/health', (_req, res) => res.json({ ok: true, board: board.status, match: !!match }));

/** Custom celebration clips: drop files into /celebrations named by event. */
function celebrationFiles() {
  try {
    return fs.readdirSync(CELEBRATIONS)
      .filter((f) => /\.(gif|webp|png|mp4|webm)$/i.test(f))
      .map((f) => ({ name: path.parse(f).name.toLowerCase(), url: `/celebrations/${encodeURIComponent(f)}` }));
  } catch (_) { return []; }
}
app.get('/api/celebrations', (_req, res) => res.json(celebrationFiles()));

/* Which boards make up this venue. The combined pages start from here. */
app.get('/api/peers', (_req, res) => {
  res.json({ name: settings.boardName, peers: settings.peers || [] });
});

/* Full results - the merged leaderboard reads this from every hub. */
app.get('/api/history', (_req, res) => {
  res.json({ name: settings.boardName, history, resetAt: settings.leaderboardResetAt || 0 });
});

/*
 * Takings and names are staff business: these endpoints want the venue PIN
 * (?pin=...), same trust model as the console's own gate. Wrong guesses are
 * rate-limited per address like the discovery challenge.
 */
function staffGuard(req, res) {
  const ip = String(req.ip || req.socket.remoteAddress || '?');
  const now = Date.now();
  const fails = (verifyFails.get(ip) || []).filter((t) => now - t < 60000);
  if (fails.length >= 10) { res.status(429).json({ error: 'slow down' }); return false; }
  const pin = String(req.query.pin || '');
  const want = String(settings.adminPin || '1234');
  const ok = pin.length === want.length
    && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(want));
  if (!ok) {
    fails.push(now);
    verifyFails.set(ip, fails);
    res.status(401).json({ error: 'PIN required' });
    return false;
  }
  return true;
}

/* Today's paid sessions - the staff console's "who's played today" list. */
app.get('/api/today', (req, res) => {
  if (!staffGuard(req, res)) return;
  const today = till.dayKey(Date.now());
  res.json({
    name: settings.boardName,
    pricePerHour: settings.pricePerHour,
    sessions: sessionsLog.filter((r) => till.dayKey(r.endedAt) === today),
  });
});

/* The day-so-far as a PDF, generated fresh on every request. */
app.get('/api/report-today', (req, res) => {
  if (!staffGuard(req, res)) return;
  const key = till.dayKey(Date.now());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${key}-report.pdf"`);
  res.end(buildReport(key));
});

/* -------------------------------------------------------------- brand --- */

const THEMES = ['green', 'claret', 'black', 'midnight'];
const LOGO_NAMES = ['logo.svg', 'logo.png', 'logo.webp', 'logo.jpg'];

/** A logo dropped into public/brand replaces the built-in crest. */
function logoUrl() {
  for (const n of LOGO_NAMES) {
    if (fs.existsSync(path.join(PUBLIC, 'brand', n))) return `/brand/${n}?v=${Date.now()}`;
  }
  return null;
}

/** Read image dimensions without a decoder, so we can tell a wordmark from a badge. */
function imageAspect(file) {
  try {
    const buf = fs.readFileSync(file);
    if (file.endsWith('.svg')) {
      const txt = buf.toString('utf8', 0, 2000);
      const vb = /viewBox\s*=\s*["']\s*[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(txt);
      if (vb) return Number(vb[1]) / Number(vb[2]);
      return null;
    }
    // PNG: IHDR width/height are big-endian at bytes 16..24
    if (buf.length > 24 && buf.toString('hex', 1, 4) === '504e47') {
      return buf.readUInt32BE(16) / buf.readUInt32BE(20);
    }
  } catch (_) {}
  return null;
}

function brand() {
  const url = logoUrl();
  let wide = false;
  if (url) {
    const file = path.join(PUBLIC, 'brand', url.split('?')[0].replace('/brand/', ''));
    const aspect = imageAspect(file);
    wide = aspect !== null && aspect >= 2;
  }
  return {
    name: settings.venueName,
    tagline: settings.venueTagline,
    location: settings.venueLocation,
    theme: settings.theme,
    themes: THEMES,
    logoUrl: url,
    logoWide: wide,
  };
}

app.get('/api/brand', (_req, res) => res.json(brand()));

/*
 * Board discovery, step two: prove you know the venue PIN. The caller sends
 * a nonce and HMAC(pin, nonce); we answer only whether it matches ours -
 * the PIN itself never crosses the network, and a wrong guess teaches the
 * guesser nothing. Failed guesses are rate-limited per address so this is
 * no faster an oracle than the socket unlock it sits beside.
 */
const verifyFails = new Map(); // ip -> recent failure timestamps
app.get('/api/discovery-verify', (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || '?');
  const now = Date.now();
  const fails = (verifyFails.get(ip) || []).filter((t) => now - t < 60000);
  if (fails.length >= 10) return res.status(429).json({ app: 'winchesterdarts', match: false });
  const c = String(req.query.c || '').slice(0, 64);
  const sig = String(req.query.sig || '').slice(0, 128);
  const want = discoverySig(c, settings.adminPin);
  const match = sig.length === want.length
    && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  if (!match) { fails.push(now); verifyFails.set(ip, fails); }
  res.json({
    app: 'winchesterdarts',
    match,
    name: match ? settings.boardName : undefined,
    id: match ? settings.discoveryId : undefined,
  });
});

/* One place to look when the board will not connect. */
const DIAG_FILE = path.join(ROOT, 'diagnostics.txt');

function diagnostics() {
  return {
    when: new Date().toISOString(),
    app: 'winchester-darts',
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    diagnosticsFile: DIAG_FILE,
    board: board.diagnostics(),
  };
}

/*
 * Always drop a copy on disk. The iPad reaches this hub over plain http, where
 * browsers refuse the clipboard API outright, so "copy for support" can fail
 * through no fault of the person pressing it. A file next to the exe needs no
 * clipboard, no permission and no network.
 */
function writeDiagFile(payload) {
  try { fs.writeFileSync(DIAG_FILE, JSON.stringify(payload, null, 2)); } catch (_) {}
}

app.get('/api/board-diag', (_req, res) => {
  const d = diagnostics();
  writeDiagFile(d);
  res.json(d);
});

/* Same thing as plain text: opens readably in any browser, select-all works. */
app.get('/api/board-diag.txt', (_req, res) => {
  const d = diagnostics();
  writeDiagFile(d);
  res.type('text/plain').send(JSON.stringify(d, null, 2));
});

/* -------------------------------------------------------------- board --- */

const board = new Board();
let boardInfo = { state: 'idle', detail: 'not started', discovered: [] };

/*
 * Lining the board up. The board reports segments in its own frame, so a board
 * hung any way but one reports the wrong numbers. Rather than have staff guess
 * the rotation, take one dart thrown into the 20 and work it out from that.
 */
let calibrating = null;

board.on('status', (s) => {
  boardInfo = Object.assign({}, s, {
    battery: board.battery,
    batteryLow: board.battery !== null && board.battery <= 40,
    verdict: board.verdict(),
  });
  broadcast();
});
board.on('dart', (d) => {
  if (calibrating) {
    const target = calibrating.target;
    const found = Board.buttonFor(d.raw, target);
    clearTimeout(calibrating.timer);
    calibrating = null;
    if (found === null) {
      io.emit('toast', { kind: 'error', text: 'Could not read that dart - try again, in the big 20' });
    } else {
      settings.buttonNumber = found;
      board.buttonNumber = found;
      board.resetRepeat();          // the line-up dart must not block the next one
      saveSettings();
      io.emit('toast', { kind: 'ok', text: `Board lined up - rotation set to ${found}` });
    }
    io.emit('calibrated', { done: true, buttonNumber: found });
    return broadcast();
  }
  handleDart(d, 'board');
});
board.on('packet', (p) => io.emit('boardpacket', p));
board.on('button', () => {
  if (match && !match.state.finished) {
    const before = match.view();
    const events = match.endTurn();   // Halve It can halve you on a pass
    recordIfFinished();
    saveMatch();
    emitEvents(events, null);
    emitVisitIfTurnPassed(before, events);
    broadcast();
  }
});

if (settings.autoConnect) {
  setTimeout(() => board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber }), 800);
}

/* ------------------------------------------------------------ updates --- */

function snapshot() {
  return {
    match: match ? match.view() : null,
    roster,
    settings: {
      boardUuid: settings.boardUuid, buttonNumber: settings.buttonNumber,
      celebrations: settings.celebrations, sound: settings.sound, autoConnect: settings.autoConnect,
      venueName: settings.venueName, venueTagline: settings.venueTagline,
      venueLocation: settings.venueLocation, theme: settings.theme,
      boardName: settings.boardName, peers: settings.peers || [],
      discoveryId: settings.discoveryId,
      pricePerHour: settings.pricePerHour,
      prizeAmount: settings.prizeAmount,
    },
    brand: brand(),
    board: boardInfo,
    session: sessionInfo(),
    games: catalogue(),
    history: history.slice(-12).reverse(),
    history50: history.slice(-50),
    server: { port: PORT, addresses: addresses() },
  };
}

function broadcast() { io.emit('state', snapshot()); }

/*
 * Time is up: end the group's session completely so the oche is ready for the
 * next one. The game in progress ends (its result is recorded first if it
 * actually finished), the player list empties, and the pad locks itself until
 * staff start a new timer. Also used by the staff console's "End session now".
 * Runs on the after-restart tick too, so a timer that expired while the PC
 * was off still resets everything.
 */
/*
 * The bill for a finished session, written down once. Timer sessions charge
 * the minutes staff sold (extensions included); stopwatch sessions charge
 * time played - minimum an hour, then to the nearest half hour. Names are
 * everyone who was on the oche at any point, so staff know who to charge.
 */
function recordSession(endOverride) {
  if (!session || !session.startedAt || session.recorded) return null;
  session.recorded = true;
  // A timer's bill ends when its sold time ran out, even if this line runs
  // hours later (the PC slept, or was off at closing time) - so the money
  // lands on the right day and "minutes played" stays sane.
  let endedAt = Number(endOverride) || Date.now();
  if (session.mode !== 'stopwatch') {
    endedAt = Math.min(endedAt, session.startedAt + session.minutes * 60000);
  }
  endedAt = Math.max(endedAt, session.startedAt);
  const played = Math.max(0, (endedAt - session.startedAt) / 60000);
  const basis = session.mode === 'stopwatch' ? played : session.minutes;
  const rate = session.rate !== undefined ? session.rate : settings.pricePerHour;
  const { chargedMinutes, price } = till.priceFor(session.mode, basis, rate);
  const names = [...new Set([...(session.names || []), ...roster.map((p) => p.name)])];
  sessionsLog.push({
    startedAt: session.startedAt,
    endedAt,
    mode: session.mode,
    minutesPlayed: Math.round(played),
    chargedMinutes,
    price,
    names,
    board: settings.boardName,
  });
  if (sessionsLog.length > 2000) sessionsLog = sessionsLog.slice(-2000);
  saveSessions();
  saveSession();
  return sessionsLog[sessionsLog.length - 1];
}

/*
 * A new session starting over a live one closes the old bill first and hands
 * the oche over clean - one stray "1 hour" tap must never erase a
 * pay-at-the-end stopwatch bill or leave the old group's names on the new tab.
 */
function closeRunningSession() {
  if (!session || !session.startedAt || session.recorded) return null;
  const bill = recordSession();
  recordIfFinished();
  retirePrizeAttempt();
  match = null;
  saveMatch();
  roster = [];
  saveRoster();
  io.emit('sessionover', {});
  return bill;
}

function expireSession() {
  recordSession();
  if (session) { session.warned = true; saveSession(); }
  recordIfFinished();
  retirePrizeAttempt();
  match = null;
  saveMatch();
  roster = [];
  saveRoster();
  io.emit('sessionover', {});
  io.emit('toast', { kind: 'error', text: 'Time is up - see the bar to add more' });
  broadcast();
}

setInterval(() => {
  const si = sessionInfo();
  if (!si || !si.expired || (session && session.warned)) return;
  expireSession();
}, 5000);

/*
 * Sleep detector: a 5-second heartbeat that arrives half a minute late means
 * the PC was suspended. BLE handles rarely survive that, so rebuild the board
 * connection automatically - previously this needed the app closed and
 * reopened by hand.
 */
let lastHeartbeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastHeartbeat > 30000) {
    console.log('wake from sleep detected - rebuilding the board connection');
    try { if (board.resumeRecover()) broadcast(); } catch (_) {}
    // Slept for over an hour with a session running? That evening is over:
    // bill it up to the moment the PC went down, so a stopwatch never
    // charges for hours nobody could have played.
    if (now - lastHeartbeat > 60 * 60000 && session && session.startedAt && !session.recorded) {
      recordSession(lastHeartbeat);
      expireSession();
    }
  }
  lastHeartbeat = now;
}, 5000);

/*
 * A liveness stamp on disk, once a minute. At boot it tells us when the
 * previous run last drew breath - the honest end time for any session that
 * was still open when the PC was shut down or slept overnight.
 */
const PREV_ALIVE = readJson('alive.json', {}).t || 0;
const BOOT_AT = Date.now();
setInterval(() => writeJson('alive.json', { t: Date.now() }), 60000);
writeJson('alive.json', { t: Date.now() });

// A session restored from a previous run that has been dead for over an
// hour is settled now, dated to when that run was last alive - before the
// report backfill below, so the money lands on the right day's PDF.
if (session && session.startedAt && !session.recorded
    && session.startedAt < BOOT_AT && PREV_ALIVE && BOOT_AT - PREV_ALIVE > 60 * 60000) {
  recordSession(PREV_ALIVE);
  expireSession();
}

/* ------------------------------------------------------------ reports --- */

const REPORTS = process.env.DARTS_REPORTS || path.join(ROOT, 'reports');
// Past reports browsable from the staff iPad: /reports/Aug/27-08-26-report.pdf?pin=...
app.use('/reports', (req, res, next) => { if (staffGuard(req, res)) next(); }, express.static(REPORTS));

function buildReport(key) {
  const sessions = sessionsLog.filter((r) => till.dayKey(r.endedAt) === key);
  const dayGames = history.filter((g) => g.at && till.dayKey(Date.parse(g.at)) === key);
  const prizes = dayGames.filter((g) => g.prize).map((g) => ({ ...g.prize, player: g.prize.player || g.winner }));
  return till.textPdf(till.reportLines(settings.venueName, settings.boardName, key, sessions, dayGames.length, prizes));
}

/**
 * Write reports/<Mon>/<DD-MM-YY>-report.pdf. The midnight write replaces any
 * earlier file (its data is final); backfill fills gaps without touching
 * reports that already exist.
 */
function writeReport(key, overwrite) {
  try {
    const { folder, file } = till.reportPath(key);
    const dir = path.join(REPORTS, folder);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, file);
    if (!overwrite && fs.existsSync(target)) return;
    fs.writeFileSync(target, buildReport(key));
    console.log(`daily report written: reports/${folder}/${file}`);
  } catch (err) {
    console.error('could not write daily report:', err.message);
  }
}

/** '27-08-26' as a comparable date - guards against a mis-set clock jumping backwards. */
function keyDate(key) {
  return new Date(2000 + Number(key.slice(6, 8)), Number(key.slice(3, 5)) - 1, Number(key.slice(0, 2)));
}

/*
 * End-of-day paperwork. When the calendar ticks over, the finished day's
 * report is written; on boot, any past day that has sessions but no report
 * (the PC was off at midnight) is filled in.
 */
let reportDay = till.dayKey(Date.now());
for (const key of [...new Set(sessionsLog.map((r) => till.dayKey(r.endedAt)))]) {
  if (key !== reportDay) writeReport(key);
}
setInterval(() => {
  const today = till.dayKey(Date.now());
  if (today !== reportDay) {
    // Only a day that genuinely finished gets its final report; a clock set
    // BACKWARDS must not stamp out an empty PDF for a day still to come.
    if (keyDate(reportDay) < keyDate(today)) writeReport(reportDay, true);
    reportDay = today;
  }
}, 60000);

function emitEvents(events, dart) {
  if (dart) io.emit('dart', dart);
  for (const ev of events || []) {
    if (ev.type === 'prizewin' || ev.type === 'prizefail') ev.amount = settings.prizeAmount;
    io.emit('celebrate', ev);
    if (ev.type === 'prizewin') {
      io.emit('toast', { kind: 'ok', text: `£${settings.prizeAmount} PRIZE WON by ${ev.player} - keep that video safe!` });
    }
  }
}

/**
 * When the turn passes, tell the screens whose visit just finished and what it
 * scored - the TV holds it up so the player sees their total before play moves
 * on, and the caller reads it out. `special` says whether something bigger
 * happened with the same darts (game shot, bust...), so the caller announces
 * that instead of the number.
 */
function emitVisitIfTurnPassed(before, events) {
  if (!match) return;
  const after = match.view();
  const finished = match.state.finished;
  if (!finished && after.turnPlayerId === before.turnPlayerId
      && after.legNumber === before.legNumber) return;
  const who = (before.rows || []).find((r) => r.id === before.turnPlayerId);
  const types = (events || []).map((e) => e.type);
  const special = types.includes('matchwin') ? 'matchwin'
    : types.includes('legwin') ? 'legwin'
    : types.includes('checkout') ? 'checkout'
    : types.includes('bust') ? 'bust'
    : types.includes('halved') ? 'bust'      // the clip says "No score!" - exactly right
    : null;
  io.emit('visit', {
    player: who ? who.name : '',
    darts: after.lastVisit || [],
    total: after.lastVisitTotal || 0,
    special,
  });
}

function handleDart(dart, source) {
  if (!match || match.state.finished) {
    // The board is working - there is just nothing to score into. Say so on
    // the TV as well: whoever is throwing is looking at that, not the iPad.
    if (source === 'board') {
      const text = match
        ? 'Game already finished - restart or start a new game'
        : 'Dart received - start a game to score it';
      io.emit('toast', { kind: 'error', text });
      io.emit('nogame', { at: Date.now(), finished: !!match, label: label(dart) });
    }
    return;
  }
  const clean = {
    score: Math.max(0, Math.min(25, Number(dart.score) || 0)),
    multiplier: Math.max(1, Math.min(3, Number(dart.multiplier) || 1)),
  };
  if (clean.score === 25 && clean.multiplier === 3) clean.multiplier = 2;  // no treble bull
  const before = match.view();
  const events = match.addDart(clean);
  recordIfFinished();
  saveMatch();
  emitEvents(events, { ...clean, source });
  emitVisitIfTurnPassed(before, events);
  broadcast();
}

/*
 * Board discovery - "Find boards" on the staff console.
 *
 * Every hub answers a UDP broadcast on one well-known port with its name,
 * HTTP port and stable id, so the staff console can list the venue's
 * machines instead of anyone typing IP addresses. A UDP reply is a lead,
 * not a board: before anything is offered for adding, the hub checks the
 * candidate over HTTP with a PIN-based challenge (HMAC of a fresh nonce),
 * so a stranger's laptop answering broadcasts can never be one-tap added -
 * and never gets sent the venue PIN. Discovery is a convenience: any
 * failure here is swallowed - the hub must run fine on networks that block
 * broadcast.
 */
const DISCOVERY_PORT = 41786;
const DISCOVERY_HELLO = 'WINCHDARTS_HELLO_V1';
const DISCOVERY_HERE = 'WINCHDARTS_HERE_V1 ';

try {
  // reuseAddr so several hubs on one machine (dev, tests) can all answer.
  const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  beacon.on('error', () => { try { beacon.close(); } catch (_) {} });
  beacon.on('message', (msg, rinfo) => {
    if (msg.toString().slice(0, DISCOVERY_HELLO.length) !== DISCOVERY_HELLO) return;
    const here = DISCOVERY_HERE + JSON.stringify({
      id: settings.discoveryId, name: settings.boardName, port: PORT,
    });
    // Per-send noop callback: one unroutable reply must not error the socket.
    beacon.send(here, rinfo.port, rinfo.address, () => {});
  });
  beacon.bind(DISCOVERY_PORT);
} catch (_) { /* no beacon, no drama */ }

/* Broadcast targets: every interface's own broadcast address plus the blanket one. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal || !net.netmask) continue;
      const ip = net.address.split('.').map(Number);
      const mask = net.netmask.split('.').map(Number);
      out.add(ip.map((oct, i) => (oct | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

/* The proof another hub knows this venue's PIN, without ever sending the PIN. */
function discoverySig(nonce, pin) {
  return crypto.createHmac('sha256', String(pin || '')).update(String(nonce)).digest('hex');
}

/* Tiny JSON GET with a hard deadline; errors resolve to null, never throw. */
function fetchJson(url, ms, done) {
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; done(v); } };
  const req = http.get(url, { timeout: ms }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    res.on('end', () => { try { finish(JSON.parse(body)); } catch (_) { finish(null); } });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => finish(null));
}

/*
 * Shout, listen briefly, then vet every reply over HTTP. Probes go out three
 * times over the window because UDP drops packets for a living; replies are
 * deduped by hub id (so a twin-NIC PC lists once) and capped, so a flood
 * cannot swamp the console. Answers arrive as
 *   { boards: [{ url, name, id }], mismatched: n }
 * where boards passed the PIN challenge and mismatched counts real-looking
 * hubs whose PIN differs (a brand-new PC, usually). This hub's own echo is
 * excluded.
 */
const DISCOVERY_MAX = 24;
function findBoards(done) {
  let finished = false;
  const found = new Map();
  let probe;
  try {
    probe = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (_) { return done({ boards: [], mismatched: 0 }); }

  const verify = () => {
    if (finished) return;
    finished = true;
    clearInterval(shout._t);
    try { probe.close(); } catch (_) {}
    const leads = [...found.values()];
    if (!leads.length) return done({ boards: [], mismatched: 0 });
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = discoverySig(nonce, settings.adminPin);
    const boards = [];
    let mismatched = 0;
    let waiting = leads.length;
    for (const lead of leads) {
      fetchJson(`${lead.url}/api/discovery-verify?c=${nonce}&sig=${sig}`, 1500, (res) => {
        if (res && res.app === 'winchesterdarts') {
          if (res.match) boards.push({ url: lead.url, name: lead.name, id: lead.id });
          else mismatched++;
        }
        if (--waiting === 0) done({ boards, mismatched });
      });
    }
  };

  probe.on('error', verify);
  probe.on('message', (msg, rinfo) => {
    const text = msg.toString();
    if (text.slice(0, DISCOVERY_HERE.length) !== DISCOVERY_HERE) return;
    let info;
    try { info = JSON.parse(text.slice(DISCOVERY_HERE.length)); } catch (_) { return; }
    if (!info || info.id === settings.discoveryId) return;
    const port = Math.max(1, Math.min(65535, Number(info.port) || 0));
    if (!port || found.size >= DISCOVERY_MAX) return;
    const key = String(info.id || `${rinfo.address}:${port}`);
    if (!found.has(key)) {
      found.set(key, {
        url: `http://${rinfo.address}:${port}`,
        name: String(info.name || '').slice(0, 24) || 'Board',
        id: String(info.id || '').slice(0, 16),
      });
    }
  });
  const shout = () => {
    for (const addr of broadcastAddresses()) {
      // Per-send noop callback: one dead adapter must not abort the scan.
      try { probe.send(DISCOVERY_HELLO, DISCOVERY_PORT, addr, () => {}); } catch (_) {}
    }
  };
  probe.bind(0, () => {
    try { probe.setBroadcast(true); } catch (_) { return verify(); }
    shout();
    shout._t = setInterval(shout, 500);
    setTimeout(verify, 1600);
  });
}

/* LAN addresses, best guess first: real home/office ranges before virtual adapters. */
function addresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const a = net.address;
      let rank = 3;
      if (/^192\.168\./.test(a)) rank = 0;
      else if (/^10\./.test(a)) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) rank = 2;
      // WSL / Hyper-V / VirtualBox adapters are rarely the one the iPad can reach
      if (/vethernet|virtualbox|vmware|wsl|loopback/i.test(name)) rank += 10;
      out.push({ a, rank });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map((x) => x.a);
}

function screenUrls() {
  const host = addresses()[0] || 'localhost';
  return {
    host,
    port: PORT,
    tv: `http://${host}:${PORT}/tv`,
    pad: `http://${host}:${PORT}/pad`,
    board: `http://${host}:${PORT}/board`,
    staff: `http://${host}:${PORT}/staff`,
    home: `http://${host}:${PORT}/`,
    others: addresses().slice(1).map((a) => `http://${a}:${PORT}`),
  };
}

/* Addresses plus scannable QR codes - everything generated locally, no internet needed. */
app.get('/api/urls', async (_req, res) => {
  const u = screenUrls();
  try {
    const opts = { margin: 1, width: 420, color: { dark: '#0A0D12', light: '#FFFFFF' } };
    const [qrTv, qrPad] = await Promise.all([
      QRCode.toDataURL(u.tv, opts),
      QRCode.toDataURL(u.pad, opts),
    ]);
    res.json({ ...u, qrTv, qrPad });
  } catch (err) {
    res.json({ ...u, qrTv: null, qrPad: null });
  }
});

/* ------------------------------------------------------------ commands -- */

io.on('connection', (socket) => {
  socket.emit('state', snapshot());

  /*
   * The Settings tab sits behind a PIN so punters cannot re-theme the venue
   * or disconnect the board mid-session. Enforced HERE, not just hidden in
   * the page: each socket must present the PIN before the settings commands
   * work. Game commands stay open - players run their own games.
   */
  socket.data.admin = false;
  socket.on('unlock', (pin, ack) => {
    const ok = String(pin || '') === String(settings.adminPin || '1234');
    socket.data.admin = ok;
    if (typeof ack === 'function') ack({ ok });
    if (!ok) socket.emit('toast', { kind: 'error', text: 'Wrong PIN' });
  });
  socket.on('lockSettings', () => { socket.data.admin = false; });

  socket.on('sessionStart', (mins) => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    const m = Math.max(5, Math.min(480, Number(mins) || 60));
    const prev = closeRunningSession();
    session = {
      mode: 'timer',
      minutes: m,
      // A game already under way means the clock starts now, not next game.
      startedAt: match && !match.state.finished ? Date.now() : null,
      warned: false,
      names: roster.map((p) => p.name),
      rate: settings.pricePerHour,
    };
    saveSession();
    broadcast();
    const note = prev ? ` (previous session closed - ${till.money(prev.price)})` : '';
    socket.emit('toast', { kind: 'ok', text: `Timer set: ${m} minutes${session.startedAt ? ' - already counting' : ' - starts with their first game'}${note}` });
  });
  // Stopwatch: open-ended, counts up, pay at the end. Ends only by hand.
  socket.on('sessionStopwatch', () => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    const prev = closeRunningSession();
    session = {
      mode: 'stopwatch',
      minutes: 0,
      startedAt: match && !match.state.finished ? Date.now() : null,
      warned: false,
      names: roster.map((p) => p.name),
      rate: settings.pricePerHour,
    };
    saveSession();
    broadcast();
    const note = prev ? ` (previous session closed - ${till.money(prev.price)})` : '';
    socket.emit('toast', { kind: 'ok', text: `Stopwatch on${session.startedAt ? ' - already counting' : ' - starts with their first game'}${note}` });
  });
  socket.on('sessionClear', () => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    // A session that actually ran ends like any other: game recorded, names
    // cleared. The next group must never inherit the last group's players.
    const ran = session && session.startedAt;
    const bill = ran ? recordSession() : null;
    session = null;
    saveSession();
    if (ran) {
      recordIfFinished();
      match = null;
      saveMatch();
      roster = [];
      saveRoster();
      io.emit('sessionover', {});
    }
    broadcast();
    socket.emit('toast', { kind: 'ok', text: bill ? `Timer cleared - session billed ${till.money(bill.price)}, game and players cleared` : 'Timer cleared' });
  });
  socket.on('sessionExtend', (mins) => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    if (!session) return socket.emit('toast', { kind: 'error', text: 'No timer to extend - start one instead' });
    if (session.mode === 'stopwatch') return socket.emit('toast', { kind: 'error', text: 'The stopwatch runs until you end it - nothing to extend' });
    const m = Math.max(1, Math.min(480, Number(mins) || 15));
    if (session.recorded) {
      // The old bill is already written; the extension is a new sale with its
      // own bill - otherwise post-expiry top-ups would be free.
      session.recorded = false;
      session.mode = 'timer';
      session.startedAt = Date.now();
      session.minutes = m;
      session.names = roster.map((p) => p.name);
      session.rate = settings.pricePerHour;
      session.warned = false;
    } else {
      session.minutes += m;
      // Extending an expired session revives it - paid-for time reopens the oche.
      if (session.warned && sessionInfo() && !sessionInfo().expired) session.warned = false;
    }
    saveSession();
    broadcast();
    socket.emit('toast', { kind: 'ok', text: `Added ${m} minutes` });
  });
  socket.on('sessionEnd', () => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    if (!session) return socket.emit('toast', { kind: 'error', text: 'No session running' });
    if (!session.startedAt) {
      // Armed but never started: just take it back off the shelf.
      session = null;
      saveSession();
      broadcast();
      return socket.emit('toast', { kind: 'ok', text: 'Timer cancelled' });
    }
    recordSession(); // price with the real mode before the shutdown conversion
    session.mode = 'timer';
    session.minutes = Math.max(0, (Date.now() - session.startedAt) / 60000);
    expireSession();
    const bill = sessionsLog[sessionsLog.length - 1];
    socket.emit('toast', { kind: 'ok', text: bill ? `Session ended - ${till.money(bill.price)}` : 'Session ended' });
  });
  const admin = (fn) => (...args) => {
    if (!socket.data.admin) {
      return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    }
    fn(...args);
  };

  socket.on('newMatch', (req = {}) => {
    const si = sessionInfo();
    if (!si) {
      return socket.emit('toast', { kind: 'error', text: 'No time on the clock - see the bar to get started' });
    }
    if (si.expired) {
      return socket.emit('toast', { kind: 'error', text: 'Time is up - see the bar to add more' });
    }
    const players = (req.players || []).filter((p) => p && p.name && p.name.trim());
    if (players.length < 1) return socket.emit('toast', { kind: 'error', text: 'Add at least one player' });
    retirePrizeAttempt();
    try {
      const cfg = { ...(req.config || {}) };
      delete cfg.prize; // the cash attempt is armed by staff, never from the pad
      match = new Match({
        gameId: req.gameId || 'x01',
        variantId: req.variantId,
        config: cfg,
        players: players.map((p, i) => ({ id: p.id || `p${i + 1}`, name: p.name.trim() })),
      });
      lastRecorded = null;
      board.resetRepeat();          // first dart of a game always counts
      if (session && !session.startedAt) { session.startedAt = Date.now(); saveSession(); }
      saveMatch();
      io.emit('newmatch', { gameId: match.gameId });
      broadcast();
    } catch (err) {
      socket.emit('toast', { kind: 'error', text: err.message });
    }
  });

  /*
   * The £-prize attempt: staff-armed only (they check the name, start the
   * video, then start this). One player, Around the Clock triples, and the
   * engine watches every dart for the perfect run.
   */
  socket.on('prizeStart', admin((req = {}) => {
    const si = sessionInfo();
    if (!si || si.expired) return socket.emit('toast', { kind: 'error', text: 'Start a session first - the attempt runs on the clock' });
    const name = String((req && req.name) || '').trim().slice(0, 24);
    if (!name) return socket.emit('toast', { kind: 'error', text: 'Type the player\'s name first' });
    if (match && !match.state.finished) recordIfFinished();
    retirePrizeAttempt();
    try {
      match = new Match({
        gameId: 'atc',
        variantId: 'triples',
        config: { prize: true },
        players: [{ id: 'prize1', name }],
      });
      lastRecorded = null;
      board.resetRepeat();
      if (session && !session.startedAt) { session.startedAt = Date.now(); saveSession(); }
      if (session && !session.recorded && !(session.names || []).includes(name)) {
        session.names = [...(session.names || []), name];
        saveSession();
      }
      saveMatch();
      io.emit('newmatch', { gameId: match.gameId });
      io.emit('toast', { kind: 'ok', text: `£${settings.prizeAmount} attempt: ${name} - camera rolling?` });
      broadcast();
    } catch (err) {
      socket.emit('toast', { kind: 'error', text: err.message });
    }
  }));

  socket.on('dart', (d) => handleDart(d || {}, 'pad'));
  socket.on('endTurn', () => {
    if (match && !match.state.finished) {
      const before = match.view();
      const events = match.endTurn();
      recordIfFinished();
      saveMatch();
      emitEvents(events, null);
      emitVisitIfTurnPassed(before, events);
      broadcast();
    }
  });
  socket.on('undo', () => { if (match && match.undo()) { saveMatch(); broadcast(); } });
  socket.on('restart', () => {
    if (!match) return;
    match.restart();
    lastRecorded = null;
    saveMatch();
    io.emit('newmatch', { gameId: match.gameId });
    broadcast();
  });
  socket.on('adjust', ({ playerId, value } = {}) => {
    if (!match || playerId === undefined) return;
    match.adjust(playerId, Number(value) || 0);
    saveMatch();
    broadcast();
  });
  socket.on('endMatch', () => { retirePrizeAttempt(); match = null; saveMatch(); broadcast(); });

  socket.on('savePlayers', (list) => {
    if (!Array.isArray(list)) return;
    roster = list
      .filter((p) => p && p.name && p.name.trim())
      .slice(0, 40)
      .map((p, i) => ({ id: p.id || `r${Date.now()}${i}`, name: p.name.trim().slice(0, 24) }));
    saveRoster();
    // Anyone who appears during a session goes on its bill - removing a name
    // from the list doesn't take them off the tab.
    if (session && !session.recorded) {
      session.names = [...new Set([...(session.names || []), ...roster.map((p) => p.name)])];
      saveSession();
    }
    broadcast();
  });

  socket.on('saveSettings', admin((patch = {}) => {
    Object.assign(settings, {
      boardUuid: patch.boardUuid !== undefined ? String(patch.boardUuid).trim() : settings.boardUuid,
      buttonNumber: patch.buttonNumber !== undefined ? Number(patch.buttonNumber) || 20 : settings.buttonNumber,
      celebrations: patch.celebrations !== undefined ? !!patch.celebrations : settings.celebrations,
      sound: patch.sound !== undefined ? !!patch.sound : settings.sound,
      autoConnect: patch.autoConnect !== undefined ? !!patch.autoConnect : settings.autoConnect,
      venueName: patch.venueName !== undefined ? String(patch.venueName).trim().slice(0, 40) || 'The Winchester' : settings.venueName,
      venueTagline: patch.venueTagline !== undefined ? String(patch.venueTagline).trim().slice(0, 30) : settings.venueTagline,
      venueLocation: patch.venueLocation !== undefined ? String(patch.venueLocation).trim().slice(0, 40) : settings.venueLocation,
      theme: patch.theme !== undefined && THEMES.includes(patch.theme) ? patch.theme : settings.theme,
      adminPin: patch.adminPin !== undefined && /^\d{4,8}$/.test(String(patch.adminPin))
        ? String(patch.adminPin) : settings.adminPin,
      boardName: patch.boardName !== undefined
        ? (String(patch.boardName).trim().slice(0, 24) || settings.boardName) : settings.boardName,
      // A rate outside 0-200 is a typo, not a decision - keep the old rate
      // rather than silently billing at a clamped one.
      pricePerHour: patch.pricePerHour !== undefined && Number.isFinite(Number(patch.pricePerHour))
          && Number(patch.pricePerHour) >= 0 && Number(patch.pricePerHour) <= 200
        ? Number(patch.pricePerHour) : settings.pricePerHour,
      prizeAmount: patch.prizeAmount !== undefined && Number.isFinite(Number(patch.prizeAmount))
          && Number(patch.prizeAmount) >= 0 && Number(patch.prizeAmount) <= 100000
        ? Math.round(Number(patch.prizeAmount)) : settings.prizeAmount,
      leaderboardResetAt: patch.leaderboardResetAt !== undefined
          && Number.isFinite(Number(patch.leaderboardResetAt))
          && Number(patch.leaderboardResetAt) >= 0
          && Number(patch.leaderboardResetAt) <= Date.now() + 86400000
        ? Number(patch.leaderboardResetAt) : settings.leaderboardResetAt,
      peers: Array.isArray(patch.peers)
        ? patch.peers.map((u) => String(u).trim().replace(/\/+$/, '')).filter((u) => /^https?:\/\//.test(u)).slice(0, 8)
        : settings.peers,
    });
    saveSettings();
    board.buttonNumber = settings.buttonNumber;
    broadcast();
  }));

  // Own gate rather than admin(): a locked console gets a definite answer
  // back, not a dangling ack the page has to time out on.
  socket.on('findBoards', (ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.data.admin) return ack({ ok: false, locked: true });
    findBoards((r) => ack({ ok: true, boards: r.boards, mismatched: r.mismatched }));
  });
  socket.on('boardConnect', admin(() => board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber })));
  socket.on('boardDisconnect', admin(() => { board.userStopped = true; board.disconnect(); }));
  socket.on('calibrate', admin(() => {
    if (!board.peripheral) return socket.emit('toast', { kind: 'error', text: 'Connect the board first' });
    if (calibrating) clearTimeout(calibrating.timer);
    calibrating = {
      target: 20,
      timer: setTimeout(() => {
        calibrating = null;
        io.emit('calibrated', { done: false });
        io.emit('toast', { kind: 'error', text: 'No dart seen - line-up cancelled' });
      }, 60000),
    };
    io.emit('calibrated', { done: false, waiting: true });
    socket.emit('toast', { kind: 'ok', text: 'Throw one dart into the 20' });
  }));
  socket.on('calibrateCancel', admin(() => {
    if (calibrating) clearTimeout(calibrating.timer);
    calibrating = null;
    io.emit('calibrated', { done: false });
  }));

  // Fire the full 180 moment at the TV so sound and card can be checked
  // without anyone having to actually hit one.
  socket.on('testCaller', admin(() => {
    io.emit('celebrate', { type: 'oneeighty', player: 'Sound check' });
    io.emit('visit', {
      player: 'Sound check',
      darts: [{ score: 20, multiplier: 3, label: 'T20' }, { score: 20, multiplier: 3, label: 'T20' },
              { score: 20, multiplier: 3, label: 'T20' }],
      total: 180,
      special: null,
    });
    socket.emit('toast', { kind: 'ok', text: 'Sent to the TV - you should hear "One hundred and eighty!"' });
  }));

  socket.on('boardWake', admin(() => {
    const ok = board.wake();
    socket.emit('toast', ok
      ? { kind: 'ok', text: 'Wake-up sent - throw a dart' }
      : { kind: 'error', text: 'Connect the board first' });
  }));
});

/*
 * Two boards, one PC: run a second copy of the folder and it finds its own
 * port - 8080 taken means another hub lives here, so step up and carry on.
 * Everything that mentions the port (banner, QR pages, discovery replies)
 * reads the port actually bound.
 */
function listenWithFallback(triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`port ${PORT} is taken (another board on this PC?) - trying ${PORT + 1}`);
      PORT += 1;
      listenWithFallback(triesLeft - 1);
    } else {
      console.error('could not start:', err.message);
      process.exit(1);
    }
  });
  server.listen(PORT, () => {
  const u = screenUrls();
  const line = '  ' + '='.repeat(52);
  console.log('');
  console.log(line);
  console.log(`   ${settings.venueName.toUpperCase()} - DARTS is running`);
  console.log(line);
  console.log('');
  console.log('   Type these into the browser on each device:');
  console.log('');
  console.log(`      TV  (big screen)   ${u.tv}`);
  console.log(`      iPad (control)     ${u.pad}`);
  console.log(`      Leaderboard        ${u.board}`);
  console.log(`      Staff (till iPad)  ${u.staff}`);
  console.log('');
  console.log(`   Not sure? Open ${u.home} on any device`);
  console.log('   and pick a screen there (it also shows QR codes).');
  if (u.others.length) {
    console.log('');
    console.log(`   Other addresses this PC has: ${u.others.join('  ')}`);
  }
  console.log('');
  console.log(`   On this PC you can also use http://localhost:${PORT}/tv`);
  console.log('   Close this window to stop the hub.');
  console.log('');
  });
}
listenWithFallback(9);

process.on('SIGINT', () => { try { board.disconnect(); } catch (_) {} process.exit(0); });
