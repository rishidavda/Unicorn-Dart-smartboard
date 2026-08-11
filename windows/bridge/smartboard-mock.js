const debug = require('debug')('kcapp-smartboard-mock:board');
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
 });

const waitForUserInput = (throwCallback) => {
  rl.question("Dart: ", (dart) => {
    rl.pause();
    if (dart === "exit"){
        rl.close();
        process.exit();
    } else {
      const score = dart.split("-")[0];
      const multiplier = dart.split("-")[1] || 1  ;
      throwCallback({ score: parseInt(score), multiplier: parseInt(multiplier) });

      waitForUserInput(throwCallback);
    }
  });
}

/** Service containing board characteristics */
const SERVICE_SCORING = "fff0";
/** Characteristic to control the button */
const CHARACTERISTIC_BUTTON = "fff2";
/** Characteristic to subscribe to throw notifications */
const CHARACTERISTIC_THROW_NOTIFICATIONS = "fff1";

exports.startScan = () => {
  debug("Started scanning")
}

exports.connect = (uuid, callback) => {
  this.discoverCallback = (peripheral) => {
    if (peripheral.uuid === uuid) {
      callback(peripheral);
      debug("Found device, stopped scanning");
      this.peripheral = peripheral;
    }
  };
  this.discoverCallback({ uuid: uuid, advertisement: { localName: 'joofunn Dartboard' }} );
}

exports.initialize = (peripheral, buttonNumber, throwCallback, playerChangeCallback) => {
  debug(`Connected to ${peripheral.advertisement.localName} (${peripheral.uuid})`);
  debug('Enabled listening');
  debug('Subscribed to throw noftifications!');

  debug(`Enter darts to send:`);
  waitForUserInput(throwCallback);
}

exports.disconnect = (peripheral, callback) => {
    debug(`Removing 'discover' callback`);
    debug(`Unsubscribed from throw notifications`);
    debug(`Disabled listening on characteristic ${CHARACTERISTIC_BUTTON}`);
    debug(`Disconnected from ${peripheral.advertisement.localName}`);
    callback();
}

/**
 * Configure the smartboard module
 */
module.exports = () => {
  debug(`Starting smartboard-mock!`);
  return this;
};
