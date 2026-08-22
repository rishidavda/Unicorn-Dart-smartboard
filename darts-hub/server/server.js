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
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Match, catalogue, label } = require('./games');
const { Board } = require('./board');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DARTS_DATA || path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const CELEBRATIONS = path.join(ROOT, 'celebrations');
const PORT = Number(process.env.PORT || 8080);

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
  boardName: 'Board 1', // label for this oche when several run in one venue
  peers: [],            // other hubs' addresses, e.g. ["http://192.168.1.51:8080"]
}, readJson('settings.json', {}));

// Starts empty on purpose: names people typed themselves beat "Player 1"
// on the telly every time. The filter also clears the placeholders out of
// rosters saved by earlier versions.
let roster = readJson('players.json', []).filter((p) => p && !/^Player \d+$/i.test(p.name || ''));
let history = readJson('history.json', []);

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
  const endsAt = session.startedAt ? session.startedAt + session.minutes * 60000 : null;
  return {
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
  history.push({
    at: new Date().toISOString(),
    board: settings.boardName,
    game: match.gameId, variant: match.variantId,
    players: match.roster.map((p) => p.name),
    winner: match.state.winner ? match.state.winner.name : null,
    darts: match.log.filter((e) => e.k === 'd').length,
    oneEighties, bestVisit,
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
  res.json({ name: settings.boardName, history });
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
function expireSession() {
  if (session) { session.warned = true; saveSession(); }
  recordIfFinished();
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

function emitEvents(events, dart) {
  if (dart) io.emit('dart', dart);
  for (const ev of events || []) io.emit('celebrate', ev);
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
    session = {
      minutes: m,
      // A game already under way means the clock starts now, not next game.
      startedAt: match && !match.state.finished ? Date.now() : null,
      warned: false,
    };
    saveSession();
    broadcast();
    socket.emit('toast', { kind: 'ok', text: `Timer set: ${m} minutes${session.startedAt ? ' - already counting' : ' - starts with their first game'}` });
  });
  socket.on('sessionClear', () => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    session = null;
    saveSession();
    broadcast();
    socket.emit('toast', { kind: 'ok', text: 'Timer cleared' });
  });
  socket.on('sessionExtend', (mins) => {
    if (!socket.data.admin) return socket.emit('toast', { kind: 'error', text: 'Settings are locked - enter the PIN' });
    if (!session) return socket.emit('toast', { kind: 'error', text: 'No timer to extend - start one instead' });
    const m = Math.max(1, Math.min(480, Number(mins) || 15));
    session.minutes += m;
    // Extending an expired session revives it - paid-for time reopens the oche.
    if (session.warned && sessionInfo() && !sessionInfo().expired) session.warned = false;
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
    session.minutes = Math.max(0, (Date.now() - session.startedAt) / 60000);
    expireSession();
    socket.emit('toast', { kind: 'ok', text: 'Session ended' });
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
    try {
      match = new Match({
        gameId: req.gameId || 'x01',
        variantId: req.variantId,
        config: req.config || {},
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
  socket.on('endMatch', () => { match = null; saveMatch(); broadcast(); });

  socket.on('savePlayers', (list) => {
    if (!Array.isArray(list)) return;
    roster = list
      .filter((p) => p && p.name && p.name.trim())
      .slice(0, 40)
      .map((p, i) => ({ id: p.id || `r${Date.now()}${i}`, name: p.name.trim().slice(0, 24) }));
    saveRoster();
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
      peers: Array.isArray(patch.peers)
        ? patch.peers.map((u) => String(u).trim().replace(/\/+$/, '')).filter((u) => /^https?:\/\//.test(u)).slice(0, 8)
        : settings.peers,
    });
    saveSettings();
    board.buttonNumber = settings.buttonNumber;
    broadcast();
  }));

  socket.on('boardConnect', admin(() => board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber })));
  socket.on('boardDisconnect', admin(() => board.disconnect()));
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

process.on('SIGINT', () => { try { board.disconnect(); } catch (_) {} process.exit(0); });
