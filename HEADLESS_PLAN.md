# Plan: Headless Data-Tree Mode for mqtt-wrapper

## Goal

Allow `mqtt-wrapper` to operate without building any DOM elements for the project/node/group/leaf UX. The `MqttTopic` data tree becomes the single source of truth, shared across all dashboards. DOM elements become optional UX decorations layered on top. In headless mode, a dashboard may still create individual standalone elements by calling `MqttTopic.createElement()` directly.

---

## New Class Hierarchy

Four data-tree classes, all subclasses of `MqttTopic`, paired with optional UX element classes:

| Data-tree class | UX element class | Contains |
|---|---|---|
| `MqttTopicProject` | `MqttProject` | `nodes: { nodeId → MqttTopicNode }` |
| `MqttTopicNode` | `MqttNode` | `groups: { groupId → MqttTopicGroup }` |
| `MqttTopicGroup` | `MqttGroup` (and subclasses) | `topics: { leaf → MqttTopic }` |
| `MqttTopic` | `MqttBar`, `MqttText`, etc. | `data[]` (time-series history) |

In full-UI mode all four levels have both a data object and a paired element. In headless mode only the data objects are created; individual elements can still be created on demand via `MqttTopic.createElement()`.

The tree structure makes the data hierarchy explicit and matches the MQTT topic path structure:
```
org / project / nodeId / groupId / leaf
  Project       Node      Group    Topic
```

---

## Proposed Changes

### 1. Add a `headless` attribute to `mqtt-wrapper`

When set, the wrapper does not build any DOM for project/node/group/leaf display. The `mqtt-client` connection UI still renders (unless separately suppressed).

In headless mode:
- `MqttTopicProject` is created but `MqttProject` (the element) is not.
- `MqttTopicNode` is created but `MqttNode` (the element) is not.
- `MqttTopicGroup` is created but `MqttGroup` (the element) is not.
- Leaf `MqttTopic` objects are created as normal — the data tree is fully populated.
- A dashboard can still call `mt.createElement()` on any individual leaf `MqttTopic` to get a standalone renderable element for that topic.

`headless` propagates from `mqtt-wrapper` → `MqttTopicProject` → `MqttTopicNode` → `MqttTopicGroup` so each level knows whether to instantiate its paired element.

---

### 2. Introduce `MqttTopicGroup` and restructure the topic index

Currently `MqttTopicNode` holds a flat map of all leaf topics keyed by twig (`group/leaf`). This is replaced by a two-level structure:

- `MqttTopicNode.groups[groupId]` → `MqttTopicGroup`
- `MqttTopicGroup.topics[leaf]` → `MqttTopic`

`MqttTopicGroup` is a subclass of `MqttTopic`. It holds:
- `topics` — the leaf topics for this group
- State fields for the group (name, `on`, `now_wired`, `out_wired`, etc.) — see change 3

**Impact on `findTopic`** (currently line 2898): navigates directly through the grouped structure:
```javascript
// old: this.state.nodes[nodeId].state.topics[`${group}/${leaf}/#`]
// new:
const node = this.nodes[nodeId];           // MqttTopicNode
const group = node && node.groups[groupId]; // MqttTopicGroup
return group && group.topics[leaf];         // MqttTopic
```

**Impact on `controlGroups` getter** (currently derives groups by filtering the flat topics map): now reads directly from `MqttTopicNode.groups` filtered by `groupId.startsWith('control')` — simpler and no derivation needed.

**Impact on `sendMessageToMatchingTopics` / MQTT routing**: currently iterates `state.topics[twig + "/#"]` with wildcard matching. With two-level storage, routing splits the twig on `/` to reach `groups[groupId].topics[leaf]` directly, which is O(1) rather than a scan. The wildcard case (messages arriving at sub-paths like `control/now/wired`) is handled by looking up `groups[groupId].topics[leaf]` and then forwarding the sub-path to that topic's `message_received`.

**Existing `MqttTopic.groups` getter** (lines 812–820, derives groups from flat topics) is removed; callers use `MqttTopicNode.groups` directly.

---

### 3. Move MQTT message routing from `MqttNode` to `MqttTopicNode`

**This is the largest change.**

`MqttNode.topicValueSet` (lines 3004–3090) strips the node prefix and `set/`, applies legacy-topic filtering, auto-creates groups from templates, and dispatches to `sendMessageToMatchingTopics`. This is data-tree logic, not UX logic.

**New structure:**

- `MqttTopicNode.topicValueSet(topicPath, message)` carries the full routing and group-creation logic. Where the existing code performs UX-specific actions (appending elements to the DOM, triggering re-renders, rebuilding dropdowns), it calls a method on `this.element` (the paired `MqttNode`), guarded by `if (this.element)`.
- `MqttNode.topicValueSet` becomes a thin override that calls `super` and handles only its UX-specific additions.
- `MqttTopicProject.topicValueSet` mirrors the same split for the project level.
- `MqttTopic.message_received` calls `this.node.topicValueSet(...)` directly, targeting the `MqttTopicNode`.

The legacy-topic filter (the long chain of `twig.startsWith` / `twig.endsWith` guards) stays in `MqttTopicNode.topicValueSet` — it is data routing logic, not UX.

Group auto-creation (`addGroupFromTemplate`) moves to `MqttTopicNode` and produces a `MqttTopicGroup`. If an element is present, the element's equivalent is then created and linked.

---

### 4. Move leaf and group state from element `state` to data-tree objects

**No parallel copies — state moves, not duplicates.**

State that describes the observed data (rather than UX presentation) moves from element `this.state` to the corresponding data-tree object:

- Leaf state (`value`, `wired`, `min`, `max`, `color`, `type`, `rw`, …) moves to `MqttTopic.state`.
- Group state (`name`, `on`, `now_wired`, `out_wired`, `limit_wired`, …) moves to `MqttTopicGroup.state`.

Names are preserved: `element.state.wired` becomes `topic.state.wired`, `element.state.on` becomes `groupTopic.state.on`, etc. UX elements read these fields from their associated topic via `this.mt.state.*`.

The `this.data` array on `MqttTopic` (time-series history for graphing) is not affected.

**Roll-up (leaf → group):** Currently `MqttReceiver.topicValueSet` calls `groupElement.setAttribute('now_wired', value)` (lines 2067–2078). This becomes: write to `this.mt.groupTopic.state.now_wired = value` (the `MqttTopicGroup` for this leaf's group). If a group element exists it is notified separately. This is also what enables the `frugaliot:groupchanged` event (change 7).

**`MqttTopic.groupName` / `usableName`:** currently reads `groupEl.state.name`. After this change it reads `this.groupMt.state.name` (the `MqttTopicGroup`) — no element traversal.

---

### 5. `MqttProject.state.nodes` goes away

`this.mt.nodes[id]` (keyed nodeId → `MqttTopicNode`) is the authoritative index; it already exists (line 2856). `MqttProject.state.nodes[id]` (which stores the element) is removed. UX code that currently reads `state.nodes` is updated to use `this.mt.nodes` and reach the element via `nodeMt.element` where needed.

`findTopic` (updated in change 2) navigates through `this.mt.nodes` and the grouped structure.

---

### 6. `wiredTopic` — replace DOM traversal with a direct data reference

Current: `this.project` → `this.node.project` → `this.node.closest("mqtt-project")` — DOM traversal.

New: `fromTemplate` (and the equivalent initialisers on `MqttTopicNode` / `MqttTopicGroup`) stores a direct reference to the `MqttTopicProject` as `this.projectMt`. `wiredTopic` becomes `this.projectMt.findTopic(this.wired)` — no DOM required. Also a correctness improvement for temporarily detached elements.

---

### 7. Replace the element reference in `frugaliot:topicschanged`

Current: `{ project: this }` where `this` is the `MqttProject` element.

New: `{ project: this.mt }` — the `MqttTopicProject`. Dashboards that already access `wrapper.projectMt` need no change.

---

### 8. Replace `MutationObserver` with a `frugaliot:groupchanged` event

`dashboard_example2.html` uses a `MutationObserver` on the group element to detect `now_wired`, `out_wired`, and `on` attribute changes, then re-runs `wireUpDashboard`.

Once group state lives on `MqttTopicGroup` (change 4), `MqttTopicNode.topicValueSet` fires a `frugaliot:groupchanged` CustomEvent whenever a group-level state field changes. The event carries `{ nodeMt, groupId, changed: ['now_wired'] }`.

Dashboards subscribe to this event instead of observing DOM mutations. This works in headless mode and removes the dependency on the group element being in the DOM.

---

## What Does NOT Need to Change

- `MqttTopic.message_received` already has a headless path: if `this.element` is absent it stores into `this.data[]`. After change 4 it also updates `this.state.value`. No restructuring of this method is needed.
- `setWired` / `publishWired` work on `MqttTopic` directly — no element required.
- `frugaliot:controlgroup` already fires with data-tree references only — no change needed.
- `mqtt-choosetopic` still needs a DOM element to render a `<select>`, but it reads options from the data tree.
- The graph (`MqttGraph`, `MqttGraphDataset`) operates on `MqttTopic` directly — no change required.
- `MqttTopic.createElement()` continues to work in headless mode — dashboards can call it on any leaf topic to get a standalone renderable element.

---

## Sequencing (suggested)

1. **5** (`MqttProject.state.nodes` → `this.mt.nodes`) — isolated, removes a redundant map  
2. **6** (`this.project` via direct reference) — isolated, correctness improvement  
3. **7** (`frugaliot:topicschanged` payload) — small, any time  
4. **2** (introduce `MqttTopicGroup`, restructure node topics into groups) — enables cleaner state migration  
5. **4** (state moves from element to data-tree objects) — depends on 2 for group state  
6. **3** (introduce `MqttTopicNode`/`MqttTopicProject`, move routing) — largest change; depends on 2 + 4  
7. **8** (replace `MutationObserver` with `frugaliot:groupchanged`) — depends on 3 + 4  
8. **1** (add `headless` attribute) — gates actual UI suppression; can be added once 3–5 are done  
