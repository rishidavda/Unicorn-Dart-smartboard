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

/*
 * A fingerprint of the screens' own files. The TVs and iPads are mounted and
 * left open for weeks: after an upgrade they would keep running the OLD page
 * code until someone reloaded each one. Every screen remembers the
 * fingerprint it loaded with and reloads itself once when it changes.
 */
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch (_) { return; }
    for (const n of names) {
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) walk(full, `${rel}${n}/`);
      else { h.update(`${rel}${n}\0`); try { h.update(fs.readFileSync(full)); } catch (_) {} }
    }
  };
  walk(PUBLIC, '');
  return h.digest('hex').slice(0, 12);
})();
const CELEBRATIONS = path.join(ROOT, 'celebrations');
let PORT = Number(process.env.PORT || 8080);

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(CELEBRATIONS, { recursive: true });

/*
 * One hub per folder. Two copies started on the same folder (a startup
 * shortcut AND a scheduled task, or a second double-click while the TV hides
 * the console) would overwrite each other's games, bills and settings.
 *
 * The lock names the running hub's process, but a process id proves little:
 * End task, a closed console, Task Scheduler's stop and a power cut all leave
 * the file behind, and Windows hands a dead hub's id to the next program it
 * starts (a service under another account even answers "no permission").
 * So the lock is only honoured while its holder can be shown to be a hub of
 * THIS folder: it must answer on the port it wrote, or be so new that it has
 * not bound one yet. Anything else is stale and taken over - a stale lock
 * must never leave the oche dark until someone finds data\hub.lock.
 */
const LOCK = path.join(DATA, 'hub.lock');
// This folder's own identity - unlike discoveryId it is NOT copied along
// with the folder, so a clone can never pass for the original.
const FOLDER_ID = crypto.createHash('sha1')
  .update(process.platform === 'win32' ? path.resolve(DATA).toLowerCase() : path.resolve(DATA))
  .digest('hex').slice(0, 16);
const SUPERVISED = process.env.WINCHESTER_SUPERVISED === '1';
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Boot must settle the lock before a single data file is read, so these few
// waits and the one HTTP probe are deliberately synchronous.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// null: nothing there (refused, or not a hub). { timeout: true }: the port
// accepted the connection but nothing answered - the exit code carries it so
// no answer body can fake it.
function hubHttp(port, method, body) {
  const script = `let up=false;const r=require('http').request({host:'127.0.0.1',port:${Number(port)},path:'/api/hub-${method === 'POST' ? 'handover' : 'id'}',method:'${method}',timeout:2000,headers:{'Content-Type':'application/json'}},(res)=>{let b='';res.on('data',(c)=>{b+=c;});res.on('end',()=>process.stdout.write(b));});r.on('socket',(s)=>s.on('connect',()=>{up=true;}));r.on('timeout',()=>{r.destroy();if(up)process.exit(3);});r.on('error',()=>{});r.end(${JSON.stringify(body || '')});`;
  try {
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const info = JSON.parse(out);
    return info && info.hub === 'winchester' ? info : null;
  } catch (err) { return err && err.status === 3 ? { timeout: true } : null; }
}
function writeLock(extra) {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), startedAt: Date.now(), folder: FOLDER_ID, ...extra }));
}
function readLock(tries = 5) {
  // A sibling that has just created the file may not have written it yet.
  for (let i = 0; i < tries; i++) {
    try {
      const rec = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : { unreadable: true };
    } catch (err) { if (err.code === 'ENOENT') return null; }
    if (i + 1 < tries) sleepSync(300);
  }
  return { unreadable: true };
}
const sameLock = (a, b) => !!a && !!b && (a.unreadable ? !!b.unreadable : a.pid === b.pid && a.startedAt === b.startedAt);
// Only the record just judged stale may be removed: a sibling copy may have
// replaced it with its own since we looked.
function removeLock(judged) {
  if (!sameLock(judged, readLock(1))) return;
  try { fs.unlinkSync(LOCK); } catch (err) {
    if (err.code === 'ENOENT') return;
    refuseToRun(['WinchesterDarts cannot start: the old lock file', `${LOCK}`,
      `could not be removed (${err.code}) - check it is not read-only, delete it by hand and start again.`]);
  }
}
function refuseToRun(lines) {
  console.error('');
  for (const l of lines) console.error(`   ${l}`);
  console.error('');
  process.exit(64);
}
function takeLock() {
  for (let attempt = 0; ; attempt++) {
    // Never spin (a lock that keeps coming back would pin the CPU with
    // nothing on screen): give up visibly instead.
    if (attempt >= 8) refuseToRun(['WinchesterDarts cannot start: the lock file', `${LOCK}`,
      'could not be taken after several tries - delete it by hand and start again.']);
    try {
      fs.closeSync(fs.openSync(LOCK, 'wx'));
      writeLock({});
      // Two copies started in the same instant can both have judged an old
      // lock stale a moment ago: the file must stay ours for a full poll.
      let mine = true;
      for (let i = 0; mine && i < 3; i++) { sleepSync(100); const now = readLock(); mine = !!now && now.pid === process.pid; }
      if (mine) return;
      continue;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = readLock();
    if (!held) continue;
    let stale = held.unreadable || !pidAlive(held.pid) || held.pid === process.pid;
    let live = null;
    if (!stale && held.port) {
      live = hubHttp(held.port, 'GET');
      // Accepted but silent: a live hub that is merely busy for a moment
      // (antivirus, text selected in its console). Only a refused connection
      // or another folder's answer proves the lock stale.
      for (let i = 0; live && live.timeout && i < 3; i++) { sleepSync(500); live = hubHttp(held.port, 'GET'); }
      if (live && live.timeout) refuseToRun(['WinchesterDarts is ALREADY RUNNING from this folder (process ' + held.pid + ', port ' + held.port + ')',
        'but is not answering right now - this copy will close so the two do not overwrite each other.']);
      stale = !live || live.folder !== FOLDER_ID;
    } else if (!stale) {
      const bootedAt = Date.now() - os.uptime() * 1000;
      const age = Date.now() - (Number(held.startedAt) || 0);
      stale = !held.startedAt || held.startedAt < bootedAt - 120000 || age > 3 * 60000;
      if (!stale) refuseToRun(['WinchesterDarts is ALREADY STARTING from this folder (process ' + held.pid + ') - this',
        'copy will close so the two do not overwrite each other.']);
    }
    if (stale) {
      removeLock(held);
      continue;
    }
    if (live.orphan && SUPERVISED) {
      // The running hub lost its own WinchesterDarts.exe (ended in Task
      // Manager, or Task Scheduler's stop): this copy has one, so it takes
      // over. The orphan saves everything and closes; we wait for it. It
      // removes its own lock on the way out - a lock still there after that
      // belongs to another newcomer and is judged like any other.
      console.log(`taking over from the hub already running here (process ${held.pid}) - it has no WinchesterDarts.exe of its own`);
      const ok = hubHttp(held.port, 'POST', JSON.stringify({ folder: FOLDER_ID }));
      for (let i = 0; ok && ok.ok && i < 80 && pidAlive(held.pid); i++) sleepSync(250);
      if (!pidAlive(held.pid)) continue;
    }
    refuseToRun(['WinchesterDarts is ALREADY RUNNING from this folder - this copy will',
      `close so the two do not overwrite each other (process ${held.pid}, port ${held.port}).`,
      ...(live.orphan
        ? ['No window? The hub is still running from an earlier start:', 'double-click WinchesterDarts.exe and it takes over from that copy.']
        : ['Use the window that is already open.'])]);
  }
}
takeLock();
// A power cut mid-save leaves the half-written temporary behind for ever.
for (const f of fs.readdirSync(DATA)) {
  if (f.endsWith('.json.tmp')) { try { fs.unlinkSync(path.join(DATA, f)); } catch (_) {} }
}
process.on('exit', () => {
  try { if (JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK); } catch (_) {}
});

/* ------------------------------------------------------------ storage --- */

/*
 * Saves must survive the PC losing power mid-write: history and takings
 * live in these files. Each save goes to a temporary file, is flushed to
 * disk, and only then replaces the real one, so the real file is always
 * either the old version or the new one - never half of each. The previous
 * version is kept as .bak, and a file that still somehow reads back
 * damaged is recovered from it instead of silently starting empty (which
 * the next save would then make permanent). When BOTH copies are damaged
 * they are set aside under a dated name rather than overwritten by the
 * next two saves - records worth a hand recovery - and the staff console
 * is told, because the console window sits hidden behind the TV.
 */
const damaged = new Set();   // main copies that failed to parse: never copied over .bak
const warnings = [];
// A file that parses but is the wrong kind of thing (history.json holding
// null) would freeze every snapshot and crash the first finished game: it
// counts as damaged like a torn one. Lists are lists; the rest are objects,
// or null (no match, no session).
const SHAPES = { array: (v) => Array.isArray(v), object: (v) => v === null || (typeof v === 'object' && !Array.isArray(v)) };
// `quiet`: a throwaway file (the liveness stamp) is simply deleted when it
// cannot be read - nothing in it is worth a hand recovery or a warning.
function readJson(file, fallback, shape, quiet) {
  const target = path.join(DATA, file);
  const broken = [];
  for (const candidate of [target, target + '.bak']) {
    let text;
    try { text = fs.readFileSync(candidate, 'utf8'); } catch (_) { continue; }   // not there
    try {
      const value = JSON.parse(text);
      if (shape && !SHAPES[shape](value)) throw new Error('wrong shape');
      if (candidate !== target && !quiet) {
        console.error(`${file} was damaged - recovered the previous copy`);
        warnings.push(`${file} on this PC was damaged and could not be read - the previous save was used instead, which may be one save behind (the last game or bill before the restart is worth a check).`);
      }
      return value;
    } catch (_) {
      if (quiet) { try { fs.unlinkSync(candidate); } catch (_) {} continue; }
      console.error(`${path.basename(candidate)} is damaged`);
      if (candidate === target) damaged.add(file);
      broken.push(candidate);
    }
  }
  if (broken.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const b of broken) { try { fs.renameSync(b, `${b}.damaged-${stamp}`); } catch (_) {} }
    damaged.delete(file);
    warnings.push(`${file} on this PC was damaged and could not be read - it starts again empty. The damaged copies are kept as data\\${file}.damaged-${stamp} for a hand recovery.`);
  }
  return fallback;
}
function writeJson(file, value) {
  const target = path.join(DATA, file);
  const text = JSON.stringify(value, null, 2);
  const tmp = `${target}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // After a recovery from .bak the first save must not roll the damaged main over it.
    if (!damaged.delete(file)) { try { fs.copyFileSync(target, `${target}.bak`); } catch (_) {} }
    fs.renameSync(tmp, target);
  } catch (err) {
    // Windows can refuse the swap while antivirus holds the file open: fall
    // back to a plain write rather than lose the save.
    try { fs.writeFileSync(target, text); } catch (err2) { console.error(`could not save ${file}:`, err2.message); }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

const settings = Object.assign({
  boardUuid: '',
  buttonNumber: 20,
  autoConnect: true,
  powered: true,        // the oche's soft power switch - staff turn it off at close
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
}, readJson('settings.json', {}, 'object'));

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
let roster = readJson('players.json', [], 'array').filter((p) => p && !/^Player \d+$/i.test(p.name || ''));

/*
 * Sticky ports: each folder keeps the port it first claimed, so a board's TV
 * and iPad bookmarks always reach the SAME board no matter which copy starts
 * first after a reboot. The home remembers which settings.ini port it was
 * claimed from: while that setting is unchanged the home wins (two folders
 * sharing PORT=8916 keep 8916 and 8917 for ever, like two on the default
 * 8080), and changing PORT in settings.ini on purpose still moves the board.
 * The shipped settings.ini says PORT=8080 and an upgrade unzips it over the
 * folder, so 8080 is no choice at all: the home always wins then, or a
 * hand-set port would jump back to 8081 after every upgrade with the
 * mounted screens left pointing at the old address. A home written from a
 * DIFFERENT folder is ignored - this one is a copy, and it never claims the
 * original's port even while that is free - unless the folder it was
 * written from is gone: then this IS that folder, renamed or moved, and it
 * keeps its home (a tidy-up must not send the TV to the other board).
 * Declared up here because the boot-time settlement below can broadcast.
 *
 * The "gone" check is a single existsSync at this instant - a folder on a
 * USB stick not yet mounted, a network share still connecting, or an
 * antivirus scan holding a lock can look gone for a moment while an
 * ordinary COPY is booting too, not because anything moved. Treating that
 * as proof would misjudge the copy as the move for good: it would try the
 * inherited port every future boot even after the real original comes back
 * and never gets a home of its own. So a "moved" verdict here only decides
 * which port THIS boot attempts - it is not written to settings.json until
 * the 'listening' handler below confirms it by actually binding that port.
 * If the real original is still there and wins the port, this boot ends up
 * displaced with the old (foreign) identity still on disk, and the next
 * boot re-checks fresh rather than repeating a false claim.
 */
const REQUESTED_PORT = PORT;
const DATA_PATH = path.resolve(DATA);
const SAVED_PORT = Number(settings.savedPort) >= 1 && Number(settings.savedPort) <= 65535 ? Number(settings.savedPort) : 0;
let copiedHome = false;   // the saved home belongs to another folder that still exists
if (SAVED_PORT && settings.savedPortAt && settings.savedPortAt !== FOLDER_ID) {
  if (!(settings.savedPortPath && (settings.savedPortPath === DATA_PATH || !fs.existsSync(settings.savedPortPath)))) {
    copiedHome = true;
  }
  // else: looks like a move for this boot's HOME_PORT below - unconfirmed
  // until 'listening' actually binds it (see the comment above).
}
// A home saved before origins were kept has none: a hand-set PORT within
// the stepping range below it is where it stepped from, not a move.
let HOME_PORT = SAVED_PORT && !copiedHome
  && (REQUESTED_PORT === 8080 || Number(settings.savedPortFrom) === REQUESTED_PORT
    || (!settings.savedPortFrom && REQUESTED_PORT >= SAVED_PORT - 9 && REQUESTED_PORT <= SAVED_PORT))
  ? SAVED_PORT : null;
if (HOME_PORT) PORT = HOME_PORT;
let portStepped = false;   // had to move past a busy port this boot
let portDisplaced = false; // ...and ended up somewhere other than home
let holdTries = Number(process.env.DARTS_PORT_HOLD_TRIES || 12); // x5s = a minute
let history = readJson('history.json', [], 'array');
let sessionsLog = readJson('sessions.json', [], 'array');
function saveSessions() { writeJson('sessions.json', sessionsLog); }

/*
 * The customer timer. Staff arm it from the locked Settings tab with a number
 * of minutes; the countdown starts when the customers' FIRST game starts (or
 * immediately, if a game is already running) and shows on both screens. While
 * it runs they can play as many games as they like; once it hits zero no new
 * game can begin. Survives a restart - time sold is time owed.
 */
let session = readJson('session.json', null, 'object');
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
const saved = readJson('match.json', null, 'object');
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

/*
 * A finished game goes into history exactly once. The guard has to survive
 * a restart - the daily fresh start, a crash, a reboot - or the last game of
 * the night (a £1,000 prize included) is recorded a second time the moment
 * the session is later ended. So every history entry carries its game's key,
 * and a finished game restored from disk counts as recorded already: history
 * is saved before match.json on every dart. The key is the game itself (when
 * it started), not its result: a game re-finished after an undo REPLACES its
 * record - a mis-read checkout or the wrong winner never leaves a second
 * game on the leaderboard - and an undo that reopens a finished game takes
 * its record back out.
 */
function matchKey(m) { return m.startedAt; }
function recorded(key) { return history.some((h, n) => n >= history.length - 50 && h.key === key); }
// Seeded from history itself, not from the match: when history.json had to
// be recovered from an OLDER .bak the last game of the night is missing
// from it, and a finished match.json alone must not stop it being recorded
// again (replace-by-key below makes a re-record harmless).
let lastRecorded = match && match.state.finished && recorded(matchKey(match)) ? matchKey(match) : null;
function unrecord(key) {
  const i = history.findIndex((h, n) => n >= history.length - 50 && h.key === key);
  if (i >= 0) { history.splice(i, 1); saveHistory(); }
}
function recordIfFinished() {
  if (!match || !match.state.finished) return;
  const key = matchKey(match);
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
  const entry = {
    key,
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
  };
  const i = history.findIndex((h, n) => n >= history.length - 50 && h.key === key);
  if (i >= 0) history[i] = entry; else history.push(entry);
  saveHistory();
}
// Settle the restored game with history now: a record for a game that is
// still running (the PC went down between the history save and the match
// save, and staff may abandon the game) is dropped, and a finished game
// whose record is missing is recorded.
if (match && !match.state.finished) unrecord(matchKey(match));
recordIfFinished();

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

/*
 * Who holds this port: a copy starting on the same folder asks before it
 * trusts the lock, and takes over (below) when the answer is a hub whose
 * WinchesterDarts.exe is gone. Both are strictly local business.
 */
app.get('/api/hub-id', (_req, res) => {
  res.json({ hub: 'winchester', folder: FOLDER_ID, discoveryId: settings.discoveryId, pid: process.pid, port: PORT, orphan: !launcherAlive() });
});
let handingOver = false;
app.post('/api/hub-handover', (req, res) => {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (!local || !req.body || req.body.folder !== FOLDER_ID) return res.status(403).json({ ok: false });
  // One successor only: a second newcomer is refused so it does not boot too.
  if (launcherAlive() || handingOver) return res.status(409).json({ ok: false });
  handingOver = true;
  res.json({ ok: true, hub: 'winchester' });
  console.log('a new WinchesterDarts.exe is taking over this folder - handing over (everything is saved)');
  try { saveMatch(); saveSession(); writeJson('alive.json', { t: Date.now() }); } catch (_) {}
  try { board.userStopped = true; board.disconnect(); } catch (_) {}
  try { io.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 1500);
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

if (settings.autoConnect && settings.powered !== false) {
  // The staff page is clickable again well inside this delay after a
  // relaunch: a Power off that lands first must win, so this is the hub's own
  // retry-style attempt and never overrides a user stop.
  setTimeout(() => {
    if (settings.powered === false || board.userStopped) return;
    board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber }, true);
  }, 800);
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
    board: {
      ...boardInfo,
      // Live truth for "connected but is it actually talking?": raw packets
      // heard since connect, when the last one landed, and WHICH physical
      // board this hub holds (two hubs sharing one uuid is the classic
      // copied-folder mistake).
      packets: board.notifications || 0,
      lastPacketAt: board.lastPacketAt || null,
      uuid: (board.peripheral && board.peripheral.uuid) || null,
    },
    session: sessionInfo(),
    games: catalogue(),
    history: history.slice(-12).reverse(),
    history50: history.slice(-50),
    powered: settings.powered !== false,
    build: BUILD,
    warnings,
    server: {
      port: PORT, homePort: HOME_PORT, displaced: portDisplaced, addresses: addresses(),
      bootedAt: BOOT_AT, freshStart: freshStartLabel(), freshStartNote: freshStartNote(),
    },
  };
}

// Last line of defence: a game view that throws must never take the whole
// oche down (it would again on every restart, the match being on disk).
function broadcast() {
  try { io.emit('state', snapshot()); } catch (err) { console.error('state broadcast failed:', err.message); }
}

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
function closeRunningSession(newTimer) {
  if (!session || !session.startedAt || session.recorded) return null;
  const bill = recordSession();
  recordIfFinished();
  retirePrizeAttempt();
  match = null;
  saveMatch();
  forgetVisitEvents();
  io.emit('celclear');
  roster = [];
  saveRoster();
  io.emit('sessionover', {});
  // The next group may already have typed their names on the pad - tell them why they went
  if (newTimer) io.emit('toast', { kind: 'error', text: 'New timer started - names cleared, type them again' });
  return bill;
}

/*
 * A session nobody closed because the PC slept or was switched off: bill it
 * up to the moment the PC went down, then close it exactly as End now does.
 * A stopwatch is converted into a finished timer - left as a stopwatch it
 * would carry on counting on every screen and let the next group play on a
 * session that is already billed.
 */
function settleAbandonedSession(endAt) {
  recordSession(endAt);
  if (session && session.mode === 'stopwatch') {
    session.mode = 'timer';
    session.minutes = Math.max(0, (endAt - session.startedAt) / 60000);
  }
  expireSession();
}

function expireSession() {
  recordSession();
  if (session) { session.warned = true; saveSession(); }
  recordIfFinished();
  retirePrizeAttempt();
  match = null;
  saveMatch();
  forgetVisitEvents();
  io.emit('celclear');                // no OUT!/WINS! cycling over the welcome screen
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
// Raw board packets that don't reach a game (no match running, repeats)
// still deserve to show on the staff card's "darts heard" counter.
let lastPacketsSeen = 0;
setInterval(() => {
  if ((board.notifications || 0) !== lastPacketsSeen) {
    lastPacketsSeen = board.notifications || 0;
    broadcast();
  }
}, 3000);

let lastHeartbeat = Date.now();
// A 5 s heartbeat that arrives 30 s late means the PC was asleep. The
// multi-day simulation (test/multiday.js) runs the hub's clock 20x faster
// and raises this so its ordinary heartbeats are not mistaken for sleeps.
const SLEEP_GAP_MS = Number(process.env.DARTS_SLEEP_GAP_MS) || 30000;
setInterval(() => {
  const now = Date.now();
  if (now - lastHeartbeat > SLEEP_GAP_MS) {
    console.log('wake from sleep detected - rebuilding the board connection');
    try { if (board.resumeRecover()) broadcast(); } catch (_) {}
    // Slept for over an hour with a session running? That evening is over:
    // bill it up to the moment the PC went down, so a stopwatch never
    // charges for hours nobody could have played.
    if (now - lastHeartbeat > 60 * 60000 && session && session.startedAt && !session.recorded) {
      settleAbandonedSession(lastHeartbeat);
    }
  }
  lastHeartbeat = now;
}, 5000);

/*
 * A liveness stamp on disk, once a minute. At boot it tells us when the
 * previous run last drew breath - the honest end time for any session that
 * was still open when the PC was shut down or slept overnight.
 */
const PREV_ALIVE = (readJson('alive.json', {}, 'object', true) || {}).t || 0;
const BOOT_AT = Date.now();
setInterval(() => writeJson('alive.json', { t: Date.now() }), 60000);
writeJson('alive.json', { t: Date.now() });

/*
 * Daily fresh start. Once a day (09:00 unless settings.ini says otherwise -
 * before opening, when nobody is throwing) the hub restarts itself, so
 * Bluetooth, sockets and Windows networking get a clean slate and a PC that
 * has run for weeks never drifts into "connected but nothing counts" or
 * dropped screens. Nothing is lost: games, timers, the power switch and the
 * port all live on disk and come straight back, and the TVs and iPads
 * reconnect by themselves within seconds. (A restart this short never
 * triggers the dead-for-an-hour session settlement above.)
 *
 * WinchesterDarts.exe relaunches the hub when it exits with RESTART_CODE and
 * announces itself via WINCHESTER_SUPERVISED; started any other way (npm
 * start) the hub never restarts itself, because nothing would bring it back.
 *
 * Only a run already up at restart time does it (a PC switched on at 10:00
 * is fresh already); darts landing in a live game defer it minute by minute
 * for up to an hour; and a second copy on the same PC goes a minute later
 * (by port) so two hubs never fight over Bluetooth at the same instant.
 */
const RESTART_CODE = 75;
const LAUNCHER_PID = Number(process.env.WINCHESTER_LAUNCHER_PID) || 0;
const FRESH_START = (() => {
  // Missing from settings.ini: 09:00. Present but blank, OFF, or nonsense: off.
  const raw = process.env.DAILY_RESTART === undefined ? '09:00' : String(process.env.DAILY_RESTART);
  const mm = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!mm || Number(mm[1]) > 23 || Number(mm[2]) > 59) return null;
  return { h: Number(mm[1]), m: Number(mm[2]) };
})();
let freshStarting = false;
let lastPlayAt = 0;

/*
 * Exiting for the fresh start only makes sense while WinchesterDarts.exe is
 * still there to bring the hub back. The launcher can vanish while the hub
 * lives on (Task Scheduler's default "stop after 3 days", or someone ending
 * it in Task Manager) - then the hub stays up rather than go dark at 09:00.
 * Once gone it is gone for good: a launcher never comes back under the same
 * process id, but Windows soon hands that id to some other program.
 */
let launcherSeen = { at: 0, alive: true };
function launcherAlive() {
  if (!LAUNCHER_PID) return true;
  if (launcherSeen.alive && Date.now() - launcherSeen.at > 10000) launcherSeen = { at: Date.now(), alive: pidAlive(LAUNCHER_PID) };
  return launcherSeen.alive;
}

// Today's restart time and yesterday's: a late time plus the per-board
// stagger can run past midnight (23:58 + 4 min is 00:02 the next day), and a
// late restart deferred by play can carry on past midnight too. A day's
// restart happens once: the relaunched hub may land on a different port
// (PORT edited, home moved) and so compute a later minute the same morning
// - or, past midnight, the next day - so the day is the one the time was
// SET for, before the stagger.
function freshStartTarget(now, daysBack) {
  const t = new Date(now);
  t.setDate(t.getDate() - daysBack);
  t.setHours(FRESH_START.h, FRESH_START.m, 0, 0);
  const day = till.dayKey(t.getTime());
  t.setMinutes(FRESH_START.m + ((Number(settings.savedPort) || PORT) % 10));
  return { at: t.getTime(), day };
}
function freshStartTargets(now) {
  return [1, 0].map((daysBack) => freshStartTarget(now, daysBack));
}
const hhmm = (ts) => { const t = new Date(ts); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
function freshStartLabel() {
  if (!FRESH_START || !SUPERVISED || !launcherAlive()) return null;
  const now = Date.now();
  const today = freshStartTarget(now, 0);
  // Today's is over (done, or this run came up after it): show tomorrow's.
  if (settings.freshStartDone === today.day) return `${hhmm(freshStartTarget(now, -1).at)} (done for today)`;
  return hhmm(BOOT_AT >= today.at ? freshStartTarget(now, -1).at : today.at);
}
function freshStartNote() {
  return FRESH_START && SUPERVISED && !launcherAlive()
    ? 'paused - WinchesterDarts.exe was ended (Task Manager, or Task Scheduler\'s 3-day stop) and this hub carried on without it; double-click WinchesterDarts.exe and it takes over from this copy'
    : null;
}

setInterval(() => {
  if (!FRESH_START || !SUPERVISED || freshStarting || !launcherAlive()) return;
  const now = Date.now();
  const due = freshStartTargets(now).find((target) =>
    now >= target.at && now - target.at <= 60 * 60000 && BOOT_AT < target.at
    && settings.freshStartDone !== target.day);
  if (!due) return;
  if (now - lastPlayAt < 5 * 60000) return;      // darts flying - try again shortly
  settings.freshStartDone = due.day;
  saveSettings();
  freshStart();
}, 20000);

function freshStart() {
  freshStarting = true;
  console.log('daily fresh start - restarting the hub (everything is saved; screens reconnect by themselves)');
  try { saveMatch(); saveSession(); writeJson('alive.json', { t: Date.now() }); } catch (_) {}
  try { board.userStopped = true; board.disconnect(); } catch (_) {}
  try { io.close(); } catch (_) {}
  // A moment for Bluetooth to let go of the board before the relaunch grabs it
  setTimeout(() => process.exit(RESTART_CODE), 2000);
}

// A session restored from a previous run that has been dead for over an
// hour is settled now, dated to when that run was last alive - before the
// report backfill below, so the money lands on the right day's PDF.
if (session && session.startedAt && !session.recorded
    && session.startedAt < BOOT_AT && PREV_ALIVE && BOOT_AT - PREV_ALIVE > 60 * 60000) {
  settleAbandonedSession(PREV_ALIVE);
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
 * that instead of the number. The special covers EVERY dart of the visit - a
 * Killer taking a life with dart 1 and missing with darts 2 and 3 still gets
 * its call.
 */
// A restart mid-visit rebuilds the visit from the log: the life taken by
// dart 1 is still owed to the caller when darts 2 and 3 land after boot.
let visitEvents = (match && !match.state.finished ? match.visitSoFar || [] : []).slice();
function forgetVisitEvents() { visitEvents = []; }
function emitVisitIfTurnPassed(before, events) {
  if (!match) return;
  visitEvents.push(...(events || []));
  const after = match.view();
  const finished = match.state.finished;
  if (!finished && after.turnPlayerId === before.turnPlayerId
      && after.legNumber === before.legNumber) return;
  const who = (before.rows || []).find((r) => r.id === before.turnPlayerId);
  const types = visitEvents.map((e) => e.type);
  const win = visitEvents.find((e) => e.type === 'matchwin');
  visitEvents = [];
  const special = win
    // A win because the last rival ran out of lives is no "game shot" - the
    // caller gets last-one-standing words instead of the checkout call.
    ? (win.lastStanding ? 'elimwin' : 'matchwin')
    : types.includes('legwin') ? 'legwin'
    : types.includes('checkout') ? 'checkout'
    : types.includes('bust') ? 'bust'
    : types.includes('halved') ? 'bust'      // the clip says "No score!" - exactly right
    : types.includes('eliminated') ? 'eliminated'
    : types.includes('lifelost') ? 'lifelost'
    : null;
  io.emit('visit', {
    player: who ? who.name : '',
    darts: after.lastVisit || [],
    total: after.lastVisitTotal || 0,
    special,
    // Target and lives games: a visit's summed board score means nothing, so
    // the caller keeps quiet and the TV shows the darts without a big total.
    noscore: !!(match.game && match.game.quietVisit),
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
  lastPlayAt = Date.now();
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
// Fresh every boot: tells a hub's own broadcast echo apart from a CLONE - a
// folder copied data\ and all shares the persistent discoveryId, and used to
// be invisible to Find boards because its replies looked like self-echoes.
const BOOT_NONCE = crypto.randomBytes(8).toString('hex');

try {
  // reuseAddr so several hubs on one machine (two boards, one PC) can all answer.
  const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  beacon.on('error', () => { try { beacon.close(); } catch (_) {} });
  beacon.on('message', (msg, rinfo) => {
    const text = msg.toString();
    if (text.slice(0, DISCOVERY_HELLO.length) !== DISCOVERY_HELLO) return;
    // A probe carrying OUR persistent id from a DIFFERENT process means this
    // folder was copied from that one. Take a fresh identity on the spot -
    // the very scan that exposed the clash then lists this hub properly.
    try {
      const probe = JSON.parse(text.slice(DISCOVERY_HELLO.length + 1) || 'null');
      // The probe reaches both sides of the clash. A hub sitting at its own
      // home, saved from this very folder, is the original: it ignores it,
      // or Find boards on the copy's console would hand its identity, its
      // board and its home to the copy and strand the wall TV there.
      const atOwnHome = settings.savedPortAt === FOLDER_ID && !portDisplaced && !copiedHome && !(portStepped && !HOME_PORT);
      if (probe && probe.id === settings.discoveryId && probe.boot !== BOOT_NONCE && !atOwnHome) {
        settings.discoveryId = crypto.randomBytes(8).toString('hex');
        // The copy also inherited the ORIGINAL's dartboard lock - two hubs
        // fighting over one board both say "connected" while neither scores.
        // Drop it so staff tap this hub's own board in the device list.
        if (settings.boardUuid) {
          settings.boardUuid = '';
          try { board.disconnect(); } catch (_) {}
          io.emit('toast', { kind: 'error', text: 'This board was set up from a copied folder - tap ITS OWN dartboard under Board & sound' });
        }
        // ...and the original's home port. The port this copy is actually
        // on becomes its own home, so the two stop swapping addresses at
        // every reboot and this one stops asking for a restart. A hub
        // displaced from a home it saved itself keeps that home (and its
        // warning): its screens still point there.
        if (settings.savedPortAt !== FOLDER_ID || !portDisplaced) {
          settings.savedPort = PORT;
          settings.savedPortFrom = REQUESTED_PORT;
          settings.savedPortAt = FOLDER_ID;
          settings.savedPortPath = DATA_PATH;
          HOME_PORT = PORT;
          portDisplaced = false;
        }
        saveSettings();
        broadcast();
        console.log('this folder was copied from another board - taking a fresh identity');
      }
    } catch (_) { /* old-version probe with no payload - fine */ }
    const here = DISCOVERY_HERE + JSON.stringify({
      id: settings.discoveryId, boot: BOOT_NONCE, name: settings.boardName, port: PORT,
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
    // Self is the reply carrying THIS process's boot nonce - never the id
    // alone, which a cloned folder shares until it heals itself.
    if (!info || info.boot === BOOT_NONCE) return;
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
  const hello = DISCOVERY_HELLO + ' ' + JSON.stringify({ id: settings.discoveryId, boot: BOOT_NONCE });
  const shout = () => {
    for (const addr of broadcastAddresses()) {
      // Per-send noop callback: one dead adapter must not abort the scan.
      try { probe.send(hello, DISCOVERY_PORT, addr, () => {}); } catch (_) {}
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
  u.boardName = settings.boardName;
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
  try { socket.emit('state', snapshot()); } catch (err) { console.error('state snapshot failed:', err.message); }

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
    if (settings.powered === false) return socket.emit('toast', { kind: 'error', text: 'Power this board on first' });
    const m = Math.max(5, Math.min(480, Number(mins) || 60));
    const prev = closeRunningSession(true);
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
    if (settings.powered === false) return socket.emit('toast', { kind: 'error', text: 'Power this board on first' });
    const prev = closeRunningSession(true);
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
      forgetVisitEvents();
      io.emit('celclear');
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
    if (settings.powered === false) return socket.emit('toast', { kind: 'error', text: 'This board is powered off - staff can switch it on from the console' });
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
      forgetVisitEvents();
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
      forgetVisitEvents();
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
  // Undo, a corrected score or an ended game make any celebration still
  // queued on the TV wrong ("OUT!" for someone who is back in): drop them.
  socket.on('undo', () => {
    if (match && match.undo()) {
      // Undoing the finishing dart reopens the game: its record goes too.
      if (!match.state.finished) { lastRecorded = null; unrecord(matchKey(match)); }
      // Keep what the visit still under way has really done (dart 1's life
      // is still gone after dart 2 comes back) - the replay knows exactly.
      visitEvents = (match.visitSoFar || []).slice();
      io.emit('celclear'); saveMatch(); broadcast();
    }
  });
  socket.on('restart', () => {
    if (!match) return;
    match.restart();
    match.startedAt = new Date().toISOString();   // a replay is a new game with its own record
    lastRecorded = null;
    saveMatch();
    forgetVisitEvents();
    io.emit('newmatch', { gameId: match.gameId });
    broadcast();
  });
  socket.on('adjust', ({ playerId, value } = {}) => {
    if (!match || playerId === undefined || match.state.finished) return;
    // Only a number, or a string with one in it, is a correction: an empty
    // box, ' ', [] and false all read as 0 to Number() - and 0 knocks a
    // player out. A finished game only changes through Undo.
    const typed = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
    if (!typed || !Number.isFinite(Number(value))) return;
    const before = match.view();
    const who = (before.rows || []).find((r) => r.id === playerId);
    // No correction box for this game (170 Challenge): nothing to log either,
    // or the entry would steal the next Undo.
    if (!who || !who.adjust) return;
    const events = match.adjust(playerId, Number(value));
    const row = (match.view().rows || []).find((r) => r.id === playerId);
    const was = who.adjust.value, now = row && row.adjust ? row.adjust.value : was;
    io.emit('celclear');
    // Drop what this visit had already said about the corrected player only
    // where the correction contradicts it: "Life lost!" for a life just
    // given back, "OUT!" for someone now back in. A life taken and then
    // corrected further down keeps its call.
    visitEvents = visitEvents.filter((e) => {
      if ((e.victim || e.player) !== who.name) return true;
      if (who.adjust.field !== 'lives') return false;
      if (e.type === 'lifelost') return now <= was;
      if (e.type === 'eliminated') return now <= 0;
      return true;
    });
    // A lives correction can knock someone out or finish the game
    recordIfFinished();
    saveMatch();
    emitEvents(events, null);
    // The thrower knocked out mid-visit still gets that visit's card and
    // call. A bystander's knock-out (someone who left the pub) is not part
    // of the thrower's visit - the OUT! card is enough - and a thrower who
    // had not thrown yet has no visit to show.
    if (who.id !== before.turnPlayerId && !match.state.finished) return broadcast();
    if ((before.visit || []).length) emitVisitIfTurnPassed(before, events);
    else forgetVisitEvents();
    broadcast();
  });
  socket.on('endMatch', () => {
    retirePrizeAttempt(); match = null; forgetVisitEvents(); io.emit('celclear'); saveMatch(); broadcast();
  });

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
  socket.on('boardConnect', admin(() => {
    if (settings.powered === false) return socket.emit('toast', { kind: 'error', text: 'Power this board on first' });
    board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber });
  }));
  // The one-tap fix: tear the whole Bluetooth link down and rebuild it from a
  // fresh scan - what closing and reopening the app used to do.
  /*
   * The oche's soft power switch. OFF settles any running bill, ends the
   * game, releases the dartboard (and keeps it released through PC sleeps),
   * and sends every screen to a black standby. ON brings it all back. The
   * choice survives a PC restart - a board switched off at close stays off.
   */
  socket.on('powerOff', admin(() => {
    if (settings.powered === false) {
      // Already off, but let the board go again anyway: a second press is how
      // staff answer a board that got grabbed behind the standby screen.
      board.userStopped = true;
      try { board.disconnect(); } catch (_) {}
      board.userStopped = true;
      broadcast();
      return socket.emit('toast', { kind: 'ok', text: `${settings.boardName} is already off - board released` });
    }
    const bill = closeRunningSession();
    session = null;
    saveSession();
    retirePrizeAttempt();
    match = null;
    saveMatch();
    forgetVisitEvents();
    io.emit('celclear');              // nothing left to play behind the standby screen
    board.userStopped = true;
    try { board.disconnect(); } catch (_) {}
    board.userStopped = true;   // nothing disconnect() ran may switch it back on
    settings.powered = false;
    saveSettings();
    broadcast();
    socket.emit('toast', { kind: 'ok', text: `${settings.boardName} powered off${bill ? ` - last session billed ${till.money(bill.price)}` : ''}` });
  }));
  socket.on('powerOn', admin(() => {
    if (settings.powered !== false) return socket.emit('toast', { kind: 'ok', text: `${settings.boardName} is already on` });
    settings.powered = true;
    saveSettings();
    board.userStopped = false;
    if (settings.autoConnect || settings.boardUuid) {
      board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber });
    }
    broadcast();
    socket.emit('toast', { kind: 'ok', text: `${settings.boardName} powered on - reconnecting the board` });
  }));

  socket.on('boardFix', admin(() => {
    if (settings.powered === false) return socket.emit('toast', { kind: 'error', text: 'Power this board on first' });
    board.userStopped = false;
    if (!board.resumeRecover('rebuilding the board link')) {
      board.connect({ uuid: settings.boardUuid, buttonNumber: settings.buttonNumber });
    }
    socket.emit('toast', { kind: 'ok', text: 'Rebuilding the board link (takes ~10s)...' });
    broadcast();
    // Follow through: once the rebuild window has passed, wake the board
    // (fresh scoring-on handshake) and tell staff how it went. The TV and
    // iPad never move - they are wired to this hub's home port.
    setTimeout(() => {
      // Power off or Disconnect since the Fix was pressed: nothing to arm or report.
      if (board.userStopped) return;
      if (board.status === 'connected') {
        try { board.wake(); } catch (_) {}
        io.emit('toast', { kind: 'ok', text: `${settings.boardName} reconnected and armed - throw a dart and watch "Darts heard"` });
      } else {
        io.emit('toast', { kind: 'error', text: `${settings.boardName} still not connected (${board.detail || board.status}) - wake the board with a dart, check batteries, then try Fix again` });
      }
      broadcast();
    }, 14000);
  }));
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
 *
 * But once a board HAS a home port, its TV and iPad are mounted on the wall
 * pointing at it - so the home is forever. If the home port is busy at boot
 * (usually the sibling copy mid-restart), WAIT for it rather than wander;
 * only after a full minute does the hub reluctantly come up elsewhere, and
 * even then the home is never overwritten - the staff console shows a red
 * warning until a restart puts things right.
 */
function listenWithFallback(triesLeft) {
  if (copiedHome && PORT === SAVED_PORT) {
    console.log(`port ${PORT} is the home of the folder this one was copied from - trying ${PORT + 1}`);
    portStepped = true;
    PORT += 1;
  }
  server.once('error', (err) => {
    if (err.code !== 'EADDRINUSE' || triesLeft <= 0) {
      console.error('could not start:', err.message);
      // Every port busy is worth retrying later (the launcher waits 30 s);
      // anything else is a setup problem to show and stop on.
      process.exit(err.code === 'EADDRINUSE' ? 78 : 1);
    }
    if (HOME_PORT && PORT === HOME_PORT && holdTries > 0) {
      holdTries -= 1;
      console.log(`home port ${PORT} is busy - waiting for it (the mounted TV and iPad point here)`);
      setTimeout(() => listenWithFallback(triesLeft), 5000);
      return;
    }
    // A hub of THIS folder on the busy port (it lost the lock to us while
    // frozen) makes us the duplicate: hand the lock back and close rather
    // than come up beside it on another port for good.
    const other = hubHttp(PORT, 'GET');
    if (other && other.folder === FOLDER_ID && other.pid !== process.pid) {
      try { writeLock({ pid: other.pid, port: PORT }); } catch (_) {}
      refuseToRun(['WinchesterDarts is ALREADY RUNNING from this folder - this copy will',
        `close so the two do not overwrite each other (process ${other.pid}, port ${PORT}).`]);
    }
    console.log(`port ${PORT} is taken (another board on this PC?) - trying ${PORT + 1}`);
    portStepped = true;
    PORT += 1;
    listenWithFallback(triesLeft - 1);
  });
  // The success handler is registered ONCE below - a failed attempt must not
  // leave an extra callback behind for the winning attempt to fire.
  server.listen(PORT);
}
server.once('listening', () => {
  // The FIRST successful claim becomes home, permanently. A displaced hub
  // never adopts its refuge as home - the mounted screens still point at
  // the real one. Stepping past a busy port only counts as displaced when
  // it lands somewhere OTHER than home (a second board stepping from 8080
  // onto its own 8081 is exactly where it belongs).
  portDisplaced = portStepped && !!HOME_PORT && PORT !== HOME_PORT;
  const moved = settings.savedPort !== PORT;
  if (!portDisplaced && (moved || settings.savedPortAt !== FOLDER_ID || settings.savedPortPath !== DATA_PATH
      || (REQUESTED_PORT !== 8080 && settings.savedPortFrom !== REQUESTED_PORT))) {
    settings.savedPort = PORT;
    // The shipped default is no choice: a home kept through it keeps its
    // origin - a legacy home none at all, or the hand-set port it stepped
    // from would later read as a move and the two boards could swap.
    if (moved || REQUESTED_PORT !== 8080) settings.savedPortFrom = REQUESTED_PORT;
    settings.savedPortAt = FOLDER_ID;
    settings.savedPortPath = DATA_PATH;
    saveSettings();
  }
  // Now the lock can name the port, and a later copy can ask us instead of
  // trusting the process id.
  try { writeLock({ port: PORT }); } catch (_) {}
  if (portDisplaced) {
    console.error('');
    console.error(`   WARNING: this board's home address (port ${HOME_PORT}) was taken.`);
    console.error(`   Running on ${PORT} for now - the mounted TV and iPad will NOT`);
    console.error('   reach this board until the PC is restarted.');
    console.error('');
  }
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
listenWithFallback(9);

// Closing the console (CTRL_CLOSE arrives as SIGHUP), End task, a Task
// Scheduler stop and a plain Ctrl-C all end the same way, so the lock and
// the last saves are never left behind.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { try { board.disconnect(); } catch (_) {} process.exit(0); });
}
