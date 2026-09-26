/*
 * Boots the real server with a fake Bluetooth stack behaving like a real
 * Unicorn board: fff0 service, fff1 notify throws, fff2 write-only button,
 * battery service, continuous advertising while scanned, and a dart thrown
 * every 2 seconds once anyone subscribes.
 *
 * Opt-in knobs that model the real backends more closely (all off by default):
 *   FAKE_CONNECT_FAIL=1          every connect is refused ("the device is unreachable")
 *   FAKE_CONNECT_FAIL_TIMES=n    the first n connects are refused, then accepted
 *   FAKE_CONNECT_DELAY_MS=n      connect completes asynchronously after n ms (WinRT takes seconds)
 *   FAKE_DISCONNECT_EVENT=1      p.disconnect() on a live link emits 'disconnect', like noble does
 *   FAKE_SECOND_BOARD=1          a second dartboard advertises too (uuid 112233445566)
 *   FAKE_HOOK_PORT=n             http://127.0.0.1:n/stats  -> connect attempts, scans, per-board state
 *                                http://127.0.0.1:n/drop[?board=i] -> that board drops the link by itself
 */
const EventEmitter = require('events');
const Module = require('module');

const stats = { connectAttempts: 0, scans: 0 };

function makeBoard(uuid, address, localName) {
  const throws = new EventEmitter();
  throws.uuid = '0000fff1-0000-1000-8000-00805f9b34fb';
  throws.properties = ['notify'];
  throws.subscribe = (cb) => cb(null);
  throws.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(throws);

  const writes = [];
  const button = {
    uuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    properties: ['write'],
    write(buf, withoutResponse, cb) {
      writes.push({ byte: buf[0], withoutResponse });
      if (cb) cb(null);
    },
  };

  const service = {
    uuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    discoverCharacteristics: (_f, cb) => cb(null, [throws, button]),
  };

  const batteryChar = {
    uuid: '00002a19-0000-1000-8000-00805f9b34fb',
    properties: ['read'],
    read: (cb) => cb(null, Buffer.from([Number(process.env.FAKE_BATTERY || 76)])),
  };
  const batteryService = {
    uuid: '0000180f-0000-1000-8000-00805f9b34fb',
    discoverCharacteristics: (_f, cb) => cb(null, [batteryChar]),
  };

  const peripheral = new EventEmitter();
  peripheral.uuid = uuid;
  peripheral.address = address;
  peripheral.advertisement = { localName };
  peripheral.connected = false;
  peripheral.attempts = 0;
  peripheral.connect = (cb) => {
    peripheral.attempts++;
    stats.connectAttempts++;
    const refuse = !!process.env.FAKE_CONNECT_FAIL
      || peripheral.attempts <= Number(process.env.FAKE_CONNECT_FAIL_TIMES || 0);
    const finish = () => {
      if (!refuse) peripheral.connected = true;
      cb(refuse ? new Error('the device is unreachable') : null);
    };
    const delay = Number(process.env.FAKE_CONNECT_DELAY_MS || 0);
    if (delay > 0) setTimeout(finish, delay); else finish();
  };
  peripheral.discoverServices = (_f, cb) => cb(null, [service, batteryService]);
  peripheral.disconnect = (cb) => {
    const wasLive = peripheral.connected;
    peripheral.connected = false;
    if (cb) cb();
    if (process.env.FAKE_DISCONNECT_EVENT && wasLive) setImmediate(() => peripheral.emit('disconnect'));
  };
  // The board itself lets go (batteries out, out of range).
  peripheral.drop = () => { peripheral.connected = false; peripheral.emit('disconnect'); };
  return { peripheral, throws, button, writes };
}

const boards = [makeBoard('aabbccddeeff', 'aa:bb:cc:dd:ee:ff', 'Unicorn Darts')];
if (process.env.FAKE_SECOND_BOARD) boards.push(makeBoard('112233445566', '11:22:33:44:55:66', 'Unicorn Darts 2'));
const { throws, writes, peripheral } = boards[0];

const noble = new EventEmitter();
noble.state = 'poweredOn';
let advertising = null;
noble.startScanning = () => {
  stats.scans++;
  clearInterval(advertising);
  advertising = setInterval(() => boards.forEach((b) => noble.emit('discover', b.peripheral)), 400);
};
noble.stopScanning = () => { clearInterval(advertising); advertising = null; };

const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@stoprocent/noble') return noble;
  return orig.call(this, request, ...rest);
};

global.__fake = { throws, writes, peripheral };
// The board throws by itself: T20-ish dart every 2 seconds once subscribed.
const beds = [[20, 3], [20, 1], [19, 3], [5, 1], [1, 1], [18, 1], [12, 2]];
let n = 0;
setInterval(() => {
  try {
    const [sc, m] = beds[n++ % beds.length];
    boards.forEach((b) => b.throws.emit('data', Buffer.from([sc, m]), true));
  } catch (_) {}
}, 2000);

if (Number(process.env.FAKE_HOOK_PORT)) {
  require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/drop') boards[Number(u.searchParams.get('board') || 0)].peripheral.drop();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ...stats,
      boards: boards.map((b) => ({
        uuid: b.peripheral.uuid,
        connected: b.peripheral.connected,
        attempts: b.peripheral.attempts,
        disconnectListeners: b.peripheral.listenerCount('disconnect'),
        dataListeners: b.throws.listenerCount('data'),
        writes: b.writes.map((w) => w.byte),
      })),
    }));
  }).listen(Number(process.env.FAKE_HOOK_PORT), '127.0.0.1');
}

require(process.env.SERVER_JS || require('path').join(__dirname, '..', 'server', 'server.js'));
