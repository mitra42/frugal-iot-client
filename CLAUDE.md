Look# Frugal IoT Client

JavaScript/Web Components MQTT client for the Frugal IoT project. Connects to an MQTT broker, auto-discovers nodes via discovery messages, and renders live sensor data using custom HTML elements.

## Main file

`webcomponents.js` — the entire client lives here (~3600 lines). All web components, MQTT logic, graphing, i18n, and admin UI are defined in this one file.

## Code style

- **Indentation**: 2 spaces throughout.
- **Async style**: prefer callback-style async (using the `async` library from `caolan/async`) over Promise chains. Existing `fetch` calls that use `.then()` are legacy patterns; new async code should use callbacks or `async.waterfall` / `async.parallel` etc.
- **Comments**: every new or edited function and class must have a comment explaining what it does and any non-obvious behaviour. Comments on the WHY, not restatements of the code.
- **Getters**: prefer `get foo()` over plain property access whenever a value is derived or retrieved by traversing connected objects (e.g. `this.node.project`, `this.parentElement`, `this.mt.node.groups[this.group]`). Getters make the dependency chain explicit and let callers read `thing.project` naturally without knowing the traversal path.
- No trailing summaries or change-log comments in code.

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
      MqttProject            manages a project and its nodes
      MqttNode               manages a single IoT node and its groups/topics
    MqttChooseTopic          dropdown to wire one topic to another
    MqttGraph                Chart.js wrapper (time-series graph)
    MqttGraphDataset         one dataset/line within a MqttGraph
    MqttGroup                collapsible group of topics (extends MqttElement)
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

MqttTopic     plain JS class (intentionally no HTMLElement inheritance) — data model for
              one MQTT topic; holds data history, metadata, and create/subscribe logic
Watchdog      plain JS class — offline detection timer per node
```

### Topic structure

```
<org>/<project>/<nodeId>/<group>/<leaf>          read path
<org>/<project>/<nodeId>/set/<group>/<leaf>      write path
<org>/<project>/<nodeId>/set/<group>/<leaf>/wired  wiring path
```

Helper functions: `topicTwig`, `topicLeaf`, `twigAttribute`, `leafAttribute`, `topicMatches`.

### Adding a new display element (TO-ADD-ELEMENT)

1. Create a class extending `MqttReceiver` (read-only) or `MqttTransmitter` (read/write).
2. Override `valueSet(val)` to update the DOM in-place (set `elements.*` refs in `render()`); return `false` to skip full re-render.
3. Override `render()` to return the initial shadow-DOM tree using the local `el()` helper.
4. Register with `customElements.define('mqtt-<name>', MyClass)`.
5. Add a `case '<display-name>':` in `MqttTopic.createElement()`.

### Adding a new group summary (TO-ADD-ELEMENT)

1. Extend `MqttSummaryGroup`.
2. Declare `static get observedAttributes()` and the matching type arrays (`floatAttributes`, `boolAttributes`, etc.).
3. Implement `summaryText()` returning a short string.
4. Register as `mqtt-group<groupid>` — `MqttNode.addGroupFromTemplate` will pick it up automatically.

## Key helpers

- `el(tag, attributes, children)` — local wrapper around `EL` that applies i18n translation to label/button/span text. Pass `i8n: false` in attributes to suppress translation for names/IDs.
- `getString(tag)` — look up a string in the current language(s); falls back to English.
- `mqtt_subscribe(topic, cb)` — registers a subscription; replays on reconnect.
- `GET(url, opts, cb)` — from `html-element-extended`; callback-style HTTP GET returning parsed JSON.
- `XXX(args)` — debug log with a breakpoint hook; leave these in place.
- `XXY(args)` — debug log for known-legacy paths (returns `false`).

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

## Running locally

```bash
npm install
# run frugal-iot-server pointing htmldir at this directory
node ../frugal-iot-server/frugal-iot-server.js
# open https://localhost:8080
```

## Debugging tips

- Sprinkle `XXX("label")` calls and set a breakpoint inside `XXX` to trace execution.
- `XXY` is for legacy twigs that should eventually disappear — don't add new calls.
- `this.state.elements` holds named refs to live DOM nodes updated without full re-render.
- `server_config` (fetched from `/config.json`) drives schema, modules, topics, and org/project/node hierarchy.
