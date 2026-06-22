# Frugal IoT Client — Claude guidance

## Project overview

MQTT-based IoT dashboard and UX client. All core logic lives in `webcomponents.js` (~3600 lines).
Dashboards (e.g. `dashboard_example2.html`) are thin HTML pages that import from `webcomponents.js`.

The broker delivers messages on paths like:

```
dev/org/project/node/module/leaf
dev/org/project/node/set/module/leaf          ← write path
dev/org/project/node/set/module/leaf/wired    ← wiring configuration
```

---

## Programming preferences

- **Indent with 2 spaces.**
- **Comments explain WHY, not WHAT.** One short line max. Do not restate what the code clearly shows.
  Good: `// topicSetPath throws if nodeMt is null — guard before calling startsWith`
  Bad: `// Check if topic starts with the set path`
- **No trailing summaries** — do not add a comment block or prose explaining what a method does after the fact.
- **No multi-line docstrings.** A single line above the method is fine when the contract is non-obvious.

---

## Naming conventions

### Topic path segments

A full MQTT path has this shape (6 segments for a leaf, 3 for a node):

```
dev / org / node / module / leaf
 0     1     2      3        4
```

| Term | Meaning | Example |
|---|---|---|
| `path` or `topicPath` | Full MQTT path from root | `dev/org/mynode/sht/temperature` |
| `twig` | From module onward (strips org/project/node prefix and `set/`) | `sht/temperature` |
| `leaf` | Last segment only | `temperature` |

Helper functions in `webcomponents.js`:
- `topicTwig(fullPath)` → `module/leaf`
- `topicLeaf(fullPath)` → `leaf`
- `twigAttribute(fullPath)` → `sht_temperature` (slashes → underscores, for DOM attributes)
- `leafAttribute(fullPath)` → `temperature_max` (same, starting from leaf)

### Variable suffixes

| Suffix | Points to | Example |
|---|---|---|
| `Mt` | An `MqttTopic` instance (data-tree node) | `sensorMt`, `nodeMt`, `groupMt`, `projectMt` |
| `Twig` | A string starting at module/leaf | `sht/temperature` |
| `Leaf` | A string starting at leaf | `temperature` |
| `Path` | A full MQTT path string | `dev/org/node/sht/temperature` |
| `El` | A DOM element | `barEl`, `groupEl` |

### Object properties

- `mt.twig` — the twig string stored on an `MqttTopic`
- `mt.leaf` — getter, returns last segment of `twig`
- `mt.topicPath` — getter, full path including node prefix
- `mt.topicSetPath` — getter, write path (`…/set/…`); **throws if `nodeMt` is null** — always guard with `this.nodeMt && …`
- `mt.element` — back-reference to the DOM element currently bound to this topic (may be null)
- `el.mt` — forward-reference from a DOM element to its `MqttTopic`

---

## Class hierarchy

```
MqttTopic                       ← pure data-tree node, no HTMLElement
MqttElement  (HTMLElementExtended)
  MqttReceiver                  ← subscribes; leaf display
    MqttTransmitter             ← also publishes; leaf controls
      MqttText / MqttToggle / MqttSlider / MqttColor
    MqttBar / MqttGauge
  MqttProject / MqttNode / MqttGroup   ← hierarchy elements
MqttWrapper                     ← top-level host; holds projectMt
```

Data-tree hierarchy (headless-mode classes, see HEADLESS_PLAN.md):
```
MqttTopicProject  → nodes{}
  MqttTopicNode   → groups{}
    MqttTopicGroup → topics{}
      MqttTopic
```

---

## Headless mode

`<mqtt-wrapper headless>` builds the full data tree (`MqttTopicProject` / `MqttTopicNode` / `MqttTopicGroup` / `MqttTopic`) **without** creating any DOM elements for the project/node/group/leaf UX. Dashboards subscribe to document events and create individual standalone elements on demand.

Key points:
- `MqttTopic.message_received` has an `else` branch (no `this.element`) for headless routing. It must set `this.state.value`, call `setWired` for wired parameters, and fire `frugaliot:groupchanged`.
- `topicSetPath` getter calls `this.nodeMt` internally and **throws** when `nodeMt` is null (graph-dataset topics). Guard every `startsWith(this.topicSetPath)` call with `this.nodeMt &&`.

---

## Dashboard patterns

### Prefer adding functionality to `webcomponents.js`

When a dashboard needs derived data from an `MqttTopic` (usable name, min/max, wired source), add a **getter on `MqttTopic`** rather than computing it in the dashboard. Dashboards should just read `mt.someGetter`.

### Add getters, not methods

For read-only derived values, always use `get` syntax on the class. This keeps dashboard code clean (`mt.usableName` not `mt.getUsableName()`).

### Binding elements to data-tree topics

When creating a standalone element in a dashboard, **always pre-bind** before `appendChild`:

```javascript
const barEl = el('mqtt-bar', { topic: sensorMt.topicPath, ... });
barEl.mt = sensorMt;       // prevents createTopic() from fabricating a wrong-path subscription
sensorMt.element = barEl;  // routes wildcard subscription messages to this element
barContainer.appendChild(barEl);
```

Clear back-references when rebuilding:

```javascript
if (prevBarMt) prevBarMt.element = null;
prevBarMt = sensorMt;
```

### Looking up topics from the data tree

Use `wrapper.projectMt.findTopic(fullPath)` — never fabricate a new `MqttTopic` with partial paths. The topic must already be in the tree if the user can select it.

```javascript
const wrapper = document.querySelector('mqtt-wrapper');
const mt = wrapper?.projectMt?.findTopic(this.state.topic);
```

### Events

| Event | Fired by | Carries | Typical use |
|---|---|---|---|
| `frugaliot:controlgroup` | `MqttGroupControlHysteresis` | `{ nodeMt, groupId, topics }` | populate node/group dropdowns |
| `frugaliot:groupchanged` | `MqttTopic.message_received` (headless) | `{ nodeMt, groupId, groupMt, changed }` | re-run `wireUpDashboard` on wired/on state changes |
| `frugaliot:topicschanged` | `MqttProject` | `{ project }` | retry wiring after late-arriving nodes |

---

## Internationalisation

Strings shown in the UI go through `getString(tag)`. The master language table lives in `webcomponents.js` under `const languages`. Dashboard-specific strings are added via `addVocabulary(yamlString)` in the dashboard's `<script>`.

Every `addVocabulary` block must include **all four** language sections (EN, FR, HI, ID). Strings absent from `webcomponents.js` must be added in the dashboard block — do not assume the core file covers them.

---

## Debugging helpers

- `XXX(args)` — `console.log` with a breakpoint target; use for unexpected states.
- `XXY(args)` — same but for legacy/expected-to-disappear paths; returns `false` so it can be used in `&&` guards.
