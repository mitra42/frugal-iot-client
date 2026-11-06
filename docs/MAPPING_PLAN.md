# Plan: Device locations and a project map

## Status

Plan agreed 2026-11-06. Phase 1 (firmware) built and compiling, not yet run on a board; it goes
into the next release. Phase 2 (schema, data tree, `located-devices` mock scenario) built and tested. Decisions are numbered M-n so they can be argued here rather than
re-decided in code; open questions are Q-n, deferred work is ML-n.

## Goal

- On the back of a device card, give the device a location — by tapping the map, or by one tap on
  "I'm here" when standing beside it.
- A map button on the project opens a resizable map with a pin per located device.
- Pins close together collapse into a count until zoomed in far enough to separate.
- Hovering a pin (tapping, on a phone) shows the device's name and summary, with a way to its card.
- Project level first; organization level later (ML-1).

## What already exists

- **`gps` module** (`sensor/gps.cpp`) publishes `gps/latitude`, `gps/longitude` (6 decimals),
  `gps/position` and `gps/satellites`. So some devices locate themselves, and the plan must say which
  wins.
- **`frugal_iot/description`** is the round trip a location needs: the browser publishes
  `set/frugal_iot/description` (not retained, `core.js:618`); `System_Frugal::dispatch` saves it to
  LittleFS and echoes `frugal_iot/description` retained (`maybeWriteToFSandEcho`); `discover()`
  republishes it at boot.
- **Broker ACL**: a WRITE user can publish only `…/set/#` (`dynsec-plan.js` `setOnly`). The browser
  cannot write a retained non-`set` topic, so with MQTT storage only the node (or the server) can make the
  location stick.
- **Pi bridges** relay topics, and replicate users and permissions, but no other tables.
- **The data tree** already gives a card everything a pin needs: `nodeMt.status`,
  `nodeMt.summaryChips`, `usableName`.

## Where the location lives

The real choice. Both work; they fail differently.

| | **A. MQTT, held by the node** — `set/frugal_iot/location` → LittleFS → retained `frugal_iot/location` | **B. Server table** — `node_locations(org, project, nodeid, lat, lon)` + REST |
|---|---|---|
| Firmware change | Yes: ~15 lines in `System_Frugal`, same as `description` | None |
| Old firmware | Ignores the set — but nodes update by OTA (Q-4) | Works |
| Node off or asleep when set | Delivered when it reconnects — sets are QoS 1 (Q-1) | Immediate |
| Acknowledged | Yes — the echo is the acknowledgement, and the card can show "pending" until it comes | Only the HTTP response |
| Offline Pi | Bridged like any topic | Needs a replica of the table, as users are replicated |
| Logger, Grafana, farm-platform push | See it as a topic, with nothing extra to do | Need their own lookup |
| Org-level map (ML-1) | One retained wildcard subscribe: `org/+/+/frugal_iot/location` | One extra endpoint |
| Same shape as GPS | Yes — a reading of the node | No — a second source to merge |
| Survives a lost server DB | Yes — the node holds it, and republishes at boot | No (backups) |
| Survives an OTA update | Yes — settings are kept | Yes |

**M-1 Recommend A.** A location is a property of the device in the same way its description is, and
the system already has one way of storing those. A also gives the offline Pi, the logger and the
org map their data without new code, and a GPS node needs no special path. Its one cost, a node on old
firmware never echoing, goes away because nodes update by OTA. Until one has, the card shows
"pending" rather than pretending the value was saved.

Only re-provisioning loses the location, and a re-provisioned node is effectively a new node, so
it gets set again (Q-2).

**M-2 One topic, `frugal_iot/location`, payload `lat,lon`** — e.g. `-6.208800,106.845600`. Not two
leaves: two messages can be half-applied, and a pin at a new latitude and an old longitude is in the
wrong field. Five decimals (~1 m) is enough precision. Six matches `gps` and costs nothing.
Empty payload = no location.

**M-3 GPS wins when it has a fix.** `nodeMt.location` returns `gps/latitude`,`gps/longitude` when
`gps/satellites > 0`, otherwise `frugal_iot/location`, otherwise null — with a `source` of
`'gps'` or `'set'`. A device that moves (a tractor, a buoy) should show where it is, not where it was
set. When the source is GPS the back shows the reading with no Set control.

## Data tree (core.js)

Following "a view must not walk the tree":

- `MqttTopicNode.location` → `{lat, lon, source}` or null. Parsing and the M-3 precedence live here,
  and are testable without a DOM.
- `MqttTopicProject.locatedNodes` → the nodes with a location; `.locationBounds` → their extent, for
  fitting the map.
- Schema: add `- leaf: location` to `frugal_iot` in `frugal-iot-server/config.d/schema/modules.yaml`,
  then `scripts/copy-schema-to-examples.zsh`.
- A location arriving fires `frugaliot:groupchanged` like any value, and the map listens for it.

## The map

**M-4 Leaflet 1.9.4 + Leaflet.markercluster 1.5.3.** Clustering into a count until zoomed is
exactly what markercluster does, it is the standard pair, and both are small (~40 KB + ~10 KB gz).
Leaflet 1.9 ships an ESM build. markercluster is UMD and expects a global `L`, so `map.js` sets
`window.L` before importing it — check this first, since it will either work or need a vendored
copy.

**M-5 A new module `map.js`, imported only when the map is first opened** (dynamic `import()`). The
card page must not pay for Leaflet or tiles until someone asks for a map. It imports `core.js` only.
`mqtt-map` is light DOM (`HTMLElementExtendedMinimum`): Leaflet positions its own DOM with
`leaflet.css`, and a page stylesheet cannot reach inside a shadow root.

**M-6 Tiles: OpenStreetMap by default, URL from `server_config`.** Two constraints:
- *Bandwidth*: a view is ~15 tiles × 20–50 KB. That is acceptable for something opened on purpose
  (M-5) but is another reason not to show a map by default.
- *An offline Pi has no tiles at all.* The pins still draw on a blank grid at the right relative
  positions, which is still useful. A Pi serving pre-downloaded tiles for its own area is ML-2.
  `tiles.url` and `tiles.attribution` in config make that a config change, not a code change.
- OSM's tile policy requires the attribution and forbids heavy use. A handful of farms is fine.
  Anything larger means a tile provider (ML-3).

**M-7 The map docks above the grid, with a drag handle on its bottom edge, rather than floating.**
"Pops up and is resizable" either way, but a floating window covers the cards that hovering a pin
is meant to lead to, and has no sensible form on a phone. Docked, it pushes the grid down. Its height
is remembered in the layout store (`frugaliot:layout:v1:{org}/{project}`, as `mapHeight`) along with
whether it was open. On a phone it is the same bottom sheet as the graph panel and a card's back
(D-6, O-8).

- Button: 🗺 in the project header beside the gear, shown only when the map has something to do:
  at least one located device, or WRITE (so there is something to set).
- Opens fitted to `locationBounds`; one device → a fixed zoom on it.

**M-8 Pins.**
- A pin per located device, coloured by `nodeMt.status` — the same colours as the card's status dot.
- A cluster takes the **worst** status of its members, so an offline device cannot hide inside a
  green "5".
- Hover (desktop) → a tooltip: `usableName` and the `summaryChips`, as on the summary card. Read on
  open, not stored, so it is never stale.
- Tap (phone) or click → the same, as a popup with **Open card**, which scrolls to the card and opens
  it on FRONT.
- GPS-sourced pins are drawn slightly differently (hollow), so a moving device reads as such.
- Re-read on the card UI's existing slow status interval, because a device going quiet sends nothing.

## Setting a location (the card's back)

In the DEVICE section, below Description:

```
│  Location    -6.20880, 106.84560        [📍]  │      set
│  Location    not set                    [📍]  │      unset
│  Location    -6.20880, 106.84560   pending…   │      sent, no echo yet
│  Location    -6.20880, 106.84560   from GPS   │      M-3, no control
```

**M-9 The 📍 opens the project map in pick mode for that device** — the same map as the header button,
not a second one inside the card. A map in a card's back would fight the flip's fixed box (the same
reasoning as D-11 for graphs). In pick mode:

- the device's pin (or a new one) is draggable, and a tap anywhere moves it there
- **I'm here** puts it at the browser's position — the installer standing beside the device
- **Save** publishes `set/frugal_iot/location`, **Cancel** puts it back, **Clear** publishes empty
- other devices' pins stay visible, so "between the two greenhouses" can be placed by eye

**"Pending" cannot be read off the value.** The browser subscribes to `<node>/#`, so it receives its
own `set/frugal_iot/location`, and `MqttTopicNode.topicValueSet` strips `set/` and routes it to the same
topic as the node's echo. The value changes the moment Save is pressed. Pending has to be "sent, and
no echo on the read path since" — tracked by the read path, not the value.

**M-10 Where pick mode starts:** the device's current location → else the project's other pins →
else the browser's position → else zoomed out. The other pins come before the browser's position
because a user setting things up from the office is usually far from the field. "I'm here" is one tap
away for the user who isn't.

**Geolocation needs a secure context.** An offline Pi served over plain HTTP gets no position, so
"I'm here" is hidden there rather than failing (see the server's INSTALLATION.md on HTTPS).

**M-11 Gated by `mt.canWrite` on the `frugal_iot/location` topic**, through the same single check as
every other control. Without WRITE the row shows the value only, and the map has no pick mode.

## Firmware (Frugal-IoT repo — announce before editing)

In `System_Frugal`: a `location` String beside `description`, handled in `dispatch` identically
(compare, store, `maybeWriteToFSandEcho`), and published retained in `discover()` when non-empty.
Read from LittleFS at boot as `description` is. Nothing parses it — the node never needs to know
where it is. A serial-config field for it (CONFIG_PLAN) would let a batch profile carry it, but a
batch of boards rarely shares one location, so not now.

## i18n

New strings — `Location`, `Not set`, `Pending`, `From GPS`, `I'm here`, `Save`, `Cancel`, `Clear`,
`Open card`, `Map` — into `languages/en.yaml` and every other language in the same change. Leaflet's
own controls are icons, and its attribution stays as the provider wrote it.

## Tests

- `nodeMt.location`: parse, empty, malformed, GPS-with-fix beats set, GPS-without-fix doesn't.
- `projectMt.locatedNodes` and `locationBounds`.
- A `test/mock.js` scenario with several located devices, two close together, one on GPS, one
  offline — so `mock.html` shows clustering and status colours without hardware.
- The back's Location row in each state, in the card snapshots.
- Leaflet does not run usefully in jsdom. Test that the map element asks the tree for the right
  pins and leave the drawing to the browser — and to you looking at it.

## Phasing

1. **Firmware** `frugal_iot/location`. First, so it ships in the next release and nodes have it by
   the time the UI can set it. It costs nothing on a node where no location is set: nothing is
   published.
2. **Data tree + schema + mock scenario.** `location`, precedence, tests.
3. **Read-only map.** `map.js`, header button, docked panel, clusters, tooltips, Open card.
4. **Pick mode** on the back.

## Deferred

| # | Deferred | Why it waits |
|---|---|---|
| ML-1 | **Organization-level map** | Needs every project's location topics, which retained topics make a single wildcard subscribe — but the org page has no device cards to open, so the popup needs a "go to project" instead. Build once the project map has been used |
| ML-2 | **Offline tiles on a Pi** | A tile set for the farm's area, served by the Pi. Config already points at it (M-6). Size and how to fetch it are their own plan |
| ML-3 | **A tile provider beyond OSM** | Only if usage outgrows OSM's policy |
| ML-4 | **Card ↔ pin highlighting** | Hovering a card lights its pin. Nice, not needed to be useful |
| ML-5 | **Shapes** — fields, beds, a greenhouse outline | A different data model (a polygon per project, not a point per device) |
| ML-6 | **Values on the map** — pins coloured by a reading (soil moisture across a field) | The most interesting one, and needs a choice of reading and scale; wait until there are real deployments with several located sensors |

## Questions — resolved 2026-11-06

- **Q-1** Does a node that is asleep, or away, receive a `set/` sent meanwhile? **Yes** — sets are
  QoS 1, so "pending" lasts only until it reconnects.
- **Q-2** Should the browser offer to resend a location the node has lost? **No.** An OTA update
  keeps settings; only re-provisioning loses them, and that is effectively a new node.
- **Q-3** Does a precise location need more than READ to see? **Not for now** — it is READ, like
  every other topic.
- **Q-4** MQTT or a server table? **MQTT (M-1)** — nodes are assumed to update by OTA to firmware
  that has `location`.
