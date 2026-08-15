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
const SERVICE_BATTERY = '180f';
const CHAR_BATTERY = '2a19';

/*
 * Below this, treat the batteries as the prime suspect. Unicorn's own support
 * line is that low batteries cause missing and random scores, and it shows up
 * exactly the way you would expect: the rim button is a plain switch and keeps
 * working on almost nothing, while scanning twenty segments for a dart is the
 * hungry part and dies first. A board that reports the button but never a dart
 * is the classic symptom.
 */
const BATTERY_LOW = 40;

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
    this.battery = null;        // percent, straight off the board
    this.batteryAt = null;
    this.batteryNote = null;
    this.connectedAt = 0;
    this.allServices = null;
    this.warnings = [];         // noble's own complaints, verbatim
    this.droppedEvents = 0;
    this.droppedNotifications = 0;
    this.recoveries = 0;
    this._recovering = false;
    this._rearmTimer = null;
    this._lastRearmAt = 0;
    this._lastDartHex = null;
    this._lastDartAt = 0;
    this._preferWithout = false;
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
      droppedEvents: this.droppedEvents,
      droppedNotifications: this.droppedNotifications,
      recoveries: this.recoveries,
      warnings: this.warnings,
      battery: this.battery,
      batteryAt: this.batteryAt,
      batteryNote: this.batteryNote,
      batteryLow: this.battery !== null && this.battery <= BATTERY_LOW,
      // Buttons but never a dart is the low-battery signature - call it out.
      verdict: this.verdict(),
      lastPacket: this.lastPacket,
      lastPacketAt: this.lastPacketAt,
      packetLog: this.packetLog,
      discovered: this.discovered,
    };
  }

  /**
   * Read the packet history and say, in one line, what it points at. Counting
   * packets is only useful if somebody knows what the counts mean.
   */
  verdict() {
    const buttons = this.notifications - this.dartPackets - this.repeatsIgnored;
    if (this.droppedNotifications > 0) {
      return `The board sent ${this.droppedNotifications} notification(s) that arrived after we lost track `
        + 'of it, so they were discarded rather than scored. The board is working - reconnecting to pick '
        + 'them up properly.';
    }
    if (this.battery !== null && this.battery <= BATTERY_LOW) {
      return `Board battery is ${this.battery}% - replace the three AA cells in the back. Low batteries `
        + 'stop darts registering while the rim button still works.';
    }
    if (this.dartPackets > 0) return `Scoring: ${this.dartPackets} dart(s) read from the board.`;
    if (buttons > 0) {
      return 'The board is connected and the rim button reports, but no dart ever has. LOOK AT THE RIM '
        + 'BUTTON: green means the board is in scoring mode and the fault is the board itself - fresh AA '
        + 'cells first, then steel or tungsten darts (brass registers poorly). Red means it never went '
        + 'into scoring mode - press Wake board and watch the light change.';
    }
    if (this.peripheral) return 'Connected, but the board has sent nothing at all yet.';
    return 'Not connected.';
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
      /*
       * noble prints "unknown peripheral ..., fff1 read!" when a notification
       * arrives for a characteristic it can no longer route to. That line means
       * the board IS sending darts and they are being dropped on our side. It
       * used to go to the console and nowhere else; now it lands in the
       * diagnostics, and a dropped notification tears the connection down so a
       * clean reconnect can put it right.
       */
      this.noble.on('warning', (msg) => {
        const text = String(msg);
        this.warnings.push({ at: new Date().toISOString(), text });
        if (this.warnings.length > 20) this.warnings.shift();
        if (/unknown peripheral/i.test(text)) {
          this.droppedEvents++;
          if (/read!|notify!/i.test(text)) this.droppedNotifications++;
          this._recover();
        }
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

    // Already on the board? Re-run the handshake rather than starting another
    // scan. Scanning on a live connection is a good way to lose it.
    if (this.peripheral && this.button) {
      this.wake();
      return;
    }
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
    this.connectedAt = Date.now();
    try { this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    const name = (peripheral.advertisement && peripheral.advertisement.localName) || 'dartboard';
    this.setStatus('connecting', `${name} (${peripheral.uuid})`);

    peripheral.once('disconnect', () => {
      if (this.peripheral === peripheral) {
        this.peripheral = null;
        this.button = null;
        this.throws = null;
        this.allServices = null;
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
        // Keep the discovered services. Discovery must happen EXACTLY ONCE per
        // connection: noble resets its characteristic registry for every
        // service each time you discover, so a second call silently orphans
        // the characteristics we already hold. Notifications then arrive and
        // are thrown away with "unknown peripheral ... read!" while everything
        // still looks connected. Anything that needs another service reads it
        // out of this array instead of asking the board again.
        this.allServices = services;
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
          throws.removeAllListeners('data');
          throws.on('data', (data) => this._onData(data));

          // Order matters, and it is the opposite of what feels natural.
          // Switch the board into listening mode FIRST, then subscribe to the
          // throw notifications. Both the published protocol notes and the two
          // independent working implementations do it this way round; doing it
          // the other way leaves a board that connects, reports its rim button
          // and never reports a dart. Run the steps one at a time - WinRT
          // drops overlapping GATT operations.
          this._enable(button, name, () => {
            this.step = 'subscribing to throws';
            throws.subscribe((subErr) => {
              this.subscribeError = subErr ? String(subErr.message || subErr) : null;
              this.step = 'ready';
              this.setStatus('connected',
                `${name} ready${this.subscribeError ? ` (subscribe warning: ${this.subscribeError})` : ''}`);
              setTimeout(() => this._readBattery(), 1500);
            });
          });
        });
      });
    });
  }

  /**
   * Put the board into listening mode: write 0x03 to the button characteristic
   * (0x02 turns it back off). The board shows this on its own rim button - the
   * LEDs go from red to green - which is the only confirmation that does not
   * depend on believing what the Bluetooth stack tells us.
   *
   * fff2 declares plain "write", so send it with response and let the write
   * actually be acknowledged. Only if that errors is the other mode worth
   * trying, and it is a fallback, not a scattergun: firing both modes at the
   * board on every attempt is how you end up hammering a healthy connection.
   */
  _enable(button, name, then) {
    const props = (button.properties || []).map((p) => String(p).toLowerCase());
    const canWithout = props.some((p) => p.replace(/[^a-z]/g, '') === 'writewithoutresponse');
    const canWith = props.includes('write');
    const first = canWith ? false : (canWithout ? true : false);   // false = with response
    const send = (withoutResponse, done) => {
      const mode = withoutResponse ? 'write-without-response' : 'write-with-response';
      const record = (err) => {
        this.enableAttempts.push({
          at: new Date().toISOString(),
          mode,
          error: err ? String(err.message || err) : null,
        });
        if (this.enableAttempts.length > 12) this.enableAttempts.shift();
        if (!err) {
          this.enabledAt = new Date().toISOString();
          this.enabledMode = mode;
          this._preferWithout = withoutResponse;
        }
        done(err);
      };
      this.step = `switching the board into scoring mode (${mode})`;
      try {
        button.write(Buffer.from([0x03]), withoutResponse, record);
      } catch (err) {
        record(err);
      }
    };

    this._preferWithout = first;
    send(first, (err) => {
      const finish = () => {
        this._scheduleRearm(button);
        if (then) then();
      };
      if (!err) return finish();
      // The declared mode was refused - try the other one before giving up.
      send(!first, (err2) => {
        if (err2) {
          this.lastError = String(err2.message || err2);
          this.setStatus('error', `could not switch the board into scoring mode: ${this.lastError}`);
        }
        finish();
      });
    });
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
    let opening = 3;                                 // three nudges, then back off
    this._rearmTimer = setInterval(() => {
      if (!this.peripheral) {
        clearInterval(this._rearmTimer);
        this._rearmTimer = null;
        return;
      }
      // Quiet since the last packet, since we connected if there never was
      // one, or since the last nudge - whichever is most recent. Without the
      // last of those, a board that stays quiet trips the two-minute test on
      // every tick after it, and "once the board has been idle a while" turns
      // into a write every twenty seconds for ever.
      const since = Math.max(
        Date.parse(this.lastPacketAt) || 0,
        this.connectedAt || 0,
        this._lastRearmAt || 0,
      ) || Date.now();
      const stillWaiting = this.dartPackets === 0 && opening-- > 0;
      if (!stillWaiting && Date.now() - since < 120000) return;
      try { button.write(Buffer.from([0x03]), this._preferWithout, () => {}); } catch (_) {}
      this.rearms++;
      this._lastRearmAt = Date.now();
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

  /**
   * Ask the board how much charge it has left (standard battery service). Runs
   * on its own, after the scoring handshake, so it can never delay a dart.
   */
  _readBattery() {
    if (!this.peripheral) return;
    const fail = (why) => { this.batteryNote = String(why); };
    // Use the services found at connect time. Re-discovering here is what
    // orphaned the throw characteristic and lost every dart - see above.
    const svc = (this.allServices || []).find((s) => shortUuid(s.uuid) === SERVICE_BATTERY);
    if (!svc) return fail('this board does not publish a battery level');
    try {
      svc.discoverCharacteristics([], (err, chars) => {
        if (err || !chars || !this.peripheral) return fail((err && err.message) || 'no characteristics');
        const c = chars.find((x) => shortUuid(x.uuid) === CHAR_BATTERY);
        if (!c) return fail('no battery-level characteristic');
        c.read((err2, data) => {
          if (err2 || !data || !data.length) return fail((err2 && err2.message) || 'no value returned');
          this.battery = data.readUInt8(0);
          this.batteryAt = new Date().toISOString();
          this.batteryNote = null;
          this.emit('battery', { percent: this.battery, low: this.battery <= BATTERY_LOW });
          this.setStatus(this.status, this.detail);      // push it to the screens
        });
      });
    } catch (e) { fail(e.message || e); }
  }

  /**
   * Our characteristic handles have gone stale, so the board's notifications
   * are landing nowhere. Nothing short of a fresh connection fixes that, so
   * drop this one and build it again - once, not on every dropped packet.
   */
  _recover() {
    if (this._recovering || !this.peripheral) return;
    this._recovering = true;
    this.recoveries++;
    const uuid = this.wanted;
    const button = this.buttonNumber;
    try { this.disconnect(); } catch (_) {}
    // After disconnect - it writes its own status and would swallow this one.
    this.setStatus('connecting', 'lost track of the board - reconnecting');
    setTimeout(() => {
      this._recovering = false;
      this.connect({ uuid, buttonNumber: button });
    }, 1500);
  }

  /** Forget the last bed, so the next dart counts even if it repeats it. */
  resetRepeat() { this._lastDartHex = null; this._lastDartAt = 0; }

  /** Repeat the whole listening handshake without dropping the connection. */
  wake() {
    // All three must be live: writing to handles from a dead connection cannot
    // work, and quietly pretending it did is how boards stay "connected" and mute.
    if (!this.peripheral || !this.button || !this.throws) return false;
    this._enable(this.button, 'board', () => {
      try { this.throws.subscribe(() => {}); } catch (_) {}
      setTimeout(() => this._readBattery(), 1200);
    });
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
    // Handles from this connection die with it. Keeping them around invites
    // exactly the stale-routing fault this file just recovered from.
    this.button = null;
    this.throws = null;
    this.allServices = null;
    if (p) { try { p.disconnect(() => {}); } catch (_) {} }
    this.setStatus('idle', 'disconnected');
  }
}

module.exports = { Board, rotate, normalise };
