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

const { Match, catalogue } = require('./games');
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
  theme: 'green',
}, readJson('settings.json', {}));

let roster = readJson('players.json', [
  { id: 'p1', name: 'Player 1' },
  { id: 'p2', name: 'Player 2' },
]);
let history = readJson('history.json', []);

function saveSettings() { writeJson('settings.json', settings); }
function saveRoster() { writeJson('players.json', roster); }
function saveHistory() { writeJson('history.json', history.slice(-100)); }
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
  history.push({
    at: new Date().toISOString(),
    game: match.gameId, variant: match.variantId,
    players: match.roster.map((p) => p.name),
    winner: match.state.winner ? match.state.winner.name : null,
    darts: match.log.filter((e) => e.k === 'd').length,
  });
  saveHistory();
}

/* --------------------------------------------------------------- app ---- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(PUBLIC, { maxAge: 0, etag: false }));
app.use('/celebrations', express.static(CELEBRATIONS, { maxAge: 0 }));

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'connect.html')));
app.get('/tv', (_req, res) => res.sendFile(path.join(PUBLIC, 'tv.html')));
app.get('/pad', (_req, res) => res.sendFile(path.join(PUBLIC, 'pad.html')));
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

function brand() {
  return {
    name: settings.venueName,
    tagline: settings.venueTagline,
    theme: settings.theme,
    themes: THEMES,
    logoUrl: logoUrl(),
  };
}

app.get('/api/brand', (_req, res) => res.json(brand()));

/* -------------------------------------------------------------- board --- */

const board = new Board();
let boardInfo = { state: 'idle', detail: 'not started', discovered: [] };

board.on('status', (s) => { boardInfo = s; broadcast(); });
board.on('dart', (d) => handleDart(d, 'board'));
board.on('button', () => { if (match && !match.state.finished) { match.endTurn(); saveMatch(); broadcast(); } });

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
      venueName: settings.venueName, venueTagline: settings.venueTagline, theme: settings.theme,
    },
    brand: brand(),
    board: boardInfo,
    games: catalogue(),
    history: history.slice(-12).reverse(),
    server: { port: PORT, addresses: addresses() },
  };
}

function broadcast() { io.emit('state', snapshot()); }

function emitEvents(events, dart) {
  if (dart) io.emit('dart', dart);
  for (const ev of events || []) io.emit('celebrate', ev);
}

function handleDart(dart, source) {
  if (!match || match.state.finished) return;
  const clean = {
    score: Math.max(0, Math.min(25, Number(dart.score) || 0)),
    multiplier: Math.max(1, Math.min(3, Number(dart.multiplier) || 1)),
  };
  if (clean.score === 25 && clean.multiplier === 3) clean.multiplier = 2;  // no treble bull
  const events = match.addDart(clean);
  recordIfFinished();
  saveMatch();
  emitEvents(events, { ...clean, source });
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

  socket.on('newMatch', (req = {}) => {
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
      saveMatch();
      io.emit('newmatch', { gameId: match.gameId });
      broadcast();
    } catch (err) {
      socket.emit('toast', { kind: 'error', text: err.message });
    }
  });

  socket.on('dart', (d) => handleDart(d || {}, 'pad'));
  socket.on('endTurn', () => { if (match && !match.state.finished) { match.endTurn(); saveMatch(); broadcast(); } });
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

  socket.on('saveSettings', (patch = {}) => {
    Object.assign(settings, {
      boardUuid: patch.boardUuid !== undefined ? String(patch.boardUuid).trim() : settings.boardUuid,
      buttonNumber: patch.buttonNumber !== undefined ? Number(patch.buttonNumber) || 20 : settings.buttonNumber,
      celebrations: patch.celebrations !== undefined ? !!patch.celebrations : settings.celebrations,
      sound: patch.sound !== undefined ? !!patch.sound : settings.sound,
      autoConnect: patch.autoConnect !== undefined ? !!patch.autoConnect : settings.autoConnect,
      venueName: patch.venueName !== undefined ? String(patch.venueName).trim().slice(0, 40) || 'The Winchester' : settings.venueName,
      venueTagline: patch.venueTagline !== undefined ? String(patch.venueTagline).trim().slice(0, 30) : settings.venueTagline,
      theme: patch.theme !== undefined && THEMES.includes(patch.theme) ? patch.theme : settings.theme,
    });
    saveSettings();
    board.buttonNumber = settings.buttonNumber;
    broadcast();
  });

  socket.on('boardConnect', () => board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber }));
  socket.on('boardDisconnect', () => board.disconnect());
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
