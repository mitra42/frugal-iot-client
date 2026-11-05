# Plan: Configure a node from the browser over USB

## Status

**Complete.** Phases 1 and 2 were released in 2.0.8 and tested on real boards during the
`FLASH_PLAN.md` work, ESP8266 included, which covers phase 4. Phase 3 (`~fields`) is dropped: the
fixed form is enough. Both open questions are resolved. One small gap remains: no test has the fake
node restart mid-Apply.

## Goal

After a board is flashed (or any time it is plugged in), let the user set its WiFi, project, name and
broker from the Flash card, with no phone and no joining the board's AP. This is FLASH_PLAN.md
Phase 5 / Next Steps 2, worked out.

Scope is **USB only** (confirmed). A node already on WiFi is configured by `set/...` over MQTT, which the cards
already do. Configuring a node *before* its first boot is not possible either way - the firmware
formats its own filesystem on first boot, so there is nothing to write into - so config always follows
a boot, and the plan waits for the node to say it is up.

## The common case: one profile, many boards

Someone flashing a batch gives every board the same org, project, enrolment secret and WiFi list;
only the name differs, and the node already has a name (its id), which we do not flash. So the unit
of configuration is a **profile**, applied to board after board, and setting one board by hand is the
rarer case. The panel is built around that:

- **Profile = org, project, enrolment secret, broker, ordered list of WiFi networks.** Held in the
  panel as an editable list (one row per network, with add/remove), not a free-text file - a typo in
  a text file is silent, while a row can be validated (SSID non-empty, project length) as it is
  edited.
- **Org and project are not free fields.** They are taken from the org and project the admin is
  active in, shown read-only, so a batch cannot be flashed into the wrong one. Changing them means
  switching project in the UI.
- **The enrolment secret is fetched, not typed.** `GET /enrolment_secret/:org` already hands it to
  an admin (SECURITY.md S10). If the org has several (rotation), use the newest.
- **The profile lives for the session**, in memory, and persists the non-secret parts (WiFi list,
  broker) in `localStorage` as a per-viewer convenience. The enrolment secret is re-fetched each time
  rather than stored in the browser.
- **Apply is automatic after a flash and a click otherwise**: flash and it applies on the board's
  first `~hello`; for a board only plugged in, press Apply. Connecting to monitor never applies. Each board then shows its own
  ok/err per setting, and the panel counts boards done this session so a batch is easy to follow.
- **Import/export** of the profile as a small JSON file is cheap and lets a team share one, but it is
  a later nicety; the list is the primary editor.

## What the node already has

One intake, three transports. Every config change ends as a `System_Message` for `set/<twig>` and
goes through `dispatch()` to `writeConfigToFS()`:

| Transport | Entry |
|---|---|
| MQTT / mDNS / LoRa | message arrives as `set/<twig>` |
| Captive portal | `POST /` in `captive.cpp` turns each form field into `queueFromCaptive("set/" + name, value)`; `ssid`+`password` becomes `set/wifi/<ssid>` = password |
| **USB serial** | **missing - this plan adds it** |

So this is a new *transport*, not a new mechanism: anything the portal can set, serial can set, with
the same validation, persistence and side effects (WiFi switches after the password is saved, language
changes, project change re-derives topics).

## Firmware changes (Frugal-IoT repo - announce before editing)

### 1. Serial exists only under `ANY_DEBUG`

`System_Frugal::startSerial()` calls `Serial.begin()` only `#ifdef ANY_DEBUG`. A production build has
no serial at all, so nothing can listen. Add `SYSTEM_SERIAL_CONFIG` (default on) that begins serial
regardless, and keep the 5 s start delay tied to `ANY_DEBUG` only. Baud stays `SERIAL_BAUD` /
115200; on native USB (C3, S2, S3) it is ignored.

### 2. A line protocol, kept apart from the debug log

The same stream carries debug output, so protocol lines start with `~` and the client treats any
other line as log.

```
client -> node   ~hello?
node -> client   ~hello <nodeid> <otakey> <version>
client -> node   ~set <twig>\t<value>            fields percent-encoded (tab, newline, % only)
node -> client   ~ok <twig>   |   ~err <twig>\t<reason>
client -> node   ~status?
node -> client   ~status {"wifi":"ssid","connected":true,"mqtt":"connected","org":..,"project":..,"name":..}
client -> node   ~get? / ~fields?      (phase 3 - see below)
```

- **Terminated by `\n`**, accumulated in the main `loop()` into a bounded buffer (say 256 bytes;
  overflow discards to the next `\n` and replies `~err`). A partial line is never applied.
- **Tab separates twig from value**, because a WiFi SSID in the twig (`wifi/My Network`) and a
  password can both contain spaces.
- **Applied through `queueFromCaptive`-equivalent** - a new `queueFromSerial` setting a `MsgFromSerial`
  flag - so the write happens on the main task and the existing `isFromCaptive()` style checks have a
  sibling. Unknown twigs get `~err`, never a silent drop: that is what lets the client confirm rather
  than assume.
- **No special handling of WiFi passwords** - they are treated as semi-public, so they may appear in
  `~ok`, in the debug log and in the client log. The enrolment secret is different (it authorises
  enrolment) and is neither echoed nor logged.
- **Boot announces itself**: print `~hello ...` once serial is up, and on every `~hello?`. That tells
  the client the monitor speed is right, which board it has, and removes the "no output yet" guesswork
  FLASH_PLAN.md describes.

### 2b. Settable org and enrolment secret

Two additions to `System_Frugal` / `System_MQTT` dispatch:

- **`org`** becomes settable and persisted like `project`, with the same rule that a blank value is
  ignored and a change re-derives topic prefixes. The compiled-in org stays the default, so existing
  builds behave as before. This is what allows one binary for all orgs.
- **`enrol_secret`** is persisted to LittleFS and used by the enrolment code in place of the compiled
  one, falling back to the compiled `configure_mqtt_enrolled()` value when unset. It is never
  echoed to MQTT (same reasoning as `username` / `password`) and not logged. Order matters: org and
  project first, then the secret, then WiFi - enrolment needs all three, and WiFi connecting
  triggers it, so WiFi goes last.
- The node does not police "only the active org/project"; it has no way to know. That constraint
  belongs in the client (above) and, for the secret, in the fact that a secret is only valid for its
  own org on the server.

### 3. The sleep window already exists

`System_Captive::okToSleep()` holds off sleep for `SYSTEM_CAPTIVE_STARTUP_MS` (3 min) after a reset,
so a freshly flashed board is awake long enough to be configured. Serial activity should also update
`lastActivityMs` so a config session is not cut off. A board on native USB loses the port when it
sleeps; the monitor already reconnects.

### 4. Describing the fields (dropped — the fixed form is enough)

The portal page is HTML built by `addString` / `addNumber` / `addBool`; nothing machine-readable lists
what is settable. First cut: the client hard-codes the few first-boot fields (below). Better: make
those `add*` calls record `{twig, label, type, min, max, current}` in a list that both the HTML and a
`~fields?` reply render from, so the client form is generated and a new module's settings appear with
no client change. Do this only once the fixed form has proved the transport.

## Client changes

All in `flash.js` - it already owns the port and the monitor.

1. **Line-buffer the monitor.** `monitorStream()` writes each decoded chunk straight to the log;
   chunks end mid-line. Buffer to `\n`, send `~` lines to a reply handler and everything else to the
   log. The `~` lines never appear in the log (so nothing sensitive can).
2. **`monitorSend(line)`.** The monitor holds a reader on the open port; a writer on `port.writable`
   coexists with it. Serialise sends and wait for the matching `~ok`/`~err` with a timeout, so the UI
   can show per-field state.
3. **A Configure panel**, shown once a `~hello` has been seen, hidden otherwise. Fields:
   - The profile editor described above (WiFi list, org/project read-only, secret fetched, broker
     prefilled from `server_config`)
   - Language, and per-board overrides (a different project, one-off WiFi) behind an "edit this
     board" disclosure rather than in the main path
   **Apply** (automatic on the first `~hello` after a flash made here, otherwise a button) sends the profile in the order org, project, secret, broker, then each WiFi network,
   shows ok/err beside each, then polls `~status?` for a few seconds and reports "WiFi connected /
   MQTT connected / enrolled" - the feedback the portal gives with its refreshing status lines.
   `~status` therefore needs an `enrolled` field.
4. **Flow after flash:** flash -> `bootReset` -> monitor starts -> `~hello` arrives -> panel
   appears. The same panel works on a board that was only plugged in (Monitor, no flash) as a
   re-configure tool, and for an app-only update it shows the board's current values from `~status`.
5. **Translate in the client.** The node sends codes, not prose: `~err <twig>\t<code>` with a
   short fixed vocabulary (`unknown`, `too_long`, `blank`, `refused`, ...). The client maps each code
   to a string in all four languages.
6. **i18n generally**: every new string in EN/FR/HI/ID, `textContent` not children, terse labels.

## Tests

- Profile logic (ordering, validation, which fields are read-only) as plain functions tested with no
  DOM, per the usual split.
- `test/flash-config.test.js`: a fake port with `ReadableStream` / `WritableStream`, feeding `~hello`,
  split across chunks, interleaved with log lines; assert the panel appears, `~set` lines are written
  encoded, `~ok` / `~err` update the right field, and no `~` line reaches the log.
- Real hardware for the firmware half (C3 first): configure a freshly provisioned board with no
  captive portal visit; do two boards in a row from one profile and check both enrol.

## Phasing

| Phase | Delivers | Firmware |
|---|---|---|
| 1 | `~hello`, `~set`, `~ok/~err` (codes), `~status` over serial, regardless of `ANY_DEBUG`; settable `org` and `enrol_secret` | yes |
| 2 | Monitor line-buffering, `monitorSend`, profile editor and Apply, enrolment secret fetch | no |
| ~~3~~ | ~~`~fields?` so the form is generated from the node~~ — dropped, the fixed form is enough | — |
| 4 | *(optional)* serial reconfigure for ESP8266 (no native USB, UART bridge baud matters) — works | check |

## As built (branch `flashconfig`, all three repos)

Phases 1 and 2 are done and tested against a fake node; **nothing has run on a real board yet.**
Where the build departs from the text above, this is what is true:

- **Wire format.** Every line is TAB-separated and every command is `~cmd[\targ...]`, with no `?`:
  `~hello`, `~status`, `~set\ttwig\tvalue`, `~apply`. Replies are `~hello\t1\tnodeid\totakey`,
  `~ok\twhat`, `~err\twhat\tcode`, `~status\t{json}`. Fields are percent-encoded for `%`, TAB, CR, LF.
- **`~ok` means queued, not applied.** The node cannot tell at the cable whether a twig names a real
  setting - modules decide that in `dispatch()` - so unknown twigs are not rejected there. The client
  confirms with `~status` (org, project, wifi, connected, mqtt, enrolled, restart) instead.
- **`~apply` ends a batch.** A change to `org` or `project` needs a restart, but over serial the node
  only sets `restartPending` and restarts on `~apply`, so one profile is not cut short by a reset
  between its lines. From MQTT or the portal the restart is immediate as before.
- **Serial now starts without `ANY_DEBUG`** (`SYSTEM_SERIALCONFIG_WANT`, on unless
  `SYSTEM_SERIALCONFIG_NOT`), but the 5 s start delay and "FrugalIoT Starting" stay debug-only.
- **`enrol_secret` is accepted only from the cable or the node's own disk**, not over MQTT - a secret
  sent through the broker would be on the broker.
- **A bug found on the way:** `forgetCredential()` blanked `/mqtt/username` and `/mqtt/password`, not
  the `/mqtt.username` files the credential is actually kept in, so a node told to forget its
  credential (on a project change) read it back at the next boot. It now uses `configPath()`. `org`
  relies on this.
- **Auto-apply after a flash only when the board's config was erased or absent** (`provision` or no
  filesystem found). An app-only update of a configured board is left alone.
- **The profile is kept in `localStorage`** (broker and WiFi list, passwords included, since they are
  treated as semi-public). The enrolment secret is not.
- **Org and project reach `mqtt-flash` as attributes**, passed down from the project's back through
  `mqtt-admin`. Pure logic (encoding, line routing, profile validation and ordering) is in
  `nodeconfig.js`; the port, the panel and Apply are in `flash.js`.
- **Server:** `GET /enrolment_secret/:org` now accepts ADMIN or OTAFLASH (`can_ADMIN_or_OTAFLASH`).
  No test was added - the route is inline in `frugal-iot-server.js` and has none today.

Since run on real boards, ESP8266 included. Still to do: a `mqtt-flash` test for the node
restarting mid-Apply (the fake node never restarts).

## Decisions

- **OTAFLASH may fetch the enrolment secret.** Whoever can flash a board can enrol it, so withholding
  the secret only forced them to paste it. Server change: `GET /enrolment_secret/:org` accepts ADMIN
  *or* OTAFLASH (a small `can_ADMIN_or_OTAFLASH`, like `can_OTAUPDATE_or_OTAFLASH`); `POST` (rotate)
  stays ADMIN. The route is also the one place a secret reaches a browser, so its log line stays.
- **Several secrets: the newest is used.**
- **No auto-apply on connect** - connecting to monitor must never reconfigure a board. **Auto-apply
  after a flash** the panel itself just did, so it cannot be forgotten; a connected-only board waits
  for the Apply button. (After a flash the board reboots, so Apply fires on the first `~hello` that
  follows that flash.)
- **Changing `org` clears the stored broker credential**, as changing `project` already does
  (frugal.cpp ~103), since the credential is only valid under the old org/project.

## Open questions

- ~~**UART-bridge boards** (CH340)~~ — resolved: configured an ESP8266 over its bridge while testing
  `FLASH_PLAN.md`.
- ~~**Changing `org` on a node that already enrolled elsewhere**~~ — resolved: `org` clears the
  stored credential as `project` does (frugal.cpp ~99).
