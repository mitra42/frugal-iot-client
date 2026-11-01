# Flasher — what still needs a real board

One bench session. Everything here was built or tested in code and **never run on hardware**; the
reasoning is in `FLASH_PLAN.md` (step numbers below refer to it). Do them in this order, which
minimises re-flashing. Skip any board you do not have and say so.

**Before you start:** serve the client from `frugal-iot-server`, open the project's back (Flash card),
use Chrome/Edge/Opera. Hard-reload once so nothing stale is cached (see CLAUDE.md "Caching").

Firmware is in `~/Documents/Arduino/frugal-iot-demo/.pio/build/<env>/firmware.bin`. All four below
were built on 2026-11-01 with pioarduino **3.3.12 (IDF v5.5.5)** and the LittleFS log change (step 4):

| Env | Chip / board | Size |
|---|---|---|
| `c3_pico` | ESP32-C3, LOLIN C3 Pico, 4 MB | 1.40 MB |
| `s2_mini` | ESP32-S2, LOLIN S2 Mini, 4 MB | 1.27 MB |
| `lilygo_t3_s3_sx127x` | ESP32-S3, LilyGo T3-S3 | 1.59 MB |
| `d1_mini` | ESP8266 | 0.56 MB |

Rebuild (`pio run -e <env>`) if the library has changed since. For every step, **copy the flasher's log**
(the new Copy log button) — it is the evidence.

---

## 1. ESP32-C3 — the case that matters most

*Covers: IDF v5.5.5 provision (step 1), the quieter LittleFS log (step 4), the UI (step 8).*

1. Connect the board **erased** (or any state — the flasher should report what it found).
2. Choose `c3_pico/firmware.bin`. **Look for:** log says `Built with ESP-IDF v5.5.5`; the status area said
   "Choose a firmware file to flash" / "Connect a board to flash" *before* you did each of those.
3. Connect. If it reads as a full provision: the warning is a **red box** and the button says
   **Erase and flash**.
4. Flash. **Look for:** log line `Bootloader: ESP-IDF v5.5.5 (core 3.3.12)`; flash completes.
5. Start the monitor (or let it start). On the first boot **look for:**
   - `LittleFS would not mount (normal on a first boot) - formatting`, then `LittleFS formatted and mounted OK`,
     then `LittleFS mounted: … bytes used`
   - **none of** `Corrupted dir pair`, `mount failed (-84)`, `disableCore0WDT` / `Failed to remove Core 0 IDLE task`
   - the node's `/wifi`, `/frugal_iot` directories created, captive portal up at 192.168.4.1.
   If one of those lines survives, **paste it**: its log tag is what to silence next (step 4).
6. Reset board (button), watch a second boot: it should say `LittleFS mounted` with no format.
7. **Reload the page.** The firmware should come back, marked "kept from last session". Select another
   file: it replaces it.
8. Clear log and Copy log work; the layout order reads naturally (file → Connect/Flash → status → Monitor → log → Configure).

**If LittleFS fails to mount or the board will not boot**, the v5.5.5 bootloader is wrong for it — note it,
and do not continue to the other chips until it is understood.

## 2. Refusals — each should leave the board untouched

Use the C3 from step 1 (it now has a known-good firmware to check against).

| Try | Expect |
|---|---|
| `s2_mini/firmware.bin` on the C3 | `… was built for ESP32-S2 (chip id 2), but this board is ESP32-C3 - nothing was written` |
| `lilygo_t3_s3_sx127x/firmware.bin` on the C3 | same, naming ESP32-S3 |
| `~/Documents/Arduino/frugal-iot-OLD/build/magi-4-c3-sht/frugal-iot.ino.bin` (IDF v5.3.2) when it would **provision** | refusal naming v5.3.2, saying to **update the Arduino IDE** |
| the same file, **app-only** over a provisioned board | allowed (no bootloader is written) |

After each refusal, Monitor the board: it should still be running the step 1 firmware, unchanged.
*(Step 7; the IDF refusal is step 1.)*

## 3. ESP32-S2 (`lolin_s2_mini`) — step 6

Provision `s2_mini/firmware.bin`. **Look for:** `Bootloader: ESP-IDF v5.5.5`, boots, LittleFS mounts as in
1.5. The shipped S2 bootloader is the `dio_80m` build, byte-identical to what PlatformIO makes for this
board. The S2 may need holding GPIO0 to enter the download mode — if Connect fails, that is the first thing to try.

## 4. ESP32-S3 (LilyGo T3-S3) — step 6

Provision `lilygo_t3_s3_sx127x/firmware.bin`. Same checks. Note the **flash size and scheme** the status
line reports: `ESP32-S3-4MB/8MB/16MB` are all in `boards.json`, but only 4 MB has run on hardware. Anything
else, or a "flash size not recognised" warning, is the octal-flash case — **write down the capacity byte it
prints** (open question in FLASH_PLAN.md).

## 5. ESP8266 (`d1_mini`) — step 5

Whole image at `0x0`, no base bundle. **Look for:** it flashes, boots, and — the open risk — **the filesystem
works**: `LittleFS formatted and mounted OK` on a first boot. The ESP8266 core cannot format on a failed
mount, so `fs.cpp` calls `format()` itself; this is the first time that has run on hardware. A blank board
and a board that previously ran something else are both worth one try.

## 6. Cheap extras while the boards are on the desk

- **921600 baud on a CH340 board** (the 'Speed' menu): does it stay reliable, or should the default drop to
  460800? (open question.)
- **Arduino-IDE build, IDF v5.5.5:** if you can build the sketch in the Arduino IDE with core 3.3.12, provision
  it on the C3. The flasher should accept it and write the same v5.5.5 bootloader.
- **v5.5.4 firmware** (anything built on pioarduino before the update, e.g. an OTA file): provisioning writes
  the **v5.5.4** bootloader. The C3 one was verified against a real build; the **S2 and S3 v5.5.4 ones were
  not**, and the S2 is probably the wrong variant — prefer not to rely on them.

## What to report back

For each step: **worked / did not**, the copied log for anything that did not, and — for step 1.5 — the
exact first-boot lines you saw. With that I can close the matching items in `FLASH_PLAN.md`.
