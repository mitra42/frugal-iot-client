# Plan: Flash a board over USB from the OTA tab

## Goal

Let a user plug an ESP board into their laptop and flash it directly from the OTA tab — both a
*virgin* board (bootloader + partition table + otadata + app) and an *already-provisioned* board
(app only, preserving its LittleFS config). The app image is either a local `.bin` or one of the
files already listed in the OTA tab.

This complements OTA rather than replacing it: OTA handles boards that are already on WiFi and
talking to the broker; USB flashing handles first provisioning and recovery of boards that can't be
reached.

---

## Library

[`esptool-js`](https://github.com/espressif/esptool-js) — Espressif's official JS port of
`esptool.py`, Apache-2.0. Drives the ESP ROM bootloader over the Web Serial API.

Use **`node_modules/esptool-js/bundle.js`**, not the package's default `lib/index.js` entry:

| | `lib/index.js` | `bundle.js` |
|---|---|---|
| Bare imports | `pako`, `tslib`, `atob-lite` | none — all inlined |
| CommonJS deps | `atob-lite` is CJS, breaks in a browser ESM context | n/a |
| Network calls | none | none — flasher stubs inlined as base64 |
| Size | many files | one file, ~214 KB |

So it fits the existing no-build-step, import-map setup with a single line. Exports used:
`ESPLoader`, `Transport`.

### Browser support

| Constraint | Consequence |
|---|---|
| Web Serial = Chrome/Edge/Opera ≥89, desktop only | Feature-detect `'serial' in navigator`; render an explanation instead of the UI when absent. No Firefox, no Safari, no iOS — ever. |
| Requires a secure context | Already satisfied (`https://localhost:8080` in dev, HTTPS in production). |
| Requires a user gesture | `navigator.serial.requestPort()` must be called synchronously in the click handler, before any `await`. |
| Android Chrome | Only via `web-serial-polyfill` (WebUSB), and it fails on CH340 adapters because the kernel driver claims the device. Not supported in v1. |

---

## The app-only vs. full-image problem

The `.bin` files the OTA tab already handles are **application images**, not complete flash images:

- **ESP8266** — Arduino's `firmware.bin` *is* the whole image (eboot included). Flash at `0x0`. Works
  on a virgin chip. None of the "base" machinery below applies.
- **ESP32 family** — app-only. Needs a bootloader, partition table and otadata already present, or it
  will not boot.

So an ESP32 board needs three extra regions that are **independent of your sketch**:

| Piece | Depends on | Per-app? |
|---|---|---|
| `bootloader.bin` | chip + flash mode/freq | No |
| `partitions.bin` | partition scheme (`min_spiffs`, `frugal_8mb`, …) | No |
| `boot_app0.bin` | nothing — fixed 8192-byte blob | No |
| `firmware.bin` | your app | Yes — this is what the OTA tab already stores |

Call those three a **base bundle**. Harvest once per chip, reuse for every app build.

### Why the base can't be generated in the browser

Both Arduino core 3.3.11 and PlatformIO ship the bootloader as **`.elf` only** — e.g.
`~/Library/Arduino15/packages/esp32/tools/esp32c3-libs/3.3.11/bin/bootloader_dio_80m.elf` and
`~/.platformio/packages/framework-arduinoespressif32-libs/esp32c3/bin/` — and convert to `.bin` with
`esptool elf2image` at build time. Only `default.bin` (3072 bytes) and `boot_app0.bin` (8192 bytes)
ship prebuilt; other partition schemes are generated from `.csv` by `gen_esp32part.py` during the
build.

**esptool-js deliberately does not implement `elf2image`.** So base binaries must be harvested from a
completed build and committed, not built on demand.

Where to find them after a build:

| Toolchain | bootloader | partition table |
|---|---|---|
| PlatformIO | `.pio/build/<env>/bootloader.bin` | `.pio/build/<env>/partitions.bin` |
| Arduino IDE | `build/<board>/frugal-iot.ino.bootloader.bin` | `build/<board>/frugal-iot.ino.partitions.bin` |

`boot_app0.bin` comes straight from the core: `tools/partitions/boot_app0.bin`.

Total per chip: bootloader ~20–26 KB + partitions 3 KB + boot_app0 8 KB ≈ **35 KB**. Small enough to
commit.

### The bundle matrix collapses — no chip×size product

This matters because the boards belong to *users of this project*, not to us, so the set of flash
sizes in the wild is open-ended. Fortunately the three base parts vary along different axes, and none
of them along both:

| Part | Varies by | Files needed |
|---|---|---|
| `bootloader.bin` | chip **only** — *not* flash size | one per chip (3) |
| `boot_app0.bin` | nothing | **one, globally** |
| `partitions.bin` | partition scheme **only** — chip-independent | one per scheme |

- The bootloader is flash-size-independent because esptool patches the flash size/mode/freq bytes into
  the header of whatever image is written at the bootloader offset (`updateImageFlashParams` in the
  bundle). Corroboration: the Arduino core ships exactly four bootloader ELFs per chip
  (`dio`/`qio` × `40m`/`80m`) and uses them across all board variants regardless of flash size.
- `partitions.bin` is chip-independent because `gen_esp32part.py` output is just the table — no chip
  fields. A `min_spiffs` table is byte-identical for C3 and S3.

So supporting a new flash size means adding **one** `partitions.bin`, with no chip-specific work, and
supporting a new chip means adding **one** `bootloader.bin`.

### Ship `dio` bootloaders only

Flash mode (`qio` vs `dio`) is **not detectable** from the chip, and the bootloader is built per mode.
`dio` works on every board (`qio` is merely faster), so shipping only the `dio_80m` bootloader
removes the variable entirely.

Pass `flashSize` as the **literal detected size string** (`"4MB"`), not `"detect"`. `"detect"` is a
legal `FlashSizeValues` member but *not* on this code path: `writeFlash` calls `flashSizeBytes()`,
which only parses `"KB"`/`"MB"` substrings and returns `-1` for anything else. Every file then fails
`data.length + address > -1`, so `writeFlash` throws `File 1 doesn't fit in the available flash`
before erasing or writing a single byte — a silent-looking failure with no board activity at all.
(`parseFlashSizeArg()` would likewise reject it, since `chip.FLASH_SIZES` only has `1MB`…`128MB`.)

Passing the real size is better than the other legal option, `"keep"`: `"keep"` skips the bounds check
entirely, whereas a literal size both patches the header correctly and gives a free
does-it-fit-in-flash guard on top of our own app-partition check.

Pass **`flashMode: "keep"` and `flashFreq: "keep"`** rather than naming `dio`/`80m` explicitly. The
shipped bootloaders are already built `dio_80m`, so `keep` preserves exactly the intended settings —
and it matters on ESP8266, where the *application* image sits at the bootloader offset and so would
itself be rewritten with mode/frequency settings its flash may not support. Only the size gets
patched.

### Octal (OPI) flash is not supported — detect and refuse

`FlashModeValues` is `"keep" | "dio" | "qio" | "dout" | "qout"` — there is **no `opi`**. So ESP32-S3
modules with octal flash (ESP32-S3-WROOM-2, 16/32 MB) cannot be flashed by esptool-js in their native
mode. This is the one real S3 gap; flash *size* detection is fine (see below).

These boards must be identified and refused with an explanatory message rather than half-flashed into
a dead state. A practical signal is `detectFlashSize()` landing on its unrecognized-capacity fallback
on an S3 — OPI flash not answering a standard RDID in default SPI mode is the likely cause. This
needs confirming against a real WROOM-2 before the message is written as a certainty.

---

## No board dropdown — detect the chip

esptool-js supplies everything needed to pick the base without asking the user:

| What | How |
|---|---|
| Chip | `esploader.chip.CHIP_NAME` after `await esploader.main()` → `"ESP32-C3"` |
| Flash size | `await esploader.detectFlashSize()` → reads the JEDEC capacity byte (`readFlashId() >> 16 & 0xFF`) against `DETECTED_FLASH_SIZES` |
| Bootloader offset | `esploader.chip.BOOTLOADER_FLASH_OFFSET` → `0x0` / `0x1000` / `0x2000` |
| Extra display info | `getChipDescription()`, `getChipRevision()`, `getFlashVendor()`, `getPsramCap()` |

Base selection is therefore `f(chip, flashSize)`. Pin variants (`ESP8266_D1`,
`ARDUINO_LOLIN_C3_PICO`, `ARDUINO_LOLIN_S2_MINI`, S3T3 …) are irrelevant here — the bootloader and
partition table depend only on chip, flash mode/freq and partition scheme. Board differences are
already covered by *which OTA file the user picks*.

### Flash-size detection is chip-agnostic, including S3

`DETECTED_FLASH_SIZES` is defined **once** in the whole bundle, on `ESPLoader` itself rather than on
any ROM class — so an S3 takes exactly the same path as a C3. The table maps the JEDEC capacity byte:

```
0x16 → 4MB    0x17 → 8MB    0x18 → 16MB   0x19 → 32MB   0x1A → 64MB   0x1B → 128MB
```

plus the `0x20–0x22` and `0x32–0x3A` alternate vendor encodings. Every realistic S3 board (4/8/16/32
MB) reports correctly, so the tool can pick the right partition table without asking the user which
board they have.

`getFlashCap()` (eFuse `EFUSE_BLOCK1 + 12`, bits 27–29) is available as a secondary cross-check, but
it reports *in-package* flash capacity only and is meaningless for modules with external flash — so
it is a sanity check, not the primary source.

**One trap:** `detectFlashSize()` falls back to `"4MB"` with only a log line when the capacity byte
is unrecognized. That is exactly the case that would brick a 2 MB board — and on an S3 it is also the
likely signature of unsupported octal flash. Always display the detected size, and when it came from
the fallback rather than a real table match, require explicit confirmation instead of proceeding.

Because distinguishing a real 4 MB from the fallback 4 MB requires the table, and because reading a
property off a minified bundle is a fragile dependency, the client keeps its own copy of the
capacity-byte map (`DetectedFlashSizes`) and derives both the size and the *was-it-guessed* flag from
that. It is a stable JEDEC convention, so the duplication is cheap.

---

## Deciding provision vs. app-only automatically

This can be decided with high confidence by reading the flash back before writing — `esploader`
exposes `readFlash()`, and with the stub loaded, reading ~7 KB is fast.

1. Read 3 KB at `0x8000`. Absent partition-table magic (`AA 50`) → no valid layout → **provision**.
2. Parse the on-device table and check the **app slot only** — `app0` at `0x10000`, size `0x1E0000`.
   Differs → the board is laid out for something else → **provision**.
3. Read 4 bytes at `chip.BOOTLOADER_FLASH_OFFSET`. Not `0xE9` → **provision**.
4. Read the first 4 KB of the on-device FS partition (offset from *its* table, not ours) and look for
   the littlefs superblock magic — the ASCII string `littlefs`. Present → a filesystem exists worth
   preserving → **app-only**.

Comparing only the app slot rather than the whole table is deliberate, and it's what the fixed app
geometry buys: a board whose FS partition is a different size than our scheme would produce is still
perfectly safe to update app-only. That correctly covers a board provisioned by an earlier version of
this tool, or flashed by hand from PlatformIO with stock `min_spiffs`, instead of needlessly wiping
its config.

That resolves the "is it virgin?" question definitively. The one residue is step 4's blind spot: a
matching partition table plus a valid LittleFS **belonging to a different project**. Flash contents
alone can't distinguish that without mounting the filesystem in the browser (see the LittleFS option
below, which this plan does not adopt).

The mitigation is to make the wrong guess cheap rather than to chase certainty:

- Default to **app-only** in that case and say so plainly in the UI ("existing config found — will be
  preserved"), with a **Provision instead (erases config)** button beside it.
- Stream the serial boot log after reset (see below). If the board comes up with the wrong
  project/WiFi, the user hits Provision and loses ten seconds.

So: automatic, with the residual ambiguity surfaced rather than guessed, and a one-click recovery.

---

## Writing config at flash time

The firmware keeps config in **LittleFS, not NVS** — `src/system/fs.h` does `#define ESPFS LittleFS`,
and the layout is `data/wifi/<ssid>` (content = password) plus `data/frugal_iot/`. So the partition
to pre-write would be the filesystem.

It is also **already solved without the flasher**: `src/system/captive.cpp` is a captive portal whose
"main use is for setting the WiFi settings", with `addString`/`addNumber`/`addBool` over arbitrary
`topicTwig`s. Pre-writing config is a convenience for bulk provisioning, not a requirement.

Three routes, in the order this plan prefers them:

1. **Captive portal (v1 — no new code).** Flash, then the user joins the board's AP and configures it.
   Works today.
2. **Serial hand-off (v2 — small firmware addition).** We still hold the serial port after flashing.
   Keep it open and let the firmware accept `topicTwig value` pairs on serial —
   `System_Captive::dispatch` already consumes that shape, so it reuses existing plumbing. Bonus: it
   becomes a *re-configure* tool, not just a provision-time one.
3. **Build a LittleFS image in the browser (not adopted).**
   [`littlefs-project/littlefs-js`](https://github.com/littlefs-project/littlefs-js) (MIT, emscripten
   build of upstream littlefs) or [`hurzhurz/littlefs-image-creator`](https://hurzhurz.github.io/littlefs-image-creator/)
   (`lfs.js`, 193 KB, license unstated on the repo). Neither is on npm, so this means committing a
   ~200 KB wasm/asm.js blob, and it couples the client to the firmware's exact geometry: block size
   4096, block count = FS partition size / 4096 (`0x20000` = 128 KB under `min_spiffs`, so only 32
   blocks), and the littlefs *on-disk version* — a v2.0/v2.1 mismatch presents as an unformatted
   filesystem, silently wiping the config just written. Not worth it to replace a working captive
   portal; revisit only if high-volume provisioning makes the AP-join step the bottleneck.

**Worth building regardless:** stream the serial boot log into the flasher UI after reset. We own the
port already, it confirms the flash actually booted, and it shows the AP name to join.

---

## Base bundles

Committed to this repo and served by the existing static handler. Because the parts vary along
independent axes (see above), they are stored **de-duplicated** rather than as a chip×size matrix:

```
base/
  boards.json
  boot_app0.bin                  8 KB   — one file for everything
  bootloader/
    esp32c3.bin                 ~24 KB  — dio_80m, any flash size
    esp32s2.bin
    esp32s3.bin
  partitions/
    min_spiffs.bin               3 KB   — chip-independent (Arduino stock, 4 MB)
    min_spiffs.csv                      — provenance for the above
    frugal_8mb.bin                      — custom, see below
    frugal_8mb.csv
    frugal_16mb.bin
    frugal_16mb.csv
```

Target chip set: **ESP8266** (no base needed at all), **ESP32-C3**, **ESP32-S2**, **ESP32-S3**.
`min_spiffs` for the smaller chips, per Frugal IoT convention.

### Partition schemes: fixed app size, all spare space to LittleFS

Bigger boards get the *same* app partitions as a 4 MB board, with the surplus going to the
filesystem. Arduino's stock large-flash schemes do the opposite (`default_8MB` gives 3.1 MB app
slots and only 1.5 MB of FS), so these are custom tables.

Starting from stock `min_spiffs` (4 MB), which is unchanged:

| Partition | Type/Subtype | Offset | `min_spiffs` (4 MB) | `frugal_8mb` | `frugal_16mb` |
|---|---|---|---|---|---|
| `nvs` | data/nvs | `0x9000` | `0x5000` | `0x5000` | `0x5000` |
| `otadata` | data/ota | `0xe000` | `0x2000` | `0x2000` | `0x2000` |
| `app0` | app/ota_0 | `0x10000` | `0x1E0000` | `0x1E0000` | `0x1E0000` |
| `app1` | app/ota_1 | `0x1F0000` | `0x1E0000` | `0x1E0000` | `0x1E0000` |
| `spiffs` | data/spiffs | `0x3D0000` | `0x20000` (128 KB) | `0x420000` (4.125 MB) | `0xC20000` (12.125 MB) |
| `coredump` | data/coredump | *varies* | `0x3F0000` | `0x7F0000` | `0xFF0000` |

App partitions stay 64 KB-aligned and the FS partition stays 4 KB-aligned in all three, and each
table sums exactly to its flash size.

**Two consequences worth relying on:**

1. **The app image is flash-size-independent.** `app0` has the same offset *and* size in every
   scheme, so one `firmware.bin` flashes to a 4, 8 or 16 MB board. The OTA files in the tab need no
   per-size variants, and the app-only path always writes at `0x10000`.
2. **A 1.875 MB app slot is generous** and unchanged from what 4 MB boards already run, so nothing
   about existing builds needs revisiting.

**Keep the label `spiffs`, even though the content is LittleFS.** Arduino's LittleFS mounts by
partition label, defaulting to `"spiffs"`
(`LittleFS.h`: `begin(bool formatOnFail = false, const char *basePath = "/littlefs", uint8_t maxOpenFiles = 10, const char *partitionLabel = "spiffs")`).
Renaming the partition to `littlefs` would stop the firmware mounting it unless `begin()` is also
changed. Not worth the coupling.

These CSVs are Frugal IoT's own, so they belong in the **firmware** repo (so builds can reference them
via `board_build.partitions`), with the generated `.bin` plus a copy of the `.csv` committed here for
the flasher. Generate with the core's `tools/gen_esp32part.py`, or just harvest
`.pio/build/<env>/partitions.bin` from a build configured with that CSV.

`boards.json` maps a detected `<chip>-<flashsize>` to the parts to use, so lookup after detection is
a single key:

```json
{
  "schemeByChipAndSize": {
    "ESP32-C3-4MB": "min_spiffs",
    "ESP32-S2-4MB": "min_spiffs",
    "ESP32-S3-4MB": "min_spiffs",
    "ESP32-S3-8MB": "frugal_8mb",
    "ESP32-S3-16MB": "frugal_16mb"
  },
  "bootloaderByChip": {
    "ESP32-C3": "bootloader/esp32c3.bin",
    "ESP32-S2": "bootloader/esp32s2.bin",
    "ESP32-S3": "bootloader/esp32s3.bin"
  },
  "otadata": "boot_app0.bin",
  "coreVersion": "esp32-3.3.11",
  "version": 1
}
```

Adding a flash size is one line here plus one `partitions/*.bin`. An unlisted `<chip>-<flashsize>`
combination is a clean "unsupported board" message, not a guess.

The three regions to write, with offsets derived rather than hardcoded:

- `bootloader` → `esploader.chip.BOOTLOADER_FLASH_OFFSET`
- `partitions` → `0x8000`
- `otadata` → **parsed out of `partitions.bin`**

### Parse the partition table

`partitions.bin` is a flat array of 32-byte records: magic `AA 50` (2), type (1), subtype (1),
offset (u32 LE), size (u32 LE), 16-byte label, flags (u32). Type `0x00` = app (subtype `0x00`
factory, `0x10` ota_0), type `0x01` = data (subtype `0x00` otadata, `0x02` nvs, `0x83` littlefs).

~30 lines of parsing yields:

- the **otadata** offset → where `boot_app0.bin` goes
- the **app slot** offset and size → where the app goes and how large it may be
- the **FS slot** offset and size → what to probe in step 4 of the provision/update decision

So the app's flash address is data-driven from the selected base, never a hardcoded `0x10000`, and
the "does this app fit?" check comes free.

### Record the core version

An Arduino-core 3.x bootloader boots 3.x apps fine, but crossing a major core version can require
re-provisioning. `coreVersion` in `boards.json` makes a stale base visible rather than mysterious,
and needs refreshing when the firmware's core is bumped.

### Contributing a new board

Since the boards belong to users of this project, document the harvest path so a contributor can add
support without touching the client code:

1. Build the firmware for the board.
2. If the **chip** is new, copy `bootloader.bin` to `base/bootloader/<chip>.bin`.
3. If the **flash size** is new, write a CSV following the table above — same app partitions, all
   surplus to `spiffs` — and commit both it and the generated `.bin` to `base/partitions/`.
4. Add one `"<CHIP>-<SIZE>": "<scheme>"` line to `schemeByChipAndSize`.

`boot_app0.bin` never needs touching, and the app binary never needs rebuilding for a different flash
size.

---

## Refuse-before-writing checks

All four are **refusals, not warnings** — a bad combination here means a board that doesn't boot.

1. Detected chip must match the base's `chip`.
2. App image: byte 0 == `0xE9`, and for ESP32-family images `chip_id` (u16 LE at offset 12) ==
   `esploader.chip.IMAGE_CHIP_ID` (0=ESP32, 2=S2, 5=C3, 9=S3, 12=C2, 13=C6, 16=H2 — the ROM classes
   expose it). This catches the classic "C3 build onto a D1 Mini".
3. App byte length ≤ app-slot size from the parsed partition table. Catches a `min_spiffs` app
   dropped onto a `default`-scheme board.
4. `detectFlashSize()` must produce a `<chip>-<flashsize>` key present in `schemeByChipAndSize` — and
   if the size came from the `"4MB"` fallback, require confirmation (and on an S3, warn about octal
   flash).

---

## Client changes

### 1. Dependency and import maps

`npm i esptool-js`, then add to the import map in **all five** pages that load `webcomponents.js`:

```json
"esptool-js": "/node_modules/esptool-js/bundle.js"
```

- `index.html`, `index-project.html`, `login.html`, `dashboard_example.html` — relative path as above.
- `index-embedded.html` — use the absolute form to match its existing entries:
  `https://frugaliot.naturalinnovation.org/node_modules/esptool-js/bundle.js`.

Load it **lazily** — `await import('esptool-js')` inside the click handler — so 214 KB never hits a
plain dashboard page load.

### 2. New `MqttFlash` element in `webcomponents.js`

Per CLAUDE.md this belongs in the main file, not a dashboard. It has no MQTT topic, so it extends
`HTMLElementExtended` directly rather than `MqttReceiver`.

Renders: a **Connect** button, a detected-hardware line, an app-source selector (local file or one of
the listed OTA files), a **Flash** button, a progress bar, and a `<pre>` log driven by esptool-js's
`IEspLoaderTerminal` (`{clean, write, writeLine}`) and then by the post-reset boot log.

State refs go in `this.state.elements` and update in place, per the existing pattern.

### 3. Wire it into the OTA tab

Add a `el('section', …)` to `otaRestContent()` ([webcomponents.js:3086](webcomponents.js#L3086)),
after the existing upload form, guarded on `'serial' in navigator`.

### 4. Add ⚡ to the OTA file list

`otaFilesList()` ([webcomponents.js:2244](webcomponents.js#L2244)) lists directories (`myproject/node42`,
`+/esp32c3`), each holding a `firmware.bin`. Add a ⚡ pseudolink beside the existing 🗑 that selects
that file as the flash source.

Fetching the bytes needs `fetch(url)` → `new Uint8Array(await res.arrayBuffer())`. `GET()` from
html-element-extended parses JSON and won't do here.

### 5. Flash sequence

```javascript
const port = await navigator.serial.requestPort();        // synchronous in the click handler
const transport = new Transport(port, true);
const esploader = new ESPLoader({transport, baudrate: 921600, terminal});
const chip = await esploader.main();                      // detect + return chip name
const flashSize = await esploader.detectFlashSize();
// … pick base, read back flash, decide provision vs app-only, run refusal checks …
await esploader.writeFlash({
  fileArray,                                              // [{data: Uint8Array, address: number}, …]
  flashSize: 'detect', flashMode: 'dio', flashFreq: '80m',
  eraseAll: provisioning, compress: true, reportProgress,
});
await esploader.after();                                  // hard reset into the new app
// … stream boot log …
await transport.disconnect();
```

`fileArray.data` is a **`Uint8Array`** — older 0.4.x tutorials pass a binary string; that API is
gone. A full provision is one `writeFlash` call with four entries, so the user connects once and the
board resets once.

### 6. Baud rate

Start at 921600. CH340-based D1 Minis are often happier at 460800 — make it a dropdown if real
hardware proves flaky.

### 7. MD5 verification

`calculateMD5Hash` is optional in `FlashOptions`, and esptool-js ships no MD5 of its own. `hash-wasm`
(what the server uses) is async and cannot satisfy the sync `(Uint8Array) => string` signature. Omit
it initially and confirm `writeFlash` skips verification cleanly rather than throwing; if
verification matters, add a small sync MD5 helper.

### 8. Async style

esptool-js is promise-native, so this is an acknowledged exception to CLAUDE.md's callback
preference: keep one `async` function and bridge to a callback at the boundary so calling code stays
callback-style.

### 9. i18n

Every new string added to all four language sections (EN/FR/HI/ID). Use `textContent` — literal
strings passed as `el()` *children* bypass translation entirely.

---

## Server changes (frugal-iot-server)

### 1. Required: a route to download an OTA binary

`/ota_list/:org` returns directory names only. Phase 4 above needs the bytes. Add, mirroring the auth
of the existing `/ota_delete` route (`frugal-iot-server.js:900`):

```javascript
app.get('/ota_get/:org/*remainingpath',
  loggedInOrFail,
  can_OTAUPDATE,
  (req, res) => {
    const remainingpath = req.params.remainingpath.join('/');
    res.sendFile(`${config.server.otadir}/${req.params.org}/${sanitize(remainingpath)}/firmware.bin`);
  }
);
```

Do **not** reuse the existing `GET /ota_update/:org/:project/:node/:attribs`
(`frugal-iot-server.js:708`) for this. It is intentionally unauthenticated (nodes call it) and applies
MD5/304 logic that would return `304` instead of bytes.

### 2. No change needed: serving `base/`

The client directory is `config.server.htmldir`, served by `express.static` under **`/dashboard`** —
not by the `publicdir` catch-all, which is a different directory. So the base files are reachable at
`/dashboard/base/...`, and the client must therefore use a **relative** URL (`./base`), exactly as
`CssUrl = './frugaliot.css'` already does. An absolute `/base/...` would 404.

Two caveats:

- That handler sets `immutable, maxAge: 1 day`. If a base binary is ever corrected in place, browsers
  hold the stale copy for a day. Cheap fix — carry the `version` from `boards.json` as a query string
  when fetching the parts.
- A relative URL means the flasher only works on a page served from the client directory. That is
  fine for the OTA tab, but the flasher could not be dropped into an externally hosted
  `index-embedded.html` without switching to an absolute base URL.

### 3. Verify only: no restrictive `Permissions-Policy`

Web Serial in a top-level page needs no special header, but a `Permissions-Policy` response header
that omits `serial` would block it. Confirm the server sends none; if the flasher is ever placed in
an iframe, the *parent* page needs `allow="serial"` on the iframe.

### 4. Explicitly not needed: COOP/COEP

`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` are only required for
`SharedArrayBuffer`, which none of this uses. Adding them would break other things for no benefit.

---

## Phasing

| Phase | Delivers | Server change | Status |
|---|---|---|---|
| 1 | `MqttFlash` element; local `.bin`; chip + flash-size detection; app-only flash at the detected app-slot offset; progress + esptool log | none | built |
| 2 | Base bundles committed for C3/S2/S3; partition-table parsing; full provision in one `writeFlash`; all four refusal checks | none | built |
| 3 | Read-back detection of provision vs. app-only, with the override button; serial boot log streamed after reset | none | built |
| 4 | ⚡ on the OTA file list — flash a server-hosted binary | `/ota_get` route | built |
| 5 | *(optional)* serial config hand-off, needs a firmware addition | none | not started |

### The bootloader must come from the same framework as the firmware

**This was the root cause of a long debug and is the single most important thing on this page.**

Base bootloaders must be generated from the framework the firmware is *built against*, not from
whatever ESP32 core happens to be installed. Frugal IoT builds with **pioarduino's**
platform-espressif32, so:

```bash
esptool --chip esp32c3 elf2image --flash-mode dio --flash-freq 80m --flash-size 4MB \
  -o base/bootloader/esp32c3.bin \
  ~/.platformio/packages/framework-arduinoespressif32-libs/esp32c3/bin/bootloader_qio_80m.elf
```

Note it is the **`qio_80m` ELF with the header patched to DIO** — that is what pioarduino does, and the
result is byte-identical to `.pio/build/<env>/bootloader.bin`. The Arduino IDE core's `dio_80m` ELF
produces a *different* binary (18688 vs 19520 bytes) which does not work.

**The symptom is deeply misleading.** With a mismatched bootloader the board boots, the app runs, and
sensors, WiFi scanning and MQTT queuing all work — but LittleFS fails:

```
E esp_littlefs: lfs.c:1383:error: Corrupted dir pair at {0x0, 0x1}
E esp_littlefs: mount failed,  (-84)
E [LittleFS.cpp:107] format(): Formatting LittleFS failed! Error: -1
```

Nothing points at the bootloader. Hours went into littlefs disk formats before spotting it.

**The diagnostic that finds it in seconds:** compare the ROM banner's second-stage loader sizes
between a known-good IDE flash and one of ours.

| | |
|---|---|
| after an IDE flash (works) | `load:0x3fcd5820,len:0x110c` `len:0xb54` `len:0x2f8c` |
| after ours, wrong bootloader | `load:0x3fcd5820,len:0x1010` `len:0x9f4` `len:0x2ea4` |

Different lengths mean different bootloaders. Always check this first when a provisioned board
misbehaves in any way.

### The filesystem partition is left erased — the firmware formats it

Provisioning writes **four** regions (bootloader, partition table, otadata, app) and deliberately does
*not* touch the filesystem partition. `LittleFS.begin(true)` formats it on first boot, and the log
reads:

```
LittleFS E esp_littlefs: ... Corrupted dir pair at {0x0, 0x1}   <- expected, partition is erased
E esp_littlefs: mount failed,  (-84)                             <- expected
[E] disableCore0WDT()                                            <- format() running
initialization done.                                             <- formatted and mounted
Creating:/frugal_iot ... Creating:/mqtt                          <- directories created
```

Those first two error lines are normal on a freshly provisioned board and are **not** a fault.

This was not obvious. An earlier iteration shipped pre-formatted blank images because `format()` was
failing with `-1` — but that turned out to be the bootloader mismatch above, and once the bootloader
was right the firmware formatted its own partition without help. The machinery was removed. Recorded
in case it is ever needed again (an **ESP8266** would need it, since its `ESPFS.begin()` takes no
format-on-fail argument):

- pioarduino's builder uses **`littlefs-python`**, not `mklittlefs`, with
  `read_size=1, prog_size=1, cache_size=block_size, lookahead_size=32, block_cycles=500, name_max=64,
  disk_version=2.1`. `prog_size=1` is the critical one — other tools pad metadata commits to 128 or
  256 bytes, whose CRCs then fail to validate and produce `Corrupted dir pair`.
- `mklittlefs` 0.2.3 emits disk 2.0 with 256-byte padding; `@wasm-os/mklfs` 0.1.0 emits disk 2.1 but
  `name_max` 255, over `CONFIG_LITTLEFS_OBJ_NAME_LEN=64`, with no wasm export to change it. **Neither
  produces a mountable image.**
- A blank filesystem is 8 KB whatever the partition size — only the superblock pair has content.

### Other bring-up fixes worth remembering

- **`flashSize` must be a literal size string.** `writeFlash`'s `flashSizeBytes()` only parses
  `"KB"`/`"MB"`; `'detect'` becomes `-1` and every file fails its fits-in-flash check, throwing before
  a single byte is written.
- **Never let a failed diagnostic read default to erasing.** `deviceInspect` originally treated an
  unreadable board as "needs provisioning", which silently erased a working board.
- **`readFlash` waits `FLASH_READ_TIMEOUT` = 100 s** for its first packet. Bound every read or Connect
  appears to hang.
- **`eraseAll` is silently ignored unless the stub is running** (`IS_STUB && eraseAll`).
- **`base/` is served `immutable, maxAge: 1 day`.** `boards.json` must be fetched with
  `cache: 'no-cache'` and the part binaries cache-busted with its `version`, or edits are invisible
  for a day and you debug a stale manifest.
- **Verify writes before resetting.** Provisioning reads the partition table back and reports whether
  it matches. Reading the *filesystem* back after a boot is useless — the app rewrites block 0 on its
  first mount attempt, so a post-boot readback never shows what was written. That trap cost real time.

### What is verified, and what still needs a board

Verified without hardware: partition tables round-trip to the intended geometry (app slot identical in
all three schemes, each table summing exactly to its flash size); parsing of real `partitions.bin`
files, of erased flash, and of garbage; littlefs superblock detection; `imageChipId`; `boards.json`
internally consistent and every referenced file present; base files served correctly at
`/dashboard/base/...` and byte-identical over HTTP; `/ota_get` returns 401 unauthenticated.

Confirmed on hardware (ESP32-C3, 4 MB): ⚡ selects a server-hosted binary; `Connect board` resolves it
to `4MB (min_spiffs)`; **app-only flash writes and verifies** — 1365808 bytes (828304 compressed) at
`0x10000` in 10.8 s, followed by a successful hard reset. `calculateMD5Hash` being omitted is fine —
`writeFlash` skips verification without complaint.

Three bugs fixed during bring-up:

1. `flashSize: "detect"` made `writeFlash` throw before touching the board (see above).
2. Any flash attempt releases the loader, so the Flash button correctly stayed disabled but gave no
   visible reason. Errors now render in the status area with a "reconnect" prompt.
3. The boot log was hard-coded to 115200 and its read loop could not time out. `reader.read()` never
   resolves on a silent port and the `while (Date.now() < deadline)` condition is only tested
   *between* reads, so a quiet board hung the whole operation with no closing marker. The loop now
   races each read against the deadline, always terminates, and says why it saw nothing.

### Serial monitor

The log is a real monitor, not a fixed capture: it streams until **Stop monitor** is pressed. The
original 25-second window turned out to be an arbitrary cutoff that ended a working log mid-stream,
so the timeout now covers only the case where *nothing at all* arrives — once the first byte lands,
plain `read()` runs indefinitely and `monitorStop()` settles the pending read with `cancel()`, so no
polling is involved.

`Monitor` also works standalone, requesting a port if none is held, so a running board can be watched
without flashing it. It is stopped before `Connect` since esptool cannot open a port the monitor holds.

### Serial monitor speed

frugal-iot's `startSerial()` picks the rate by toolchain, so the boot log needs a selector rather
than a constant:

| Build | Rate |
|---|---|
| PlatformIO | `SERIAL_BAUD`, default **460800** |
| Arduino IDE | **115200** |
| ESP8266 ROM boot messages | 74880 |

Two further reasons a boot log can be legitimately empty, both reported in the log rather than left
mysterious: the firmware only prints when built with **`ANY_DEBUG`**, and `startSerial()` deliberately
waits 5 s before its first line (hence a 25 s capture window).

**Full provisioning is confirmed working** on an ESP32-C3 4 MB (LOLIN C3 Pico, `min_spiffs`): erase,
bootloader, partition table, otadata, blank filesystem and app in one pass, after which the board
mounts LittleFS, creates its `/wifi`, `/frugal_iot`, … directories and brings up the captive portal at
192.168.4.1. App-only update is confirmed too.

Confirmed with the filesystem partition left erased: the firmware formats and mounts it itself, so no
blank-filesystem image is shipped.

Still untested:

- the **S2 and S3 bootloaders**, generated with the same recipe but never checked against a reference
  build from those boards
- whether 921600 baud is reliable on CH340 adapters, or the default should drop to 460800
- whether unsupported octal flash on an S3 really does surface as the capacity-byte fallback
- ESP8266 end to end (single whole image at `0x0`, no base bundle)

---

## Next steps

### 1. Arduino-IDE-built firmware probably needs a different bootloader

Almost certainly yes — the Arduino IDE core's `dio_80m` ELF (18688 bytes) is a different binary from
pioarduino's `qio_80m`-with-DIO-header (19520 bytes), and that mismatch is exactly what broke
LittleFS. We currently ship only the pioarduino one.

Better than a warning comment on the page: **read the framework out of the app image.** Every ESP-IDF
app carries an `esp_app_desc_t` at offset `0x20` (24-byte image header + 8-byte segment header), magic
`0xABCD5432`, with `version`, `project_name`, `time`, `date` and `idf_ver` as fixed-width strings.
Their `firmware.bin` reports:

```
idf_ver: v5.5.4    project_name: arduino-lib-builder    date: Jun 2 2026
```

So the flasher can parse the selected firmware, display what built it, and either pick a matching
bootloader or refuse when it doesn't match the one on offer — turning an invisible, badly-misleading
failure into an explicit refusal. Needs `idf_ver` recorded per bootloader in `boards.json`, which
means capturing it when the bootloader is harvested.

### 2. Writing WiFi config does bring the littlefs machinery back — so don't do it that way

Pre-writing `/wifi/<ssid>` files means *building* a littlefs image, which reintroduces the whole
generator problem: disk 2.1, `name_max` 64, `prog_size` 1, and no in-browser library that can produce
that combination (`@wasm-os/mklfs` cannot set `name_max` at all).

Given how sensitive this proved, prefer **serial config hand-off**: after flashing we still hold the
port, and `System_Captive::dispatch` already consumes `topicTwig value` pairs, with
`set/wifi/<ssid>` = password being an existing convention. The firmware then writes its own files
using its own littlefs, so there is no format coupling, a list of networks is natural, and it doubles
as a re-configure tool for boards already in the field. Small firmware addition; no client-side
filesystem generation.

**Reuse the intake the node already has.** The firmware does not need a new way to *apply* config —
only a new way to *receive* it. Today the same values arrive over HTTP: the captive portal builds a
form from `addString` / `addNumber` / `addBool` / `addButton`, and `addSTARoute` registers POST
handlers on the station interface, so config comes in as query/form key-value pairs, is turned into
`topicTwig` + value, and goes through `dispatch()` to `writeConfigToFS()`. MQTT `set/...` messages
land in the same place.

So the work is a **transport**, not a mechanism: read the same key-value pairs from USB serial and
feed them into that existing dispatch. That keeps one code path for HTTP, MQTT and USB, and means
anything configurable through the captive portal is automatically configurable at flash time. Worth
settling on the serial line format (a `topicTwig value` pair per line is enough, terminated so a
partial line is never applied) and whether the node echoes each accepted setting so the flasher can
confirm rather than assume.

### 3. Monitor needs Clear and Copy buttons

The log is hard to work with once long. Two buttons beside Monitor, two new strings in four languages.

### 4. `fs.cpp` reports a scary failure that isn't one

On a freshly provisioned board the normal path prints `Corrupted dir pair`, `mount failed (-84)` and a
`disableCore0WDT` error before quietly succeeding — and `"initialization done."` is gated behind
`SYSTEM_LITTLEFS_DEBUG`, so an ordinary build shows only the alarming half. Worth fixing in
`System_LittleFS::pre_setup`: suppress the component's log level around `begin(true)` (e.g.
`esp_log_level_set("esp_littlefs", ESP_LOG_NONE)`, restoring afterwards) and print one clear line for
each outcome, with the failure case *not* gated behind a debug flag. Firmware repo change.

### 5. ESP8266 end to end

Single whole image at `0x0`, no base bundle. Note it cannot format its own filesystem — its
`ESPFS.begin()` takes no format-on-fail argument — so this is the one case that may genuinely need the
pre-formatted blank image described above.

### 6. S2 and S3 bootloaders

Generated with the C3 recipe but never checked against a reference build. The check is exactly what
settled the C3: build the firmware for an S2/S3 env and compare `.pio/build/<env>/bootloader.bin`
against `base/bootloader/esp32s{2,3}.bin`.

### 7. Auto-detect chip type and refuse a binary built for the wrong chip

Partly built already: `appCheck()` compares the app image's `chip_id` (u16 at byte 12) against
`esploader.chip.IMAGE_CHIP_ID` and throws on mismatch. But it has never been exercised — every test so
far used a correctly matched C3 image — so it needs a deliberate wrong-chip attempt to confirm the
refusal fires, reads clearly, and leaves the board untouched. Also worth checking whether esptool-js
rejects it independently, so we know whether our check is the only guard or a second one.

Two related refusals in the same code path are likewise untested: an app larger than the app
partition, and a `<chip>-<flashsize>` combination absent from `boards.json`.

### 8. UI polish

Nothing structural — the flow works but is a little unintuitive. Known rough edges:

- `Flash` is disabled until *both* a board and a firmware are chosen, with no hint saying so; the
  reason should be visible rather than inferred from a grey button.
- Provision vs app-only is auto-detected and reported in prose, but the destructive case deserves to
  read as clearly destructive.
- A hard reload silently clears the chosen firmware, which is surprising mid-session.
- Ordering of the controls (file, speed, monitor speed, Connect, Flash, Monitor) has grown by
  accretion rather than by how it is actually used.

---

## Open questions

- **Octal-flash S3 detection.** Confirm on a real ESP32-S3-WROOM-2 that unsupported OPI flash shows up
  as `detectFlashSize()`'s unrecognized-capacity fallback, so the refusal message can be stated as
  fact rather than a guess.
- Confirm `writeFlash` tolerates an omitted `calculateMD5Hash` (see Client change 7).
- **Ship 4 MB only at first.** Larger boards are still more expensive and not seen in practice, so
  `min_spiffs` is the only scheme that needs to work on day one. The `frugal_8mb` / `frugal_16mb`
  tables above are specified so they *can* be added without redesign, but they should be generated and
  tested by someone holding the hardware rather than committed untested — an unlisted
  `<chip>-<flashsize>` already fails cleanly as "unsupported board".
- Whether an ESP32-S2 `bootloader.bin` is worth harvesting up front, given `ARDUINO_LOLIN_S2_MINI`
  appears in the firmware but may not be in active use.
