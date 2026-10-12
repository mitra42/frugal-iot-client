// The flasher's hold on the serial port. WebSerial refuses a second open of the same port, so the
// element is the only thing that can close it - and a connect that fails is exactly when it must.
import './setup.js';
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let ports; // what a fake Transport did, in order

// A Transport that records rather than talking to a board. `fail` is thrown by main() after the
// port is open, which is what a board that will not sync looks like.
function fakeEsptool(fail) {
  return async () => ({
    Transport: class {
      constructor(port) { this.port = port; ports.push('opened'); }
      async disconnect() { ports.push('closed'); }
    },
    ESPLoader: class {
      constructor(o) { this.transport = o.transport; this.chip = {CHIP_NAME: 'ESP8266', BOOTLOADER_FLASH_OFFSET: 0}; }
      async main() { if (fail) throw new Error(fail); return 'ESP8266EX'; }
      async readFlashId() { return 0x16 << 16; } // 4MB, so detectFlashSize is not called
    },
  });
}
function flashElement(fail) {
  const flash = document.createElement('mqtt-flash');
  document.body.append(flash);
  flash.esptoolImport = fakeEsptool(fail);
  flash.state.boards = {wholeImageChips: ['ESP8266']}; // stands in for the fetch of boards.json
  return flash;
}
const connectButton = (flash) => [...flash.shadowRoot.querySelectorAll('button')]
  .find((b) => b.textContent === 'Connect board');

before(async () => { await import('../flash.js'); });
beforeEach(() => {
  ports = [];
  // One SerialPort object for the run, as WebSerial hands back for the same device
  const port = {};
  Object.defineProperty(navigator, 'serial',
    {value: {requestPort: async () => port}, configurable: true});
});
afterEach(() => { delete navigator.serial; });

describe('connecting to a board', () => {
  test('a failure still closes the port, so Connect can be clicked again', async () => {
    // It could not before: the transport was recorded only after main() succeeded, so the release
    // on the way out had nothing to release and the retry met "The port is already open"
    const flash = flashElement('Failed to connect to ESP32: Wrong boot mode detected');
    connectButton(flash).click();
    await flash.state.connectDone;
    assert.deepEqual(ports, ['opened', 'closed']);
    assert.match(flash.state.log.join('\n'), /Wrong boot mode/, 'the reason should be logged');
    assert.equal(flash.state.transport, null, 'it should not still hold a transport');
    assert.ok(!flash.state.busy, 'the button should be live again');
    flash.remove();
  });

  test('a second try closes the first attempt before opening again', async () => {
    const flash = flashElement('Failed to connect to ESP32');
    connectButton(flash).click();
    await flash.state.connectDone;
    connectButton(flash).click();
    await flash.state.connectDone;
    assert.deepEqual(ports, ['opened', 'closed', 'opened', 'closed']);
    flash.remove();
  });

  test('a board that answers leaves the port held, since flashing needs it', async () => {
    const flash = flashElement(null);
    connectButton(flash).click();
    await flash.state.connectDone;
    assert.deepEqual(ports, ['opened'], 'it should not have let go');
    assert.equal(flash.state.device.chipName, 'ESP8266');
    flash.remove();
  });
});

/*
 * The monitor across a deep sleep. A board on native USB takes the port with it when it sleeps, so
 * the stream ends and the port cannot be opened again until it wakes - which is the normal case for
 * a frugal-iot node, not a fault.
 */
describe('the serial monitor', () => {
  // Each entry is one open(): {fail} refuses it, otherwise a stream of `chunks` that then ends the
  // way `end` says. No end at all leaves the read pending, as a live board does between lines.
  function fakePort(attempts, info) {
    const port = {opened: 0, closed: 0, signals: 0, readable: null};
    if (info) port.getInfo = () => info;
    port.open = async () => {
      const a = attempts[port.opened++] || {fail: 'The device has been lost.'};
      if (a.fail) throw new Error(a.fail);
      port.readable = new ReadableStream({
        start(c) {
          (a.chunks || []).forEach((t) => c.enqueue(new TextEncoder().encode(t)));
          if (a.end === 'error') c.error(new Error('The device has been lost.'));
          if (a.end === 'done') c.close();
        },
      });
    };
    port.close = async () => { port.closed++; port.readable = null; };
    port.setSignals = async () => { port.signals++; };
    return port;
  }
  function monitoring(attempts, granted, info) {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.state.monitorRetryMs = 5;  // a second per retry is right for a board, not for a test
    flash.state.port = fakePort(attempts, info);
    if (granted) Object.defineProperty(navigator, 'serial',
      {value: {getPorts: async () => granted()}, configurable: true});
    flash.monitorStart();
    return flash;
  }
  const ESP32 = {usbVendorId: 0x303a, usbProductId: 0x1001};
  const log = (flash) => flash.state.log.join('\n');
  // Stops the monitor before failing: a retry loop left running holds the test runner open
  async function until(flash, test, what) {
    for (let i = 0; i < 400 && !test(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!test()) { await flash.monitorStop(); assert.fail(what); }
  }

  test('picks the port up again when the board wakes, with no click', async () => {
    const flash = monitoring([
      {chunks: ['before sleep\n'], end: 'error'},  // the port goes as the board sleeps
      {fail: 'The device has been lost.'},         // still asleep
      {chunks: ['awake again\n']},                 // back, and talking
    ]);
    await until(flash, () => log(flash).includes('awake again'), 'the monitor did not come back');
    assert.match(log(flash), /port gone/, 'it should say why it went quiet');
    assert.match(log(flash), /---- port back ----/);
    await flash.monitorStop();
    assert.equal(flash.state.port.opened, 3);
    flash.remove();
  });

  test('follows the device to the new port it comes back as', async () => {
    // Chrome does not revive a SerialPort whose device went away: a replugged board is a new object,
    // and reopening the old one fails for ever. This is what a reset or a replug actually looks like.
    const replugged = fakePort([{chunks: ['back from the dead\n']}], ESP32);
    const flash = monitoring([{chunks: ['before\n'], end: 'error'}], () => [replugged], ESP32);
    await until(flash, () => log(flash).includes('back from the dead'), 'it did not find the new port');
    await flash.monitorStop();
    assert.equal(flash.state.port, replugged, 'and Connect should now use the live one');
    flash.remove();
  });

  test('does not take a different device just because one is plugged in', async () => {
    const other = fakePort([{chunks: ['not the board you want\n']}],
      {usbVendorId: 0x1a86, usbProductId: 0x7523}); // a CH340, not our ESP32
    const flash = monitoring([{chunks: ['before\n'], end: 'error'}], () => [other], ESP32);
    await until(flash, () => log(flash).includes('port gone'), 'it should be waiting');
    await new Promise((r) => setTimeout(r, 40));
    await flash.monitorStop();
    assert.ok(!log(flash).includes('not the board you want'), 'it monitored the wrong device');
    flash.remove();
  });

  test('never picks up a Mac\u2019s Bluetooth or debug-console port', async () => {
    // Both are always on offer and neither is a board. They have no usbVendorId, which is what rules
    // them out - silently monitoring one of those is worse than not reconnecting at all.
    const bluetooth = fakePort([{chunks: ['bluetooth noise\n']}], {});
    const debugConsole = fakePort([{chunks: ['debug console noise\n']}], {});
    const flash = monitoring([{chunks: ['before\n'], end: 'error'}],
      () => [bluetooth, debugConsole], ESP32);
    await until(flash, () => log(flash).includes('port gone'), 'it should be waiting');
    await new Promise((r) => setTimeout(r, 40)); // several more attempts, with both on offer
    await flash.monitorStop();
    assert.equal(bluetooth.opened, 0, 'it opened the Bluetooth port');
    assert.equal(debugConsole.opened, 0, 'it opened the debug console');
    flash.remove();
  });

  test('retries only the port the user picked when that port is not a USB device', async () => {
    // Nothing to match on, so there is no safe way to guess a replacement
    const other = fakePort([{chunks: ['someone else\n']}], ESP32);
    const flash = monitoring([{chunks: ['before\n'], end: 'error'}], () => [other], {});
    await until(flash, () => log(flash).includes('port gone'), 'it should be waiting');
    await new Promise((r) => setTimeout(r, 40));
    await flash.monitorStop();
    assert.equal(other.opened, 0, 'it wandered off to another device');
    flash.remove();
  });

  test('does not reset the board it reconnects to', async () => {
    // The first pass pulses RTS to catch the boot log from the start; doing that on a reconnect
    // would restart a board that had just woken from sleep
    const flash = monitoring([
      {chunks: ['boot\n'], end: 'error'},
      {chunks: ['awake\n']},
    ]);
    await until(flash, () => log(flash).includes('awake'), 'no reconnect');
    const afterFirst = flash.state.port.signals;
    await flash.monitorStop();
    assert.ok(afterFirst > 0, 'the first pass should have reset the board');
    assert.equal(flash.state.port.signals, afterFirst, 'the reconnect should not have');
    flash.remove();
  });

  test('says the port is gone once, not once per attempt', async () => {
    const flash = monitoring([{fail: 'No such port'}]);
    await until(flash, () => log(flash).includes('could not open port'), 'nothing was said');
    await new Promise((r) => setTimeout(r, 40)); // several more attempts
    await flash.monitorStop();
    assert.equal(log(flash).match(/could not open port/g).length, 1);
    assert.ok(flash.state.port.opened > 1, 'it should have kept trying');
    flash.remove();
  });

  test('Stop ends it while it is waiting for a port that never comes back', async () => {
    const flash = monitoring([{fail: 'No such port'}]);
    await until(flash, () => flash.state.port.opened > 1, 'it should be retrying');
    await flash.monitorStop();
    assert.equal(flash.state.monitoring, false);
    const opened = flash.state.port.opened;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(flash.state.port.opened, opened, 'it should have stopped trying');
    assert.match(log(flash), /---- monitor stopped ----/);
    flash.remove();
  });
});

/*
 * Provision vs app-only, against real partition tables from base/. A board is only re-laid out when
 * its app slot is somewhere else - a different size is checked against the image instead, since
 * provisioning erases the board's configuration.
 */
describe('flashing over a board that is already laid out', () => {
  const readBase = (p) => new Uint8Array(readFileSync(new URL(`../base/${p}`, import.meta.url)));
  const boards = JSON.parse(readFileSync(new URL('../base/boards.json', import.meta.url), 'utf8'));
  let writes;
  // An 8MB S3 whose flash holds `table` at 0x8000, a bootloader, and an erased filesystem
  function fakeS3(table) {
    return async () => ({
      Transport: class { async disconnect() {} },
      ESPLoader: class {
        constructor() { this.chip = {CHIP_NAME: 'ESP32-S3', BOOTLOADER_FLASH_OFFSET: 0, IMAGE_CHIP_ID: 9}; }
        async main() { return 'ESP32-S3'; }
        async readFlashId() { return 0x17 << 16; }
        async readFlash(offset, length) {
          const block = new Uint8Array(length).fill(0xff);
          if (offset === 0) block[0] = 0xe9;
          if (offset === 0x8000) block.set(table.subarray(0, length));
          return block;
        }
        async writeFlash({fileArray}) { writes.push(...fileArray.map((f) => f.address)); }
        async after() {}
      },
    });
  }
  async function connected(table) {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.esptoolImport = fakeS3(table);
    flash.state.boards = boards;
    flash.monitorStart = () => {};
    await flash.connectAndInspect({});
    return flash;
  }
  const image = (size) => { const b = new Uint8Array(size); b[0] = 0xe9; b[12] = 9; return b; };
  let realFetch;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const bytes = readBase(String(url).replace(/^\.\/base\//, '').replace(/\?.*$/, ''));
      return {ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
    };
  });
  after(() => { globalThis.fetch = realFetch; });
  beforeEach(() => { writes = []; });

  test('a board on a bigger app slot than our scheme is updated app-only, keeping its config', async () => {
    const flash = await connected(readBase('partitions/default_8MB.bin'));
    assert.equal(flash.state.device.provision, false, flash.state.log.join('\n'));
    flash.state.app = {name: 'firmware.bin', bytes: image(0x200000)}; // too big for min_spiffs, fits here
    await flash.flash();
    assert.deepEqual(writes, [0xe000, 0x10000], 'otadata reset, then the app - nothing else');
    flash.remove();
  });

  test('an app-only write resets otadata where the board says, so it boots app0 and not an older app1', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    flash.state.app = {name: 'firmware.bin', bytes: image(0x1000)};
    await flash.flash();
    assert.ok(writes.includes(0xe000), 'otadata should have been written');
    flash.remove();
  });

  test('an image too big for the board is refused, not provisioned behind the user’s back', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    flash.state.app = {name: 'firmware.bin', bytes: image(0x200000)};
    await assert.rejects(flash.flash(), /larger than the 1\.88MB app partition on this board - "Provision instead"/);
    assert.deepEqual(writes, []);
    flash.remove();
  });

  test('a board whose app slot is somewhere else is provisioned', async () => {
    const table = readBase('partitions/min_spiffs.bin').slice();
    new DataView(table.buffer).setUint32(2 * 32 + 4, 0x20000, true); // app0 is the third record
    const flash = await connected(table);
    assert.equal(flash.state.device.provision, true);
    assert.deepEqual(flash.state.device.provisionReasons, ['app partition not at 0x10000']);
    flash.remove();
  });
});
