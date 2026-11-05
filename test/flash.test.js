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

describe('an ESP8266', () => {
  test('its flash ID is read with the ESP8266\u2019s own SPI registers', async () => {
    const flash = document.createElement('mqtt-flash');
    const {ESPLoader} = await flash.esptoolImport();
    const {ESP8266ROM} = await import('esptool-js/lib/targets/esp8266.js');
    const loader = new ESPLoader({transport: {getInfo: () => 'fake'}, baudrate: 115200, terminal: {clean() {}, writeLine() {}, write() {}}});
    loader.chip = new ESP8266ROM();
    const writes = [];
    loader.readReg = async () => 0;
    loader.writeReg = async (a, v) => { writes.push([a, v]); };
    await loader.readFlashId();
    const base = loader.chip.SPI_REG_BASE;
    // The ESP32 path writes the data lengths at base + 0 - on an ESP8266 that is the command register
    assert.deepEqual(writes.filter(([a]) => a === base).map(([, v]) => v), [1 << 18], 'only the "go" bit in SPI_CMD');
    assert.ok(writes.some(([a, v]) => a === base + loader.chip.SPI_USR1_OFFS && v === (23 << 8)), '24 bits read back, set in USR1');
  });

  test('a flash chip that does not answer is refused, not left to a confirmation box', async () => {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.state.boards = {wholeImageChips: ['ESP8266']};
    flash.esptoolImport = async () => ({
      Transport: class { async disconnect() {} },
      ESPLoader: class {
        constructor() { this.chip = {CHIP_NAME: 'ESP8266', BOOTLOADER_FLASH_OFFSET: 0}; }
        async main() { return 'ESP8266EX'; }
        async readFlashId() { return 0; }
        async detectFlashSize() { return undefined; }
      },
    });
    await flash.connectAndInspect({});
    assert.match(flash.state.device.refusal, /flash chip did not answer/);
    flash.state.app = {name: 'firmware.bin', bytes: new Uint8Array([0xe9, 0, 0, 0])};
    assert.equal(flash.ready, false, 'Flash should not be offered');
    flash.remove();
  });
});

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

describe('restarting an S2 on native USB after a flash', () => {
  const chip = {RTC_CNTL_WDT_WKEY: 0x50d83aa1, RTC_CNTL_WDTWPROTECT_REG: 0xac, RTC_CNTL_WDTCONFIG0_REG: 0x94,
    RTC_CNTL_WDTCONFIG1_REG: 0x98, GPIO_STRAP_REG: 0x38, GPIO_STRAP_SPI_BOOT_MASK: 1 << 3,
    RTC_CNTL_OPTION1_REG: 0x128, RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK: 1};
  function loader({otg = true, strap = 0, forced = 0} = {}) {
    const regs = {[chip.GPIO_STRAP_REG]: strap, [chip.RTC_CNTL_OPTION1_REG]: forced};
    const writes = [];
    return {chip, writes, async usesUsbOtg() { return otg; }, async readReg(a) { return regs[a]; },
      async writeReg(a, v) { writes.push([a, v]); }};
  }
  function element() {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    return flash;
  }

  test('a board put in its loader by holding IO0 is restarted by its watchdog, armed then locked', async () => {
    const flash = element();
    const l = loader();
    assert.equal(await flash.usbOtgReset(l), true);
    assert.deepEqual(l.writes.map(([a]) => a), [0xac, 0x98, 0x94, 0xac]);
    assert.equal(l.writes[0][1], chip.RTC_CNTL_WDT_WKEY, 'unlocked first');
    assert.equal(l.writes[3][1], 0, 'locked again');
    flash.remove();
  });

  test('a loader entered from the app over USB is not restarted - it would come back to the loader', async () => {
    const flash = element();
    const l = loader({forced: 1});
    assert.equal(await flash.usbOtgReset(l), false);
    assert.deepEqual(l.writes, []);
    assert.match(flash.state.log.join('\n'), /RESET button/);
    flash.remove();
  });

  test('a board on a USB-serial chip is left to the monitor\u2019s DTR/RTS reset', async () => {
    const flash = element();
    const l = loader({otg: false});
    assert.equal(await flash.usbOtgReset(l), false);
    assert.deepEqual(l.writes, []);
    assert.doesNotMatch(flash.state.log.join('\n'), /RESET button/);
    flash.remove();
  });

  test('the monitor looks for the app\u2019s own USB device, which is another product from the loader\u2019s', async () => {
    const flash = element();
    const loaderPort = {getInfo: () => ({usbVendorId: 0x303a, usbProductId: 0x2})};
    const appPort = {getInfo: () => ({usbVendorId: 0x303a, usbProductId: 0x80c2})};
    const otherVendor = {getInfo: () => ({usbVendorId: 0x1a86, usbProductId: 0x7523})};
    Object.defineProperty(navigator, 'serial', {value: {getPorts: async () => [appPort, otherVendor]}, configurable: true});
    assert.deepEqual(await flash.monitorCandidates(loaderPort), [loaderPort], 'not before a restart');
    flash.state.stalePort = loaderPort;
    assert.deepEqual(await flash.monitorCandidates(loaderPort), [appPort, loaderPort]);
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

  test('after a watchdog restart, finds the app\u2019s device even though the loader\u2019s port opened first', async () => {
    // The loader's port is still there for a moment after the watchdog is set, and opening it must not end the search
    const app = fakePort([{chunks: ['app booting\n']}], {usbVendorId: 0x303a, usbProductId: 0x80c2});
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.state.monitorRetryMs = 5;
    flash.state.port = fakePort([{chunks: [], end: 'error'}], {usbVendorId: 0x303a, usbProductId: 0x2});
    flash.state.stalePort = flash.state.port;
    let searches = 0; // the app's device enumerates only after the restart
    Object.defineProperty(navigator, 'serial', {value: {getPorts: async () => (searches++ ? [app] : [])}, configurable: true});
    flash.monitorStart();
    await until(flash, () => log(flash).includes('app booting'), 'it did not move to the app\u2019s device');
    await flash.monitorStop();
    assert.equal(flash.state.port, app);
    assert.equal(flash.state.stalePort, null, 'found, so Monitor need not ask for a port');
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

  test('starting the monitor, or reconnecting it, never resets the board', async () => {
    // It used to pulse RTS on the first pass to catch the boot log, which restarted a board that was
    // in the middle of something. Resetting is its own button now.
    const flash = monitoring([
      {chunks: ['boot\n'], end: 'error'},
      {chunks: ['awake\n']},
    ]);
    await until(flash, () => log(flash).includes('awake'), 'no reconnect');
    await flash.monitorStop();
    assert.equal(flash.state.port.signals, 0);
    flash.remove();
  });

  test('Reset board resets it, and only while the monitor is running', async () => {
    const flash = monitoring([{chunks: ['running\n']}]);
    await until(flash, () => flash.state.monitorPort, 'the monitor did not open');
    flash.onReset();
    await until(flash, () => flash.state.port.signals > 0, 'it did not reset');
    await flash.monitorStop();
    const after = flash.state.port.signals;
    flash.onReset(); // nothing is listening, so there is nothing to reset
    assert.equal(flash.state.port.signals, after);
    flash.remove();
  });

  test('Clear log empties the log, and Copy log puts what is there on the clipboard', async () => {
    const flash = monitoring([{chunks: ['one\ntwo\n']}]);
    await until(flash, () => log(flash).includes('two'), 'nothing was logged');
    const button = (name) => flash.shadowRoot.querySelector(`button[aria-label="${name}"]`);
    let copied = null;
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (t) => { copied = t; }}, configurable: true});
    const shown = log(flash);
    button('Copy log').click();
    assert.equal(copied, shown);
    button('Clear log').click();
    assert.equal(flash.state.log.length, 0);
    assert.equal(flash.state.elements.log.textContent, '', 'the displayed log should be cleared too');
    await flash.monitorStop();
    flash.remove();
    delete navigator.clipboard;
  });

  test('Copy log with nothing in the log copies nothing', () => {
    const flash = monitoring([]);
    let copied = null;
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (t) => { copied = t; }}, configurable: true});
    flash.state.log = [];
    flash.onCopyLog();
    assert.equal(copied, null);
    flash.remove();
    delete navigator.clipboard;
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
  let afterModes;
  let loaderOptions;
  // An 8MB S3 whose flash holds `table` at 0x8000, a bootloader, and an erased filesystem
  function fakeS3(table, capacity = 0x17) {
    return async () => ({
      Transport: class { async disconnect() {} },
      ESPLoader: class {
        constructor(options) { loaderOptions = options; this.chip = {CHIP_NAME: 'ESP32-S3', BOOTLOADER_FLASH_OFFSET: 0, IMAGE_CHIP_ID: 9}; }
        async main() { return 'ESP32-S3'; }
        async readFlashId() { return capacity << 16; }
        async readFlash(offset, length) {
          const block = new Uint8Array(length).fill(0xff);
          if (offset === 0) block[0] = 0xe9;
          if (offset === 0x8000) block.set(table.subarray(0, length));
          return block;
        }
        async writeFlash({fileArray}) { writes.push(...fileArray.map((f) => f.address)); }
        async after(mode) { afterModes.push(mode); }
      },
    });
  }
  async function connected(table, capacity) {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.esptoolImport = fakeS3(table, capacity);
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
  beforeEach(() => { writes = []; afterModes = []; });

  test('a board on a bigger app slot than our scheme is updated app-only, keeping its config', async () => {
    const flash = await connected(readBase('partitions/default_8MB.bin'));
    assert.equal(flash.state.device.provision, false, flash.state.log.join('\n'));
    flash.state.app = {name: 'firmware.bin', bytes: image(0x200000)}; // too big for min_spiffs, fits here
    await flash.flash();
    assert.deepEqual(writes, [0xe000, 0x10000], 'otadata reset, then the app - nothing else');
    flash.remove();
  });

  test('a flash over a configured board says its settings were kept, and a provision does not', async () => {
    const kept = await connected(readBase('partitions/default_8MB.bin'));
    kept.state.app = {name: 'firmware.bin', bytes: image(0x200000)};
    kept.state.device.hasConfig = true; // the fake board's filesystem is blank, which is the other case
    await kept.flash();
    assert.equal(kept.state.keptConfig, true);
    assert.equal(kept.state.applyAfterHello, false);
    assert.match(kept.state.log.join('\n'), /already configured - its settings were kept/);
    kept.state.node = {nodeid: 'n', otakey: 'k'};
    kept.configRender();
    assert.match(kept.state.elements.config.textContent, /already configured/);
    kept.state.apply = {rows: [], problems: [], status: null}; // an apply has run: the rows speak now
    kept.configRender();
    assert.doesNotMatch(kept.state.elements.config.textContent, /already configured/);
    kept.remove();
    const table = readBase('partitions/min_spiffs.bin').slice();
    new DataView(table.buffer).setUint32(2 * 32 + 4, 0x20000, true); // forces a provision
    const fresh = await connected(table);
    fresh.state.app = {name: 'firmware.bin', bytes: image(0x1000)};
    await fresh.flash();
    assert.equal(fresh.state.keptConfig, false);
    assert.equal(fresh.state.applyAfterHello, true);
    assert.ok(!fresh.state.log.join('\n').includes('settings were kept'));
    fresh.remove();
  });

  test('an app-only write resets otadata where the board says, so it boots app0 and not an older app1', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    flash.state.app = {name: 'firmware.bin', bytes: image(0x1000)};
    await flash.flash();
    assert.ok(writes.includes(0xe000), 'otadata should have been written');
    flash.remove();
  });

  test('a connect that fails to sync is tried once, and the error is the library\u2019s own', async () => {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.monitorStart = () => {};
    let mains = 0;
    const real = fakeS3(readBase('partitions/min_spiffs.bin'));
    flash.esptoolImport = async () => {
      const lib = await real();
      // esptool-js's errors have a read-only message
      lib.ESPLoader = class extends lib.ESPLoader { async main() { mains++; throw Object.defineProperty(new Error(), 'message', {get: () => 'no sync'}); } };
      return lib;
    };
    await assert.rejects(flash.connectAndInspect({}), (e) => e.message === 'no sync');
    assert.equal(mains, 1);
    flash.remove();
  });

  test('a native-USB board stops after one failed try and says to pick it again', async () => {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.monitorStart = () => {};
    let mains = 0;
    const real = fakeS3(readBase('partitions/min_spiffs.bin'));
    flash.esptoolImport = async () => {
      const lib = await real();
      lib.ESPLoader = class extends lib.ESPLoader { async main() { mains++; throw new Error('no sync'); } };
      return lib;
    };
    await assert.rejects(flash.connectAndInspect({getInfo: () => ({usbVendorId: 0x303a, usbProductId: 2})}), /click Connect again/);
    assert.equal(mains, 1);
    flash.remove();
  });

  test('the loader is built as Espressif\u2019s page builds it, at the chosen speed with no serial options', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    assert.equal(loaderOptions.baudrate, flash.state.baudrate);
    assert.equal(loaderOptions.serialOptions, undefined, 'a native-USB S2 went silent with a larger buffer');
    flash.remove();
  });

  test('flash is read one small packet at a time, each acknowledged before the next is sent', async () => {
    const flash = document.createElement('mqtt-flash');
    const {ESPLoader} = await flash.esptoolImport(); // the real library, as the page loads it
    const flashBytes = Uint8Array.from({length: 4096}, (_, i) => i * 7);
    const acks = [];
    let sent = 0;
    let md5Sent = false;
    const transport = {
      getInfo: () => 'fake',
      async read() {
        if (sent > (acks.at(-1) || 0)) throw new Error('asked for a packet before acknowledging the last');
        if (sent >= flashBytes.length) { md5Sent = true; return new Uint8Array(16); }
        const packet = flashBytes.slice(sent, sent + args.packet);
        sent += packet.length;
        return packet;
      },
      async write(bytes) { acks.push(new DataView(bytes.buffer).getUint32(0, true)); },
    };
    const loader = new ESPLoader({transport, baudrate: 115200, terminal: {clean() {}, writeLine() {}, write() {}}});
    const args = {};
    loader.checkCommand = async (desc, op, data) => {
      const v = new DataView(data.buffer);
      Object.assign(args, {op, packet: v.getUint32(8, true), unacked: v.getUint32(12, true)});
      return 0;
    };
    const got = await loader.readFlash(0x8000, 4096);
    assert.equal(args.op, loader.ESP_READ_FLASH);
    assert.equal(args.unacked, 1, 'one packet in flight - a burst is what Chrome dropped');
    assert.ok(args.packet <= 256, 'a small packet, not esptool-js\u2019s 4KB');
    assert.deepEqual(got, flashBytes);
    assert.ok(md5Sent, 'the stub\u2019s MD5 must be read, or it answers the next command');
  });

  test('esptool does not reset the board - the monitor does, once, after the port is reopened', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    flash.state.app = {name: 'firmware.bin', bytes: image(0x1000)};
    await flash.flash();
    assert.deepEqual(afterModes, ['no_reset_stub']);
    assert.equal(flash.state.resetOnOpen, true);
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

  // Nothing here was exercised until now - every other test used an image that matched its board
  test('an image built for another chip is refused, by name, before anything is written', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    const c3 = image(0x1000); c3[12] = 5;
    flash.state.app = {name: 'c3-firmware.bin', bytes: c3};
    await assert.rejects(flash.flash(), /c3-firmware\.bin was built for ESP32-C3 \(chip id 5\), but this board is ESP32-S3 - nothing was written/);
    assert.deepEqual(writes, []);
    flash.remove();
  });

  test('choosing another firmware replaces the verdict on the last one, and checks the new one at once', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    const choose = (name, bytes) => { flash.state.app = {name, bytes}; flash.appChosen(); };
    const c3 = image(0x1000); c3[12] = 5;
    choose('c3.bin', c3);
    assert.match(flash.state.error, /c3\.bin was built for ESP32-C3/);
    choose('good.bin', image(0x1000));
    assert.equal(flash.state.error, null, 'the old file\'s error must not outlive it');
    const s2 = image(0x1000); s2[12] = 2;
    choose('s2.bin', s2);
    assert.match(flash.state.error, /s2\.bin was built for ESP32-S2/);
    assert.deepEqual(writes, []);
    flash.remove();
  });

  test('connecting a board checks the firmware already chosen, and a lost board clears the verdict', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    const c3 = image(0x1000); c3[12] = 5;
    flash.state.app = {name: 'c3.bin', bytes: c3};
    flash.state.busy = false;
    flash.verdictRefresh(); // what the end of Connect runs
    assert.match(flash.state.error, /c3\.bin was built for ESP32-C3/);
    flash.state.esploader = null; // the board is gone
    flash.verdictRefresh();
    assert.equal(flash.state.error, null);
    flash.state.esploader = {chip: {}}; flash.state.app = null; // a board, no file
    flash.verdictRefresh();
    assert.equal(flash.state.error, null);
    flash.remove();
  });

  test('connecting a board forgets the ticks from the one before', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    flash.state.apply = {rows: [{label: 'frugal_iot/org dev'}], problems: [], status: null};
    await flash.connectAndInspect({});
    assert.equal(flash.state.apply, null);
    flash.remove();
  });

  test('the Connect button itself checks the firmware chosen before it', async () => {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    flash.esptoolImport = fakeS3(readBase('partitions/min_spiffs.bin'));
    flash.state.boards = boards;
    flash.monitorStart = () => {};
    Object.defineProperty(navigator, 'serial', {value: {requestPort: async () => ({})}, configurable: true});
    const c3 = image(0x1000); c3[12] = 5;
    flash.state.app = {name: 'c3.bin', bytes: c3};
    flash.state.elements.connectButton.click();
    await flash.state.connectDone;
    assert.match(flash.state.error, /c3\.bin was built for ESP32-C3/);
    flash.remove();
    delete navigator.serial;
  });

  test('a wrong-chip image is refused when provisioning too, not after the bootloader is written', async () => {
    const table = readBase('partitions/min_spiffs.bin').slice();
    new DataView(table.buffer).setUint32(2 * 32 + 4, 0x20000, true); // forces a provision
    const flash = await connected(table);
    assert.equal(flash.state.device.provision, true);
    const s2 = image(0x1000); s2[12] = 2;
    flash.state.app = {name: 's2.bin', bytes: s2};
    await assert.rejects(flash.flash(), /built for ESP32-S2.*this board is ESP32-S3/);
    assert.deepEqual(writes, []);
    flash.remove();
  });

  test('a chip id it has no name for is still refused, by number', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'));
    const odd = image(0x1000); odd[12] = 99;
    flash.state.app = {name: 'odd.bin', bytes: odd};
    await assert.rejects(flash.flash(), /built for chip id 99, but this board is ESP32-S3/);
    assert.deepEqual(writes, []);
    flash.remove();
  });

  test('an image too big for the partition it would be provisioned into is refused', async () => {
    const table = readBase('partitions/min_spiffs.bin').slice();
    new DataView(table.buffer).setUint32(2 * 32 + 4, 0x20000, true);
    const flash = await connected(table);
    flash.state.app = {name: 'huge.bin', bytes: image(flash.state.device.base.appSize + 1)};
    await assert.rejects(flash.flash(), /huge\.bin is .*larger than the .* app partition of default_8MB/);
    assert.deepEqual(writes, []);
    flash.remove();
  });

  test('a chip and flash size with no base bundle is refused, and Flash stays unavailable', async () => {
    const flash = await connected(readBase('partitions/min_spiffs.bin'), 0x15); // 2MB S3
    assert.equal(flash.state.device.refusal, 'No base bundle for ESP32-S3 2MB');
    flash.state.app = {name: 'firmware.bin', bytes: image(0x1000)};
    assert.equal(flash.ready, false);
    await assert.rejects(flash.flash(), /No base bundle for ESP32-S3 2MB/, 'a direct call must not reach a missing base');
    assert.deepEqual(writes, []);
    flash.remove();
  });
});

describe('matching the app to the bootloader it would be provisioned with', () => {
  const readBase = (p) => new Uint8Array(readFileSync(new URL(`../base/${p}`, import.meta.url)));
  const boards = JSON.parse(readFileSync(new URL('../base/boards.json', import.meta.url), 'utf8'));
  // A C3 image with the descriptor ESP-IDF puts at 0x20
  function described(idfVer, size = 0x1000) {
    const b = new Uint8Array(size);
    b[0] = 0xe9; b[12] = 5;
    new DataView(b.buffer).setUint32(0x20, 0xabcd5432, true);
    const put = (offset, text) => b.set(new TextEncoder().encode(text), 0x20 + offset);
    put(16, '43a8f6d'); put(48, 'arduino-lib-builder'); put(96, 'Jun  2 2026'); put(112, idfVer);
    return b;
  }
  const url = (b) => `./base/${b.path}`;
  function flashFor(provision) {
    const flash = document.createElement('mqtt-flash');
    flash.state.device = {chipName: 'ESP32-C3', provision, scheme: 'min_spiffs', base: {
      bootloaders: boards.bootloadersByChip['ESP32-C3'].map((b) => ({idfVer: b.idfVer, core: b.core, url: url(b)})),
      bootloaderAddress: 0, appSize: 0x1e0000}, onDeviceAppSize: 0x1e0000};
    flash.state.esploader = {chip: {IMAGE_CHIP_ID: 5}};
    return flash;
  }

  test('boards.json records the IDF release each bootloader really contains', () => {
    for (const [chip, options] of Object.entries(boards.bootloadersByChip)) {
      for (const b of options) {
        const text = Buffer.from(readBase(b.path)).toString('latin1');
        assert.ok(text.includes(b.idfVer), `${chip} ${b.path} does not contain ${b.idfVer}`);
      }
    }
  });

  test('every chip offers the same IDF releases, so a board is not supported by only one', () => {
    const sets = Object.values(boards.bootloadersByChip).map((o) => o.map((b) => b.idfVer).join());
    assert.equal(new Set(sets).size, 1, sets.join(' | '));
  });

  test('the bootloader is chosen by the app’s IDF release', () => {
    const flash = flashFor(true);
    flash.state.app = {name: 'x.bin'};
    assert.equal(flash.bootloaderFor({idfVer: 'v5.5.5'}).core, '3.3.12');
    assert.throws(() => flash.bootloaderFor({idfVer: 'v5.5.4'}), /Update the Arduino IDE/, 'no longer shipped');
  });

  test('an app from a release with no bootloader is refused when it would be provisioned', () => {
    const flash = flashFor(true);
    flash.state.app = {name: 'old.bin', bytes: described('v5.3.2-282-gcfea4f7c98-dirty')};
    assert.throws(() => flash.appCheck(), /ESP-IDF v5\.3\.2.*no bootloader.*v5\.5\.5/);
  });

  test('an older IDE is told to update, a newer one is told the flasher is behind', () => {
    const flash = flashFor(true);
    flash.state.app = {name: 'x.bin'};
    assert.throws(() => flash.bootloaderFor({idfVer: 'v5.3.2-282-gcfea4f7c98-dirty'}), /Update the Arduino IDE/);
    assert.throws(() => flash.bootloaderFor({idfVer: 'v5.5.6'}), /newer than this flasher knows/);
    assert.throws(() => flash.bootloaderFor({idfVer: 'v5.10.0'}), /newer than this flasher knows/, 'compared as numbers, not text');
  });

  test('the shipped release is accepted', () => {
    const flash = flashFor(true);
    flash.state.app = {name: 'firmware.bin', bytes: described('v5.5.5')};
    flash.appCheck();
  });

  test('an app-only update keeps the board’s own bootloader, so the release does not matter', () => {
    const flash = flashFor(false);
    flash.state.app = {name: 'old.bin', bytes: described('v5.3.2')};
    flash.appCheck();
  });

  test('an image with no descriptor is not refused on a guess, and gets the default bootloader', () => {
    const flash = flashFor(true);
    const bytes = new Uint8Array(0x1000); bytes[0] = 0xe9; bytes[12] = 5;
    flash.state.app = {name: 'firmware.bin', bytes};
    flash.appCheck();
    assert.equal(flash.bootloaderFor(null).idfVer, 'v5.5.5');
  });

  test('provisioning writes the bootloader that matches the app', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const bytes = readBase(String(u).replace(/^\.\/base\//, ''));
      return {ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
    };
    try {
      for (const [v, path] of [['v5.5.5', 'bootloader/v5.5.5/esp32c3.bin']]) {
        const flash = flashFor(true);
        flash.state.device.base.partitions = {url: './base/partitions/min_spiffs.bin', address: 0x8000};
        flash.state.device.base.otadata = {url: './base/boot_app0.bin'};
        flash.state.device.appAddress = 0x10000;
        flash.state.app = {name: 'firmware.bin', bytes: described(v)};
        const files = await flash.fileArrayBuild();
        assert.deepEqual(files[0].data, readBase(path), `${v} should write ${path}`);
        assert.equal(files[0].address, 0);
      }
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('the flasher panel', () => {
  const memoryStore = () => ({data: null, async get() { return this.data; }, async put(app) { this.data = {name: app.name, bytes: app.bytes}; }});
  const image = (size = 0x1000) => { const b = new Uint8Array(size); b[0] = 0xe9; return b; };
  function panel(store = memoryStore()) {
    const flash = document.createElement('mqtt-flash');
    flash.appStore = store;
    document.body.append(flash);
    return flash;
  }
  const statusText = (flash) => flash.state.elements.status.textContent;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test('says what is missing while Flash is disabled', () => {
    const flash = panel();
    assert.match(statusText(flash), /Choose a firmware file to flash/);
    assert.match(statusText(flash), /Connect a board to flash/);
    flash.state.app = {name: 'f.bin', bytes: image()};
    flash.statusRender();
    assert.doesNotMatch(statusText(flash), /Choose a firmware file/);
    assert.match(statusText(flash), /Connect a board to flash/);
    flash.remove();
  });

  test('the button says it erases, when it will', () => {
    const flash = panel();
    const button = flash.state.elements.flashButton;
    assert.equal(button.textContent, 'Flash');
    flash.state.device = {chipName: 'ESP32-C3', description: 'ESP32-C3', flashSize: '4MB', provision: true, scheme: 'min_spiffs'};
    flash.state.esploader = {};
    flash.statusRender();
    assert.equal(button.textContent, 'Erase and flash');
    assert.ok(button.classList.contains('destructive'));
    assert.ok(flash.state.elements.status.querySelector('p.destructive'), 'the warning should read as destructive');
    flash.state.esploader = null; // released after a flash: nothing is connected, so nothing is about to be erased
    flash.statusRender();
    assert.equal(button.textContent, 'Flash');
    assert.ok(!button.classList.contains('destructive'));
    assert.ok(button.disabled);
    assert.ok(!flash.state.elements.status.querySelector('p.destructive'), 'a stale warning is shown about a board no longer connected');
    assert.match(flash.state.elements.status.textContent, /Reconnect the board to flash again/);
    flash.state.esploader = {};
    flash.state.device.provision = false;
    flash.statusRender();
    assert.equal(button.textContent, 'Flash');
    assert.ok(!button.classList.contains('destructive'));
    flash.remove();
  });

  test('a chosen file is kept, and comes back marked after a reload', async () => {
    const store = memoryStore();
    const first = panel(store);
    const input = first.shadowRoot.querySelector('#flashfile');
    const bytes = image(0x2000);
    Object.defineProperty(input, 'files', {value: [{name: 'chosen.bin', arrayBuffer: async () => bytes.buffer}]});
    input.dispatchEvent(new window.Event('change'));
    await settle();
    assert.equal(store.data.name, 'chosen.bin');
    first.remove();

    const second = panel(store); // a reload
    await settle();
    assert.equal(second.state.app.name, 'chosen.bin');
    assert.equal(second.state.app.bytes.length, 0x2000);
    assert.match(statusText(second), /chosen\.bin.*kept from last session/);
    second.remove();
  });

  test('what was kept does not replace a file already chosen', async () => {
    const store = memoryStore();
    store.data = {name: 'old.bin', bytes: image()};
    const flash = document.createElement('mqtt-flash');
    flash.appStore = store;
    flash.state.app = {name: 'new.bin', bytes: image()};
    document.body.append(flash);
    await settle();
    assert.equal(flash.state.app.name, 'new.bin');
    flash.remove();
  });

  test('without IndexedDB nothing is kept, and nothing breaks', async () => {
    const flash = document.createElement('mqtt-flash'); // the real store, in a DOM with no IndexedDB
    document.body.append(flash);
    await settle();
    assert.equal(flash.state.app, null);
    await flash.appStore.put({name: 'x.bin', bytes: image()});
    flash.remove();
  });

  test('controls follow the order they are used in', () => {
    const flash = panel();
    const nodes = [...flash.shadowRoot.querySelector('.mqtt-flash').children];
    const at = (match) => nodes.findIndex((n) => match(n));
    const button = (text) => at((n) => n.tagName === 'BUTTON' && n.textContent === text);
    const order = [
      at((n) => n.id === 'flashfile'), button('Connect board'), button('Flash'),
      at((n) => n.classList.contains('flash-status')), at((n) => n.tagName === 'PROGRESS'),
      button('Monitor'), button('Reset board'), at((n) => n.classList.contains('flash-log')),
      at((n) => n.tagName === 'H4' && n.textContent === 'Configure board'),
    ];
    assert.ok(order.every((i) => i >= 0), `a control is missing: ${order}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the controls are out of order');
    flash.remove();
  });
});

describe('configuring the node over the monitor’s port', () => {
  // A node that speaks the protocol: says hello when the port opens, and answers like the firmware.
  // `got` is every line written to it.
  function nodePort({restart = false, enrolled = true, dropFirstSet = false} = {}) {
    let dropping = dropFirstSet;
    const port = {got: [], readable: null, writable: null};
    let controller;
    const say = (t) => controller.enqueue(new TextEncoder().encode(t));
    port.open = async () => {
      port.readable = new ReadableStream({start(c) { controller = c; say('boot noise\n~hello\t1\tesp32-abc123\tc3_pico\n'); }});
      port.writable = new WritableStream({write(chunk) {
        new TextDecoder().decode(chunk).split('\n').filter(Boolean).forEach((line) => {
          port.got.push(line);
          const [cmd, twig] = line.split('\t');
          if (cmd === '~hello') say('~hello\t1\tesp32-abc123\tc3_pico\n');
          else if (cmd === '~set') { if (dropping) dropping = false; else say(`~ok\t${twig}\n`); }
          else if (cmd === '~apply') say('~ok\tapply\n');
          else if (cmd === '~status') say(`~status\t{"org":"dev","project":"lotus","connected":true,"mqtt":true,"enrolled":${enrolled},"restart":${restart}}\n`);
        });
      }});
    };
    port.close = async () => { port.readable = null; port.writable = null; };
    port.setSignals = async () => {};
    return port;
  }
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({ok: true, json: async () => ({secrets: ['newest', 'older']}), url});
  });
  afterEach(() => { globalThis.fetch = realFetch; localStorage.clear(); });

  async function ready(opts) {
    const flash = document.createElement('mqtt-flash');
    flash.setAttribute('org', 'dev');
    flash.setAttribute('project', 'lotus');
    document.body.append(flash);
    flash.state.port = nodePort(opts);
    flash.profileGet().wifi = [{ssid: 'Home Net', password: 'pw 1'}];
    flash.monitorStart();
    for (let i = 0; i < 200 && !flash.state.node; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(flash.state.node, 'the node should have been heard');
    return flash;
  }

  test('hello makes the board ready, and the protocol line stays out of the log', async () => {
    const flash = await ready();
    assert.equal(flash.state.node.nodeid, 'esp32-abc123');
    assert.match(flash.state.log.join('\n'), /boot noise/);
    assert.ok(!flash.state.log.join('\n').includes('~hello'));
    await flash.monitorStop();
    flash.remove();
  });

  test('Apply sends the profile in order, using the newest secret, then applies', async () => {
    const flash = await ready();
    await flash.applyProfile();
    const sent = flash.state.port.got.filter((l) => l.startsWith('~set') || l === '~apply');
    assert.deepEqual(sent, [
      '~set\tfrugal_iot/org\tdev', '~set\tfrugal_iot/project\tlotus', '~set\tmqtt/enrol_secret\tnewest',
      ...(flash.profileGet().broker ? [`~set\tmqtt/hostname\t${flash.profileGet().broker}`] : []),
      '~set\twifi/Home Net\tpw 1', '~apply']);
    assert.ok(flash.state.apply.rows.every((r) => !r.error), JSON.stringify(flash.state.apply.rows));
    assert.equal(flash.state.applied, 1, 'a board that came up enrolled counts as done');
    assert.ok(!flash.state.log.join('\n').includes('newest'), 'the secret must not reach the log');
    assert.equal(flash.profileGet().secret, '', 'nor stay in the profile');
    await flash.monitorStop();
    flash.remove();
  });

  test('a set the board did not answer is sent once more', async () => {
    const flash = await ready({dropFirstSet: true});
    await flash.applyProfile();
    assert.equal(flash.state.port.got.filter((l) => l === '~set\tfrugal_iot/org\tdev').length, 2);
    assert.ok(flash.state.apply.rows.every((r) => !r.error), JSON.stringify(flash.state.apply.rows));
    await flash.monitorStop();
    flash.remove();
  });

  test('the ticks from one connection are not kept for the next', async () => {
    const flash = await ready();
    await flash.applyProfile();
    assert.ok(flash.state.apply.rows.length);
    await flash.monitorStop();
    flash.monitorStart();
    for (let i = 0; i < 200 && flash.state.apply; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(flash.state.apply, null, 'a reopened port may be a reset board');
    await flash.monitorStop();
    flash.remove();
  });

  test('the monitor started after a flash resets the board once, and only then', async () => {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    const port = nodePort();
    const signals = [];
    port.setSignals = async (s) => { signals.push(s); };
    flash.state.port = port;
    flash.state.resetOnOpen = true;
    flash.monitorStart();
    for (let i = 0; i < 200 && signals.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(signals, [{dataTerminalReady: false, requestToSend: true}, {dataTerminalReady: false, requestToSend: false}]);
    await flash.monitorStop();
    flash.monitorStart(); // an ordinary start must not restart a board that is busy
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(signals.length, 2);
    await flash.monitorStop();
    flash.remove();
  });

  test('a flashed board that says hello again is applied again, until one apply succeeds', async () => {
    const flash = await ready();
    let calls = 0;
    flash.applyProfile = async () => { calls++; };
    flash.state.applyAfterHello = true;
    flash.onProtocolLine('~hello\t1\tesp32-abc123\tc3_pico');
    flash.onProtocolLine('~hello\t1\tesp32-abc123\tc3_pico'); // reset after a freeze
    assert.equal(calls, 2);
    flash.state.autoApply = false;
    flash.onProtocolLine('~hello\t1\tesp32-abc123\tc3_pico');
    assert.equal(calls, 2, 'unticking Apply after flashing must stop it');
    assert.match(flash.state.log.join('\n'), /Apply after flashing is off/);
    await flash.monitorStop();
    flash.remove();
  });

  test('without the secret it still applies the rest and says what is missing', async () => {
    globalThis.fetch = async () => ({ok: false, status: 403});
    const flash = await ready();
    await flash.applyProfile();
    assert.ok(!flash.state.port.got.some((l) => l.includes('enrol_secret')));
    assert.ok(flash.state.apply.rows.some((r) => r.error), 'the missing secret should be shown');
    assert.ok(flash.state.port.got.includes('~apply'));
    await flash.monitorStop();
    flash.remove();
  });

  test('a board flashed from here is applied on its first hello, once', async () => {
    const flash = document.createElement('mqtt-flash');
    flash.setAttribute('org', 'dev');
    flash.setAttribute('project', 'lotus');
    document.body.append(flash);
    flash.state.port = nodePort();
    flash.profileGet().wifi = [{ssid: 'Home', password: 'pw'}];
    flash.state.applyAfterHello = true;
    flash.monitorStart();
    for (let i = 0; i < 400 && !flash.state.port.got.includes('~apply'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(flash.state.port.got.includes('~apply'), 'it should have applied without a click');
    assert.equal(flash.state.applyAfterHello, false);
    await flash.monitorStop();
    flash.remove();
  });

  test('removing the card closes the port, so the next card can connect', async () => {
    // The project\u2019s back is rebuilt on some events, taking the card with it
    const flash = await ready();
    flash.remove();
    for (let i = 0; i < 200 && flash.state.port.writable; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(flash.state.port.writable, null, 'the port is still open');
    assert.ok(!flash.state.monitoring);
  });

  test('a board that is only being watched is never applied to', async () => {
    const flash = await ready();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!flash.state.port.got.some((l) => l.startsWith('~set')), 'connecting must not configure');
    await flash.monitorStop();
    flash.remove();
  });
});

describe('the log', () => {
  function logged() {
    const flash = document.createElement('mqtt-flash');
    document.body.append(flash);
    return {flash, pre: flash.state.elements.log};
  }
  test('new lines are appended to the same text node, so a selection survives them', () => {
    const {flash, pre} = logged();
    flash.logLine('first');
    const node = pre.firstChild;
    flash.logLine('second');
    flash.logWrite('3rd');
    flash.logWrite('+more\n');
    assert.equal(pre.firstChild, node, 'the text was replaced - that is what dropped the selection');
    assert.equal(pre.textContent, 'first\nsecond3rd+more\n'); // logWrite continues the last line
    flash.remove();
  });
  test('it does not drag the view to the bottom when the reader has scrolled up', () => {
    const {flash, pre} = logged();
    flash.logLine('a');
    // jsdom has no layout: describe a log scrolled well above its end
    Object.defineProperty(pre, 'scrollHeight', {value: 1000, configurable: true});
    Object.defineProperty(pre, 'clientHeight', {value: 100, configurable: true});
    pre.scrollTop = 200;
    flash.logLine('b');
    assert.equal(pre.scrollTop, 200);
    pre.scrollTop = 900; // now at the end, so it should follow
    flash.logLine('c');
    assert.equal(pre.scrollTop, 1000);
    flash.remove();
  });
  test('a trim waits while text is being selected, then catches up', async () => {
    const {flash, pre} = logged();
    flash.state.log = Array.from({length: 1999}, (_, i) => `line ${i}`);
    flash.logLine('x'); // 2000 - at the limit, no trim yet
    const node = pre.firstChild;
    let selecting = true;
    flash.logSelecting = () => selecting;
    flash.logLine('y'); // 2001: trimmed, which would replace the text
    assert.equal(pre.firstChild, node, 'it replaced the text under a selection');
    selecting = false;
    for (let i = 0; i < 200 && pre.firstChild === node; i++) await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(pre.firstChild, node, 'it never caught up');
    assert.ok(pre.textContent.endsWith('y'));
    flash.remove();
  });
});
