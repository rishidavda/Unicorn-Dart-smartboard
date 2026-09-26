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
    this.userStopped = false;   // staff switched it off: no timer may bring it back
    this._startTimer = null;    // the "board just released" pause before a scan
    this._scanRestartTimer = null;
    this._retryTimer = null;
    this._retryTicker = null;
    this._retryCount = 0;
    this._retryAt = 0;
    this._onPeripheralDisconnect = null;
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
    this.emit('status', this.statusInfo());
  }

  statusInfo() {
    return {
      state: this.status, detail: this.detail, discovered: this.discovered,
      scanSeconds: this.scanning && this.scanStartedAt ? Math.round((Date.now() - this.scanStartedAt) / 1000) : 0,
      seen: this.discovered.length,
      hint: this.troubleshoot(),
    };
  }

  /*
   * What staff should DO right now, worded for the bar, not the developer.
   * Escalates with time: a board that has just been released needs a moment
   * to broadcast again; one that never shows up is asleep (rim button or a
   * dart wakes it), or is still linked to a phone or the other PC - a board
   * talks to one device at a time.
   */
  troubleshoot() {
    const now = Date.now();
    // While a retry is pending the hub is already doing the right thing;
    // the button that always works from here is Fix board connection
    // (Connect does nothing on a scan that is already running).
    const retrying = this._retryTimer ? 'The hub keeps trying by itself. If it never gets through, take' : 'Take';
    if (this.status === 'error') {
      if (/could not connect/i.test(this.detail)) {
        return 'The board answered but refused the link - it is usually still linked to another device '
          + `(the other PC, or a phone). ${retrying} one battery out of the board for 5 seconds, put it back, then press Fix board connection.`;
      }
      if (/driver did not load|Bluetooth error|could not start scanning/i.test(this.detail)) {
        return 'Bluetooth on this PC is not responding. In Windows settings switch Bluetooth OFF, wait 5 seconds, ON - then press Fix board connection. If that fails, restart the PC.';
      }
      return null;
    }
    if (this.status === 'off') return 'Switch Bluetooth ON in Windows settings on that PC, then press Connect.';
    if (this.status === 'idle' && /dropped the link/i.test(this.detail)) {
      return 'The board dropped the link by itself - usually batteries running low, or the board out of range or asleep. '
        + (this._retryTimer
          ? 'It reconnects on its own once the board is back; if it does not, press Fix board connection.'
          : 'Check the batteries, then press Fix board connection.');
    }
    if (this.status !== 'scanning') return null;
    const secs = this.scanStartedAt ? (now - this.scanStartedAt) / 1000 : 0;
    if (this.releasedAt && now - this.releasedAt < 12000) {
      return 'Board just released - it takes a few seconds to start broadcasting again. Waiting...';
    }
    if (secs < 15) return null;
    if (this.wantedSeenAt && now - this.wantedSeenAt < 30000) {
      return 'The board IS broadcasting but the link has not gone through yet - probably still held by another device. '
        + 'The hub keeps trying by itself. If it never gets through, take one battery out for 5 seconds, put it back, then press Fix board connection.';
    }
    const seen = this.discovered.length;
    const radio = seen
      ? `Bluetooth is working (${seen} other device${seen === 1 ? '' : 's'} seen) but nothing from the board.`
      : 'No Bluetooth devices seen at all - check Bluetooth is ON in Windows settings.';
    if (secs < 75) {
      return `${radio} WAKE THE BOARD: press its rim button or throw a dart - a sleeping board does not broadcast.`;
    }
    return `${radio} Still nothing after ${Math.round(secs)} seconds. A board only talks to ONE device: close the Unicorn app on any phone, `
      + 'and check the other PC is not holding it. Then take one battery out for 5 seconds, put it back, and press Fix board connection.';
  }

  /*
   * While scanning: keep the staff card's clock ticking, and restart the
   * scan every 45 seconds - Windows' radio sometimes stops reporting adverts
   * mid-scan, and a restart is free.
   */
  _startScanTicker() {
    clearInterval(this._scanTicker);
    this._scanTicker = setInterval(() => {
      if (!this.scanning) { clearInterval(this._scanTicker); this._scanTicker = null; return; }
      const secs = Math.round((Date.now() - this.scanStartedAt) / 1000);
      if (secs > 0 && secs % 45 === 0 && this.noble) {
        try { this.noble.stopScanning(); } catch (_) {}
        clearTimeout(this._scanRestartTimer);
        this._scanRestartTimer = setTimeout(() => {
          this._scanRestartTimer = null;
          if (this.scanning) { try { this.noble.startScanning([], true); } catch (_) {} }
        }, 1500);
      }
      this.emit('status', this.statusInfo());
    }, 5000);
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
      this.emit('status', this.statusInfo());
    }
    const looksRight = /dart|joofunn|unicorn/i.test(name);
    const match = this.wanted ? (uuid === this.wanted || (addr && addr === this.wanted)) : looksRight;
    if (match) this.wantedSeenAt = Date.now();
    if (!match || this.peripheral) return;
    if (this.wanted) return this._connect(p);
    // Auto-pick waits a beat: with two boards on one PC (a supported setup),
    // grabbing the first board seen could steal the other hub's board. One
    // candidate after the grace period connects; more than one asks staff to
    // tap the right board in the console instead.
    this._autoSeen = this._autoSeen || new Map();
    this._autoSeen.set(uuid, p);
    if (this._autoTimer) return;
    this._autoTimer = setTimeout(() => {
      this._autoTimer = null;
      const seen = [...(this._autoSeen || new Map()).values()];
      this._autoSeen = new Map();
      if (this.peripheral || this.wanted) return;
      if (seen.length === 1) return this._connect(seen[0]);
      if (seen.length > 1) {
        this.setStatus('scanning', `${seen.length} dartboards in range - tap yours in the staff console`);
      }
    }, 2500);
  }

  /**
   * Start looking for the board. uuid may be blank: then we auto-pick a
   * board-looking device. `retry` marks the hub's own automatic attempt
   * after a failed or dropped link: it never overrides staff switching the
   * board off, and keeps the device list staff are looking at.
   */
  connect({ uuid, buttonNumber }, retry) {
    if (retry) {
      if (this.userStopped) return;
    } else {
      this.userStopped = false;  // any connect request overrides an old "leave it off"
      this._retryCount = 0;
    }
    this._clearRetry();
    clearTimeout(this._autoTimer);
    this._autoTimer = null;
    this._autoSeen = null;
    this.wanted = uuid ? normalise(uuid) : null;
    if (buttonNumber) this.buttonNumber = Number(buttonNumber);

    // Holding a different board than the one asked for (staff tapped another
    // device in the list): let it go and look for the new one.
    if (this.peripheral && this.wanted && !this._holds(this.wanted)) this.disconnect();
    // Already on the board? Re-run the handshake rather than starting another
    // scan. Scanning on a live connection is a good way to lose it.
    if (this.peripheral && this.button) {
      this.wake();
      return;
    }
    // Mid-handshake: the link in flight finishes (or fails and is retried)
    // by itself. A scan on top of it would outlive the connection.
    if (this.peripheral) return;
    if (!retry) this.discovered = [];

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
      if (this.userStopped || this.scanning || this.peripheral) return;
      this.scanning = true;
      this.scanStartedAt = Date.now();
      this.wantedSeenAt = null;
      this._startScanTicker();
      this.setStatus('scanning', this.wanted ? `looking for ${this.wanted}` : 'looking for any dartboard');
      try {
        noble.startScanning([], true);
      } catch (err) {
        this.scanning = false;
        this.setStatus('error', `could not start scanning: ${err.message}`);
      }
    };

    const start = () => {
      if (this.userStopped) return;
      const state = noble.state || noble._state;
      if (state === 'poweredOn') begin();
      else {
        this.setStatus('idle', `waiting for Bluetooth (currently ${state || 'unknown'})`);
        noble.once('stateChange', (s) => {
          if (s === 'poweredOn') begin();
          else this.setStatus('off', `Bluetooth is ${s} - switch it on in Windows settings`);
        });
      }
    };
    // Straight after a disconnect the radio is still letting go of the old
    // link; a scan started in that window can come up empty. Give it a beat.
    clearTimeout(this._startTimer);
    const sinceRelease = Date.now() - (this.releasedAt || 0);
    if (sinceRelease < 2500) {
      this.setStatus('scanning', 'board just released - starting the search in a moment');
      this._startTimer = setTimeout(() => { this._startTimer = null; start(); }, 2500 - sinceRelease);
    } else start();
  }

  /** Is the peripheral we hold the one this uuid (or address) names? */
  _holds(uuid) {
    const p = this.peripheral;
    return !!p && (normalise(p.uuid) === uuid || (p.address && normalise(p.address) === uuid));
  }

  /*
   * A link that failed or dropped is tried again without anyone pressing
   * anything: quickly at first (a board briefly held by a phone, or a radio
   * still letting go), then every 30 s for as long as the board keeps
   * showing up. Disconnect and Power off end it. The countdown goes into
   * the status detail so the staff card shows what is going on.
   */
  _scheduleRetry(base) {
    this._clearRetry();
    if (this.userStopped) return;
    const delays = [3000, 6000, 12000];
    const delay = this._retryCount < delays.length ? delays[this._retryCount] : 30000;
    this._retryCount++;
    this._retryAt = Date.now() + delay;
    const tick = () => {
      const secs = Math.max(1, Math.round((this._retryAt - Date.now()) / 1000));
      this.setStatus(this.status, `${base} - trying again in ${secs} s`);
    };
    this._retryTimer = setTimeout(() => {
      this._clearRetry();
      if (this.userStopped || this.peripheral) return;
      this.connect({ uuid: this.wanted, buttonNumber: this.buttonNumber }, true);
    }, delay);
    this._retryTicker = setInterval(tick, 5000);
    tick();
  }

  _clearRetry() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    clearInterval(this._retryTicker);
    this._retryTicker = null;
  }

  /*
   * Let go of a link that never came up, or came up unusable, so the next
   * scan can attempt it again. Leaving the peripheral set is how a refused
   * board was "seen" every 400 ms and never connected to. `live` says the
   * board actually accepted the link, so it has to be told to drop it.
   */
  _release(peripheral, live) {
    if (this.peripheral !== peripheral) return;
    if (this._onPeripheralDisconnect) {
      try { peripheral.removeListener('disconnect', this._onPeripheralDisconnect); } catch (_) {}
    }
    this._onPeripheralDisconnect = null;
    this.peripheral = null;
    this.button = null;
    this.throws = null;
    this.allServices = null;
    clearInterval(this._rearmTimer);
    this._rearmTimer = null;
    if (live) {
      this.releasedAt = Date.now();
      try { peripheral.disconnect(() => {}); } catch (_) {}
    }
  }

  _connect(peripheral) {
    this.peripheral = peripheral;
    this.connectedAt = Date.now();
    try { this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    clearInterval(this._scanTicker);
    this._scanTicker = null;
    clearTimeout(this._scanRestartTimer);
    this._scanRestartTimer = null;
    const name = (peripheral.advertisement && peripheral.advertisement.localName) || 'dartboard';
    this.setStatus('connecting', `${name} (${peripheral.uuid})`);

    // Batteries pulled, out of range, board gone to sleep: the link drops
    // on its own. Nobody in a pub presses anything about it, so look for
    // the board again by ourselves.
    const onDisconnect = () => {
      if (this.peripheral !== peripheral) return;
      this._release(peripheral, false);
      this.releasedAt = Date.now();
      this.setStatus('idle', 'the board dropped the link');
      this.emit('lost');
      this._retryCount = 0;
      this._scheduleRetry('the board dropped the link');
    };
    this._onPeripheralDisconnect = onDisconnect;
    peripheral.once('disconnect', onDisconnect);

    // Disconnect or Power off can land while any step below is in flight -
    // a real link takes seconds to come up. A step that finds it is no longer
    // the link we hold stops there, and a link that came up anyway is dropped:
    // a half-built connection from a released board must never score.
    const abandoned = () => {
      if (this.peripheral === peripheral) return false;
      try { peripheral.removeListener('disconnect', onDisconnect); } catch (_) {}
      try { peripheral.disconnect(() => {}); } catch (_) {}
      return true;
    };
    const failed = (detail, live, retry) => {
      this._release(peripheral, live);
      this.setStatus('error', detail);
      if (retry) this._scheduleRetry(detail);
    };

    peripheral.connect((err) => {
      if (abandoned()) return;
      if (err) {
        this.lastError = String(err.message || err);
        return failed(`could not connect to the board: ${this.lastError}`, false, true);
      }
      this.step = 'discovering services';
      // Discover everything and match ourselves: backends disagree about
      // whether a uuid filter takes the short or the 128-bit form.
      peripheral.discoverServices([], (err2, services) => {
        if (abandoned()) return;
        if (err2 || !services || !services.length) {
          this.lastError = String((err2 && err2.message) || 'no services returned');
          return failed(`could not read the board's services: ${this.lastError}`, true, true);
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
          return failed(`scoring service ${SERVICE_SCORING} not found - this device offers ${this.services.join(', ')}`, true, false);
        }

        this.step = 'discovering characteristics';
        svc.discoverCharacteristics([], (err3, chars) => {
          if (abandoned()) return;
          if (err3 || !chars || !chars.length) {
            this.lastError = String((err3 && err3.message) || 'none returned');
            return failed(`could not read the board's characteristics: ${this.lastError}`, true, true);
          }
          this.characteristics = chars.map((c) => ({ uuid: shortUuid(c.uuid), properties: c.properties || [] }));
          const button = chars.find((c) => shortUuid(c.uuid) === CHAR_BUTTON);
          const throws = chars.find((c) => shortUuid(c.uuid) === CHAR_THROWS);
          if (!button || !throws) {
            return failed(`expected ${CHAR_THROWS}/${CHAR_BUTTON}, found ${this.characteristics.map((c) => c.uuid).join(', ')}`, true, false);
          }

          this.button = button;
          this.throws = throws;
          throws.removeAllListeners('data');
          // Only the connection we currently hold may score. After Disconnect
          // or Power off a released board's characteristic can keep
          // delivering (Windows may hold the GATT session open for a while) -
          // those packets must go nowhere, not into the next group's game.
          throws.on('data', (data) => { if (this.throws === throws) this._onData(data); });

          // Order matters, and it is the opposite of what feels natural.
          // Switch the board into listening mode FIRST, then subscribe to the
          // throw notifications. Both the published protocol notes and the two
          // independent working implementations do it this way round; doing it
          // the other way leaves a board that connects, reports its rim button
          // and never reports a dart. Run the steps one at a time - WinRT
          // drops overlapping GATT operations.
          this._enable(button, name, () => {
            if (abandoned()) return;
            this.step = 'subscribing to throws';
            throws.subscribe((subErr) => {
              if (abandoned()) return;
              this.subscribeError = subErr ? String(subErr.message || subErr) : null;
              this.step = 'ready';
              this._retryCount = 0;
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
        // Not ours any more (released mid-write): no nudges to a dead handle.
        if (this.button === button) this._scheduleRearm(button);
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

  /**
   * The PC just woke from sleep: every BLE handle is suspect even when the
   * connection still claims to be alive, and Windows' radio needs a moment
   * before it will scan again. Tear down and rebuild from scratch - this is
   * what closing and reopening the app used to do by hand.
   */
  resumeRecover(reason) {
    if (this._recovering) return false;
    if (this.userStopped) return false;  // staff switched it off on purpose - stay off
    if (!this.peripheral && !this.wanted && this.status !== 'connected') return false;
    this._recovering = true;
    this.recoveries++;
    const uuid = this.wanted;
    const button = this.buttonNumber;
    try { this.disconnect(); } catch (_) {}
    this.setStatus('connecting', reason || 'PC woke up - reconnecting to the board');
    // The radio can take a while to come back after resume: try at 4s, and
    // if the attempt died (error / bluetooth off), again at ~20s and ~50s.
    const attempt = (retriesLeft) => {
      this._recovering = false;
      this.connect({ uuid, buttonNumber: button });
      if (retriesLeft > 0) {
        setTimeout(() => {
          if ((this.status === 'error' || this.status === 'off') && !this.userStopped) {
            attempt(retriesLeft - 1);
          }
        }, 30000 / retriesLeft);
      }
    };
    setTimeout(() => attempt(2), 4000);
    return true;
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
    clearTimeout(this._startTimer);
    this._startTimer = null;
    this._clearRetry();
    clearTimeout(this._autoTimer);
    this._autoTimer = null;
    this._autoSeen = null;
    clearInterval(this._scanTicker);
    this._scanTicker = null;
    clearTimeout(this._scanRestartTimer);
    this._scanRestartTimer = null;
    const p = this.peripheral;
    if (p) this.releasedAt = Date.now();   // a real board needs a moment before it broadcasts again
    if (p && this._onPeripheralDisconnect) {
      try { p.removeListener('disconnect', this._onPeripheralDisconnect); } catch (_) {}
    }
    this._onPeripheralDisconnect = null;
    this.peripheral = null;
    clearInterval(this._rearmTimer);
    this._rearmTimer = null;
    try { if (this.noble) this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    if (this.button) { try { this.button.write(Buffer.from([0x02]), true, () => {}); } catch (_) {} }
    if (this.throws) { try { this.throws.removeAllListeners('data'); } catch (_) {} }
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
