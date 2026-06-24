# Frugal IoT Client

JavaScript/Web Components MQTT client for the Frugal IoT project. Connects to an MQTT broker, auto-discovers nodes via discovery messages, and renders live sensor data using custom HTML elements.

## Main file

`webcomponents.js` — the entire client lives here (~3600 lines). All web components, MQTT logic, graphing, i18n, and admin UI are defined in this one file.

Dashboards (e.g. `dashboard_example2.html`) are thin HTML pages that import selectively from `webcomponents.js`.

## Code style

- **Indentation**: 2 spaces throughout.
- **Async style**: prefer callback-style async (using the `async` library from `caolan/async`) over Promise chains. Existing `fetch` calls that use `.then()` are legacy patterns; new async code should use callbacks or `async.waterfall` / `async.parallel` etc.
- **Comments**: explain WHY, not WHAT. One short line is enough; do not restate what the code clearly shows. No multi-line docstrings.
  - Good: `// topicSetPath throws when this.node is null — guard before calling`
  - Bad: `// Check if topic starts with the set path`
- **No trailing summaries** — do not add a comment block or prose after a method explaining what it does.
- **Getters**: prefer `get foo()` over plain property access whenever a value is derived or retrieved by traversing connected objects (e.g. `this.node.project`, `this.parentElement`, `this.mt.node.groups[this.group]`). Getters make the dependency chain explicit and let callers read `thing.project` naturally.
- **Dashboard functionality**: prefer adding reusable behaviour to `webcomponents.js` over implementing it inside a custom dashboard file. If a dashboard needs to traverse the topic tree, compute a list, or fire an event, that logic belongs on the relevant class as a getter or method.

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

**Data-tree** (plain JS, no HTMLElement):
```
MqttTopic          leaf data node — history, metadata, subscribe/publish logic
  (future: MqttTopicProject → MqttTopicNode → MqttTopicGroup, see HEADLESS_PLAN.md)
Watchdog           offline detection timer per node
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

1. Extend `MqttSummaryGroup`.
2. Declare `static get observedAttributes()` and the matching type arrays (`floatAttributes`, `boolAttributes`, etc.).
3. Implement `summaryText()` returning a short string.
4. Register as `mqtt-group<groupid>` — `MqttNode.addGroupFromTemplate` will pick it up automatically.

---

## Headless mode

`<mqtt-wrapper headless>` builds the full data tree without creating any DOM elements for the project/node/group/leaf UX. Dashboards subscribe to document events and create individual standalone elements on demand.

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
| `frugaliot:topicschanged` | `MqttProject` | `{ project }` | retry wiring after late-arriving nodes |

---

## Internationalisation

Strings shown in the UI go through `getString(tag)`. The master language table is `const languages` in `webcomponents.js`. Dashboard-specific strings are added via `addVocabulary(yamlString)` in the dashboard's `<script>`.

Every `addVocabulary` block must include **all four** language sections (EN, FR, HI, ID). Strings absent from `webcomponents.js` must be explicitly added in the dashboard block — do not assume the core file covers them.

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
