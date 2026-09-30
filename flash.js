/*
 * Frugal IoT client - flashing a device over USB from the browser, via esptool-js.
 *
 * Kept separate because esptool-js is large and only ever wanted on one screen. See FLASH_PLAN.md.
 */

import async from '/node_modules/async/dist/async.mjs'; // https://caolan.github.io/async/v3/docs.html
import {HTMLElementExtended} from '/node_modules/html-element-extended/htmlelementextended.js';
import { CssUrl, XXX, el, getString } from './core.js';

const BaseUrl = './base';
const PartitionTableOffset = 0x8000;
const PartitionTableMagic = 0x50aa; // AA 50 on the wire
const PartitionType = {app: 0x00, data: 0x01};
const PartitionSubtype = {factory: 0x00, ota0: 0x10, otadata: 0x00, spiffs: 0x82, littlefs: 0x83};
// Every Frugal IoT scheme keeps app0 here, so one firmware.bin suits any flash size - see FLASH_PLAN.md
const AppPartitionOffset = 0x10000;
const AppPartitionSize = 0x1e0000;
const ImageMagic = 0xe9;
const LittleFsMagic = [0x6c, 0x69, 0x74, 0x74, 0x6c, 0x65, 0x66, 0x73]; // "littlefs" in the superblock
const FlashBaudRates = [921600, 460800, 230400, 115200];
// frugal-iot's SERIAL_BAUD defaults to 460800 under PlatformIO, 115200 from the Arduino IDE;
// 74880 is the ESP8266 ROM's own boot-message rate
const MonitorBaudRates = [460800, 115200, 921600, 74880];
const BootLogMs = 25000; // startSerial() waits 5s before printing, then WiFi/captive portal follows
// How often the monitor tries the port again while it is gone - a deep sleep is measured in
// seconds to minutes, so there is nothing to gain from trying harder than this
const MonitorRetryMs = 1000;
// esptool-js's readFlash waits FLASH_READ_TIMEOUT (100s) for its first packet, which stalls Connect
// on any board that does not answer the stub's read command
const FlashReadMs = 8000;
// How long to wait for the port to close before saying it did not - esptool-js's disconnect() waits
// on the streams unlocking with no deadline of its own
const TransportReleaseMs = 5000;
// JEDEC capacity byte -> size, mirroring esptool-js's own table so we can tell a real detection from
// its silent 4MB fallback, which on an S3 is also the signature of unsupported octal flash
const DetectedFlashSizes = {
  0x12: "256KB", 0x13: "512KB", 0x14: "1MB", 0x15: "2MB", 0x16: "4MB", 0x17: "8MB", 0x18: "16MB",
  0x19: "32MB", 0x1a: "64MB", 0x1b: "128MB", 0x1c: "256MB",
  0x20: "64MB", 0x21: "128MB", 0x22: "256MB",
  0x32: "256KB", 0x33: "512KB", 0x34: "1MB", 0x35: "2MB", 0x36: "4MB", 0x37: "8MB", 0x38: "16MB",
  0x39: "32MB", 0x3a: "64MB",
};

// Promise.race leaves the loser's timer running - on a 25s deadline that holds the event loop long
// after the answer arrived, which is also what kept the test run alive for half a minute
function withTimeout(promise, ms, value) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(value), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 32-byte records: magic u16, type, subtype, offset u32, size u32, label[16], flags u32
function partitionsParse(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  for (let o = 0; o + 32 <= bytes.length; o += 32) {
    if (dv.getUint16(o, true) !== PartitionTableMagic) break;
    parts.push({
      type: bytes[o + 2],
      subtype: bytes[o + 3],
      offset: dv.getUint32(o + 4, true),
      size: dv.getUint32(o + 8, true),
      label: new TextDecoder().decode(bytes.subarray(o + 12, o + 28)).replace(/\0.*$/, ''),
    });
  }
  return parts;
}
function partitionApp(parts) {
  return parts.find((p) => p.type === PartitionType.app &&
    (p.subtype === PartitionSubtype.factory || p.subtype === PartitionSubtype.ota0));
}
function partitionOtadata(parts) {
  return parts.find((p) => p.type === PartitionType.data && p.subtype === PartitionSubtype.otadata);
}
// Arduino's LittleFS keeps the partition labelled "spiffs", so match on subtype not label
function partitionFs(parts) {
  return parts.find((p) => p.type === PartitionType.data &&
    (p.subtype === PartitionSubtype.spiffs || p.subtype === PartitionSubtype.littlefs));
}
function bytesInclude(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((b, j) => haystack[i + j] === b)) return true;
  }
  return false;
}
// ESP32 image header holds chip_id at byte 12; ESP8266 images have no such field
function imageChipId(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(12, true);
}
function bytesToHex(bytes, count) {
  return Array.from(bytes.subarray(0, count)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function bytesToSizeString(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(2)}MB` : `${Math.round(n / 1024)}KB`;
}
// GET() parses JSON, so it cannot fetch a firmware image
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
// base/ is served with `immutable, maxAge: 1 day`, so boards.json must be revalidated explicitly or
// an edit is invisible for a day - the part binaries are then cache-busted with its version
async function fetchJson(url) {
  const res = await fetch(url, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
class MqttFlash extends HTMLElementExtended {
  constructor(props) {
    super(props);
    this.state = {elements: {}, log: [], app: null, device: null, busy: false,
      baudrate: FlashBaudRates[0], monitorBaudrate: MonitorBaudRates[0], monitorRetryMs: MonitorRetryMs};
  }
  get supported() { return 'serial' in navigator; }
  // esploader goes null after flashing, so a second flash needs a reconnect rather than a stale loader
  get ready() {
    return !!(this.state.app && this.state.device && this.state.esploader && !this.state.device.refusal && !this.state.busy);
  }
  /*
   * The port stays open until this runs, and WebSerial then refuses the next open with "The port is
   * already open" - so every path out of a connect or a flash, failed ones included, must reach here.
   *
   * disconnect() waits for the streams to unlock with no deadline of its own, so it is bounded:
   * a reader that never releases would otherwise leave the button disabled with nothing said.
   */
  async transportRelease() {
    const transport = this.state.transport;
    this.state.transport = null;
    this.state.esploader = null;
    if (!transport) return;
    const released = transport.disconnect().catch((e) => { XXX(`transport disconnect: ${e.message}`); });
    if (await withTimeout(released, TransportReleaseMs, 'timeout') === 'timeout') {
      this.logLine("The serial port did not close - unplug the board or reload the page before connecting again.");
    }
  }

  // ---- logging ----
  logTrim() {
    if (this.state.log.length > 400) this.state.log.splice(0, this.state.log.length - 400);
    const pre = this.state.elements.log;
    if (pre) {
      pre.textContent = this.state.log.join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
  }
  logLine(text) {
    this.state.log.push(String(text));
    this.logTrim();
  }
  // esptool writes progress without newlines, so append to the last line
  logWrite(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    if (!this.state.log.length) this.state.log.push('');
    this.state.log[this.state.log.length - 1] += lines.shift();
    lines.forEach((l) => this.state.log.push(l));
    this.logTrim();
  }
  get terminal() {
    return {
      clean: () => { this.state.log = []; this.logTrim(); },
      writeLine: (data) => this.logLine(data),
      write: (data) => this.logWrite(data),
    };
  }

  // ---- app image source ----
  onLocalFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    file.arrayBuffer().then((buf) => {
      this.state.app = {name: file.name, bytes: new Uint8Array(buf)};
      this.logLine(`Selected ${file.name} (${bytesToSizeString(this.state.app.bytes.length)})`);
      this.statusRender();
    });
  }
  // Reached from the ⚡ in the OTA card, by way of mqtt-projectback and MqttAdmin.flashRemote
  setRemoteSource(org, path) {
    const url = `/ota_get/${org}/${path}`;
    this.logLine(`Fetching ${url}`);
    fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`${url} ${res.status}`); return res.arrayBuffer(); })
      .then((buf) => {
        this.state.app = {name: `${path}/firmware.bin`, bytes: new Uint8Array(buf)};
        this.logLine(`Selected ${this.state.app.name} (${bytesToSizeString(this.state.app.bytes.length)})`);
        this.statusRender();
      })
      .catch((e) => { this.logLine(`Error: ${e.message}`); this.statusRender(); });
  }

  // ---- connect and inspect ----
  onConnect() {
    if (!this.supported || this.state.busy) return;
    const portPromise = navigator.serial.requestPort(); // must be called before any await, inside the gesture
    this.state.busy = true;
    this.state.error = null;
    this.statusRender();
    this.state.connectDone = portPromise // kept so a test can await the click
      .then((port) => this.connectAndInspect(port))
      .catch((e) => {
        this.logLine(`Error: ${e.message}`);
        this.state.device = null;
        return this.transportRelease(); // otherwise a half-open port stays locked
      })
      .then(() => { this.state.busy = false; this.statusRender(); });
  }
  // A seam: the real thing is 214KB of esptool-js and wants a board on the other end of a port
  esptoolImport() { return import('esptool-js'); }
  async connectAndInspect(port) {
    await this.monitorStop();      // the monitor holds the port open, so esptool cannot have it
    await this.transportRelease(); // clicking Connect twice must not stack transports on one port
    const {ESPLoader, Transport} = await this.esptoolImport(); // not loaded until first use
    const transport = new Transport(port, true);
    const esploader = new ESPLoader({transport, baudrate: this.state.baudrate, terminal: this.terminal});
    // Recorded before main(), which opens the port: a failure after that has to be releasable, or
    // the retry meets a port this element no longer knows it holds
    this.state.port = port;
    this.state.transport = transport;
    this.state.esploader = esploader;
    const description = await esploader.main(); // returns the description, not the chip name
    const chipName = esploader.chip.CHIP_NAME;
    const flashIdCapacity = (await esploader.readFlashId()) >> 16 & 0xff;
    const flashSizeGuessed = !DetectedFlashSizes[flashIdCapacity];
    const flashSize = DetectedFlashSizes[flashIdCapacity] || await esploader.detectFlashSize();
    this.state.device = {chipName, description, flashSize, flashSizeGuessed};
    if (flashSizeGuessed) {
      this.logLine(`WARNING: flash size not recognised (capacity byte 0x${flashIdCapacity.toString(16)}), assuming ${flashSize}`);
      if (chipName === "ESP32-S3") this.logLine("On an S3 this is the signature of octal (OPI) flash, which cannot be flashed from a browser.");
    }
    await this.planBuild();
  }
  // Decide provision vs app-only by reading the board back - see FLASH_PLAN.md
  async planBuild() {
    const dev = this.state.device;
    const boards = this.state.boards || (this.state.boards = await fetchJson(`${BaseUrl}/boards.json`));
    if (boards.wholeImageChips.includes(dev.chipName)) {
      dev.wholeImage = true;                 // ESP8266 firmware.bin is a complete image at 0x0
      dev.provision = false;                 // and does not overlap the filesystem
      dev.appAddress = 0x0;
      dev.appLimit = null;
      return;
    }
    const scheme = boards.schemeByChipAndSize[`${dev.chipName}-${dev.flashSize}`];
    const bootloaderPath = boards.bootloaderByChip[dev.chipName];
    if (!scheme || !bootloaderPath) {
      dev.refusal = `No base bundle for ${dev.chipName} ${dev.flashSize}`;
      this.logLine(`Unsupported board: ${dev.refusal}`);
      return;
    }
    dev.scheme = scheme;
    const partUrl = (p) => `${BaseUrl}/${p}?v=${boards.version}`; // busts the immutable cache
    dev.base = {
      bootloader: {url: partUrl(bootloaderPath), address: this.state.esploader.chip.BOOTLOADER_FLASH_OFFSET},
      partitions: {url: partUrl(boards.partitionsByScheme[scheme]), address: boards.partitionTableOffset},
      otadata: {url: partUrl(boards.otadata), address: null}, // from the partition table below
    };
    // The filesystem partition is deliberately left erased - the firmware's LittleFS.begin(true)
    // formats it on first boot. See FLASH_PLAN.md: it only appeared unable to when we were writing a
    // bootloader from the wrong framework.
    dev.appAddress = AppPartitionOffset;
    dev.appLimit = AppPartitionSize;
    await this.deviceInspect();
  }
  // Returns null rather than stalling, so a board that will not answer the stub's read command does
  // not hold up Connect for 100s per read
  async readFlashBounded(offset, length) {
    const read = this.state.esploader.readFlash(offset, length)
      .catch((e) => { this.logLine(`(read of 0x${offset.toString(16)} failed: ${e.message})`); return null; });
    const bytes = await withTimeout(read, FlashReadMs, null);
    if (!bytes) this.logLine(`(could not read 0x${offset.toString(16)} - skipping inspection)`);
    return bytes;
  }
  async deviceInspect() {
    const dev = this.state.device;
    const esploader = this.state.esploader;
    const bootloaderOffset = esploader.chip.BOOTLOADER_FLASH_OFFSET;
    const reasons = [];
    let onDeviceParts = [];
    // Read whole 4096-byte blocks - readFlash works in blocks and partitionsParse stops at the
    // first record without the magic anyway
    const head = await this.readFlashBounded(bootloaderOffset, 4096);
    const table = head && await this.readFlashBounded(PartitionTableOffset, 4096);
    if (!head || !table) {
      // Never fall through to provisioning here - erasing a board because a diagnostic read failed
      // is destructive, so require an explicit "Provision instead" click
      dev.inspected = false;
      dev.provision = false;
      this.logLine("Could not inspect the board - assuming it is already provisioned. Use \"Provision instead\" if this is a new board.");
      return;
    }
    dev.inspected = true;
    if (head[0] !== ImageMagic) reasons.push("no bootloader");
    onDeviceParts = partitionsParse(table);
    const app = partitionApp(onDeviceParts);
    if (!onDeviceParts.length) reasons.push("no partition table");
    else if (!app) reasons.push("no app partition");
    // Only the app slot has to match - a differently sized filesystem is still safe to keep
    else if (app.offset !== AppPartitionOffset || app.size !== AppPartitionSize) reasons.push("app partition differs");
    // Worth always logging - a layout that disagrees with the base explains most boot failures
    if (onDeviceParts.length) {
      this.logLine("On-device partition table:");
      onDeviceParts.forEach((p) => this.logLine(
        `  ${p.label.padEnd(10)} type=0x${p.type.toString(16).padStart(2, '0')}` +
        ` subtype=0x${p.subtype.toString(16).padStart(2, '0')}` +
        ` offset=0x${p.offset.toString(16).padStart(6, '0')} size=${bytesToSizeString(p.size)}`));
    }
    if (!reasons.length) {
      const fs = partitionFs(onDeviceParts);
      const sb = fs && await this.readFlashBounded(fs.offset, 4096);
      if (fs && sb) {
        dev.hasConfig = bytesInclude(sb, LittleFsMagic);
        const blank = sb.every((b) => b === 0xff);
        // Only a byte-pattern match, not proof the filesystem mounts - stale bytes from a previous,
        // differently sized filesystem match too
        this.logLine(`Filesystem partition at 0x${fs.offset.toString(16)}: ` + (dev.hasConfig
          ? "littlefs byte pattern present (may still be stale or unmountable)"
          : blank ? "erased (0xff) - unformatted" : "not littlefs and not erased - stale data"));
        this.logLine(`  on device: ${bytesToHex(sb, 32)}`);
      } else if (!fs) {
        this.logLine("No filesystem partition in the on-device table");
      }
    }
    dev.provision = reasons.length > 0;
    dev.provisionReasons = reasons;
    this.logLine(dev.provision
      ? `Board needs provisioning: ${reasons.join(', ')}`
      : `Board already provisioned${dev.hasConfig ? " and has a filesystem - config will be preserved" : ""}`);
  }
  onProvisionOverride() {
    if (!this.state.device) return;
    this.state.device.provision = true;
    this.state.device.provisionReasons = ["requested"];
    this.logLine("Provisioning requested - existing configuration will be erased");
    this.statusRender();
  }

  // ---- flash ----
  onFlash() {
    if (!this.ready) return;
    this.state.busy = true;
    this.state.error = null;
    this.statusRender();
    this.flash()
      // Surfaced in the status area as well as the log - flashing releases the loader either way, so
      // the Flash button stays disabled and the reason has to be visible
      .catch((e) => { this.state.error = e.message; this.logLine(`Error: ${e.message}`); })
      .then(() => { this.state.busy = false; this.statusRender(); });
  }
  // Refusals rather than warnings - a bad combination here means a board that will not boot
  appCheck() {
    const dev = this.state.device;
    const bytes = this.state.app.bytes;
    if (bytes[0] !== ImageMagic) {
      throw new Error(`${this.state.app.name} is not an ESP firmware image (first byte 0x${bytes[0].toString(16)}, expected 0xe9)`);
    }
    if (!dev.wholeImage) {
      const chipId = imageChipId(bytes);
      if (chipId !== this.state.esploader.chip.IMAGE_CHIP_ID) {
        throw new Error(`${this.state.app.name} was built for chip id ${chipId}, but this board is ${dev.chipName} (chip id ${this.state.esploader.chip.IMAGE_CHIP_ID})`);
      }
      if (dev.appLimit && bytes.length > dev.appLimit) {
        throw new Error(`${this.state.app.name} is ${bytesToSizeString(bytes.length)}, larger than the ${bytesToSizeString(dev.appLimit)} app partition`);
      }
    }
    if (dev.flashSizeGuessed && !this.state.confirmed) {
      throw new Error("Flash size was not detected reliably - tick the confirmation box to flash anyway");
    }
  }
  async fileArrayBuild() {
    const dev = this.state.device;
    const files = [];
    if (dev.provision && !dev.wholeImage) {
      const [bootloader, partitions, otadata] = await Promise.all(
        [dev.base.bootloader, dev.base.partitions, dev.base.otadata].map((p) => fetchBytes(p.url)));
      // otadata goes wherever the table we are about to write says, not at a hardcoded offset
      const baseParts = partitionsParse(partitions);
      const otadataPart = partitionOtadata(baseParts);
      if (!otadataPart) throw new Error(`${dev.base.partitions.url} has no otadata partition`);
      files.push({data: bootloader, address: dev.base.bootloader.address});
      files.push({data: partitions, address: dev.base.partitions.address});
      files.push({data: otadata, address: otadataPart.offset});
      dev.verifyAddress = dev.base.partitions.address; // read back below to confirm the write landed
    }
    files.push({data: this.state.app.bytes, address: dev.appAddress});
    return files;
  }
  async flash() {
    const dev = this.state.device;
    const esploader = this.state.esploader;
    this.appCheck();
    const fileArray = await this.fileArrayBuild();
    fileArray.forEach((f) => this.logLine(`Will write ${bytesToSizeString(f.data.length)} at 0x${f.address.toString(16)}`));
    if (this.state.elements.progress) this.state.elements.progress.value = 0;
    try {
      await esploader.writeFlash({
        fileArray,
        // Must be a literal size string. writeFlash's flashSizeBytes() only parses "KB"/"MB", so
        // 'detect' silently becomes -1 and every file then fails its "fits in flash" check, even
        // though 'detect' is a legal FlashSizeValues member on other code paths.
        flashSize: dev.flashSize,
        // 'keep' preserves the mode/freq the image was built with. Our base bootloaders are already
        // dio_80m, and on an ESP8266 the app image itself sits at the bootloader offset and would
        // otherwise be rewritten to settings its flash may not support.
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: dev.provision,
        compress: true,
        reportProgress: (index, written, total) => {
          const bar = this.state.elements.progress;
          if (bar) { bar.max = total; bar.value = written; }
        },
      });
      // Read the partition table back before resetting - the app rewrites nothing here, but doing it
      // now catches a failed write immediately instead of leaving a mysteriously dead board
      if (dev.verifyAddress != null) {
        const wrote = fileArray.find((f) => f.address === dev.verifyAddress);
        const back = await this.readFlashBounded(dev.verifyAddress, 4096);
        if (wrote && back) {
          let differsAt = -1;
          const n = Math.min(back.length, wrote.data.length);
          for (let i = 0; i < n; i++) if (back[i] !== wrote.data[i]) { differsAt = i; break; }
          this.logLine(differsAt < 0
            ? `Partition table write verified at 0x${dev.verifyAddress.toString(16)} (${n} bytes match)`
            : `Partition table write did NOT verify at 0x${dev.verifyAddress.toString(16)}, first difference at byte ${differsAt}`);
        }
      }
      this.logLine("Flash complete - resetting. Reconnect the board if you want to flash again.");
      await esploader.after("hard_reset");
      dev.flashed = true;
    } finally {
      await this.transportRelease(); // a failed flash must still free the port
    }
    this.monitorStart(); // not awaited - it now runs until stopped
  }
  // DTR/RTS drive EN and IO0 on boards with the usual auto-reset circuit - RTS left asserted holds
  // the chip in reset and it prints nothing at all. Releasing both then pulsing RTS restarts it, so
  // the log is captured from the beginning rather than from wherever esptool's reset left off.
  async bootReset(port) {
    if (!port.setSignals) return;
    try {
      await port.setSignals({dataTerminalReady: false, requestToSend: true});
      await new Promise((resolve) => setTimeout(resolve, 100));
      await port.setSignals({dataTerminalReady: false, requestToSend: false});
    } catch (e) {
      XXX(`boot log reset signals: ${e.message}`);
    }
  }
  // Reopen the port with plain WebSerial and stream it until stopped.
  monitorStart() {
    if (this.state.monitoring || !this.state.port) return this.state.monitorDone || Promise.resolve();
    this.state.monitoring = true;
    this.state.monitorDone = this.monitorRun(this.state.port)
      .catch((e) => XXX(`monitor run: ${e.message}`)) // cleanup below must run either way
      .then(() => {
        this.state.monitoring = false;
        this.state.monitorReader = null;
        this.logLine("---- monitor stopped ----");
        this.statusRender();
      });
    this.statusRender();
    return this.state.monitorDone;
  }
  /*
   * A board that deep-sleeps takes its USB serial with it - on native USB the port disappears
   * mid-log and comes back only when the board wakes - so the monitor has to outlive the port, the
   * way `pio device monitor` does. Stop is the only thing that ends this loop; every other way a
   * stream can end leads back to waiting for the port.
   */
  async monitorRun(port) {
    let streamed = false; // a stream has run, so a failure to open is the board going away
    let waiting = false;  // the outage has been reported: not once a second
    while (this.state.monitoring) {
      let err = null;
      let opened = null;
      for (const candidate of await this.monitorCandidates(port)) {
        err = await this.monitorOpen(candidate);
        if (!err) { opened = candidate; break; }
      }
      if (opened) {
        if (waiting) this.logLine("---- port back ----");
        waiting = false;
        port = this.state.port = opened; // Connect and Flash must use the live one too
        await this.monitorStream(port, !streamed); // only the first pass resets the board
        streamed = true;
      } else if (!waiting) {
        waiting = true;
        this.logLine(streamed ? `(port gone - waiting for the board: ${err})` : `(could not open port: ${err})`);
      }
      if (this.state.monitoring) await this.monitorWait(this.state.monitorRetryMs);
    }
  }
  // Settled early by monitorStop, so Stop is not left waiting out a retry delay
  monitorWait(ms) {
    return new Promise((resolve) => {
      this.state.monitorWake = resolve;
      setTimeout(resolve, ms);
    });
  }
  /*
   * A device that re-enumerates comes back as a NEW SerialPort: the object being held stays lost
   * for good, so reopening it can never succeed - which is why unplugging and plugging back in did
   * not bring the monitor back, while Connect, which asks for a port afresh, did.
   *
   * So each attempt tries every port this page already has permission for that looks like the same
   * device. The one being held comes first while it is still valid, since getPorts() hands back the
   * very same object for a device that never went away.
   */
  async monitorCandidates(port) {
    const info = (port && port.getInfo) ? port.getInfo() : {};
    const granted = (navigator.serial && navigator.serial.getPorts)
      ? await navigator.serial.getPorts().catch((e) => { XXX(`getPorts: ${e.message}`); return []; })
      : [];
    /*
     * The same USB device and nothing else. A Mac always offers Bluetooth-Incoming-Port and
     * debug-console, and quietly monitoring one of those is worse than not reconnecting at all -
     * neither has a usbVendorId, so requiring a matching one rules them out. If the port being held
     * has no vendor id either, there is nothing to match on and only it is retried: the user picked
     * it themselves, and a port like that does not re-enumerate anyway.
     */
    const sameDevice = info.usbVendorId ? granted.filter((p) => {
      const i = p.getInfo ? p.getInfo() : {};
      return i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId
        && !i.bluetoothServiceClassId;
    }) : [];
    return [...sameDevice, port].filter((p, i, all) => p && all.indexOf(p) === i);
  }
  async monitorOpen(port) {
    try {
      await port.open({baudRate: this.state.monitorBaudrate});
      return null;
    } catch (e) {
      return e.message;
    }
  }
  // cancel() settles the pending read(), so no polling is needed to notice the stop
  monitorStop() {
    if (!this.state.monitoring) return Promise.resolve();
    this.state.monitoring = false;
    const reader = this.state.monitorReader;
    if (reader) reader.cancel().catch((e) => XXX(`monitor cancel: ${e.message}`));
    if (this.state.monitorWake) this.state.monitorWake(); // it may be between attempts rather than reading
    return this.state.monitorDone || Promise.resolve();
  }
  onMonitor() {
    if (this.state.monitoring) { this.monitorStop(); return; }
    if (this.state.port) {
      // esptool still holds the port after Connect and it cannot be opened twice, so hand it over
      this.transportRelease().then(() => this.monitorStart());
      return;
    }
    const portPromise = navigator.serial.requestPort(); // inside the gesture, before any await
    portPromise
      .then((port) => { this.state.port = port; return this.monitorStart(); })
      .catch((e) => { this.state.error = e.message; this.logLine(`Error: ${e.message}`); this.statusRender(); });
  }
  // Takes an open port and always closes it, so monitorRun can open it again
  async monitorStream(port, firstPass) {
    this.logLine(`---- monitor (${this.state.monitorBaudrate} baud) ----`);
    let reader = null;
    let quiet = true;
    try {
      if (firstPass) await this.bootReset(port); // a reconnect must not reset a board that just woke
      if (!port.readable) throw new Error("port has no readable stream");
      const decoder = new TextDecoder();
      reader = port.readable.getReader();
      this.state.monitorReader = reader;
      const quietUntil = Date.now() + BootLogMs;
      while (this.state.monitoring) {
        // On the first pass silence is worth reporting - it usually means the wrong speed - and
        // read() on a quiet port may never resolve, so that needs a deadline. Afterwards the wait
        // is the point: a sleeping board settles the read when it wakes, and Stop cancels it.
        const chunk = (quiet && firstPass)
          ? await withTimeout(reader.read(), Math.max(250, quietUntil - Date.now()), 'timeout')
          : await reader.read();
        if (chunk === 'timeout' || chunk.done) break;
        if (chunk.value && chunk.value.length) {
          quiet = false;
          this.logWrite(decoder.decode(chunk.value, {stream: true}));
        }
      }
    } catch (e) {
      this.logLine(`(stream ended: ${e.message})`);
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch (e) { XXX(`monitor reader cancel: ${e.message}`); }
        try { reader.releaseLock(); } catch (e) { XXX(`monitor reader release: ${e.message}`); }
      }
      try { await port.close(); } catch (e) { XXX(`monitor port close: ${e.message}`); }
      if (quiet && firstPass) {
        this.logLine("(no output yet - check the monitor speed and that the build defines ANY_DEBUG. Still listening: a board on native USB drops the port when it sleeps and is picked up again when it wakes.)");
      }
    }
  }

  // ---- render ----
  statusLines() {
    const dev = this.state.device;
    const app = this.state.app;
    const lines = [];
    if (this.state.error) {
      lines.push(el('p', {class: 'error', i8n: false, textContent: this.state.error}));
    }
    // The loader is released after any flash attempt, so say why the Flash button is disabled
    if (dev && !this.state.esploader) {
      lines.push(el('p', {textContent: "Reconnect the board to flash again"}));
    }
    lines.push(el('p', {}, [
      el('span', {textContent: "Firmware"}),
      el('span', {i8n: false, textContent: app ? ` ${app.name} (${bytesToSizeString(app.bytes.length)})` : " -"}),
    ]));
    if (!dev) {
      lines.push(el('p', {textContent: "No board connected"}));
      return lines;
    }
    lines.push(el('p', {}, [
      el('span', {textContent: "Board"}),
      el('span', {i8n: false, textContent: ` ${dev.description} ${dev.flashSize}${dev.scheme ? ` (${dev.scheme})` : ''}`}),
    ]));
    if (dev.refusal) {
      lines.push(el('p', {class: 'error'}, [
        el('span', {textContent: "Unsupported board"}),
        el('span', {i8n: false, textContent: ` - ${dev.refusal}`}),
      ]));
      return lines;
    }
    if (dev.flashSizeGuessed) {
      // Held in state, not read off the checkbox - statusRender() rebuilds these elements
      lines.push(el('p', {class: 'warning'}, [
        el('label', {}, [
          el('input', {type: 'checkbox', checked: this.state.confirmed,
            onchange: (ev) => { this.state.confirmed = ev.target.checked; }}),
          el('span', {textContent: "Flash size was not detected reliably - flash anyway"}),
        ]),
      ]));
    }
    if (dev.inspected === false) {
      lines.push(el('p', {class: 'warning', textContent: "Could not read the board - assuming it is already provisioned"}));
    }
    if (dev.provision) {
      lines.push(el('p', {class: 'warning', textContent: "Full provision - all configuration on the board will be erased"}));
    } else {
      lines.push(el('p', {textContent: dev.hasConfig
        ? "Updating the app only - the existing configuration will be preserved"
        : "Updating the app only"}));
      lines.push(el('button', {class: 'submit', type: 'button', textContent: "Provision instead (erases config)",
        onclick: this.onProvisionOverride.bind(this)}));
    }
    return lines;
  }
  statusRender() {
    const status = this.state.elements.status;
    if (status) status.replaceChildren(...this.statusLines());
    const flashButton = this.state.elements.flashButton;
    if (flashButton) flashButton.disabled = !this.ready;
    const connectButton = this.state.elements.connectButton;
    if (connectButton) connectButton.disabled = this.state.busy;
    const monitorButton = this.state.elements.monitorButton;
    if (monitorButton) {
      monitorButton.textContent = getString(this.state.monitoring ? "Stop monitor" : "Monitor");
      monitorButton.disabled = this.state.busy;
    }
  }
  render() {
    if (!this.supported) {
      return [
        el('link', {rel: 'stylesheet', href: CssUrl}),
        el('div', {class: 'mqtt-flash'}, [
          el('h4', {textContent: "Flash over USB"}),
          el('p', {textContent: "Flashing needs the Web Serial API - use Chrome, Edge or Opera on a desktop computer"}),
        ]),
      ];
    }
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'mqtt-flash'}, [
        el('h4', {textContent: "Flash over USB"}),
        el('label', {for: 'flashfile', textContent: "Firmware file"}),
        el('input', {id: 'flashfile', type: 'file', accept: '.bin', onchange: this.onLocalFile.bind(this)}),
        el('label', {for: 'flashbaud', textContent: "Speed"}),
        el('select', {id: 'flashbaud', onchange: (ev) => { this.state.baudrate = Number(ev.target.value); }},
          FlashBaudRates.map((b) => el('option', {i8n: false, value: b, textContent: String(b)}))),
        el('label', {for: 'monitorbaud', textContent: "Monitor speed"}),
        el('select', {id: 'monitorbaud', onchange: (ev) => { this.state.monitorBaudrate = Number(ev.target.value); }},
          MonitorBaudRates.map((b) => el('option', {i8n: false, value: b, textContent: String(b)}))),
        this.state.elements.connectButton = el('button', {class: 'submit', type: 'button',
          textContent: "Connect board", onclick: this.onConnect.bind(this)}),
        this.state.elements.flashButton = el('button', {class: 'submit', type: 'button', disabled: true,
          textContent: "Flash", onclick: this.onFlash.bind(this)}),
        this.state.elements.monitorButton = el('button', {class: 'submit', type: 'button',
          textContent: "Monitor", onclick: this.onMonitor.bind(this)}),
        this.state.elements.status = el('div', {class: 'flash-status'}, this.statusLines()),
        this.state.elements.progress = el('progress', {max: 100, value: 0}),
        this.state.elements.log = el('pre', {class: 'flash-log', i8n: false}),
      ]),
    ];
  }
}
customElements.define('mqtt-flash', MqttFlash);

