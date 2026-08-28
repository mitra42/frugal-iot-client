# Device Cards — UX Design

Step 1 of 3: **UX design** → implementation plan (`CARDS_PLAN.md`) → implementation.

This document is the thing to argue with. Every place marked **D-n** is a decision that is open;
each carries a recommendation so it can be accepted by deleting the alternatives. Implementation
notes accumulate in the appendix and move to `CARDS_PLAN.md` in step 2.

---

## 1. What this replaces

Today a project renders as a vertical stack of `mqtt-node` elements, each containing one
`<details>` drop-down per module (`MqttGroup`), each drop-down showing a summary line when closed
and its topic widgets when open. Nesting is two levels deep (`insidefrugaliot` modules hide inside
the `frugal_iot` drop-down). To read one device's temperature you open the device, find the SHT
drop-down, open it.

The new model: **one device = one card, with three display modes.** Drop-downs disappear from the
main path.

## 2. Vocabulary

| UI word | Code word | Note |
|---|---|---|
| Device | node / `MqttNode` / `MqttTopicNode` | UI text says "device"; code keeps `node` |
| Card | (new) `mqtt-devicecard` | one per device |
| Reading | topic with `rw: r` | a measurement, e.g. `sht/temperature` |
| Actuator | topic with `rw: w` | drives hardware directly — `relay/on`, `ledbuiltin/on`, `brightness` |
| Control | a control module | a loop with both inputs and outputs, e.g. `controlhysteresis`, `controlblinken` |
| Module | group / `MqttGroup` | e.g. `sht`, `relay`, `controlhysteresis` |

"Actuator" and "control" are deliberately separate. An actuator is one writable topic that changes
the world when you set it. A control is a whole module that reads inputs, applies a rule, and drives
an output — so it is never a single topic, and its inputs (`limit`, `greater`, `hysteresis`) are
settings, not actuators.

> **Detecting a control module.** The code tests `groupId.startsWith('control')`
> (`MqttTopic.controlGroups`, and the `frugaliot:controlgroup` dispatch in
> `MqttTopicNode.addGroupFromTemplate`). That test used to miss `climate` — a control module by every
> structural measure that did not start with "control". **`climate` has since been deleted** as
> legacy (see D-16), so the prefix test is correct again for every module that exists today.
>
> It is still correct only by luck: the next control module named `thermostat` or `irrigation`
> breaks it silently. A module-level `control: true` in `modules.yaml` is three lines of YAML and
> removes the naming dependency — now a robustness fix rather than a bug fix. **D-16**

## 3. The three modes

```
        ┌──────────┐  click card   ┌──────────┐  click ⚙ / gear   ┌──────────┐
        │ SUMMARY  │ ────────────► │  FRONT   │ ────────────────► │   BACK   │
        │ 1 line   │ ◄──────────── │ readings │ ◄──────────────── │ settings │
        └──────────┘  click ⌄      └──────────┘  click ✕ / done   └──────────┘
```

One `<mqtt-devicecard mode="summary|front|back">`. Mode is per-device, remembered (§7).
Several cards may be on FRONT at once — users compare devices, so this is not an accordion. **D-1**

### 3.1 SUMMARY — "is it alive and roughly what is it saying"

Full-width row on mobile; a responsive grid cell on desktop. The whole card is one click target.

```
┌─────────────────────────────────┐ ┌─────────────────────────────────┐
│ ● Greenhouse North          78% │ │ ● Pond Pump                 91% │
│   30.1 °C   85 %RH              │ │   Pump ✓   Soil 38 %            │
└─────────────────────────────────┘ └─────────────────────────────────┘
┌─────────────────────────────────┐
│ ◌ Shed Sensor            2h ago │   ← stale: values dimmed, age instead of battery
│   29.4 °C   81 %RH              │
└─────────────────────────────────┘
```

- Line 1: status dot, device name (`frugal_iot/name`, falling back to the device id), battery % or,
  when stale, "2h ago".
- Line 2: the summary chips (§4.1).
- Nothing on SUMMARY is interactive — the card is a single tap target. A relay toggle sitting in a
  summary invites mis-taps; controls are reachable one tap away. **D-2**

### 3.2 FRONT — "what is it doing, in detail"

**No module structure on the front.** No module headers, no grouping, no nesting — a flat ordered
list of rows. Which sensor a reading came from is a fact about the hardware, not something the
person watching the greenhouse needs. Module structure returns on the back, where it is the right
organising principle. **D-17**

```
┌───────────────────────────────────────────────┐
│ ● Greenhouse North                     ⌄  ⚙  │   ⌄ collapse   ⚙ flip to back
├───────────────────────────────────────────────┤
│ Temperature                         30.1 °C 📈│
│ ├────────────────────────█──────────────────┤ │
│ 0                                          50 │
│ Humidity                             85 %RH 📈│
│ ├───────────────────────────────█───────────┤ │
│ 0                                         100 │
│ Heating                          ●──○  ON  📈 │
│ Control      Temperature > 32 ±3        ✓ ON  │
│ Vent light                       ○──●  OFF 📈 │
├───────────────────────────────────────────────┤
│ 🔋 3.94 V · seen 12s ago                      │
└───────────────────────────────────────────────┘
```

Exactly three kinds of row, in whatever order the device declares (§4.2):

1. **Reading** — label, value + unit, and the widget its `display:` calls for (bar here), with
   min/max end labels and the graph icon `mqtt-bar` already has.
2. **Actuator** — label and a live toggle or slider. **Tappable on the front**: turning a pump on is
   the commonest thing anyone does in the field, and making them flip the card to do it is a real
   cost. The mis-tap worry of D-2 was about the *summary*, where the whole card is one target; here
   the card is already open and the toggle is a deliberate, properly sized target. **D-3**
3. **Control** — read-only. Shows the rule and the resulting output state
   (`Temperature > 32 ±3   ✓ ON`). Editing the rule happens on the back. So the split is *act on
   the front, configure on the back*, which keeps the symmetry rather than breaking it.

**Actuators and controls stay separate rows**, even when a control drives that actuator. Merging
them into one row was considered and dropped: it hides the fact that two distinct things exist, and
the interesting question — what happens when you tap an actuator a control is driving — has its own
UX that is deliberately **deferred** (§14). Until that lands, tapping a control-driven actuator will
be overwritten by the loop on its next cycle. That is a known rough edge, recorded rather than
designed around. **D-18**

Footer strip: battery, last seen. Small, gray, always present.

### 3.3 BACK — "settings and background"

```
┌───────────────────────────────────────────────┐
│ ⚙ Greenhouse North                        ✕  │
├───────────────────────────────────────────────┤
│ DEVICE                                        │
│  Name        [Greenhouse North          ]     │
│  Description [Bed 3, north end          ]     │
│  Device id   esp8266-fb94bb                   │
│  Last seen   12s ago (14:32:05)               │
│  Battery     3.94 V      Wifi ▂▄▆  "shed-ap" │
│  OTA key     a1b2c3d4                     ⧉  │
├───────────────────────────────────────────────┤
│ CONTROL — Fan                                 │
│  Input   [Temperature (SHT)     ▾]     30.1   │
│  When    [>]  [ 32.0 ]  ±  [ 3.0 ]            │
│  Output  [Relay 1               ▾]     ✓ ON   │
│  Manual override  [ ]                         │
├───────────────────────────────────────────────┤
│ SHT                                           │
│  Temperature  30.1 °C    min 0    max 50   📈 │
│  Humidity     85 %RH     min 0    max 100  📈 │
├───────────────────────────────────────────────┤
│ RELAY                                         │
│  Relay 1      [x] on                       📈 │
├───────────────────────────────────────────────┤
│ ADVANCED                                   ⌄  │
└───────────────────────────────────────────────┘
```

- Flat sections in a fixed order — **no drop-downs**, agreeing with the instinct in the brief that
  someone on the back of a card wants everything about that sensor. Order: Device → Controls →
  Readings by module → Advanced.
- ADVANCED is the one thing still collapsed: raw MQTT topic paths, wiring internals, flash/OTA
  actions. It is for debugging, not for the field. **D-4**
- Editable min/max per reading is shown above as a stretch (`min 0 max 50`); the schema already
  carries `min`/`max` per topic, and per-device overrides arrive on `…/set/…/max`. **D-5**
- **The control line follows `dashboard_example.html`, not the old node UI.** One inline row,
  `[>] [ 32.0 ] ± [ 3.0 ]`: the comparison is a two-state control showing `<` or `>`, the limit and
  the hysteresis are bare number fields, and the hysteresis is labelled with the `±` symbol rather
  than the word "Hysteresis". The dashboard already builds precisely this — an `mqtt-toggle` with
  `labels: '<,>'` plus two `mqtt-text` fields with `label: ''` and `label: '±'`. A two-state toggle
  is one tap where a dropdown is two, so prefer the toggle over a `▾` menu. **D-19**

### 3.4 How the flip behaves

- **Desktop**: a real CSS `rotateY` flip. This requires front and back to occupy the same box, so
  the back scrolls internally at the front's height rather than growing the card. Same width, same
  height, no layout jump for neighbouring cards.
- **Mobile**: no flip. The back opens as a full-screen sheet sliding up from the bottom, with the
  device name and a ✕ in its header. A 3D flip in a 340px-wide column, with form fields on the
  reverse, is worse than the sheet that every mobile OS has trained people on. **D-6**
- The metaphor survives either way: front = watch, back = adjust.

## 4. How modules accumulate into a card

This is the core question in the brief. Three levels of declaration, each answering one question:

| Level | File | Question it answers |
|---|---|---|
| Topic | `topics.yaml` | how is one reading rendered (`display`, `units`, `width`, `color`, `min`, `max`) |
| Module | `modules.yaml` | which of *my* topics belong in *my* summary |
| Device | org/project config | what appears on the summary and the front of *this* device, in what order |

Note what is **not** here: nothing declares a render type twice. `display:` already carries
`bar|gauge|text|toggle|slider|color` per topic, so the summary and front lists say only *which*
topics and *in what order* — never *how*.

### 4.1 Summary content — a list of twigs, not a format string

The brief suggests a format string:
`'${sht/temperature} ${sht/temperature/unit} ${frugaliot/battery}${frugaliot/battery/unit}'`

**Recommendation: an ordered list of twigs instead.** **D-7**

```yaml
# in a device / project config
summary: [sht/temperature, sht/humidity, battery/battery]
```

Why not a format string:
- Units, names and number formatting all need translating and localising; baking them into a
  string in YAML puts untranslatable text in the config.
- A missing value (sensor absent, device never seen) has to render as something sensible — a
  format string gives `undefined °C`.
- Values want individual styling: schema colour, dimming when stale, red when out of range.
- A list is a strict subset of what a format string can express, minus arbitrary literal text —
  which nothing in the summary actually needs.

**Default when nothing is declared**: use each module's existing `summaryText()`. The machinery is
already built — `MqttGroupSht` returns `30.1°C 85%RH`, `MqttGroupRelay` returns `✓`,
`MqttGroupControlHysteresis` returns the whole control line. A module opts into the summary with

```yaml
sht:
  summary: true       # module-level: contribute my summaryText() to the device summary
```

so the common case needs no per-device config at all, and `summary:` on a device is the override.

**This is explicitly an interim step.** Only a handful of modules have a hand-coded `summaryText()`
(`sht`, `dht`, `ht`, `soil`, `ds18b20`, `battery`, `relay`, `ledbuiltin`, `ota`,
`controlhysteresis`) — every other module has no summary at all, and each one that does required a
subclass. The intent is to delete those subclasses. The migration needs no new mechanism, because
the *same twig list* works one level up:

```yaml
sht:
  name: SHT
  summary: [temperature, humidity]    # leaves, not twigs — replaces MqttGroupSht.summaryText()
```

So there is one mechanism at both levels: a module declares its own default summary as a list of
leaves, a device may override with a list of twigs. As each module gains a `summary:` list, its
hand-coded class goes. **D-20**

**Controls are the exception and stay hand-coded.** `MqttGroupControlHysteresis.summaryText()`
produces `Fan = Temperature > 32 ±3 ✓` — a structural sentence with wiring lookups and a comparison
operator in the middle, not a list of values. A list cannot express it and a format string would
express it badly. Control modules keep a purpose-built renderer; only *sensor* summaries become
declarative.

**Fallback order** for a module with no `summary:` list and no `summaryText()`: its `graphable`
readings, capped at two, else nothing. A module contributing nothing is not an error — a device
whose summary line is empty still shows its name and status, which is the important part.

### 4.2 Front content — a per-device ordered list

An earlier draft put `front: bar|value|none` on each topic in `modules.yaml`. That was wrong: it
duplicates `display:`, which already says `bar|gauge|text|toggle|slider|color`. Two keys meaning
"how do I render" is one key too many, and they would eventually disagree.

What is actually needed is *which* topics appear and *in what order* — and that is a per-device
question, because a temperature logger wants the temperature at the top with its control beneath,
while another device wants something else entirely. Same shape as the summary list: **D-21**

```yaml
# device level
front:
  - sht/temperature
  - controlhysteresis        # a bare module id = that control's row
  - sht/humidity
  - relay/on
```

An entry is either a **twig** (a reading or an actuator, rendered per its `display:`) or a **module
id** (a control module, rendered as its one control row). Order is the list order, so readings,
actuators and controls interleave freely — no fixed section order to fight.

**Default when no `front:` is declared**, so a newly discovered device is never blank:

1. every reading with `graphable: true`, in module declaration order, then
2. every actuator (`rw: w`, not inside a control module), then
3. one row per control module.

Excluded from (1) and (2): modules marked `insidefrugaliot` — `battery`, `health` — which feed the
status strip instead (§4.4), and topics belonging to a control module, which the control's own row
already represents. `graphable: true` turns out to be a good proxy for "a real measurement rather
than a diagnostic field": it is set on 33 of the 54 topics in `topics.yaml`, and the ones it leaves
out are exactly the writable settings and the text/metadata fields. **D-22**

If that default proves wrong in practice, the fix is a module-level boolean, not a second render
key.

### 4.3 Labels

On the **front**, a row is labelled by the topic's `name` from `topics.yaml` — `Temperature`,
`Humidity` — with no module name attached, per §3.2.

Where two front rows would carry the same label, the collision is resolved by using the **module's**
`name` instead of the topic's: a device with both an SHT and a DS18B20 shows `Temperature` and
`Soil Temperature`, because `ds18b20` is already named "Soil Temperature" in `modules.yaml`. This is
better than `Temperature (SHT)` / `Temperature (DS18B20)` — it reads as a description of what is
being measured rather than as an exposed part number. A device-level `label:` on a `front:` entry
overrides both. **D-8**

On the **back**, readings sit under a module heading, so the label is always just the topic `name` —
the heading carries the module identity.

### 4.4 `insidefrugaliot` modules

`battery`, `health` and friends already nest inside the `frugal_iot` group. They do not become
sections; they feed the status strip (battery, wifi, last seen) on SUMMARY/FRONT and the DEVICE
section on BACK. `frugal_iot` itself is never a section — it *is* the card's identity.

### 4.5 Units are not usable as they stand

The brief's example summary, "SHT 30° 85%", assumes a unit after the number. Two problems:

- **The client never reads `units`.** The key exists in `topics.yaml` on 18 topics; `webcomponents.js`
  contains no reference to it at all. Today's UI shows bare numbers, and the `°C`/`%RH` in
  `MqttGroupSht.summaryText()` is a hard-coded string in the class.
- **The values are SenML codes, not display symbols.** `units: Cel`, `deg`, `lx`, `lat`, `lon`,
  `kOhm`, `mg/L`. Rendered literally that reads "30.1 Cel".

So the card UI needs a small SenML-code → display-symbol map (`Cel` → `°C`, `deg` → `°`, `%RH` and
`mV` pass through unchanged), and `units:` needs filling in on the topics that lack it. Neither is
large, but neither is free, and the summary line does not work without both.

**Recommendation: a separate lookup table, not the `languages` table.** **D-23** Three reasons, the
first decisive:

1. **`el()`'s translation filters actively reject unit symbols.** Look at the two guards at
   `webcomponents.js:1092-1094`: a value containing `/` is skipped, and a value whose first
   character is not an ASCII letter is skipped. That excludes `°C`, `%RH`, `m/s`, `mm/hr` and
   `mg/L` outright. Units would have to special-case their way around the very mechanism they were
   put into.
2. **`getString` fails unreadably for codes.** It falls back to the tag itself, so a missing entry
   renders the literal `Cel`. A missing *English string* at least still reads as English; a missing
   *code* renders as noise. Keying a lookup table by code is fine; keying a translation table by
   code conflates "identifier → display" with "English → other language".
3. **It keeps unit *conversion* separate from unit *translation*.** °C → °F is a user preference
   that has nothing to do with language — a French speaker wants °C, an American English speaker
   may want °F. Folding units into `languages` invites conflating the two and closes that door.

The escape hatch survives either way: if a unit ever genuinely needs translating (`%RH` → `%HR` in
French), the table's *value* can be a `getString()` tag. Starting separate does not prevent that;
starting inside `languages` does force four-language duplication for all ~18 entries today.

### 4.6 Which `devices.yaml` entry applies

The OTA key is built by the firmware as `SYSTEM_OTA_PREFIX "_" SYSTEM_OTA_SUFFIX`
(`src/system/ota.cpp:220`), where the prefix is the application and the suffix is the board. One app
across ten boards therefore produces ten keys — `sht30_c3_pico`, `sht30_d1_mini`,
`sht30_s2_mini_4x`, … — all wanting the same card layout, because the layout follows the
*application*, not the board.

So `devices.yaml` keys **match by prefix**, resolved in this order: **D-34**

1. an exact match on the **device id** (`esp8266-fb94bb`) — one device overriding its build;
2. an exact match on the **full OTA key** (`sht30_c3_pico`) — one board differing from its siblings;
3. the **longest key** `k` for which `otakey.startsWith(k)` (`sht30`) — the normal case.

Longest-match, not file order, so adding a more specific entry never depends on where it is placed
and `sht30` correctly beats `sht` when both exist.

Prefix matching is not merely convenient here, it is necessary: suffixes themselves contain
underscores (`c3_pico`, `s2_mini_4x`), so `key.split('_')[0]` does not recover the application name.
`startsWith` does.

The practical effect is that `devices.yaml` has roughly one entry per *example application*, not per
device or per build.

### 4.7 Precedence for the summary line

Three sources, first match wins: **D-36**

1. the device entry's `summary:` list;
2. otherwise the **first two entries of its `front:` list** — so the common device declares `front:`
   only and gets a sensible summary for free;
3. otherwise every module with `summary: true`, contributing its summary (§4.1).

`summary:` is kept as a separate key rather than always derived, because the one-line view genuinely
differs from the full one often enough to matter — a soil sensor whose summary is the moisture but
whose front leads with the control, or a relay whose summary is just its state while its front leads
with the sensor driving it. Rule (2) means most devices never write it.

Entries in both lists are a **twig** (contains `/`) or a **module id** (does not), as §4.2.

## 5. Status, staleness and number formatting

Three things the brief does not cover but which decide whether the UI is usable in the field.

**Status.** A frugal device's most important property is whether it is still reporting. One dot
with three states, shape-differentiated as well as coloured (sunlight, colour blindness):

| State | Dot | Meaning |
|---|---|---|
| Live | ● green | seen within the watchdog interval |
| Stale | ◌ amber | seen, but not recently |
| Offline | ○ gray | watchdog expired / never seen |

**Stale values stay visible, dimmed, with their age.** A two-hour-old reading is still
information; hiding it is a regression from today's behaviour, which greys the whole node.

**Number formatting — `width`.** `30.142857 °C` is unusable and is what MQTT currently delivers.
The node/firmware already has the concept of **width**, so use the same word rather than inventing
`precision`: `width` is the total character count of the rendered number, **including the sign and
the decimal point, excluding units**. Add it to `topics.yaml`, overridable per module in
`modules.yaml` like any other topic field. **D-9**

**Only `float` and `exponential` topics need it** — 25 of the 54 topics in `topics.yaml`, not all of
them. **D-35** An integer has no decimals to decide, so `width` would carry no information a
renderer cannot already derive: the field width for right-alignment is
`max(len(formatInt(min)), len(formatInt(max)))`, and an int with no declared range is simply rendered
as it arrives. `bool`, `text` and `color` never take it.

Decimals are derived, not declared:

```
intWidth = max(len(formatInt(min)), len(formatInt(max)))   # formatInt includes a leading "-"
decimals = max(0, width - intWidth - 1)                    # the -1 is the decimal point
```

Derived from `min`/`max` rather than from the current value, so the number of decimals is **stable
as the value moves** — `9.9` does not become `10` the moment it crosses ten. Worked example, a
temperature with `min: 0, max: 50, width: 4`: `intWidth` = 2, so `decimals` = 1, giving `30.1`. Give
the same topic `min: -40, max: 125, width: 5` and `intWidth` = 3, `decimals` = 1, giving `-40.0` and
`125.0` — both exactly 5 characters.

- Right-align in `width` characters with tabular numerals, so digits do not jitter as values update.
- **Never truncate a number to fit.** A sensor reporting `-999` in a `width: 4` field overflows the
  field rather than rendering `-99`. Overflowing looks broken, which it is; truncating lies.
- Default when `width` is absent: 1 decimal for `float`, 0 for `int`, matching current practice.

> **Naming hazard.** `MqttBar` already has `get width()`, returning the bar fill as a percentage.
> A schema `width` arriving on `mt` would sit confusingly close to it. Rename the getter to
> `fillPercent` while doing this work. **D-24**

**Out of range.** A reading past its `min`/`max` gets a red value and a filled-to-the-end bar
rather than an overflowing one. Cheap, and it catches broken sensors. **D-10**

## 6. Graphs

Not a fourth card mode. The graph icon on a reading (already on `mqtt-bar`) adds that series to the
**shared graph panel below the grid** — which is the existing behaviour and the right one, because
the interesting comparison is usually across devices ("both greenhouses, last 3 days"), which an
in-card graph cannot show.

Alternative considered and rejected: graph inside the card. It would make the card tall, fight the
flip's fixed box, and lose cross-device comparison. **D-11**

## 7. Layout, ordering and memory

### 7.1 One mechanism, not two

The brief asks for free dragging on desktop and reordering on mobile. **Recommendation: an ordered
list on both**, i.e. drag-to-reorder inside a responsive flow grid, not free XY placement. **D-12**

Free XY placement needs fixed-size cards (cards change size when they open), breaks on window
resize, has no meaning on a one-column phone, and needs a second persisted format. Drag-to-reorder
gives one interaction model, one storage format (`[nodeId, …]`), and behaves under resize.

```
desktop: grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
         a FRONT card spans 2 columns where there is room
mobile:  one column; a FRONT card is simply taller
```

### 7.2 Drag mechanics

- Pointer Events, not HTML5 drag-and-drop (which is unreliable on Android browsers — the target
  platform).
- Desktop: grab anywhere on the card header and drag; live gap where it will land.
- Mobile: long-press to lift, or the always-visible ▲▼ buttons in the card header. The buttons are
  not a fallback nobody uses — on a low-end phone they are more reliable than a long-press. **D-13**
- Keyboard: focus a card, Space to grab, arrows to move, Space to drop.

### 7.3 Persistence — `localStorage`, not a cookie

The brief says cookie; **recommend `localStorage`**. A cookie is sent on every HTTP request to the
server (wasteful where bandwidth is the constraint), is capped near 4 KB, and this state never
needs to reach the server. `localStorage` is same-origin, synchronous, and ~5 MB. **D-14**

```
key:   frugaliot:layout:v1:{org}/{project}
value: { order: ["esp8266-fb94bb", …], mode: { "esp8266-fb94bb": "front" }, pinned: [] }
```

- New devices appear at the end of the order, never reshuffling what the user arranged.
- Unknown ids in a stored order are ignored (device retired) rather than erroring.
- Mode is remembered per device, so returning to a project restores the same open cards.
- A project with one or two devices opens them on FRONT by default — a grid of one summary card is
  a wasted screen. **D-15**
- Later, optionally, sync the layout to the logged-in user's account so it follows them across
  devices. Explicitly out of scope for now.

## 8. Page chrome

```
┌───────────────────────────────────────────────────────────────┐
│ Frugal IoT   [dev ▾] [lotus ▾]        ● connected   EN ▾  ⚙  │  sticky
├───────────────────────────────────────────────────────────────┤
│  ┌ card ┐ ┌ card ┐ ┌ card ┐                                   │
│  ┌ card ┐ ┌ card ┐                                            │
├───────────────────────────────────────────────────────────────┤
│  Graph panel (only once something has been added to it)       │
└───────────────────────────────────────────────────────────────┘
```

Org and project selectors already exist on `MqttWrapper`; they move into a compact sticky header.
The trailing ⚙ is app/admin settings (existing `mqtt-admin`), distinct from a card's own ⚙.

### 8.1 States that must be designed, not left to chance

| State | Treatment |
|---|---|
| No project chosen | centred prompt with the project selector, nothing else |
| Project chosen, no devices yet | "Waiting for devices…" with a spinner and the broker name |
| Device discovered, no readings | card in SUMMARY with the name and "no readings yet" |
| MQTT disconnected | banner across the top, grid dimmed, values frozen not blanked |
| Device offline | card as §5, still draggable, still openable |

## 9. Visual style suggestions

Offered because the brief asks for them; all cheap to change later if they are wrong.

- **Card**: white, 8px radius, 1px hairline border (`#e3e3e3`) plus a 1px soft shadow. Not the
  heavy black border of today. (Note: the current CSS writes `border: 1px,black,solid` in several
  places, which is invalid CSS and silently does nothing — worth fixing while here.)
- **Hierarchy**: the *value* is the loudest thing on the card. Label small, uppercase-ish, gray
  (`#6b6b6b`); value large, near-black, tabular numerals so digits do not jitter as they update.
  These devices get read outdoors on a phone in sunlight — favour contrast over subtlety.
- **Colour**: use the topic's schema `color` for the bar fill only. Never let colour be the only
  carrier of meaning; the number is always shown.
- **Bars**: keep them. They are cheap, fast, readable at a glance, and already implemented. Add
  min/max end labels so the value has context.
- **Touch targets** ≥ 44px. Today's CSS reaches mobile by bumping `font-size` to `xxx-large` at
  `max-width: 1001px`, which is coarse; replace with CSS custom properties for spacing/type scale
  set once per breakpoint.
- **Back tint**: give the back a faintly different background so it is obvious which side you are
  on without reading it.
- **Dark mode**: not now, but define colours as custom properties from the start so
  `prefers-color-scheme` is a small diff later.
- **Motion**: 150–200ms on the summary↔front expand and the flip; respect
  `prefers-reduced-motion` by cutting to the end state.

## 10. Permissions — the WRITE capability

A new org-scoped `WRITE` capability, required for **any** change: toggling an actuator, editing a
control's limit, renaming a device, setting a wire. Capabilities are free text in the
`permissions(id, capability, org)` table, so adding one needs no schema change — only the client's
dropdown at `webcomponents.js:3060`, which today offers `OTAUPDATE`/`ADMIN`/`READ`. **D-25**

The full set after this work — the dropdown must offer all five: **D-31**

| Capability | Grants |
|---|---|
| `READ` | see an organization's projects and devices at all |
| `WRITE` | change anything: actuators, control settings, names, wiring |
| `OTAUPDATE` | upload and manage OTA binaries |
| `OTAFLASH` | flash a device over USB from the browser |
| `ADMIN` | permissions, projects, the API tools, raw message publishing |

`OTAFLASH` and `OTAUPDATE` are **independent — neither implies the other**, and `OTAFLASH` will be
the more widely granted of the two: flashing requires physically holding the device, which is its own
access control, whereas pushing an OTA binary reaches every device in the organization at once.

### 10.1 What a user without WRITE sees

The proposal was that the whole back is hidden. **Recommendation: show the back, read-only,
instead.** **D-26**

The back is "settings *and background info*" (§3.3) and the background half is read-only by nature —
device id, last seen, battery, wifi SSID, OTA key, every reading with its min/max. That is exactly
what someone diagnosing a quiet device needs, and none of it is on the front. Hiding it means a
read-only user cannot answer "when did it last report, and what is its battery doing" without an
admin.

So each element degrades rather than disappearing, using display forms the codebase already has:

| With WRITE | Without WRITE |
|---|---|
| actuator toggle on the front | state indicator (`✓` / `✗`, per `trueFalseSymbol`) |
| `mqtt-text` limit field | the value as text |
| `mqtt-choosetopic` wiring dropdown | the wired topic's `usableName` as text |
| device name / description inputs | plain text |
| ADVANCED: flash, OTA actions | section omitted entirely |

The gear icon still appears, because the back still has something to show. If a device ever has
*nothing* read-only worth showing, omit the gear rather than opening an empty card.

### 10.2 What WRITE does not govern

Card order, which cards are open, and summary/front choice are **local presentation**, stored in
`localStorage` (§7.3). They are not writes to the system and stay available to everyone. A read-only
user can still arrange their own dashboard and drive the graph.

### 10.3 This is decluttering, not security — and must be labelled as such

Every user of an organization connects to the broker with the **same** credentials: `setClientCredentials`
sets `username = org` and `password = orgConfig.mqtt_password`, and that password reaches the browser
inside `/config.json`. So a user without `WRITE` still holds working publish credentials and can
change anything with any MQTT client.

Hiding controls is therefore worth doing — it prevents accidents, and it stops a viewer being offered
actions that are not theirs — but it must not be described to anyone as a permission boundary. Real
enforcement needs per-user broker credentials, or a server-side publish proxy that checks `WRITE`.
Either is a substantial piece of work on the server and broker, and belongs on the deferred list
rather than in this UI change. **D-27**

## 11. The project back — administration

The card metaphor extends up a level: the **project** has a front and a back too. Front is the grid
of device cards; the gear in the project header flips to the back, which is a grid of
**administration cards**. This is what becomes of the rest of `<mqtt-admin>` — today a
`tabbed-display` of Dashboard / OTA / Admin / Nodes / API with the project UI buried inside tab 0.
Tabs become cards, and the Dashboard tab stops being a tab because it *is* the front. **D-28**

```
┌───────────────────────────────────────────────────────────────┐
│ ⚙  dev / lotus                                            ✕  │
├───────────────────────────────────────────────────────────────┤
│  ┌ OTA ─────────┐ ┌ Flash ───────┐ ┌ Publish ─────┐           │
│  └──────────────┘ └──────────────┘ └──────────────┘           │
│  ┌ Permissions ─┐ ┌ Projects ────┐ ┌ Nodes ───────┐           │
│  └──────────────┘ └──────────────┘ └──────────────┘           │
│  ┌ API ─────────┐                                             │
│  └──────────────┘                                             │
└───────────────────────────────────────────────────────────────┘
```

Each card is shown only if the user's capabilities allow it:

| Card | Capability | Note |
|---|---|---|
| OTA upload and manage | `OTAUPDATE` | existing OTA tab, unchanged |
| Flash | `OTAFLASH` | **new capability**; today `mqtt-flash` sits inside the OTA tab and so is gated on `OTAUPDATE` — it moves out |
| Permissions | `ADMIN` | existing Admin tab, unchanged |
| Projects | `ADMIN` | existing Admin tab, unchanged |
| Publish Message | `ADMIN` | ⚠ a **loosening** — see below |
| Nodes | `ADMIN` | unchanged; `READ` would be defensible, see below |
| API | `ADMIN` | unchanged — `apiRestContent()` includes a "Node Actions" section that writes, so this is not a read-only tool |

**Publish Message is deliberately not on `WRITE`.** A user who can change things through the UI
should not thereby get a raw publish box — the UI constrains them to topics and values that mean
something, and an arbitrary publish breaks things. Note it is gated *more* tightly than `ADMIN`
today: `server_config.user.id !== 1 ? null : …`, i.e. superuser only, with the comment "not really a
feature, more for testing and debugging". Moving it to `ADMIN` is therefore a widening, deliberate but
worth seeing plainly. **D-32**

**Nodes stays on `ADMIN`.** Its content is genuinely read-only — `nodesRestContent()` is a heading
and a table — so `READ` would be defensible. But a UI redesign is the wrong vehicle for widening who
can see an organization's device inventory; if that is wanted it should be its own decision. **D-33**

For a user with none of these, the project back holds only whatever project-level fields they can
control, which today is nothing — so **omit the project gear entirely when no card would appear**,
rather than opening an empty back. **D-29**

**API stays as it is.** It is a lightweight surface whose only purpose is developers poking at their
own API while testing. Wrap the existing markup in a card and change nothing else — no restyle, no
i18n pass, no responsive work. Spending design effort there is spending it in the wrong place. **D-30**

**Flash** is already designed in `FLASH_PLAN.md` and implemented as `mqtt-flash`; it becomes a card
without redesign. Note it is the one admin function that is *device*-specific as well as
project-level, so it also earns a link from a device's back under ADVANCED (§3.3).

## 12. Out of scope for this design

Named so they do not creep in: multi-project dashboards on one screen, per-user server-side layout
sync, alerts/notifications, dark mode, historical CSV browsing beyond the existing graph panel,
grouping cards into user-defined sections, and the flash/provisioning UI (`mqtt-flash`, already
designed in `FLASH_PLAN.md`) beyond a link on the back's ADVANCED section.

---

## 13. Decisions — all confirmed 2026-08-28

D-1 … D-24 are settled as below and are inputs to the implementation plan, not open questions.
Reopening one means revisiting this document, not deciding it in code.

| # | Decision | Resolution |
|---|---|---|
| D-1 | Many cards open at once, or accordion? | Many |
| D-2 | Interactive controls on SUMMARY? | No — whole card is one tap target |
| D-3 | Actuators tappable on FRONT? | Yes — front acts, back configures. Controls stay read-only on the front |
| D-4 | Anything still collapsed on BACK? | Only ADVANCED |
| D-5 | Edit per-reading min/max on BACK? | Yes, where the topic is writable |
| D-6 | Literal flip on mobile? | No — full-screen sheet; flip on desktop only |
| D-7 | Summary as format string or twig list? | Twig list, defaulting to module `summaryText()` for now |
| D-8 | How to disambiguate two same-named readings? | Use the module's `name` ("Soil Temperature"), not "(DS18B20)" |
| D-9 | `precision:` or `width:` in `topics.yaml`? | `width:`, matching the node; decimals derived from `min`/`max` |
| D-10 | Out-of-range styling? | Yes, red value + clamped bar |
| D-11 | Graph in-card or shared panel? | Shared panel below the grid |
| D-12 | Free XY drag on desktop? | No — drag-to-reorder in a flow grid, both platforms |
| D-13 | ▲▼ buttons always visible on mobile? | Yes, alongside long-press drag |
| D-14 | Cookie or `localStorage`? | `localStorage` |
| D-15 | Auto-open FRONT for small projects? | Yes, ≤2 devices |
| D-16 | Detect a control module by name prefix or flag? | `climate` deleted ✔; `control: true` still worth adding for robustness |
| D-17 | Module structure on the FRONT? | None. Flat ordered rows; modules return on the BACK |
| D-18 | Actuator driven by a control — merge the rows? | No. Separate rows; the override UX is deferred (§14) |
| D-19 | Control row style on the BACK? | `[>] [ 32.0 ] ± [ 3.0 ]`, per `dashboard_example.html` |
| D-20 | Replace hand-coded `summaryText()`? | Yes, eventually — module-level `summary: [leaves]`, same mechanism |
| D-21 | Who declares FRONT content? | The device, as an ordered list of twigs and control-module ids |
| D-22 | Default FRONT when undeclared? | `graphable` readings, then actuators, then controls |
| D-23 | Units in the `languages` table or their own? | Their own table — `el()`'s filters actively reject `°C`, `%RH`, `m/s` |
| D-24 | Rename `MqttBar.get width()`? | Yes → `fillPercent`, to free the name for the schema's `width` |
| D-25 | Add a `WRITE` capability? | Yes, org-scoped, required for every change including an actuator tap |
| D-26 | Hide the whole back without WRITE? | No — show it read-only; omit only ADVANCED's actions |
| D-27 | Is client-side WRITE gating a security boundary? | No, and must not be described as one — all org users share one broker credential |
| D-28 | What becomes of `<mqtt-admin>`'s other tabs? | Cards on the project's back, reached by the project gear |
| D-29 | Project gear when the user can do nothing? | Omit the gear rather than open an empty back |
| D-30 | Redesign the API tab? | No — wrap the existing markup in a card, change nothing |
| D-31 | Capability dropdown contents | Add `WRITE` and `OTAFLASH` to the existing `OTAUPDATE`/`ADMIN`/`READ` |
| D-32 | Publish Message gating | `ADMIN` — not `WRITE`; note this widens it from today's superuser-only |
| D-33 | Nodes card gating | `ADMIN`, as today — do not widen access as a side effect of a redesign |
| D-34 | `devices.yaml` key matching | device id, then exact OTA key, then longest prefix of the OTA key |
| D-35 | Which topics need `width`? | `float` and `exponential` only — 25 topics; ints derive their field width from `min`/`max` |
| D-36 | Is a device `summary:` list required? | No — defaults to the first two entries of `front:` |

---

## 14. Deferred to a later step

Intended, but explicitly **after** the card UI switch is complete. Distinct from §12, which is not
planned at all. This list is expected to grow as the plan and the implementation turn things up.

| # | Deferred | Why it waits |
|---|---|---|
| L-1 | **Overriding a control-driven actuator** — tapping a relay a control loop is driving | Has its own UX thinking in progress; depends on L-2. Interim behaviour: the loop overwrites the tap (D-18) |
| L-2 | **Setting `manual` from the UI** | Node side exists (`Control_Sonoff`), UX side does not. Needs a reverse lookup `mt.drivenBy` — for an actuator, the control whose `out` is wired to it. Note `out.wired` holds a *set* path, so the comparison must normalise as `findTopic` does |
| L-3 | **Replacing hand-coded `summaryText()` with `summary: [leaves]`** in `modules.yaml` (D-20) | The existing subclasses work; converting them is orthogonal to the card layout and safer once the cards are real |
| L-4 | **`control: true` in `modules.yaml`** (D-16) | With `climate` deleted the prefix test is correct again, so this is robustness against a future module name, not a fix |
| L-5 | **`TODO-213` — a module declaring dynamically-added outputs** | The reason `manual` sits in `topics.yaml` with no module declaring it. Wants doing with L-4 |
| L-6 | **Per-user server-side layout sync** (§7.3) | `localStorage` covers the single-browser case, which is the common one; sync needs an account-scoped store |
| L-7 | **Real enforcement of `WRITE`** (§10.3) | A known, separate project — per-user broker credentials or a server-side publish proxy. Until it lands, the UI gating is decluttering only and must be described that way |

---

## 15. Open issues for the implementation plan

Not UX decisions — things the plan has to answer. **All resolved 2026-08-28**; recorded here with
the reasoning because the plan depends on them.

### O-1 Where does the per-device `front:` / `summary:` config actually live? — RESOLVED

§4 says "org/project config, or a new `devices.yaml`" and that is not good enough to build from.
What the code says today:

- The org yamls hold **no** per-node config at all — `winam.yaml` is three lines.
- `p.nodes` in `/config.json` is built dynamically by `addLoggedNodesToConfig()` from
  `mqttLogger.reportNodes()`, i.e. `{nodeid: lastseen}`. There is nowhere static to hang a layout.
- The **OTA key is a firmware-build identifier**, not a secret: binaries live at
  `ota/<org>/<project>/<key>` (e.g. `ota/dev/lotus/sonoff_r4`), the device publishes it as
  `ota/key`, and the admin form labels the field "OTA Key or Device ID".

**Resolution: a new `config.d/schema/devices.yaml`, keyed by OTA key** — sitting alongside
`modules.yaml` and `topics.yaml`. Keys match by **prefix**, so one entry covers an application across
every board it is built for; see §4.6 for the resolution order. Served in `/config.json` next to
`schema.modules` and `schema.topics`; the client reads `ota/key` off MQTT and looks the layout up.
This is exactly the brief's "a table per OTA-key" instinct, and it means **zero per-device admin** —
every device flashed with `sonoff_r4` gets the same cards. Server cost is small: load one more YAML
into `config.schema`.

*Rejected alternative:* the device declares its own layout in its discovery message. It puts a purely
presentational preference on the most constrained side of the system, costs flash and MQTT bytes, and
makes restyling a card require a reflash.

### O-2 Does the card use Shadow DOM? — RESOLVED, and neither fork is needed

The concern was that `html-element-extended` presumes Shadow DOM, so light-DOM cards would mean
either an option flag in a library other sites depend on, or a second version kept in sync. Reading
the library, neither is necessary.

**`HTMLElementExtendedMinimum` already exists, is already exported, and does not attach a shadow
root.** The shadow root is attached in exactly one place — the `HTMLElementExtended` subclass
constructor:

```js
class HTMLElementExtended extends HTMLElementExtendedMinimum {
  constructor(props) { super(props); this.attachShadow({ mode: 'open' }); }
}
```

The only thing stopping the Minimum class from rendering is that `renderAndReplace()` names
`this.shadowRoot` unconditionally — in **three places, all inside that one method** (lines 295, 297,
301). Change them to `(this.shadowRoot || this)` and the library supports both, with no flag and no
fork.

**It is backwards compatible by construction:** every existing consumer extends
`HTMLElementExtended`, so `this.shadowRoot` is truthy and behaviour is byte-identical. Nothing in
`webcomponents.js` references `shadowRoot` at all, so the client side is free too.

So, per element:

| Element | Base | Stylesheet |
|---|---|---|
| `mqtt-devicecard`, `mqtt-devicegrid` | `HTMLElementExtendedMinimum` — light DOM | `frugaliot.css` on the page; **no `CssUrl` link node** |
| `mqtt-bar`, `mqtt-text`, `mqtt-toggle`, … | `HTMLElementExtended` — unchanged | as today |

That also removes, for the new elements, the "first node rendered is a link to a common stylesheet"
boilerplate — there are 18 such `href: CssUrl` nodes in `webcomponents.js` today.

**Correcting my earlier framing:** I implied drag-and-drop, CSS grid and a fixed-position sheet need
light DOM. They do not — pointer events cross shadow boundaries fine with `composedPath()`, and
`position: fixed` works inside a shadow root. The honest arguments are styling ergonomics (the notes
at the top of `frugaliot.css` are a standing record of the `:host-context` cost) and not duplicating
a stylesheet into every root. Worth being straight about, since this touches a shared library.

**Two plan consequences.** The change lands in
`~/git/github_mitra42/html-element-extended` — a repo outside the frugal-iot tree, to be called out
when edited. And the client depends on the *published* package (`^0.1.6`; the local repo and
`node_modules` copy are currently identical), so it needs a version bump and publish, or an `npm
link` while developing.

*Optional follow-up, not required:* the widgets that keep Shadow DOM could share one constructible
stylesheet via `adoptedStyleSheets` instead of a `<link>` per root — twelve devices is on the order of
80 roots each parsing the same 10 KB. Needs a `<link>` fallback for Safari before 16.4.

### O-3 Cutover, or parallel? — RESOLVED: a parallel page, not a flag

**A new page alongside `index.html`**, not a `layout=` attribute on `mqtt-project`. `index.html`
retires once the cards cover everything it does — the admin functions especially.

Worth being precise about what `index.html` currently *is*, because it is not the project UI: its
body is a single `<mqtt-admin>`, whose render puts a `tabbed-display` with tabs
Dashboard / OTA / Admin / Nodes / API, and tab 0 "Dashboard" contains the `<mqtt-wrapper>`. So the
project UI is nested inside the admin element, and the four non-Dashboard tabs are exactly the
functions that must be covered before `index.html` can go.

This is simpler than the flag: no branch inside `mqtt-project`, and the old path stays untouched
rather than modified, so there is nothing to regress while the cards are being built.

### O-8 Where does the graph panel go on a phone? — RESOLVED: try the sheet

**What a "sheet" is** (it appears in §3.4 for the card back too): a panel that slides up from the
bottom edge and sits *over* the page, which dims behind it. It covers part or all of the screen, and
is dismissed by swiping it down, tapping the dimmed area, or a ✕. Every mobile OS uses them — the
iOS share sheet, an Android "open with" chooser — so the gesture needs no teaching. The reason it
suits us: it appears *where the thumb already is*, regardless of how far down the page you had
scrolled, which is precisely the "graph is eight cards below the bar you just tapped" problem.

**Resolution: on mobile the graph opens as a sheet; on desktop it stays a panel below the grid.**
Same mechanism as the card back, so it is built once. If it proves wrong in the hand it is a
contained change — the graph panel keeps working as a panel, so falling back costs a media query.

### O-4 Is the card a new element, or a rewrite of `MqttNode`?

New element, `mqtt-devicecard`, bound to the same `MqttTopicNode` through the existing
`el.mt` / `mt.element` convention, extending `HTMLElementExtendedMinimum` per O-2. `MqttNode` and
`MqttGroup` are not modified at all — with O-3 putting the cards on their own page, the two never
coexist in one document, so `mt.element` has a single owner and the old path cannot regress while the
new one is built.

### O-5 How is this developed and reviewed without hardware? — RESOLVED: yes, step 0

There is no test infrastructure — `npm test` is `echo "Error: no test specified"`. **A mock harness is
step 0 of the plan**: a `mock.js` that replays canned discovery and value messages into the data tree
with no broker, so every state can be put on screen in seconds — offline, stale, no readings yet,
out-of-range, control wired and unwired, one device, twelve devices. Cards cannot be built honestly
against a live broker that only shows the two or three states that happen to occur while watching.
This is the highest-leverage item in the plan and belongs before any card code.

**It must cover the existing UI, not just the cards.** The same canned message set drives
`mqtt-wrapper` → `MqttNode` → `MqttGroup` and the new card page, so the old UX has a regression check
for the whole of the build rather than being verified by hand at the end. Two consequences for how it
is built:

- The mock feeds the **data tree**, not the card, so it is layout-agnostic by construction — the
  seam is `mqtt_subscribe`/`message_received`, below both UIs.
- Assertions need to be about rendered output, not internals, or they will not survive the refactor
  they exist to protect. Snapshot the text content and key attributes of a node's rendered tree for a
  given message set; a diff is then either an intended change or a regression.

This also makes the file split in the appendix safe: run the snapshots before and after, and a purely
mechanical split has to produce identical output.

### O-6 Who fills in `width:` and `units:` across 54 topics?

Mechanical, but needs per-sensor judgement, so it is its own pass in the server schema, done *before*
the cards land — the cards look wrong without it, though they will not break (defaults exist).
Extend `check-schema.js` to warn on any displayable topic missing either.

### O-7 Relative time in four languages

"2h ago", "3 days ago" and their plurals would mean a pile of new `languages` entries. Use
`Intl.RelativeTimeFormat` instead — available in every target browser, needs no translation entries,
and gets plural rules right in HI and ID where hand-rolling would not.

### O-9 `index-embedded.html` is a third consumer, and constrains the split

It uses a bare `mqtt-client` plus `mqtt-bar` / `mqtt-toggle` with explicit topic paths — no
`mqtt-wrapper`, no project tree, no `server_config`. So `core.js` + `widgets.js` must work standalone,
which the §Appendix split allows but must not regress. Separately: `index.html` links
`/manifest.json`, which lives in the *server's* `public/`, so the client directory is not
self-serving.

### O-10 Discovery order versus stored order

Cards arrive asynchronously as discovery messages land, so the stored order has to be applied per
arrival, not once at load, and a device with no stored position and no name yet still needs a stable
slot. Append in arrival order; re-sort only on an explicit drag. Unplanned, this is where the grid
flickers.

---

## Appendix — implementation notes parked for step 2

Not a plan; a scratchpad so nothing is lost while the UX is still moving.

**Schema changes.** The master copy is `../frugal-iot-server/config.d/schema/`. Edit there first,
then propagate outwards to the `../frugal-iot-logger/examples/*/config.d/schema/` copies — never the
other way round.
- `modules.yaml`: module-level `summary: true` now, `summary: [leaves]` later (D-20);
  module-level `control: true` (D-16). **No `front:` key here** — it would duplicate `display:`.
- `topics.yaml`: `width:` (D-9); fill in missing `units:` (D-23).
- Device/project level (org yaml, or a new `devices.yaml`): `summary: [twigs]`,
  `front: [twigs and control-module ids]`, optional per-entry `label:`.
- `scripts/check-schema.js` in the logger should learn the new keys.

**Splitting `webcomponents.js`** (5.7k lines, one file). Candidate split, as a mechanical
no-behaviour-change commit *before* any card work:
- `core.js` — mqtt connection & subscriptions, `MqttTopic`/`MqttTopicProject`/`Node`/`Group` data
  tree, `server_config`, `el()`, i18n, `Watchdog`, helpers. Everything a headless dashboard needs.
- `widgets.js` — `MqttBar`, `MqttText`, `MqttToggle`, `MqttGauge`, `MqttSlider`, `MqttColor`,
  `MqttChooseTopic`, `MqttGraph`, `MqttGraphDataset`. Shared by all UIs including
  `dashboard_example.html`.
- `cards.js` — new: `mqtt-devicecard`, `mqtt-devicegrid`, layout store.
- `admin.js` — `MqttAdmin`, `MqttFlash`, `MqttLogin`, `TabbedDisplay`.
- `index.js` — the entry point `index.html` loads; imports the above and defines nothing.
- `dashboard_example.html` then imports `core.js` + `widgets.js` only, which is the separation the
  brief asks for.

**Card ↔ data tree.** The card is a DOM element bound to an `MqttTopicNode`, following the existing
convention (`el.mt` / `mt.element`, pre-bind before `appendChild`). `MqttGroup` keeps its role as
the roll-up/`summaryText()` holder but stops rendering `<details>`; the card decides layout and asks
groups for their summary strings. `MqttNode.render()` is replaced by the card.

**Reuse, do not rewrite**: `summaryText()` per module, `mqtt-bar`/`mqtt-text`/`mqtt-toggle`,
`mqtt-choosetopic` for wiring on the back, `Watchdog` for online/stale/offline, the graph panel. The
control row on the back is already built in `dashboard_example.html`'s `wireUpDashboard` — lift it
rather than rewriting it (D-19).

**New getters needed on the data tree** (per the house rule that derived values are getters on
`MqttTopic`, not dashboard logic):
- `mt.formatted` — the value rendered per `width` (D-9) plus its unit symbol (D-23).
- `mt.frontRows` / `mt.summaryChips` on the node topic — the resolved ordered lists from §4.1/§4.2,
  so the card reads a list rather than re-deriving the rules.
- `nodeMt.isControlModule(groupId)` — reading `control: true` rather than the name prefix, in both
  `MqttTopic.controlGroups` and the `frugaliot:controlgroup` dispatch in
  `MqttTopicNode.addGroupFromTemplate`. Deferred as L-4, so the prefix test stands for now.

**`manual` — node side exists, UX side does not.** The node implements it: `examples/sonoff/sonoff.ino`
defines `Control_Sonoff extends Control_Hysteresis` with an extra `manual` OUTbool, where cycling the
output sets manual and a long button press drops out of it. `topics.yaml` defines the topic and
`MqttGroupControlHysteresis` observes it and renders "Manual". What is missing is any UX for *setting*
it.

Note the `TODO-213` on that line — "handle case of valid topics but not in a module" — which is
exactly why `manual` is in `topics.yaml` while no module declares it: `Control_Sonoff` adds the output
dynamically in a subclass, so there is no module template for the schema to describe. Worth resolving
alongside `control: true` (D-16), since both are about a module declaring what it actually publishes.

Setting `manual` from the UI is **deferred** (§14), so nothing above blocks the card work.

**Open technical questions**: whether cards keep Shadow DOM (styling across shadow boundaries is
already awkward — see the notes at the top of `frugaliot.css`); whether the layout store belongs in
`core.js` or `cards.js`; how the mobile sheet coexists with `position: sticky` header.
