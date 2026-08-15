'use strict';
/*
 * Unicorn Smartboard driver (Bluetooth LE).
 *
 * Emits: 'dart'   {score, multiplier}   - a dart landed (already rotated)
 *        'button'                       - rim button = end of turn
 *        'status' {state, detail}        - idle|scanning|connected|error|off
 *
 * Windows 10/11 uses the native WinRT backend, Linux the HCI socket - both via
 * @stoprocent/noble, which ships prebuilt binaries for each.
 */
const EventEmitter = require('events');

const SERVICE_SCORING = 'fff0';
const CHAR_BUTTON = 'fff2';
const CHAR_THROWS = 'fff1';

/*
 * The board reports the same bed several times for one dart - the contact
 * bounces as the point beds in, so identical packets arrive a few hundred
 * milliseconds apart. An identical packet inside this window is treated as
 * that same dart, and the window rolls forward while the repeats continue.
 *
 * The window is deliberately short. Three darts in the treble 20 bed report
 * as three identical packets too, and swallowing the second and third would
 * turn a 180 into a 60 - so this only ever suppresses packets closer together
 * than a human can throw. Anything slower is counted, and the iPad's undo is
 * there for the rare stray.
 */
const REPEAT_MS = 1200;
const RING = [15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5, 20, 1, 18, 4, 13, 6, 10];

function normalise(id) {
  return String(id || '').toLowerCase().replace(/[:\-\s]/g, '');
}

/** 128-bit Bluetooth uuids collapse to their 4-hex short form. */
function shortUuid(u) {
  const x = String(u || '').toLowerCase().replace(/-/g, '');
  const m = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(x);
  return m ? m[1] : x;
}

/** Rotate a reported segment to compensate for how the board is hung. */
function rotate(num, button) {
  if (num === 25 || !button) return num;
  const i = RING.indexOf(num) + RING.indexOf(Number(button));
  return RING[i >= RING.length ? i - RING.length : i];
}

class Board extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.detail = 'not started';
    this.peripheral = null;
    this.noble = null;
    this.wanted = null;
    this.buttonNumber = 20;
    this.discovered = [];
    this.scanning = false;
    this.moduleLoaded = false;
    this.loadError = null;      // kept verbatim so the diagnostics can show it
    this.lastError = null;
    this.step = 'not started';
    this.services = null;
    this.characteristics = null;
    this.subscribeError = null;
    this.enabledAt = null;
    this.enabledMode = null;
    this.notifications = 0;     // raw packets from the board, before any parsing
    this.dartPackets = 0;       // of those, ones we read as a dart
    this.lastPacket = null;
    this.lastPacketAt = null;
    this.packetLog = [];        // last 30, decoded, for diagnosis
    this.enableAttempts = [];   // every wake-up byte we sent, and how it went
    this.rearms = 0;
    this.repeatsIgnored = 0;
    this._rearmTimer = null;
    this._lastDartHex = null;
    this._lastDartAt = 0;
  }

  /** Everything a diagnosis needs, in one object. */
  diagnostics() {
    let nobleState = null;
    try { nobleState = this.noble ? (this.noble.state || this.noble._state || null) : null; } catch (_) {}
    return {
      status: this.status,
      detail: this.detail,
      step: this.step,
      moduleLoaded: this.moduleLoaded,
      loadError: this.loadError,
      lastError: this.lastError,
      nobleState,
      scanning: this.scanning,
      connected: !!this.peripheral,
      wanted: this.wanted || '(auto-detect)',
      buttonNumber: this.buttonNumber,
      services: this.services,
      characteristics: this.characteristics,
      subscribeError: this.subscribeError,
      enabledAt: this.enabledAt,
      enabledMode: this.enabledMode,
      enableAttempts: this.enableAttempts,
      rearms: this.rearms,
      packetsFromBoard: this.notifications,
      dartPackets: this.dartPackets,
      repeatsIgnored: this.repeatsIgnored,
      lastPacket: this.lastPacket,
      lastPacketAt: this.lastPacketAt,
      packetLog: this.packetLog,
      discovered: this.discovered,
    };
  }

  setStatus(state, detail) {
    this.status = state;
    this.detail = detail || '';
    this.emit('status', { state, detail: this.detail, discovered: this.discovered });
  }

  _noble() {
    if (!this.noble) {
      // Loaded lazily so the app still runs on machines without Bluetooth.
      this.noble = require('@stoprocent/noble');
      this.moduleLoaded = true;
      this.loadError = null;
      this.noble.on('discover', (p) => this._onDiscover(p));
      // noble can also fail asynchronously - surface that instead of dying
      this.noble.on('error', (err) => {
        this.lastError = String((err && err.message) || err);
        this.setStatus('error', `Bluetooth error: ${this.lastError}`);
      });
    }
    return this.noble;
  }

  _onDiscover(p) {
    const uuid = normalise(p.uuid);
    const addr = normalise(p.address);
    const name = (p.advertisement && p.advertisement.localName) || '';
    if (!this.discovered.some((d) => d.uuid === uuid)) {
      this.discovered.push({ uuid, address: addr, name });
      if (this.discovered.length > 40) this.discovered.shift();
      this.emit('status', { state: this.status, detail: this.detail, discovered: this.discovered });
    }
    const looksRight = /dart|joofunn|unicorn/i.test(name);
    const match = this.wanted ? (uuid === this.wanted || (addr && addr === this.wanted)) : looksRight;
    if (match && !this.peripheral) this._connect(p);
  }

  /** Start looking for the board. uuid may be blank: then we auto-pick a board-looking device. */
  connect({ uuid, buttonNumber }) {
    this.wanted = uuid ? normalise(uuid) : null;
    if (buttonNumber) this.buttonNumber = Number(buttonNumber);
    this.discovered = [];

    let noble;
    try {
      noble = this._noble();
    } catch (err) {
      this.moduleLoaded = false;
      this.loadError = {
        message: String(err && err.message || err),
        code: err && err.code,
        stack: String(err && err.stack || '').split('\n').slice(0, 6).join(' | '),
      };
      this.setStatus('error', `Bluetooth driver did not load: ${this.loadError.message}`);
      return;
    }

    const begin = () => {
      if (this.scanning) return;
      this.scanning = true;
      this.setStatus('scanning', this.wanted ? `looking for ${this.wanted}` : 'looking for any dartboard');
      try {
        noble.startScanning([], true);
      } catch (err) {
        this.scanning = false;
        this.setStatus('error', `could not start scanning: ${err.message}`);
      }
    };

    const state = noble.state || noble._state;
    if (state === 'poweredOn') begin();
    else {
      this.setStatus('idle', `waiting for Bluetooth (currently ${state || 'unknown'})`);
      noble.once('stateChange', (s) => {
        if (s === 'poweredOn') begin();
        else this.setStatus('off', `Bluetooth is ${s} - switch it on in Windows settings`);
      });
    }
  }

  _connect(peripheral) {
    this.peripheral = peripheral;
    try { this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    const name = (peripheral.advertisement && peripheral.advertisement.localName) || 'dartboard';
    this.setStatus('connecting', `${name} (${peripheral.uuid})`);

    peripheral.once('disconnect', () => {
      if (this.peripheral === peripheral) {
        this.peripheral = null;
        clearInterval(this._rearmTimer);
        this._rearmTimer = null;
        this.setStatus('idle', 'board disconnected - press Reconnect');
        this.emit('lost');
      }
    });

    peripheral.connect((err) => {
      if (err) {
        this.lastError = String(err.message || err);
        return this.setStatus('error', `could not connect to the board: ${this.lastError}`);
      }
      this.step = 'discovering services';
      // Discover everything and match ourselves: backends disagree about
      // whether a uuid filter takes the short or the 128-bit form.
      peripheral.discoverServices([], (err2, services) => {
        if (err2 || !services || !services.length) {
          this.lastError = String((err2 && err2.message) || 'no services returned');
          return this.setStatus('error', `could not read the board's services: ${this.lastError}`);
        }
        this.services = services.map((s) => shortUuid(s.uuid));
        const svc = services.find((s) => shortUuid(s.uuid) === SERVICE_SCORING);
        if (!svc) {
          return this.setStatus('error',
            `scoring service ${SERVICE_SCORING} not found - this device offers ${this.services.join(', ')}`);
        }

        this.step = 'discovering characteristics';
        svc.discoverCharacteristics([], (err3, chars) => {
          if (err3 || !chars || !chars.length) {
            this.lastError = String((err3 && err3.message) || 'none returned');
            return this.setStatus('error', `could not read the board's characteristics: ${this.lastError}`);
          }
          this.characteristics = chars.map((c) => ({ uuid: shortUuid(c.uuid), properties: c.properties || [] }));
          const button = chars.find((c) => shortUuid(c.uuid) === CHAR_BUTTON);
          const throws = chars.find((c) => shortUuid(c.uuid) === CHAR_THROWS);
          if (!button || !throws) {
            return this.setStatus('error',
              `expected ${CHAR_THROWS}/${CHAR_BUTTON}, found ${this.characteristics.map((c) => c.uuid).join(', ')}`);
          }

          this.button = button;
          this.throws = throws;
          // Listen and subscribe BEFORE waking the board, and run the GATT
          // steps one at a time - overlapping operations get dropped on WinRT.
          throws.removeAllListeners('data');
          throws.on('data', (data) => this._onData(data));
          this.step = 'subscribing to throws';
          throws.subscribe((subErr) => {
            this.subscribeError = subErr ? String(subErr.message || subErr) : null;
            this._enable(button, name);
          });
        });
      });
    });
  }

  /**
   * Put the board into scoring mode: 0x03 on the button characteristic.
   *
   * There is no reliable success signal here. A write-without-response is
   * fire-and-forget, and on Windows a write to a characteristic that does not
   * declare the mode you asked for is often accepted and then quietly dropped
   * - the callback still says "fine". So don't pick a mode and hope: send the
   * byte in the mode the characteristic declares, then send it again the other
   * way a moment later. 0x03 means "listening on", so sending it twice is
   * harmless, and whichever write the Bluetooth stack honours wakes the board.
   *
   * The real success signal is a dart packet arriving, which is why _onData
   * cancels the re-arm timer below.
   */
  _enable(button, name) {
    const props = (button.properties || []).map((p) => String(p).toLowerCase());
    const canWithout = props.some((p) => p.replace(/[^a-z]/g, '') === 'writewithoutresponse');
    const canWith = props.includes('write');
    // false = write-with-response. Lead with whatever the board advertises.
    const first = canWith ? false : (canWithout ? true : false);
    const send = (withoutResponse, then) => {
      const mode = withoutResponse ? 'write-without-response' : 'write-with-response';
      const record = (err) => {
        this.enableAttempts.push({
          at: new Date().toISOString(),
          mode,
          error: err ? String(err.message || err) : null,
        });
        if (this.enableAttempts.length > 12) this.enableAttempts.shift();
        if (!err) { this.enabledAt = new Date().toISOString(); this.enabledMode = mode; }
        if (then) then(err);
      };
      this.step = `enabling scoring (${mode})`;
      try {
        button.write(Buffer.from([0x03]), withoutResponse, record);
      } catch (err) {
        record(err);
      }
    };

    send(first, (err1) => {
      // Don't hold the UI back: the link is up either way.
      this.step = 'ready';
      const failed = err1 ? ` (first write failed: ${this.enableAttempts.slice(-1)[0].error})` : '';
      this.setStatus('connected',
        `${name} ready${failed}${this.subscribeError ? ` (subscribe warning: ${this.subscribeError})` : ''}`);
      setTimeout(() => { if (this.peripheral) send(!first); }, 700);
    });

    this._scheduleRearm(button);
  }

  /**
   * Keep nudging the board with 0x03. A board that fell asleep and a wake-up
   * byte the Bluetooth stack swallowed look identical from here, and both are
   * fixed the same way. Two speeds:
   *
   *   - before the first dart, every 20s for ~3 minutes, because at that point
   *     we have no evidence the board ever woke;
   *   - afterwards, once the board has been quiet for two minutes, because a
   *     board left alone between games goes back to sleep. In a pub nobody is
   *     going to walk over and press Connect, so the hub does it.
   */
  _scheduleRearm(button) {
    clearInterval(this._rearmTimer);
    let opening = 10;                                // 10 x 20s of hard trying
    this._rearmTimer = setInterval(() => {
      if (!this.peripheral) {
        clearInterval(this._rearmTimer);
        this._rearmTimer = null;
        return;
      }
      const quietFor = Date.now() - (Date.parse(this.lastPacketAt) || 0);
      const stillWaiting = this.dartPackets === 0 && opening-- > 0;
      if (!stillWaiting && quietFor < 120000) return;
      try { button.write(Buffer.from([0x03]), false, () => {}); } catch (_) {}
      try { button.write(Buffer.from([0x03]), true, () => {}); } catch (_) {}
      this.rearms++;
    }, 20000);
    if (this._rearmTimer.unref) this._rearmTimer.unref();
  }

  _onData(data) {
    this.notifications++;
    const hex = data ? Buffer.from(data).toString('hex') : null;
    this.lastPacket = hex;
    this.lastPacketAt = new Date().toISOString();

    const note = (kind, detail) => {
      this.packetLog.push({ at: this.lastPacketAt, hex, kind, detail });
      if (this.packetLog.length > 30) this.packetLog.shift();
      this.emit('packet', { hex, at: this.lastPacketAt, kind, detail });
    };

    if (!data || data.length < 2) { note('short', `${data ? data.length : 0} byte(s) - ignored`); return; }
    const raw = data.readUInt8(0);
    const mult = data.readUInt8(1);
    if (raw === 85 && mult === 170) { note('button', 'rim button - next player'); this.emit('button'); return; }

    // 0 = thin single, 1 = fat single, 2 = double, 3 = treble
    if (mult > 3) { note('unknown', `multiplier byte ${mult} is out of range (segment ${raw})`); return; }
    if (raw !== 25 && RING.indexOf(raw) === -1) {
      note('unknown', `segment ${raw} is not on the board (multiplier byte ${mult})`);
      return;
    }

    // The board repeats the bed a dart is resting in - count it once.
    const now = Date.now();
    if (hex === this._lastDartHex && now - this._lastDartAt < REPEAT_MS) {
      this._lastDartAt = now;                    // rolls while the dart is in
      this.repeatsIgnored++;
      note('repeat', 'same bed again - the dart is still in the board, not counted');
      return;
    }
    this._lastDartHex = hex;
    this._lastDartAt = now;

    const multiplier = mult === 0 ? 1 : mult;
    const score = rotate(raw, this.buttonNumber);
    this.dartPackets++;
    note('dart', `raw ${raw} x${mult} -> ${multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : ''}${score}`);
    this.emit('dart', { score, multiplier, raw, zone: mult === 0 ? 'inner' : 'outer' });
  }

  /**
   * Work out how the board is hung from one known dart: given the segment the
   * board reported and the number it physically landed in, return the button
   * number that lines the two up.
   */
  static buttonFor(raw, actual) {
    const from = RING.indexOf(Number(raw));
    const to = RING.indexOf(Number(actual));
    if (from === -1 || to === -1) return null;
    return RING[(to - from + RING.length) % RING.length];
  }

  /** Forget the last bed, so the next dart counts even if it repeats it. */
  resetRepeat() { this._lastDartHex = null; this._lastDartAt = 0; }

  /** Re-send the wake-up byte without reconnecting. */
  wake() {
    if (!this.button) return false;
    this._enable(this.button, 'board');
    return true;
  }

  disconnect() {
    const p = this.peripheral;
    this.peripheral = null;
    clearInterval(this._rearmTimer);
    this._rearmTimer = null;
    try { if (this.noble) this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    if (this.button) { try { this.button.write(Buffer.from([0x02]), true, () => {}); } catch (_) {} }
    if (p) { try { p.disconnect(() => {}); } catch (_) {} }
    this.setStatus('idle', 'disconnected');
  }
}

module.exports = { Board, rotate, normalise };
