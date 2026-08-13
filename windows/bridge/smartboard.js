const debug = require('debug')('kcapp-smartboard:board');
const noble = require('@stoprocent/noble');

/** List containing all numbers on the board. Used to shift scores when board is rotated */
const BOARD = [15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5, 20, 1, 18, 4, 13, 6, 10];
/** Service containing board characteristics */
const SERVICE_SCORING = "fff0";
/** Characteristic to control the button */
const CHARACTERISTIC_BUTTON = "fff2";
/** Characteristic to subscribe to throw notifications */
const CHARACTERISTIC_THROW_NOTIFICATIONS = "fff1";

/**
 * Normalize a board identifier for comparison: lowercase, strip colons/dashes.
 * Lets the venue config hold either "c4be84123456" or "C4:BE:84:12:34:56".
 */
function normalizeId(id) {
  return (id || "").toString().toLowerCase().replace(/[:-]/g, "");
}

/**
 * Shift the given number depending on board rotation
 * @param {int} num - Number reported by board
 * @param {int} button - Number closest to smartboard button
 */
function shift(num, button) {
  if (num == 25) {
    return num; // No need to shift Bullseye
  }
  let index = BOARD.indexOf(num) + BOARD.indexOf(button);
  if (index >= BOARD.length) {
    index = index - BOARD.length;
  }
  return BOARD[index];
}

/**
 * Start scanning for the board. Unlike the original driver this waits for the
 * Bluetooth adapter to report poweredOn before scanning — starting a scan
 * earlier throws and killed the old bridge when Bluetooth was off.
 */
exports.startScan = () => {
  if (noble._state === 'poweredOn' || noble.state === 'poweredOn') {
    debug("Started scanning for board");
    noble.startScanning([], true);
    return;
  }
  debug(`Bluetooth adapter not ready (state: ${noble.state}), waiting for poweredOn...`);
  noble.once('stateChange', (state) => {
    if (state === 'poweredOn') {
      debug("Adapter powered on, started scanning for board");
      noble.startScanning([], true);
    } else {
      debug(`Bluetooth adapter state is '${state}' — cannot scan. Is Bluetooth switched on in Windows settings?`);
    }
  });
}

/**
 * Connect to the dart board
 * Adds a callback to the discover event and checks all peripherals found
 * until one matches the configured UUID / MAC address.
 *
 * @param {string} uuid - UUID (or MAC) of smartboard to connect to
 * @param {function} callback - Callback once the board is found
 */
exports.connect = (uuid, callback) => {
  const wanted = normalizeId(uuid);
  const seen = new Set();
  this.discoverCallback = (peripheral) => {
    const pid = normalizeId(peripheral.uuid);
    const paddr = normalizeId(peripheral.address);
    if (!seen.has(pid)) {
      seen.add(pid);
      debug(`Discovered device uuid=${peripheral.uuid} address=${peripheral.address || "?"} name=${peripheral.advertisement && peripheral.advertisement.localName || "?"}`);
    }
    if (pid === wanted || (paddr && paddr === wanted)) {
      callback(peripheral);
      debug("Found device, stopped scanning");
      noble.stopScanning();
      this.peripheral = peripheral;
    }
  };
  noble.on('discover', this.discoverCallback);
}

/**
 * Initialize the dart board, by setting up notification listeners
 * for darts thrown, and button presses
 *
 * @param {object} - Peripheral object to initialize
 * @param {int} - Number next to the board button
 * @param {function} - Callback when dart is thrown
 * @param {function} - Callback when button is pressed
 */
exports.initialize = (peripheral, buttonNumber, throwCallback, playerChangeCallback) => {
  peripheral.connect((error) => {
    if (error) {
      debug(`ERROR: ${error}`);
    }
    debug(`Connected to ${peripheral.advertisement.localName} (${peripheral.uuid})`);

    peripheral.discoverServices([SERVICE_SCORING], (error, services) => {
      if (error) {
        debug(`ERROR: ${error}`);
      }
      if (!services || !services[0]) {
        debug(`ERROR: scoring service ${SERVICE_SCORING} not found — is this really the smartboard?`);
        return;
      }

      const scoringService = services[0];
      scoringService.discoverCharacteristics([CHARACTERISTIC_BUTTON, CHARACTERISTIC_THROW_NOTIFICATIONS], (error, characteristics) => {
        if (error) {
          debug(`ERROR: ${error}`);
        }
        // Select by uuid rather than position — noble returns handle order,
        // which is not guaranteed to match the filter order
        const buttonCharacteristic = characteristics.find((c) => c.uuid === CHARACTERISTIC_BUTTON);
        const throwNotifyCharacteristic = characteristics.find((c) => c.uuid === CHARACTERISTIC_THROW_NOTIFICATIONS);
        if (!buttonCharacteristic || !throwNotifyCharacteristic) {
          debug(`ERROR: expected characteristics ${CHARACTERISTIC_BUTTON}/${CHARACTERISTIC_THROW_NOTIFICATIONS} not found`);
          return;
        }

        // To enable listening for notifications, we first need to set the button as high (0x03)
        buttonCharacteristic.write(Buffer.from([0x03]), true, (error) => {
          if (error) {
            debug(`ERROR: ${error}`);
          }
          debug('Enabled listening');
        });
        this.buttonCharacteristic = buttonCharacteristic;

        throwNotifyCharacteristic.subscribe((error) => {
          if (error) {
            debug(`ERROR: ${error}`);
          }
          debug('Subscribed to throw notifications!');
        });

        throwNotifyCharacteristic.on('data', (data, isNotification) => {
          const rawValue = data.readUInt8(0);
          const dart = {
            score: shift(rawValue, buttonNumber),
            multiplier: data.readUInt8(1)
          };
          if (dart.multiplier == 170 && rawValue == 85) {
            playerChangeCallback();
          } else {
            throwCallback(dart);
          }
        });
        this.throwNotifyCharacteristic = throwNotifyCharacteristic;
      });
    });
  });
}

/**
 * Disconnect from the connected peripheral
 * @param {object} - Connected peripheral
 * @param {function} - Callback once disconnected
 */
exports.disconnect = (peripheral, callback) => {
  debug(`Removing 'discover' callback`);
  if (this.discoverCallback) {
    noble.removeListener('discover', this.discoverCallback);
  }

  if (this.throwNotifyCharacteristic) {
    this.throwNotifyCharacteristic.unsubscribe((error) => {
      if (error) {
        debug(`ERROR: ${error}`);
      }
      debug(`Unsubscribed from throw notifications`);
    });
  }
  if (this.buttonCharacteristic) {
    this.buttonCharacteristic.write(Buffer.from([0x02]), true, (error) => {
      if (error) {
        debug(`ERROR: ${error}`);
      }
      debug(`Disabled listening on characteristic ${CHARACTERISTIC_BUTTON}`);
      peripheral.disconnect((error) => {
        if (error) {
          debug(`ERROR: ${error}`);
        }
        debug(`Disconnected from ${peripheral.advertisement.localName}`);
        if (callback) {
          callback();
        }
      });
    });
  } else if (peripheral && peripheral.disconnect) {
    // Board vanished before initialize finished — still complete the callback
    // so the bridge's connected-flag gets reset
    peripheral.disconnect(() => {
      if (callback) {
        callback();
      }
    });
  } else if (callback) {
    callback();
  }
}

/**
 * Subscribe to battery level changes
 * @param {function} - Callback when battery level changes
 */
exports.subscribeToBatteryLevel = (changeCallback) => {
  this.peripheral.discoverServices(['180f'], (error, services) => {
    if (error || !services || !services[0]) {
      debug(`ERROR: battery service not found`);
      return;
    }
    services[0].discoverCharacteristics(['2a19'], (error, characteristics) => {
      if (error || !characteristics || !characteristics[0]) {
        debug(`ERROR: battery characteristic not found`);
        return;
      }
      const batteryLevelCharacteristic = characteristics[0];
      batteryLevelCharacteristic.on('data', (data, isNotification) => {
        const level = data.readUInt8(0);
        debug(`Battery level is ${level}%`);
        changeCallback(level);
      });
      batteryLevelCharacteristic.subscribe((error) => {
        if (error) {
          debug(`ERROR: ${error}`);
        }
        debug(`Subscribed to battery level notifications`);
      });
    });
  });
}

function interrupt() {
  if (this.peripheral) {
    debug("Caught interrupt signal, disconnecting...");
    exports.disconnect(this.peripheral, () => {
      process.exit();
    });
    // Give the board 3 seconds to disconnect before we die
    setTimeout(() => {
      process.exit();
    }, 3000);
  } else {
    process.exit();
  }
}

/**
 * Configure the smartboard module
 */
module.exports = () => {
  process.on('SIGINT', interrupt.bind(this));
  return this;
};
