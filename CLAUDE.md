# Frugal IoT Client

JavaScript/Web Components MQTT client for the Frugal IoT project. Connects to an MQTT broker, auto-discovers nodes via discovery messages, and renders live sensor data using custom HTML elements.

## Modules

The client was one file; it is now split. `core.js` imports none of the others — that is what keeps
it loadable on its own, and it is maintained by reaching the display elements **by tag name**
(`el('mqtt-bar', …)`), never by importing their classes.

| File | Imports | Holds |
|---|---|---|
| `core.js` | none | MQTT plumbing, the `MqttTopic*` data tree, `Watchdog`, i18n and `el`, `server_config`, `MqttClient`, `MqttWrapper` |
| `widgets.js` | core | `mqtt-bar`, `mqtt-text`, `mqtt-toggle`, `mqtt-gauge`, `mqtt-slider`, `mqtt-color`, `mqtt-choosetopic` — all shadow DOM |
| `graph.js` | core, widgets | `mqtt-graph`, `mqtt-graphdataset` — pulls Chart.js |
| `cards.js` | core | the card UI: `mqtt-devicecard`, `mqtt-devicegrid`, `mqtt-projectback`, `mqtt-dashboard`, the layout store |
| `nodeview.js` | core, widgets | the old node/group UI — **retires with `index-old.html`**; nothing new belongs here |
| `flash.js` | core | `mqtt-flash` — pulls esptool-js |
| `admin.js` | core | `mqtt-admin`, `mqtt-login`, `tabbed-display` |

Entry points: `index.html` → `dashboard.js` (the card UI, everything but `nodeview.js`);
`index-old.html` → `webcomponents.js` (everything, and the only remaining user of it);
`index-embedded.html` needs only `core.js` + `widgets.js` and must keep working.

Dashboards (e.g. `dashboard_example.html`) are thin HTML pages importing selectively.

## Design documents

`CARDS_UX.md` is the design for the card UI — every decision is numbered (D-n) with its reasoning,
deferred work is L-n, and it is the place to argue with a choice rather than re-deciding it in code.
`CARDS_PLAN.md` is how it was built, including the bugs found on the way. `FLASH_PLAN.md` and
`HEADLESS_PLAN.md` cover their own areas.

## Code style

- **Indentation**: 2 spaces throughout.
- **Async style**: prefer callback-style async (using the `async` library from `caolan/async`) over Promise chains. Existing `fetch` calls that use `.then()` are legacy patterns; new async code should use callbacks or `async.waterfall` / `async.parallel` etc.
- **Comments**: explain WHY, not WHAT. One short line is enough; do not restate what the code clearly shows. No multi-line docstrings.
  - Good: `// topicSetPath throws when this.node is null — guard before calling`
  - Bad: `// Check if topic starts with the set path`
- **No trailing summaries** — do not add a comment block or prose after a method explaining what it does.
- **Getters**: prefer `get foo()` over plain property access whenever a value is derived or retrieved by traversing connected objects (e.g. `this.node.project`, `this.parentElement`, `this.mt.node.groups[this.group]`). Getters make the dependency chain explicit and let callers read `thing.project` naturally.
- **Dashboard functionality**: prefer adding reusable behaviour to the shared modules over implementing it inside a custom dashboard file. If a dashboard needs to traverse the topic tree, compute a list, or fire an event, that logic belongs on the relevant class as a getter or method.
- **A view must not walk the tree.** The cards read `nodeMt.frontRows`, `.summaryChips`, `.status`,
  `mt.formatted` — resolved values, computed once on the data tree and testable with no DOM. A card
  that starts iterating groups and topics has had logic put in the wrong place.
- **One gate, asked once.** `mt.canWrite` is checked in `renderMaybeWired` — the single point where
  every widget decides between an input and a display — so a control cannot end up editable on one
  screen and read-only on another. Resist per-widget permission checks.

---

## Naming conventions

### Topic path segments

```
org / project / nodeId / group / leaf                         read
org / project / nodeId / set / group / leaf                   write
org / project / nodeId / set / group / leaf / wired           wiring
org / project / nodeId / set / group / leaf / parameter       parameter (e.g. max, min)
```

Concrete examples:
```
dev/myproject/node42/sht/temperature
dev/myproject/node42/set/sht/temperature
dev/myproject/node42/set/sht/temperature/wired
dev/myproject/node42/set/sht/temperature/max
```

| Term | Meaning | Example |
|---|---|---|
| `path` / `topicPath` | Full path from root | `dev/myproject/node42/sht/temperature` |
| `twig` | From group onward; strips org/project/node prefix and `set/` | `sht/temperature` |
| `leaf` | Last segment only | `temperature` |
| `parameter` | Sub-path under the set path | `max`, `min`, `wired` |

Helper functions: `topicTwig(path)` → twig, `topicLeaf(path)` → leaf, `twigAttribute(path)` → `sht_temperature`, `leafAttribute(path)` → `temperature_max` (slashes replaced with underscores for DOM attributes).

### Variable suffixes

| Suffix | Points to | Example |
|---|---|---|
| `Mt` | An `MqttTopic` instance | `sensorMt`, `nodeMt`, `groupMt`, `projectMt` |
| `Twig` | A string starting at group/leaf | `sht/temperature` |
| `Leaf` | A string holding just the final segment | `temperature` |
| `Path` | A full MQTT path string | `dev/myproject/node42/sht/temperature` |
| `El` | A DOM element | `barEl`, `groupEl` |

### Object properties on `MqttTopic`

- `mt.twig` — stored twig string (e.g. `sht/temperature`)
- `mt.leaf` — getter, last segment of twig
- `mt.topicPath` — getter, full path including node prefix
- `mt.topicSetPath` — getter, write path (`…/set/…`); **throws when `this.node` is null** — only call on topics that are known to be part of the node hierarchy (i.e. `this.node` is set). Project-level or standalone topics (e.g. those created by an embedded `mqtt-graphdataset`) have no real node and must not reach this getter.
- `mt.element` — back-reference to the DOM element currently bound to this topic (null in headless mode or before binding)
- `el.mt` — forward-reference from a DOM element to its `MqttTopic`

---

## Architecture

### Global state (module-level)

| Variable | Purpose |
|---|---|
| `mqtt_client` | The live MQTT connection (mqtt.js) |
| `mqtt_subscriptions` | `[{topic, cb}]` — all active subscriptions |
| `server_config` | Config JSON fetched from `/config.json` at startup |
| `graph` | The default `MqttGraph` created on first graphing action |
| `preferedLanguages` | Array of language codes, e.g. `['EN']` |

### Class hierarchy

Data-tree classes are always instantiated. UI element classes are only instantiated when not in headless mode.

**Data-tree** (plain JS, no HTMLElement, all in `core.js`). This is where derived values live, and
it works with no DOM at all — which is what lets the cards run headless and be tested without a
browser.
```
MqttTopic            leaf data node — history, metadata, subscribe/publish, formatted, canWrite
  MqttTopicGroup     one module on a node — summaryText/summaryShort roll up here, not on the element
    MqttTopicGroupRelay / …Ota / …ControlHysteresis   only where a reading list is the wrong shape
  MqttTopicProject   discovery; nodes
  MqttTopicNode      status, deviceConfig, frontRows, summaryChips — what a card reads
Watchdog             offline detection timer per node (old UI only; the data tree derives status
                     from message arrival instead, with no timer)
```

**UI elements** (extend HTMLElementExtended):
```
HTMLElementExtended          (from html-element-extended)
  MqttElement                attributeChangedCallback, typeOfAttribute
    MqttReceiver             topicValueSet, valueSet, parameterSet, render helpers
      MqttTransmitter        publish, valueGet
        MqttText             text/number input
        MqttColor            color picker input
        MqttToggle           boolean checkbox
        MqttSlider           drag slider
      MqttBar                progress bar display
      MqttGauge              dial-gauge display
      MqttProject            manages a project and its nodes     ← not created in headless
      MqttNode               manages a single IoT node           ← not created in headless
    MqttChooseTopic          dropdown to wire one topic to another
    MqttGraph                Chart.js wrapper (time-series graph)
    MqttGraphDataset         one dataset/line within a MqttGraph
    MqttGroup                collapsible group of topics         ← not created in headless
      MqttSummaryGroup       base for groups with a summary line
        MqttGroupLedbuiltin  LED on/off indicator dot
        MqttGroupRelay       relay on/off symbol
        MqttGroupSht         temperature + humidity summary
        MqttGroupSoil        soil moisture %
        MqttGroupDS18B20     DS18B20 temperature °C
        MqttGroupBattery     battery mV
        MqttGroupOta         OTA key display
        MqttGroupControlHysteresis   control loop summary
        MqttGroupControlHysterisis   legacy spelling alias
      MqttGroupFrugalIot     the frugal_iot system group (name, battery, OTA…)
  MqttClient                 MQTT connection UI element
  MqttWrapper                top-level entry point; fetches config, builds tree
  MqttLogin                  login/register form
  MqttAdmin                  admin panel (OTA, permissions, node table)
  LanguagePicker             language selector
  TabbedDisplay              generic tab UI
```

### Adding a new display element

1. Create a class extending `MqttReceiver` (read-only) or `MqttTransmitter` (read/write).
2. Override `valueSet(val)` to update the DOM in-place (set `elements.*` refs in `render()`); return `false` to skip full re-render.
3. Override `render()` to return the initial shadow-DOM tree using the local `el()` helper.
4. Register with `customElements.define('mqtt-<name>', MyClass)`.
5. Add a `case '<display-name>':` in `MqttTopic.createElement()`.

### Adding a new group summary

Usually nothing to do: `MqttTopicGroup.summaryText()` already returns the module's own readings,
formatted by the schema and capped at two, which suits 26 of the 33 modules. Write a subclass only
when a list of readings is the wrong shape — `relay` wants its name beside a tick, `ota` shows a key,
a control shows a rule. Then:

1. Extend `MqttTopicGroup` in **`core.js`** (not the element — a card has no elements to ask).
2. Implement `summaryText()`, and `summaryShort()` too if the chip form differs from the row form.
3. Add it to `topicGroupClasses`, keyed by module id.

### The card UI

- `mqtt-devicecard` and `mqtt-devicegrid` are **light DOM** (`HTMLElementExtendedMinimum`), so
  `frugaliot.css` reaches them directly. That needs html-element-extended ≥ 0.1.7 (`renderRoot`).
- A light-DOM element has no `<slot>`, and `renderAndReplace` **clears its own children** — so the
  grid renders once with `render0()` and mutates in place, and a card builds every child itself.
- Widgets in a card are pre-bound (`el.mt = mt`) but deliberately **not** registered as `mt.element`:
  only one element may hold that, and binding would have a card competing with a graph, a second
  card, or the old UI for the same topic. The card pushes values into its own children instead.
- Which readings a device shows comes from `config.d/schema/devices.yaml`, keyed by OTA key and
  matched by prefix. `nodeMt.deviceConfig` resolves it.

---

## Headless mode

`<mqtt-wrapper headless>` builds the full data tree without creating any DOM elements for the project/node/group/leaf UX. Dashboards subscribe to document events and create individual standalone elements on demand. **The card UI runs this way** — `index.html` uses a headless wrapper for the connection, the selectors and the tree, and the cards render from it. So headless is the main path now, not a special case for custom dashboards, and anything that only works with `this.element` set is broken for the primary UI.

Key points for `MqttTopic.message_received` headless path (the `else` branch when `this.element` is null):
- Must set `this.state.value` so that getters like `usableName` and `wiredTopic` work without a DOM element.
- Must call `setWired` when a `wired` parameter arrives.
- Must fire `frugaliot:groupchanged` to notify dashboards of state changes.

---

## Dashboard patterns

### Prefer getters on `MqttTopic` over dashboard logic

When a dashboard needs derived data (usable name, min/max, wired source), add a `get` on `MqttTopic` rather than computing it in the dashboard. Dashboards should just read `mt.someGetter`.

### Binding elements to data-tree topics

Always pre-bind before `appendChild`, otherwise `connectedCallback` calls `createTopic()` and fabricates a wrong-path subscription:

```javascript
const barEl = el('mqtt-bar', { topic: sensorMt.topicPath, ... });
barEl.mt = sensorMt;       // prevents createTopic() from running
sensorMt.element = barEl;  // routes wildcard subscription messages to this element
barContainer.appendChild(barEl);
```

Clear back-references when rebuilding so stale elements don't receive messages:

```javascript
if (prevBarMt) prevBarMt.element = null;
prevBarMt = sensorMt;
```

### Looking up topics

Use `wrapper.projectMt.findTopic(fullPath)` — never fabricate a new `MqttTopic` with partial paths:

```javascript
const mt = document.querySelector('mqtt-wrapper')?.projectMt?.findTopic(this.state.topic);
```

### Events

| Event | Fired by | Carries | Typical use |
|---|---|---|---|
| `frugaliot:controlgroup` | `MqttGroupControlHysteresis` | `{ nodeMt, groupId, topics }` | populate node/group dropdowns |
| `frugaliot:groupchanged` | `MqttTopic.message_received` (headless) | `{ nodeMt, groupId, groupMt, changed }` | re-run `wireUpDashboard` on wired/on state changes |
| `frugaliot:topicschanged` | `MqttProject`, `MqttTopicProject.addNode` | `{ project }` | retry wiring, and add a card, after late-arriving nodes |
| `frugaliot:projectchanged` | `MqttWrapper.addProject` | `{ projectMt, organization, project }` | a project now exists — `topicschanged` is too late, it needs a node |
| `frugaliot:organizationchanged` | `MqttWrapper.onOrganization` | `{ organization }` | capabilities are per organization, so this precedes any project |
| `frugaliot:cardmove` / `cardmoveover` | `mqtt-devicecard` | `{ nodeId, delta }` / `{ nodeId, targetNodeId }` | the card asks to be moved; the grid decides what that means |
| `frugaliot:cardmode` | `mqtt-devicecard` | `{ nodeId, mode }` | so the grid can remember what was open |

---

## Traps

Each of these cost real time. They are not obvious from reading the code.

- **A page stylesheet cannot reach inside a shadow root.** `frugaliot.css` is loaded *into* each
  shadow root as well as onto the page, so `.mqtt-text input` works from within but
  `.fi-when input` (a light-DOM ancestor) never matches. **Custom properties are the only thing that
  crosses the boundary** — set `--fi-…` outside, read it in a rule that lives inside.
- **`el()` assigns only `onclick`, `onchange` and `onsubmit`** (plus `textContent`, `style`,
  `innerHTML`, `action`) as properties. **Any other function is silently put in `el.state`** and
  never wired up: `el({onpointerdown: fn})` does nothing at all. Use `addEventListener`.
- **`@media (max-width: 1001px)` in `frugaliot.css`** inflates fonts and icons for the node/group UI,
  where a node is one wide block. Inside a card it makes everything wider than the card. Those rules
  read `var(--fi-chrome-font, …)`; the card page sets it to `1rem`. Anything new that is not
  `nodeview.js` should opt out the same way. Replace them properly when `nodeview.js` goes.
- **`:host-context(details[open]) div { display: block }`** near the top of `frugaliot.css` has
  specificity (0,2,2) and overrides most rules for any div in a shadow root inside an open
  `<details>` — which is every widget in the old UI.
- **Assets resolve against the module, not the document**: `CssUrl` and `ImagesUrl` use
  `import.meta.url`, or a page in a subdirectory 404s every stylesheet and icon.
- **Timestamps go through `nowMs()`**, never `Date.now()`, or a replayed history collapses onto one
  instant and a graph has nothing to draw. `setClock()` is how tests decide what "now" is.
- **Caching will lie to you.** `/node_modules` and the client directory are served
  `immutable, max-age=86400`, *and* `frugal-iot-server/public/service-worker.js` caches the libraries
  cache-first at scope `/`. A stale library shows up as a null `append` inside `renderAndReplace`.
  Devtools "disable cache" does not stop a service worker: unregister it.
- **Schema is mastered in `frugal-iot-server/config.d/schema/`.** Edit there, then
  `scripts/copy-schema-to-examples.zsh`; `scripts/check-schema.js` verifies. Never edit a copy.

---

## Testing

`npm test` runs `node --test` over `test/*.test.js` — no browser, no broker. `test/setup.js` supplies
a jsdom DOM, an in-memory `localStorage`, and a resolve hook for the client's `/node_modules/…`
imports.

Messages are injected with `mqtt_deliver`, the same call the real client makes for every message, so
scenarios in `test/mock.js` drive the whole tree with nothing mocked below it. **`test/mock.html`
(served at `/dashboard/test/mock.html`) replays those scenarios in a browser** — pick one, switch
between the card UI, the old UI and the data tree, and see the messages that produced it.

Two lessons worth keeping:

- **Calling a handler directly does not test that it is wired.** `card.onPointerDown(...)` passed
  against code that was never connected to the DOM. Dispatch real events.
- **Shadow content is not in `textContent` and not reachable by `card.querySelector`.** A test
  asserting `querySelector('mqtt-choosetopic')` is null passes whether or not the chooser exists.

Snapshots in `test/snapshots/` record the rendered tree of both UIs. They exist so the old UI cannot
regress unnoticed; regenerate deliberately with `npm run test:update` and read the diff.

---

## Internationalisation

The master language table is `const languages` in `webcomponents.js`. Dashboard-specific strings are added via `addVocabulary(yamlString)` in the dashboard's `<script>`.

Every `addVocabulary` block must include **all four** language sections (EN, FR, HI, ID). Strings absent from `webcomponents.js` must be explicitly added in the dashboard block — do not assume the core file covers them.

### How a string gets translated

There are three ways a piece of UI text is translated. If a string doesn't go through one of these, it silently stays in English regardless of the selected language:

1. **Direct call to `getString(tag)`** — looks the string up in `languages`, falling back to the English value, falling back to `tag` itself. Used for names built dynamically (e.g. a graph's scale/axis name at `text: getString(this.name...)`).
2. **Via `el(tag, attributes, children)`** — `el()` auto-translates certain *attributes* on certain *tags*, per the `i8ntags` table (currently `label`, `button`, `span`, `option`, `p`, `h1`–`h5`, `th`, all via their `textContent` attribute). Add a tag/attribute pair to `i8ntags` when a new kind of element needs translated text. Excluded even on a listed tag: values containing `:` or `/` (these are usually paths or key:value pairs, not prose), and values not starting with a letter (emoji/symbol-only content). Pass `i8n: false` on an element you know is untranslatable (a proper name, an id, dynamic per-row data).
3. **Via a graph's scale name** — same as (1), a direct `getString()` call when building the Chart.js scale config.

**Only `textContent` is translated — never a literal string passed as a DOM `children` argument.** `el('p', {}, ["Some text"])` bypasses the mechanism entirely because the filter inspects `attributes`, not `children`. Always write `el('p', {textContent: "Some text"})` instead. This applies to `p`, `h1`–`h5`, `span`, and any other tag in `i8ntags`.

When adding a new UI string: add matching entries to all four language sections in `languages` (or the dashboard's `addVocabulary` block) — even if you only have the English text, add the same text under EN so `getString` doesn't silently fall through and hide missing translations.

---

## Key helpers

- `el(tag, attributes, children)` — local wrapper around `EL` that applies i18n translation to label/button/span text. Pass `i8n: false` in attributes to suppress translation for names/IDs.
- `getString(tag)` — look up a string in the current language(s); falls back to English.
- `mqtt_subscribe(topic, cb)` — registers a subscription; replays on reconnect.
- `GET(url, opts, cb)` — from `html-element-extended`; callback-style HTTP GET returning parsed JSON.
- `XXX(args)` — debug log with a breakpoint hook; use for unexpected states. Leave calls in place.
- `XXY(args)` — debug log for known-legacy paths; returns `false` so it can be used in `&&` guards. Don't add new calls.

---

## Dependencies

| Package | Role |
|---|---|
| `html-element-extended` | Base class `HTMLElementExtended`, `EL`, `GET`, `toBool` |
| `mqtt` | MQTT over WebSocket |
| `js-yaml` | Parse YAML in discovery messages and i18n config |
| `async` | Callback-style async utilities (preferred over Promises) |
| `csv-parse` | Parse historical CSV data from the logger |
| `chart.js` | Time-series graphs |
| `luxon` | Date/time for Chart.js (adapter inlined in webcomponents.js) |
| `dial-gauge` | Gauge web component |

---

## Running locally

The card UI is `index.html`, served at `/dashboard/`. The node/group UI it replaced is
`index-old.html`, linked from the project's home page. `frugal-iot-server` must be running: it serves
`/config.json`, `/node_modules`, the OTA files and the login flow, so the client cannot be opened as
a file.

```bash
npm install
# run frugal-iot-server pointing htmldir at this directory
node ../frugal-iot-server/frugal-iot-server.js
# open https://localhost:8080
```

## Debugging tips

- Sprinkle `XXX("label")` calls and set a breakpoint inside `XXX` to trace execution.
- `XXY` is for legacy twigs that should eventually disappear — don't add new `XXY` calls.
- `this.state.elements` holds named refs to live DOM nodes updated without full re-render.
- `server_config` (fetched from `/config.json`) drives schema, modules, topics, and org/project/node hierarchy.
