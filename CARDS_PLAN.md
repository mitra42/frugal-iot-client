# Device Cards — Implementation Plan

Step 2 of 3. The design is `CARDS_UX.md`; decisions D-1…D-33, deferrals L-1…L-7 and resolved plan
questions O-1…O-10 are settled there and are inputs here, not open questions. This document says
**how and in what order**, and sets the code rules the implementation must hold to.

Two questions are genuinely new and marked **P-n**. Everything else is a recommendation to follow.

---

## 1. What "done" means

A new page renders every device in a project as a card with summary / front / back modes, arranged
by drag, remembered locally, gated by `WRITE`; and the project's own back carries the admin cards.
`index.html` and the existing node/group UI **still work unchanged** and are covered by regression
tests throughout.

Explicitly not done here: retiring `index.html` (a later step once the admin cards are proven), and
everything in `CARDS_UX.md` §14.

## 2. Sequence

Phases are ordered by what they unblock. Sizes are relative, not hours.

| # | Phase | Size | Gates | Ships alone? |
|---|---|---|---|---|
| 0 | Test infrastructure and mock harness | M | everything | **DONE** |
| 1 | `html-element-extended`: light-DOM rendering | S | 5 | **DONE** |
| 2 | Schema: `devices.yaml`, `width`, `units`, capabilities | M | 4, 8 | **DONE** |
| 3 | Split `webcomponents.js` | M | — (but easier before 4+) | **DONE** |
| 4 | Data tree: move roll-up down, add derived getters | M | 5, 6 | **DONE** |
| 5 | The card element — summary / front / back | L | 6, 7 | **DONE** |
| 6 | The grid — layout, drag, `localStorage` | M | 7 | no |
| 7 | The new page, project front/back, admin cards | L | — | yes |
| 8 | Permissions: `WRITE`, `OTAFLASH` | S | — | yes |
| 9 | Polish: sheets, motion, i18n sweep, visual pass | M | — | yes |

Phases 1 and 2 are independent of everything and of each other — start them whenever. Phase 0 comes
first because its value is protecting phases 3–7, and because it is the only way to see the work
without hardware.

## 3. Code design criteria

Rules for this work. The first group is house style from `CLAUDE.md`, restated because these are the
ones a large new surface tends to erode; the second is specific to cards.

### 3.1 Existing house rules that this work must not erode

- 2-space indent. Callback-style async (`async` library), not promise chains.
- Comments say **why**, one line, never restating the code. No trailing prose summaries.
- **Derived values are getters on the data tree**, not logic in a view. If a card computes something
  by walking `node → group → topic`, that walk belongs on `MqttTopic`/`MqttTopicNode` as a getter and
  the card reads it. This rule does most of the work in phase 4 — treat a traversal inside a card as
  a defect.
- Every new UI string goes in all four languages (EN, FR, HI, ID), even if the text is identical.
- Translation only reaches `textContent` **attributes** — `el('p', {textContent: "…"})`, never
  `el('p', {}, ["…"])`. Pass `i8n: false` for names, ids and per-row data.
- No new `XXY` calls. Use `XXX` for states that should not happen, and leave the calls in.

### 3.2 New rules for the card work

- **The card renders a resolved row list, never a group traversal.** `nodeMt.frontRows` returns an
  ordered array of `{kind: 'reading'|'actuator'|'control', mt|groupMt, label}`; the card maps it to
  DOM. All the §4.2 precedence — device `front:` list, else `graphable` readings then actuators then
  controls, minus `insidefrugaliot`, minus control-owned topics — lives in that one getter, where it
  can be unit-tested with no DOM.
- **Light DOM for card and grid, shadow DOM for widgets.** `mqtt-devicecard` and `mqtt-devicegrid`
  extend `HTMLElementExtendedMinimum`; `mqtt-bar` and friends are untouched. Card CSS classes are
  prefixed `fi-` since there is no shadow boundary to protect them.
- **No `<slot>` in a light-DOM element, and nothing it did not render may live inside it.**
  `renderAndReplace()` clears its render root, which for these elements is the element itself. The
  grid renders once via `render0()` and mutates in place as devices arrive; anything reaching for a
  slot has picked the wrong base class.
- **Cross-boundary styling is CSS custom properties, never `:host-context`.** Define the palette,
  spacing and type scale as `--fi-*` properties on `:root`; widgets read them. Custom properties
  pierce shadow boundaries, which is the whole reason to use them here.
- **One permission gate.** A single `get canWrite()` (on the wrapper, from `server_config.user`),
  read wherever it is needed. Never a scattered `hasPermission('WRITE')` in each widget — that is how
  a control ends up editable on one card and not another.
- **Numbers go through one formatter.** `mt.formatted` applies `width`, appends the unit symbol, and
  never truncates. No `toFixed` anywhere else.
- **`localStorage` access is wrapped and versioned.** One module, try/catch on every read and write
  (private browsing throws), a `v:` field in the stored object, unknown/absent → sane default. A
  storage failure must degrade to "no remembered layout", never to a broken grid.
- **Core does not import widgets.** `MqttTopic.createElement()` reaches widgets by tag name
  (`el('mqtt-bar', …)`), not by class import. Preserve that: it is what keeps `core.js` loadable on
  its own and `index-embedded.html` working.
- **No silent schema fallbacks.** A topic with no `display`, an unknown module, a `front:` entry
  naming a twig that does not exist — `XXX` and render something visibly wrong-looking, rather than
  quietly skipping. Silent skips are how a device ends up with a blank card and no clue why.

## 4. Phases

### Phase 0 — Test infrastructure and mock harness

The seam is already there and it is a good one. `MqttClient` dispatches messages in six lines at
`webcomponents.js:2013`:

```js
for (let o of mqtt_subscriptions) {
  if (topicMatches(o.topic, topic)) { o.cb(topic, msg); }
}
```

**Extract that into an exported `mqtt_deliver(topic, msg)`** and the mock needs no fake broker, no
network and no `mqtt` module — it calls `mqtt_deliver` with canned messages and the entire tree, old
UI and new, behaves exactly as it does against a real broker.

Three tiers, in descending order of how often they get used:

**Tier 0 — `test/mock.html`, a browser harness.** Loads a canned scenario and renders it. This is the
thing to open to see progress, and to review a card against the mockups in `CARDS_UX.md` §3. Cheap,
and it is what makes the rest of the work reviewable without flashing a device.

**Tier 1 — data-tree tests under `node:test`.** Headless mode already exists
(`<mqtt-wrapper headless>` builds the full tree with no elements), so the getters from phase 4 —
`frontRows`, `summaryChips`, `formatted`, `usableName`, staleness — are testable without a browser.
This is where most assertions should live, because it is where most of the logic will live if §3.2 is
followed.

> **Correction, found while building this.** An earlier draft said tier 1 needs "no jsdom, no
> browser". Wrong: `webcomponents.js` has ~25 `customElements.define` calls plus `Chart.register`
> and `_adapters._date.override` at module scope, so merely importing it requires `customElements`
> and `document` to exist. jsdom supplies them, and once it does the *same* run can also render and
> snapshot the DOM — so tiers 1 and 2 largely merge, and Playwright is not needed yet.

**Tier 2 — rendered-DOM snapshots**, of the same scenarios. **These cover the old node/group UI as
well as the cards** — one scenario set, both layouts, so phases 3–7 have a regression check for the
existing UX rather than a hand-check at the end. Descend into shadow roots, record tags, meaningful
attributes and text, and normalise timestamps.

Assert on rendered output, not internals; internals are what phases 3 and 4 deliberately change.

**Deferred: bare specifiers.** Converting `/node_modules/…` imports was listed here, and is not
done. Each package resolves differently in node and in the browser (`mqtt` in particular has separate
node and browser builds), so it is its own change with its own verification, and mixing it into a
refactor whose contract is "byte-identical output" would have undermined that. The test resolve hook
stays until then.

**A second obstacle worth recording**: the client's imports are server-root-relative
(`/node_modules/html-element-extended/…`), which node cannot resolve at all — only a web server can.
`test/setup.js` installs a `module.registerHooks` resolve hook that maps them onto the real
`node_modules`. **Phase 3 should convert them to bare specifiers** and add the missing importmap
entries, at which point the hook can go; the absolute paths are also why the client cannot be served
from a subpath.

**Scenarios the canned set must include**, because these are the states that never show up when you
happen to be watching a live broker: device live / stale / offline / never-seen; device discovered
with no readings; reading out of range; control wired and unwired; actuator driven by a control;
`manual` set; no `WRITE`; one device; twelve devices; a module absent from `modules.yaml`.

**P-1 is now moot for this phase.** jsdom turned out to handle custom elements and shadow DOM well
enough to snapshot both UIs, so it is the only new devDependency. Playwright stays worth considering
later, for the things jsdom genuinely cannot do — pointer-event drag (phase 6), the bottom sheets and
transitions (phase 9), and real CSS layout. Decide it when phase 6 starts, not now.

**Delivered:**

| File | Role |
|---|---|
| `test/setup.js` | jsdom globals + the `/node_modules/…` resolve hook |
| `test/mock.js` | scenarios and `runScenario()`, replayed through `mqtt_deliver` |
| `test/serialize.js` | rendered-tree serializer that descends into shadow roots |
| `test/fixtures/regenerate.js` | rebuilds `fixtures/config.json` from the real server schema |
| `test/datatree.test.js` | 15 data-tree tests |
| `test/oldui.test.js` | 5 rendered snapshots of the existing UI |
| `test/snapshots/*.txt` | the committed snapshots |
| `test/mock.html` | browser harness — pick a scenario, see it render |

The harness is at **`/dashboard/test/mock.html`** — the client is served under `/dashboard`, not the
server root. It needs no login and never connects to a broker: the schema comes from the checked-in
fixture and every value from `mqtt_deliver`.

Source changes: `mqtt_deliver()` extracted from `MqttClient`'s `on('message')`; `configSet()` added
and used by both existing `server_config = json` sites; the export list extended with the data-tree
classes and the subscription functions a headless consumer needs.

One real bug fell out of running the harness. `CssUrl` was `'./frugaliot.css'` and the graph icons
`'images/icon_graph.svg'` — both resolved against the **document**, so from a page one directory down
every shadow root's stylesheet link 404'd and the UI rendered entirely unstyled. Since nearly all of
the UI lives inside shadow roots, the client only worked when served from the one directory holding
`frugaliot.css`. Both now resolve against the module's own URL:

```js
const CssUrl = new URL('./frugaliot.css', import.meta.url).href;
const ImagesUrl = new URL('./images/', import.meta.url).href;
```

Same family as the `/node_modules/…` imports, and the same lesson for phase 3: nothing in the client
should assume the document's directory.

Scenarios deliberately **not** included yet: `live/stale/offline/never-seen` and `manual`. They
depend on `nodeMt.status`, which arrives in phase 4; faking them now would test the fake. Add them
with that phase, driven by an injectable clock rather than real timers.

### Phase 1 — `html-element-extended`: light-DOM rendering

In `~/git/github_mitra42/html-element-extended` — **a repo outside the frugal-iot tree; I will call
out the edit when I make it.**

Done as a `renderRoot` getter returning `this.shadowRoot || this`, with `renderAndReplace()` using
it in all three places. A named getter rather than an inline `||` so a subclass can see where its
output goes, and so the constraint below has somewhere to be documented.

Backwards compatible by construction: every existing consumer extends `HTMLElementExtended`, so
`shadowRoot` is truthy and behaviour is byte-identical. Nothing in `webcomponents.js` references
`shadowRoot`. Confirmed by the phase 0 snapshots passing unchanged against the linked library.

**Constraint this creates, and it matters for phases 5–6.** A light-DOM element renders into itself,
so `<slot>` means nothing to it and `renderAndReplace()` **destroys any children it did not render**.
The existing UI leans on slots heavily; cards cannot. Two consequences:

- `mqtt-devicecard` builds all its own children from the data tree — no slots, no author children.
- `mqtt-devicegrid` appends cards as devices are discovered, so a later full re-render would wipe
  them. Use `render0()` — which the library already supports, rendering once — and mutate in place
  afterwards, rather than re-rendering the grid.

**`npm link` needed a workaround.** The global npm prefix is `/usr/local/lib/node_modules`, owned by
root, so `npm link` fails without sudo. `npm run link:hee` does the local half directly:

```
ln -sfn ../../html-element-extended node_modules/html-element-extended
```

`package.json` is untouched (still `^0.1.6`), and the published copy is kept alongside as
`html-element-extended.published-0.1.6`. **`npm install` replaces the symlink**, so re-run
`npm run link:hee` after one; `npm run unlink:hee` goes back to the published package. The library
change is `0.1.7 (unreleased)` in its CHANGELOG — publish once the card work settles.

Verified by `test/lightdom.test.js`: a Minimum subclass renders into itself with no shadow root and
re-renders replace rather than append; an HTMLElementExtended subclass still renders into its shadow
root with nothing leaking into its light DOM.

### Phase 2 — Schema

Master is `frugal-iot-server/config.d/schema/`; propagate to the three
`frugal-iot-logger/examples/*/config.d/schema/` copies. Never the reverse.

1. **`devices.yaml`** (new). Keys match by prefix (§4.6): device id, then exact OTA key, then the
   longest key the OTA key starts with. The OTA key is `PREFIX_SUFFIX` where the suffix is the board,
   so one entry per *application* covers every board it is built for:
   ```yaml
   sht30:                     # matches sht30_c3_pico, sht30_d1_mini, sht30_s2_mini_4x, …
     front:   [sht/temperature, sht/humidity]
   sonoff:                    # matches sonoff_r4
     front:   [controlhysteresis, relay/on]
     summary: [controlhysteresis]      # optional — defaults to the first two of front
   esp8266-fb94bb:            # one device overriding its build
     front:   [sht/temperature]
   ```
   Roughly one entry per example application, so the file stays small.
2. **`topics.yaml`**: add `width:` to `float` and `exponential` topics only — **25 of 54**, not all
   (D-35); ints derive their field width from `min`/`max`. Fill in missing `units:`. Mechanical but
   needs per-sensor judgement, so its own reviewed pass.
3. **`modules.yaml`**: `summary: true` on the modules that should contribute a summary.
4. **Server**: *no change needed.* `readConfigFromDir` maps `config.d/<dir>/<file>.yaml` onto
   `config.<dir>.<file>`, so dropping the file in makes it `config.schema.devices` and it reaches the
   client in `/config.json` for free. Confirmed while building phase 0's fixture, which mirrors that
   mapping.
5. **`frugal-iot-server/scripts/check-schema.js`** — extended, not written. It already existed, in
   the server beside the master schema; I looked only in the logger's `scripts/` and wrongly
   concluded it was missing, then wrote a second one there. The duplicate is deleted and its checks
   merged into the original, which already had several the new one lacked — a module topic
   overriding a field its base topic does not define, a `duplicates` rule that sets neither
   threshold, a topic that is not a set of settings, and per-type reasoning about what `log:` would
   default to. Added to it: `width` missing / present on a type with no decimals / too small for its
   own range; `units` missing on a numeric topic; `devices.yaml` entries naming a module or leaf that
   does not exist (an **error**, since it silently loses a row); prefix shadowing between device
   keys; `summary: true` being a no-op; and `--resolve <otakey>`. Its "warnings never block" contract
   is kept — errors exit 1, and both call sites already guard with `|| true`.
6. **`frugal-iot-server/scripts/copy-schema-to-examples.zsh`** — likewise already existed, and had
   just been left behind: it copied a hard-coded `topics.yaml modules.yaml` and so never copied the
   new `devices.yaml`. Changed to glob every `*.yaml` in the schema directory, so the next file added
   is not silently missed too. My duplicate `propagate-schema.js` is deleted.

**Outcome.** `width` on all 25 float/exponential topics, derived so decimals stay steady as a value
moves; `summary: false` on six modules (D-37); `devices.yaml` with 11 application entries; the
checker and propagator; `check-schema.js` reports OK. `defaults.h` is unaffected — the generator
extracts only `color`/`min`/`max`.

**Judgement calls, resolved:**

- `pressure` had `min: 0, max: 99` — a placeholder that all three bmx280 modules overrode. The base
  is now `300..1100` with `units: hPa`, and those three overrides are deleted as redundant. Note
  `ms5803` never overrode it and so now inherits the atmospheric range, which suits it as a
  barometer but not as a depth sensor.
- `soil` now uses `units: "%"`. SenML has only `%RH`, which is relative humidity and not this; the
  registry is restrictive and unmaintained, so we do not follow it here.
- `gps` contributes to summaries after all — its `summary: false` is removed.
- `satellites` had `units: m/s`, copied from `speed`; corrected to `count`. **Its type is still
  `float` for what is a count** — changing that touches logging and firmware, so it is flagged, not
  changed.
- `altitude` gained `units: m`. `latitude`/`longitude` keep `lat`/`lon`, which are real SenML units
  despite looking like field names.
- Still no units, and each needs a human: `loadcell` (depends on the cell), `hdop` (dimensionless),
  `controlfloat` (a generic template).

Deliberately **not** here: `control: true` (deferred L-4 — with `climate` deleted the name-prefix
test is correct for every module that exists).

### Phase 3 — Split `webcomponents.js`

5,723 lines in one file. Mechanical, no behaviour change, verified by running the phase 0 snapshots
before and after and requiring identical output.

| File | Lines | Imports | Contents |
|---|---|---|---|
| `core.js` | 2214 | **none** | mqtt plumbing, `mqtt_deliver`, topic helpers, the `MqttTopic*` data tree, `Watchdog`, i18n + `languages` + `el`, `server_config`, `MqttClient`, `MqttWrapper`, `LanguagePicker` |
| `widgets.js` | 717 | core | `MqttElement`…`MqttChooseTopic` — the leaf display and control elements |
| `graph.js` | 475 | core, widgets | `MqttGraph`, `MqttGraphDataset`, the inlined Luxon adapter — pulls Chart.js |
| `nodeview.js` | 457 | core, widgets | `MqttProject`, `MqttNode`, `MqttGroup` + subclasses — **retires with `index.html`**, said so in its header |
| `flash.js` | 609 | core | `MqttFlash` and the partition helpers — pulls esptool-js |
| `admin.js` | 1331 | core | `MqttAdmin`, `MqttLogin`, `TabbedDisplay` |
| `webcomponents.js` | 19 | all | the entry every page already loads: `export * from './core.js'` plus side-effect imports |

`cards.js` and its entry point arrive with phases 5–7; there was nothing to put in them yet.

**No HTML changed.** Every page already loads `webcomponents.js` as its entry, and
`dashboard_example.html` imports four helpers from it, so keeping it as the shim left all five pages
untouched — a better outcome than the planned separate `index.js`.

**Verification: the five old-UI snapshots are byte-identical**, which is what "mechanical, no
behaviour change" was supposed to mean. `test/modules.test.js` now also pins the shape: core imports
nothing, widgets needs only core, graph and nodeview need only core and widgets, and importing
`core.js` alone registers no display widgets — so `index-embedded.html`'s core+widgets case (O-9)
cannot silently regress.

**Four behaviour-preserving edits were needed first**, because the module graph was not a DAG:

- `MqttTopic.graph` called `MqttGraph.graph` directly — a core→graph cycle. It now goes by tag name,
  `customElements.get('mqtt-graph')`, the same way `createElement` reaches the widgets. This is the
  rule in §3.2 and it is now what keeps core standalone.
- `MqttWrapper` borrowed `MqttReceiver.observedAttributes`, a core→widgets reference evaluated at
  `customElements.define` time. Both now share a `RECEIVER_ATTRIBUTES` constant in core.
- `MqttChooseTopic` did `++unique_id` on a core variable — an imported binding cannot be assigned to.
  It calls `nextUniqueId()`, and the label and select now share one captured id instead of reading
  the counter twice.
- Two locals shadowed module-level names — `let el` inside `elementsForEach` and `let graph` inside
  `createGraph` — which hid a real import behind a false negative. Renamed to `elx` and `graphEl`.

**Two things the generator nearly lost, worth recording** because both would have failed only at
runtime: `Chart.register(...registerables)` lived in the file preamble, outside every declaration
block; and `import { DateTime } from 'luxon'` sits *mid-file* at line 53, inside the copied
chartjs-adapter-luxon block, so it was swept into a core-owned block instead of following the adapter
into `graph.js`.

### Phase 4 — Data tree

**4a. Move the summary roll-up down to `MqttTopicGroup`.** `summaryText()` currently lives only on
the `MqttGroup*` *element* subclasses (`webcomponents.js:5245-5317`), which exist only when not
headless. So a headless card page cannot call it — the card would have no summary at all. Move the
logic to `MqttTopicGroup`, reading `this.topics[leaf].state.value` directly rather than relying on
values being mirrored up as element attributes. The `MqttGroup*` element subclasses become thin
wrappers that call it, and disappear with `nodeview.js`.

This is the one architectural change of consequence in the plan, it is squarely within "derived
values are getters on the data tree", and it makes every summary unit-testable with no DOM.

**4a turned out easier than feared.** `groupMt.state[leafAttr]` was *already* being mirrored on
every message, in both the element path (`MqttReceiver.topicValueSet`) and the headless one
(`MqttTopic.message_received`). So `MqttTopicGroup` already held exactly the state the element
subclasses were reading, and the summary logic moved across essentially verbatim. What was needed
around it:

- `MqttTopicGroup` subclasses in `core.js` (`…Relay`, `…Soil`, `…Ota`, `…Battery`, `…DS18B20`,
  `…Ht`, `…ControlHysteresis`), chosen by a `topicGroupClasses` registry keyed on module id — the
  data-tree counterpart of looking up `mqtt-group${groupId}` as a custom element.
- `groupMt.nodeMt` and `groupMt.twig` set at creation, so `projectMt` resolves (the control summary
  needs it to name what its inputs are wired to) and `topicPath` is right for a group.
- The group element now links to its group topic (`el.mt` / `mt.element`), which it never did.
- `MqttSummaryGroup.summaryText()` delegates to `this.mt.summaryText()`; the per-module element
  subclasses keep only what is genuinely presentational — `MqttGroupLedbuiltin.renderSummary()`
  draws a coloured dot rather than returning text, so it stays.

**4b, all done and all tested with no DOM:** `mt.decimals`, `mt.formatted`, `mt.outOfRange`,
`unitSymbol`/`unitSuffix`, `nodeMt.status`, `nodeMt.age`, `nodeMt.otaKey`, `nodeMt.deviceConfig`,
`nodeMt.orderedGroupIds`, `nodeMt.labelFor`, `nodeMt.resolveEntry`, `nodeMt.frontRows`,
`nodeMt.defaultFrontEntries`, `nodeMt.summaryChips`.

Three details worth knowing:

- **Status needs no timer.** `noteMessage()` learns the reporting interval as messages arrive, the
  same smoothing `Watchdog` does, but derives `live | stale | offline | never` from arithmetic rather
  than a `setTimeout`. That makes it testable, and `setClock()` in core lets a test decide what "now"
  is. The old UI keeps its timer-driven `Watchdog` until `nodeview.js` retires.
- **Group order comes from `modules.yaml`, not from message arrival**, or a card would reorder itself
  between loads depending on which sensor reported first.
- **A declared row is dropped when the device lacks that module.** `devices.yaml` is keyed by
  application, so it lists what the application *can* have; a device whose control never reported
  must not get an empty row. Pinned by a test.

### Phase 5 — The card

**Summary mode is done.** `cards.js` holds `mqtt-devicecard`, light DOM, reading only data-tree
getters. Four things came out of reviewing it in the harness:

- A bare `47%` beside the device name says nothing about *what* is 47%. It is now the battery level
  icon alone (`images/Battery0-6.png`, already in the repo and reached for by the old UI's dead
  `topicChanged` code) — the summary is a glanceable view and the level is in the icon's shape, so
  the number is clutter. The percentage is on the icon's title and will be text on the front. The age
  shows whenever the device is not live (D-39).
- An unwired control is left off the summary entirely (D-40): a device often carries a control nobody
  wired up, and it should not take one of the four places. It still appears on the front.
- The summary cap of two was too tight — an ENS160 device wants temperature, humidity and air
  quality, and a control besides. Raised to four for the fallbacks; a declared `summary:` list is
  uncapped (D-36).
- A control was missing from the summary entirely, because `sht30`'s `summary:` list stopped short
  of it. Those redundant lists are deleted from `devices.yaml` so the default picks the control up,
  and a control now contributes a **chip** — `Relay ✓` — rather than its whole rule (D-38).
- The hand-written module summaries read raw state and hardcoded `°C`/`%RH`, so a summary showed
  `30.142857°C`. They now go through `mt.formatted`, which gives them width-based rounding and the
  schema's own units, and removes the hardcoded units D-23 complained about. The old UI gets the
  same improvement: `3940` became `3940 mV` and a lone `✓` became `Relay ✓`.

**Front mode is done.** Three row kinds off `nodeMt.frontRows`, built from the widgets the client
already has, plus the header buttons (⌄ collapse, ⚙ back) and the battery / last-seen footer.

- **Widgets are pre-bound (`el.mt`) but deliberately not registered as `mt.element`.** Only one
  element can hold that at a time, so binding would have this card competing with a graph, a second
  card, or the old UI for the same topic. The card pushes values into its own children from
  `refresh()` instead — which is also why the "clear the back-reference when rebuilding" footgun in
  CLAUDE.md does not apply here.
- **The `label` attribute never worked.** Every widget rendered `this.mt.name` regardless, so
  `dashboard_example.html`'s `label:` has always been ignored. A `displayLabel` getter now prefers
  the attribute, which is what lets a card show "Soil Temperature" where the topic is called
  "Temperature".
- **The bar showed the raw value** — `30.142857` — which made `width` pointless. `mqtt-bar` and
  `mqtt-text` now display `mt.formatted`, and the bar gained the min/max end labels §9 asked for.
  Both improvements land on the old UI too: `3940` → `3940 mV`, `30.142857` → `30.1°C`, and every
  bar now says what its range is.

**Back mode is done**, so phase 5 is complete. Flat sections in fixed order — Device, Controls,
readings by module, Advanced — with `<details>` used exactly once, for Advanced. The control section
is the compact `[>] [ 32.0 ] ± [ 3.0 ]` row lifted from `dashboard_example.html` (D-19), with the
input and output as the topics' own widgets so their wiring dropdowns come for free. Every module
gets a section, including ones the front leaves out — which is how a device's relay stays reachable
when its `devices.yaml` entry does not list it.

Editing is **not** gated yet: `WRITE` arrives in phase 8, and until then the back is as editable as
the existing UI is.

Reviewing the back turned up six more, and one of them was a genuine headless crash:

- **`renderWiredName` reached `wiredTopic.node`** — the `MqttNode` *element*, which a headless page
  does not have. It threw inside `connectedCallback`, so the widget rendered nothing at all and the
  wiring chooser simply appeared to be missing. A `mt.fullName` getter now goes through `nodeMt`.
  There is a test for the failure *mode* as well as the bug: no widget on a card may render empty.
- **`labels="<,>"` rendered a two-option `<select>`.** D-19 says a comparison should flip in one tap,
  and I had described the existing behaviour wrongly when writing it. It is a button showing the
  current symbol, and clicking it flips.
- **A wireable field inside the compact row wrapped itself in a `<details>`**, so a stray disclosure
  sat above the limit and revealed a second copy of the label and value when opened. There is now a
  `wiring` attribute: `none` for a row that lays out and labels its own fields, `open` for one whose
  purpose is to wire something.
- **The output's chooser was there but collapsed**, which is the same thing as absent when the row
  exists to be wired. `wiring="open"` on input and output.
- **Every chooser claimed "Unused".** `renderDropdown` read the `wired` *attribute*, which is only
  ever set on the element path, so on a headless card it saw null — each chooser was misreporting
  its own state. It reads `mt.wired` now.
- **The wired source was named twice**, once by the chooser and once as text beside the value, and
  the text then sat stale until the broker echoed a change back, so the two disagreed. The chooser
  names it; the text only appears where `wiring="none"` means there is no chooser to do so.
- **My first attempt at the overflow was wrong in a way the design criteria already warned about.**
  I wrote `.fi-when input { max-width }` from the page stylesheet, but those inputs are inside the
  widgets' shadow roots, so it never applied. It is a custom property now — which §3.2 says is the
  only way to style across that boundary.
- **The gear on the back did nothing** — the back *is* where the gear goes. It is gone, and `✕`
  returns to the front rather than all the way to the summary.
- **Out-of-range readings were only red on the front**, and the hysteresis field overflowed the card.

Two more pre-existing defects surfaced while building it:

- **`label=""` was indistinguishable from no label.** `displayLabel` used `||`, so an explicitly
  empty label fell back to the topic name and the back read "Name  Node Name  [input]". It now
  treats any string, including empty, as the caller labelling it themselves.
- **`min`/`max` were stringified unconditionally**, so a text topic got `min="undefined"` in the
  attribute and `min="NaN"` on the input it rendered.

Reviewing the front turned up four more, three of them in code that predates the cards:

- **A bar whose reading was below min showed a stub of fill, not an empty bar.** `MqttBar.width`
  returned a negative percentage, which is not a width, so the fill shrank to fit its own text.
  Clamped to 0..100, so under-range empties the bar and over-range fills it, with the true value
  still printed. The `out-of-range` scenario now carries one of each.
- **The range-end labels rendered as "0100".** `mqtt-bar`'s host is `display: inline` by default, so
  its shadow content shrink-wraps and `justify-content: space-between` had no width to work across.
  The host is a block now.
- **`frugaliot.css` had a stray `}`**, at what was line 263, leaving every rule after it parsed at
  brace depth −1. It has presumably been there a while.
- **The collapse control was a `⌄`**, which reads as "there is more below" — the opposite of what it
  does. It is now a `✕`, and sits last so it lands in the corner.

**And one real bug that change exposed.** In `MqttReceiver.topicValueSet` the group roll-up
(`setAttribute`, which triggers `reSummarize`) ran *before* `valueSet` mirrored the value into the
data tree. Any summary built from the data tree was therefore one message behind — and empty for a
topic that reports only once. The tree is now updated first, before anything is asked to re-render,
which is the right order regardless.



`mqtt-devicecard`, light DOM, `mode="summary|front|back"`, bound to its `MqttTopicNode` by the
existing `el.mt` / `mt.element` convention (pre-bind before `appendChild`, per `CLAUDE.md`).

Build in mode order — summary, then front, then back — with each reviewed in `test/mock.html` against
the §3 mockups before starting the next. The back is the biggest single piece; its control row lifts
`wireUpDashboard` from `dashboard_example.html` rather than reimplementing it (D-19).

Reuse and do not rewrite: `mqtt-bar`, `mqtt-text`, `mqtt-toggle`, `mqtt-choosetopic`, `Watchdog`, and
the graph panel.

### Phase 6 — The grid

`mqtt-devicegrid`, light DOM, CSS grid `repeat(auto-fill, minmax(300px, 1fr))`.

- Drag-to-reorder on Pointer Events, not HTML5 DnD (unreliable on Android). Long-press to lift on
  touch, plus always-visible ▲▼ buttons (D-13), plus keyboard grab/move/drop.
- Layout store: `frugaliot:layout:v1:{org}/{project}` → `{v, order, mode, pinned}`, per §3.2's
  wrapping rule.
- Apply the stored order **per card arrival**, not once at load (O-10) — cards appear as discovery
  messages land. Append unknown devices; re-sort only on an explicit drag.

### Phase 7 — The page, project front/back, admin cards

A new page beside `index.html` (O-3) — nothing in `index.html` or `nodeview.js` is modified.

- Sticky header: org and project selectors, connection status, language picker, app gear.
- Project front = the device grid. Project gear flips to the project back = admin cards.
- Admin cards, each shown only with its capability (D-28, and the §11 table): OTA `OTAUPDATE`,
  Flash `OTAFLASH`, Permissions `ADMIN`, Projects `ADMIN`, Publish Message `ADMIN`, Nodes `ADMIN`,
  API `ADMIN`.
- **Omit the project gear entirely when no card would appear** (D-29).
- API is wrapped, not redesigned (D-30). Flash moves out of the OTA tab's `OTAUPDATE` gating, which
  is a relocation of `mqtt-flash`, not just a new condition.
- The eight §8.1 empty and error states are part of this phase, not afterthoughts.

**P-2 — what is the new page called?** `cards.html` describes the implementation; `dashboard.html`
describes the job and is what it will become when `index.html` retires. Recommend `dashboard.html`.

### Phase 8 — Permissions

- `WRITE` and `OTAFLASH` into the capability dropdown at `webcomponents.js:3060`, which today offers
  `OTAUPDATE`/`ADMIN`/`READ`. No server or DB change — capabilities are free text in
  `permissions(id, capability, org)`.
- One `canWrite` gate (§3.2); without it every control degrades to its display form per §10.1, and
  ADVANCED's actions are omitted.
- Card order and open/closed state are local presentation and stay available without `WRITE`.
- Nothing here is a security boundary and no code comment or UI text may imply it is (D-27, L-7).

### Phase 9 — Polish

Bottom sheets for the card back and the mobile graph (O-8); 150–200ms transitions honouring
`prefers-reduced-motion`; `Intl.RelativeTimeFormat` for "2h ago" (O-7); the four-language sweep for
every new string; the §9 visual pass including `--fi-*` tokens and fixing the invalid
`border: 1px,black,solid` declarations.

## 5. Risks

**A bug found and fixed while doing this.** The control summary ended with
`trueFalseSymbol(this.state.on)`, but no control module has an `on` leaf. The firmware's
`Control_Hysteresis` publishes an `OUTbool` named **`out`** (`src/control/hysteresis.cpp:58`), and
the `on` topic in `topics.yaml` is `rw: w` — an *actuator's* leaf, as on `relay` and `ledbuiltin`.
So that symbol had always rendered `?`. Fixed in three places:

- `MqttTopicGroupControlHysteresis.summaryText()` reads `state.out`;
- the element's `observedAttributes`/`boolAttributes` observe `out` rather than `on`, or the summary
  would not refresh when the output changed;
- `dashboard_example.html` had the same bug twice — its on/off dot read `groupMt.state.on`, so it has
  never lit.

The snapshot records the fix: `Relay = SHT:Temperature > 32 +/- 3 ✓`.

| Risk | Bites when | Mitigation |
|---|---|---|
| Old UI regresses unnoticed | phases 3–4 change shared code | tier 2 snapshots cover both layouts from phase 0 |
| `html-element-extended` change breaks other sites | on publish | `npm link` during development; publish only at the end; the change is a no-op when a shadow root exists |
| Schema edits diverge across 4 files | every phase 2 touch | one script edits master then copies; `md5` the four files as the check |
| The split changes behaviour by accident | phase 3 | snapshots must be byte-identical before and after |
| `frontRows` precedence grows into a tangle | phase 4 | it is one getter with one test file; if it needs a second place, the design is wrong |
| Chart.js / esptool-js slow the card page | phase 3 | dynamic `import()` for both |
| `width`/`units` pass stalls the UI work | phase 2 | defaults exist (1dp float, 0 int, no unit); cards look wrong but work |

## 6. Open plan questions

- **P-1** Playwright for tier 2 browser snapshots, or tier 0+1 only?
- **P-2** New page name: `dashboard.html` (recommended) or `cards.html`?

Neither blocks starting phase 0.
