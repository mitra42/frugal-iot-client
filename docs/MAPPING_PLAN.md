# Plan: Device locations and a project map

## Status

Plan agreed 2026-11-06. Phase 1 (firmware) built and compiling, not yet run on a board; it goes
into the next release. Phase 2 (schema, data tree, `located-devices` mock scenario) built and tested. Phase 3 (the
read-only map) built, tested in jsdom, and looked at in a browser. Phase 4 (pick mode) built and tested in
jsdom; not yet looked at in a browser, and not yet round-tripped through a node. The organization map
(ML-1) built and tested in jsdom; not yet looked at in a browser or run against the broker's ACLs. Decisions are numbered M-n so they can be argued here rather than
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

**M-5 A new module `map.js`; Leaflet is loaded only when the map is first opened.** The card page
must not pay for Leaflet or tiles until someone asks for a map. `map.js` itself is small and
`cards.js` imports it, because the page calls its methods, not just its tag. It imports `core.js`
only. *As built:* Leaflet and markercluster are added as classic `<script>` tags, not imported.
markercluster attaches itself to a global `L`, and an ES module's namespace is frozen.
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
and whether it was open are remembered per project in `frugaliot:map:v1:{org}/{project}`. That key is
separate from the card layout's, because the grid caches its layout and would write back over them.
On a phone it is the same docked panel. The graph panel turned out not to be a sheet either.

- Button: 🗺 in the project header beside the gear, shown only when the map has something to do:
  at least one located device, or WRITE (so there is something to set). *As built:* located devices
  only, not WRITE. Setting starts from a card's 📍, never from the header, so an empty map behind the
  button would have nothing to do. The panel is hidden with its button, so a map remembered open is
  never left on screen with no way to close it. While picking it is shown regardless, since pick
  mode has its own Cancel.
- Opens fitted to `locationBounds`; one device → a fixed zoom on it.

**M-8 Pins.**
- A pin per located device, coloured by `nodeMt.status` — the same colours as the card's status dot.
- A cluster takes the **worst** status of its members, so an offline device cannot hide inside a
  green "5".
- Hover (desktop) → a tooltip: `usableName` and the `summaryChips`, as on the summary card. Read on
  open, not stored, so it is never stale.
- Tap (phone) or click → the same, as a popup with **Open card**, which scrolls to the card and opens
  it on FRONT.
- Status is shown by shape as well as colour, as on the cards: live is solid, stale is a dashed
  ring, offline and never are hollow. GPS-sourced pins are diamonds, so a moving device reads as one.
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

*As built:* `MqttTopic.publish` stamps `sentAt` and any message on the topic's read path clears it, so
`mt.pending` works for any topic, not only this one. `publish` also fires `frugaliot:groupchanged`, or
the card would not show Pending until something came back. The 📍 stays while Pending, since a
node may be asleep for hours and a mis-placed pin should not wait for it. When the pick ends, the
dashboard sends `frugaliot:cardopen` to return to the card, and the map closes again if it was
closed before. Escape cancels. The pin being placed is a bullseye, unlike any status.

**M-10 Where pick mode starts:** the device's current location → else the project's other pins →
else the browser's position → else zoomed out. The other pins come before the browser's position
because a user setting things up from the office is usually far from the field. "I'm here" is one tap
away for the user who isn't.

**Geolocation needs a secure context.** An offline Pi served over plain HTTP gets no position, so
"I'm here" is hidden there rather than failing (see the server's INSTALLATION.md on HTTPS).

**M-11 Gated by `mt.canWrite` on the `frugal_iot/location` topic**, through the same single check as
every other control. Without WRITE the row shows the value only, and the map has no pick mode.

## The organization map (ML-1)

*Planned 2026-11-06; Q-6 and Q-7 answered the same day. Built the same day.*

**Where.** On the organization page: the dashboard once an organization is chosen and before a project is,
which today says only "Choose a project to see its devices". The same 🗺 header button, the same
docked `mqtt-map`, remembered under its own key `frugaliot:map:v1:{org}`. The project selector stays where it is;
the map is another way of choosing.

**M-12 Only for READ on the whole organization.** Someone with READ on some of its projects gets no
organization map: they choose a project. `hasCapability(org, 'READ')` cannot be the test, since with no project it
accepts a project-scoped row; it needs a form that accepts only organization-wide rows.

**M-13 A slim data tree for the organization, not every project's full one.** A new
`MqttTopicOrganization` in `core.js` holds one `MqttTopicProject` per project, created as messages
arrive. Their nodes are created *without* their usual `node/#` subscription. Instead the
organization subscribes to:

```
org/+/+/frugal_iot/#        name, description, location - retained, a few per device
org/+/+/gps/latitude        for a device that locates itself (M-3) - not gps/#, which would
org/+/+/gps/longitude       stream a moving device's speed and course into a page that only
org/+/+/gps/satellites      draws pins
```

so `nodeMt.location`, `usableName` and the M-3 precedence work unchanged. M-12 is what makes the
wildcard in the project position allowed: an organization-wide READ has the ACL `org/#`
(`dynsec-plan.js` `orgTree`). `org/#` itself would pull every reading of every device just to draw pins.

**M-14 `topicMatches` learns `+`.** It is the one routine that matches incoming topics to subscriptions,
and it matches a trailing `#` only. Small change, with tests.

**M-15 Status as of page load, with a reload.** A pin is coloured from `/config.json`'s `lastseen`, as the
project page seeds it already. Retained messages do not count as contact (as now); a live GPS message
does. Nothing else updates it: live status would mean subscribing to everything. A ↻ on the map
fetches `/config.json` again and re-seeds `lastseen`, so a device that has come back can be seen to.

**M-16 The popup goes to the project.** Name, project name, and **Open project**: the wrapper switches to
that project (a new public `setProject`, like `setOrganization`). That is the ordinary project page,
listing every device and subscribing to their readings, and it then sends `frugaliot:cardopen`, so the
device's card is open on its front. The organization map's popup has no summary chips, since the organization tree
does not subscribe to readings. The project page has them as usual.

**M-17 `mqtt-map` takes either level.** It already asks its tree only for `nodes`, `locatedNodes`,
`locationBounds` and `twig`; `MqttTopicOrganization` provides the same four, keyed by node id across its
projects (a node belongs to one project). The map checks the level only for the popup (M-16) and the ↻
(M-15). There is no pick mode at organization level: a location is set from a device's card.

**M-18 Built when the organization page is shown, dropped when a project is chosen.** The button
appears only when something is located, so the data has to be there before the map is asked for.
Choosing a project unsubscribes the organization's topics, and the project builds its own full tree as now.

Pins, clusters (worst status wins), shapes, tiles, resizing: as the project map.

*As built:*
- The tree is announced by a new event, `frugaliot:organizationtree {organizationMt}`, fired again
  with null when it is dropped. A URL that names the organization reaches the organization page
  without the organization picker, so the event comes from where the page is built, not from the picker.
- Its projects fire `topicschanged` like any other. The dashboard now ignores a `topicschanged`
  for any project but its own, or each device arriving on the organization map rebuilt the page.
- Open project is `frugaliot:projectopen {project, nodeId}`, handled by the dashboard. A project
  whose devices have not arrived shows "Waiting for devices" and no grid, so nothing would hear
  `cardopen`. The card is then remembered open in the layout, and is made open when it arrives.
- ↻ uses the existing `Refresh` string as its title. It re-seeds from a fresh `/config.json`
  without replacing `server_config`, which the rest of the page reads.
- `mock.html` has an *organization map* view; `located-organization` adds a second project.

Tests: `topicMatches` with `+`; the organization-wide gate, including a user with READ on every
project but not the organization; `MqttTopicOrganization` routing and `locatedNodes` across projects; the
organization page offering the map; ↻ re-seeding status; Open project landing on the open card. A mock
scenario with located devices in two projects.

## Tiles kept by the server (ML-2)

*Planned 2026-11-06, revised 2026-11-07, not yet agreed.*

Three servers, one design:
- **Production**: online, plenty of disk. Caching saves fetches from OSM.
- **A Pi while online**: a small disk, but it can fetch. It is also when an offline Pi fills its cache.
- **A Pi while offline**: has only what it fetched earlier. Its devices are within WiFi range of it,
  so the areas it needs are small.

They differ only in config (M-24): production turns the prefetch off and gives the cache more room.

**M-19 The server keeps the tiles, not the browser.** A browser cache (the service worker) only
helps the phone that has already looked; a new phone on an offline Pi would get nothing. So the server
gets `/tiles/osm/{z}/{x}/{y}.png`, a cache in `datadir/tiles/osm/z/x/y.png`:
- **Kept and fresh**: served from disk.
- **Kept but due a check, and online**: a conditional request upstream (`If-None-Match` /
  `If-Modified-Since`). "Not modified" only touches the file's `mtime`; a new tile replaces it.
- **Kept but due a check, and offline**: served as it is. A stale tile beats none, so nothing is
  ever dropped for being old.
- **Not kept, and online**: fetched, stored, and served.
- **Not kept, and offline**: a 404 at once. Waiting on a timeout for every tile would freeze the
  map; the server remembers that upstream failed and does not try again for a minute.

`mtime` is when the tile was last known to be current, so "due a check" means `mtime` is older than
the tile's `Expires`/`max-age` or `refreshdays`, whichever is longer. `/config.json` then carries
`map.tiles.url: /tiles/osm/{z}/{x}/{y}.png`. The map already reads that (M-6), so the client needs no
change to use it.

**M-20 Behind the login**, like `/data`. Tiles are not secret, but an open `/tiles` would make every
Frugal IoT server a free proxy to OSM. Leaflet's tile `<img>`s are same-origin and carry the session
cookie, so this costs the map nothing.

**M-21 A prefetch fills in what nobody has looked at yet**, only on a server where it is turned on,
and only while online. It works from the retained locations, using the organization map's
subscriptions (M-13) made by the server's own MQTT client. It runs at startup, daily, and when a
location changes. An organization, or even a project, can span the world, so no layer is set as a
zoom. Each is set as a number of tiles, and goes as deep as that allows:
- **Organization**: the bounding box of all its devices, at each zoom while it needs no more than
  `organizationtiles` (64). That is zoom 3 for the whole world, about 9 for a province, about 12 for a
  district.
- **Project**: the same for each project's box, with `projecttiles` (256).
- **Device**: a square `deviceradius` (250 m) around each device, down to `devicezoom` (19, OSM's
  deepest). About 100 tiles per device, fewer where devices are close together, because the squares
  overlap.

Cost: each layer's total is about 4/3 of its budget, since every zoom shallower costs a quarter of
the one below. A project spread over a country therefore gets a few detailed squares around its
devices, not millions of tiles over the gaps between them.

**M-22 Deeper than what is kept, a tile is its ancestor enlarged.** When a tile is not there, the map
does not refuse. Leaflet stretches a layer past one depth only (`maxNativeZoom`), and that depth is the
same everywhere. Here the depth varies by place: deep around devices, shallow between them. So when a
tile fails to load, the map loads its parent instead and shows the right quarter of it, scaled up;
then the grandparent, and so on. Zoomed in past what is kept, the map is blurry, not blank. It is a
small Leaflet `TileLayer` subclass in `map.js`, so the Pi does no image processing. Online, where tiles
rarely fail, it does no harm.

**M-23 Within OSM's tile policy.** It requires a User-Agent that identifies the application, honouring
cache headers, and forbids downloading *significant* areas at zoom 17 and above for offline use without
consent. So the fetcher:
- identifies itself (`frugal-iot-server/<version> (+<server's public URL>)`);
- never fetches more than two tiles at once;
- goes deep (17 and above) only in the device squares;
- re-checks a kept tile no more often than its cache headers allow (M-19).

The attribution stays on the map, as now. If OSM ever objects, switch off the prefetch: the
read-through (M-19) is ordinary use.

**M-25 Keeping the cache to size, without wearing out an SD card.** Two kinds of tile:
- **Prefetched** tiles are never evicted while they are still in the prefetch set. An offline Pi
  cannot get them back, and the set can be recomputed from the locations at any time. When a device
  moves or is forgotten, the tiles that drop out of the set become ordinary.
- **Everything else**, the tiles somebody looked at, is dropped least recently used first once the
  cache is over `maxmb`. Disk space below housekeeping's `freespacepercent` also triggers dropping.

Recency is kept in memory, not read from `atime`:
- Pis are commonly mounted `noatime` to spare the card, so `atime` would silently never change.
- Even under the Linux default, `relatime`, `atime` costs a metadata write per tile per day viewed.

After a restart, a tile with no recency in memory counts as last used at its `mtime`. That is good
enough for choosing what to drop. Eviction runs with the daily housekeeping, not per request.

Writes on a Pi are then:
- each tile once when fetched;
- a `mtime` touch per tile per refresh period;
- a delete per evicted tile.

That is nothing per view. A whole prefetch is a few MB: a tile is 5–30 KB, and the budgets above are
hundreds of tiles, not thousands.

**M-24 Config, in `config.d/mapping.yaml`** (`config.mapping`, as `email.yaml` is `config.email`). All
of M-19 to M-25's numbers live here, not in code:

```yaml
tiles:
  enabled: false              # off: the map fetches from OSM directly, as now
  upstream: https://tile.openstreetmap.org/{z}/{x}/{y}.png
  refreshdays: 30             # re-check a kept tile after this, or its Expires if later
  maxmb: 200                  # viewed tiles beyond this are dropped, least recently used first
  prefetch:
    enabled: false            # a Pi that goes offline: true; production: false
    organizationtiles: 64
    projecttiles: 256
    deviceradius: 250         # metres
    devicezoom: 19
```

Off by default, so nothing changes on a server until it is turned on. `upstream` is a list in all
but name: ML-8 adds an imagery layer as a second entry, with a directory of its own.

**Phasing**
1. Server: `/tiles` read-through with its disk cache, conditional refresh, offline 404s, the config,
   and LRU eviction by size. Useful on production at once.
2. Client: the enlarged-ancestor fallback (M-22).
3. Server: the prefetch (M-21), and the rule that its tiles are never evicted (M-25).

**Tests**:
- A tile path to file and back, with a malformed `z/x/y` refused. It becomes a file path, so this is
  also a path-traversal check.
- A hit served without an upstream.
- A stale hit served when offline; "not modified" touching only `mtime`.
- A miss when offline is a 404 at once.
- Eviction drops the least recently used tiles and spares prefetched ones.
- The tiles each prefetch layer chooses, as numbers with no network. Include a world-spanning
  organization and a project of two far-apart devices.
- The fallback's parent tile and offset, as numbers.

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
| ML-1 | **Organization-level map** | Planned above (M-12 to M-18) |
| ML-2 | **Offline tiles on a Pi** | Planned above (M-19 to M-25) |
| ML-3 | **A tile provider beyond OSM** | Only if usage outgrows OSM's policy |
| ML-4 | **Card ↔ pin highlighting** | *Built 2026-11-06.* One event, `frugaliot:highlight {nodeId}` (null clears), either way: a card hovered by mouse or holding keyboard focus rings its pin (or the cluster hiding it); a pin hovered rings its card. Nothing on touch, where a tap already opens things |
| ML-5 | **Shapes** — fields, beds, a greenhouse outline | A different data model (a polygon per project, not a point per device). Not at this stage |
| ML-6 | **Values on the map** — pins coloured by a reading (soil moisture across a field) | The most interesting one, and needs a choice of reading and scale; waits for a use case |
| ML-7 | **What `retain` in the schema means** | Look at at the end of this project. Sets from the UI are meant to be QoS 1 and not retained; readings from a node are retained. But `initialize()` copies the schema's `retain: true` over the constructor's default, so `description`, `location` and six others publish their sets retained, and it is no longer clear what the schema field is for. `location` follows `description` until then |
| ML-8 | **Detail at site scale** — imagery for a view ~100 m across, where OpenStreetMap shows little | On an online server nothing is kept: the browser fetches a few imagery tiles as it would any map, so this is a second tile layer (map / imagery) with its own provider in config, as M-6. What it needs is a provider whose terms allow use from our page — most want an API key and attribution. OpenAerialMap has nothing for our sites. Waits for a budget, though several imagery providers have free tiers behind an API key that may cover a few farms - check their terms when this comes back |

## Questions — resolved 2026-11-06

- **Q-1** Does a node that is asleep, or away, receive a `set/` sent meanwhile? **Yes** — sets are
  QoS 1, so "pending" lasts only until it reconnects.
- **Q-2** Should the browser offer to resend a location the node has lost? **No.** An OTA update
  keeps settings; only re-provisioning loses them, and that is effectively a new node.
- **Q-3** Does a precise location need more than READ to see? **Not for now** — it is READ, like
  every other topic.
- **Q-4** MQTT or a server table? **MQTT (M-1)** — nodes are assumed to update by OTA to firmware
  that has `location`.
- **Q-6** Is a status as of page load acceptable on the organization map? **Yes**, with a reload on the
  map (M-15).
- **Q-7** Where does Open project land? **The project page, with that device's card open on its front**
  (M-16).
