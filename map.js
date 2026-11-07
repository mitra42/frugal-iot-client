/*
 * mqtt-map - the project's located devices as pins on a map (MAPPING_PLAN.md).
 *
 * Leaflet and Leaflet.markercluster are loaded as classic scripts on first open, not imported:
 * markercluster attaches itself to a global L, which an ES module namespace (frozen) cannot be. A
 * page that never opens the map fetches neither, nor any tiles.
 *
 * Light DOM, so leaflet.css on the page reaches the map's own markup.
 */
import { HTMLElementExtendedMinimum } from '/node_modules/html-element-extended/htmlelementextended.js';
import { el, getString, locationPayload, server_config, XXX } from './core.js';

const LEAFLET_SCRIPTS = [
  '/node_modules/leaflet/dist/leaflet.js',
  '/node_modules/leaflet.markercluster/dist/leaflet.markercluster.js',
];
const LEAFLET_CSS = [
  '/node_modules/leaflet/dist/leaflet.css',
  '/node_modules/leaflet.markercluster/dist/MarkerCluster.css',
];
const BASE_NAME = 'Map';   // sources with this name are drawn everywhere; any other is a switch over it
const DEFAULT_SOURCES = [{
  id: 'osm',
  name: BASE_NAME,
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  minzoom: 0,
  maxzoom: 19,
}];
const MAP_PREFS_VERSION = 1;
const MAP_HEIGHT_DEFAULT = 320;
const MAP_HEIGHT_MIN = 120;
const STATUS_TICK_MS = 10000;  // the cards' interval: a device going quiet sends nothing to re-draw it
const SYNC_DELAY_MS = 200;     // a node reports in a burst; draw once at the end of it
// Worse is higher. A cluster shows its worst member, so an offline device cannot hide in a green "5".
const STATUS_RANK = { live: 0, stale: 1, never: 2, offline: 3 };

// Where tiles come from, as config.json lists them (M-6, M-27): OpenStreetMap unless it says
// otherwise. Leaflet only ever sees this, so a change of provider is a config change.
function mapSources() {
  const configured = server_config && server_config.mapping && server_config.mapping.sources;
  const sources = (Array.isArray(configured) && configured.length) ? configured : DEFAULT_SOURCES;
  return sources.map((s) => ({ minzoom: 0, maxzoom: 19, ...s }));
}
// The switches the map offers - one per name, so sources sharing a name switch together (M-28)
function mapLayerNames(sources) {
  return [...new Set(sources.filter((s) => s.name !== BASE_NAME).map((s) => s.name))];
}
// Whether a switch is worth showing for this view: 'hidden' where none of its sources reaches,
// 'zoom' where one does but only deeper, 'ready' where pressing it shows something
function reachingSources(sources, name, view) {
  return sources.filter((s) => (s.name === name) && (!s.bounds
    || ((view.south <= s.bounds[1][0]) && (view.north >= s.bounds[0][0])
      && (view.west <= s.bounds[1][1]) && (view.east >= s.bounds[0][1]))));
}
function layerAvailability(sources, name, view, zoom) {
  const reaching = reachingSources(sources, name, view);
  if (!reaching.length) return 'hidden';
  return reaching.some((s) => zoom >= s.minzoom) ? 'ready' : 'zoom';
}
// Where pressing a switch that is not yet deep enough takes the map, at the shallowest zoom it has
// anything at: the device inside it nearest the centre of the view. Bounds are a rectangle, and
// mostly not land the source covers, so failing a device, the middle of them.
function layerZoomTarget(sources, name, view, center, devices = []) {
  const [s] = reachingSources(sources, name, view).sort((a, b) => a.minzoom - b.minzoom);
  if (!s) return null;
  const inside = (d) => !s.bounds || ((d.lat >= s.bounds[0][0]) && (d.lat <= s.bounds[1][0])
    && (d.lon >= s.bounds[0][1]) && (d.lon <= s.bounds[1][1]));
  const distance = (d) => ((d.lat - center.lat) ** 2) + ((d.lon - center.lon) ** 2);
  const [nearest] = devices.filter(inside).sort((a, b) => distance(a) - distance(b));
  if (nearest) return { lat: nearest.lat, lon: nearest.lon, zoom: s.minzoom };
  return s.bounds
    ? { lat: (s.bounds[0][0] + s.bounds[1][0]) / 2, lon: (s.bounds[0][1] + s.bounds[1][1]) / 2, zoom: s.minzoom }
    : { lat: center.lat, lon: center.lon, zoom: s.minzoom };
}

const FALLBACK_DEPTH = 8;   // 256 times enlarged; anything blurrier than that is no help

// The tile `depth` levels up that covers this one, and which part of it this one is (M-22)
function ancestorTile({ x, y, z }, depth) {
  const scale = 2 ** depth;
  const ax = Math.floor(x / scale);
  const ay = Math.floor(y / scale);
  return { x: ax, y: ay, z: z - depth, scale, dx: x - (ax * scale), dy: y - (ay * scale) };
}

// A tile not kept shows its parent's quarter enlarged, then the grandparent's, and so on - so past
// what an offline Pi holds the map is blurry rather than blank. maxNativeZoom cannot do it: it is one
// depth for the whole map, and what is kept is deep around devices and shallow between them.
// Built once Leaflet has loaded, since that is a classic script.
function fallbackTileLayer(L) {
  return L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('div');
      tile.style.overflow = 'hidden';
      this.loadAncestor(tile, coords, 0, done);
      return tile;
    },
    loadAncestor(tile, coords, depth, done) {
      const a = ancestorTile(coords, depth);
      const size = this.getTileSize();
      const img = document.createElement('img');
      img.alt = '';
      img.setAttribute('role', 'presentation');
      // leaflet.css caps an img at its container, which would undo the enlargement
      Object.assign(img.style, {
        position: 'absolute', maxWidth: 'none', maxHeight: 'none',
        width: `${size.x * a.scale}px`, height: `${size.y * a.scale}px`,
        left: `${-a.dx * size.x}px`, top: `${-a.dy * size.y}px`,
      });
      img.onload = () => done(null, tile);
      img.onerror = () => (((depth < FALLBACK_DEPTH) && (a.z > (this.options.minZoom || 0)))
        ? this.loadAncestor(tile, coords, depth + 1, done)
        : done(new Error('no tile'), tile));
      // getTileUrl would use the map's zoom, not the ancestor's
      img.src = L.Util.template(this._url, L.Util.extend({ r: '', s: this._getSubdomain(a) }, this.options, { x: a.x, y: a.y, z: a.z }));
      tile.replaceChildren(img);
    },
  });
}

function worstStatus(statuses) {
  return statuses.reduce((worst, s) => (((STATUS_RANK[s] ?? 0) > (STATUS_RANK[worst] ?? 0)) ? s : worst), 'live');
}

// One pin per located device, read from the tree - what the map draws, testable with no Leaflet
function mapPins(projectMt) {
  if (!projectMt) return [];
  return projectMt.locatedNodes.map((nodeMt) => {
    const { lat, lon, source } = nodeMt.location;
    return { nodeId: nodeMt.nodeId, lat, lon, source, status: nodeMt.status };
  });
}

// Open and height, per project and per browser: presentation, like the card layout (CARDS_UX.md 7.3).
// A key of its own, because the grid caches its layout and would write back over these.
function mapPrefsKey(projectMt) {
  return `frugaliot:map:v${MAP_PREFS_VERSION}:${projectMt.twig}`;
}
function mapPrefsLoad(projectMt) {
  const prefs = { open: false, height: MAP_HEIGHT_DEFAULT };
  try {
    const parsed = JSON.parse(localStorage.getItem(mapPrefsKey(projectMt)) || 'null');
    if (parsed && (parsed.v === MAP_PREFS_VERSION)) {
      prefs.open = !!parsed.open;
      if (Number.isFinite(parsed.height)) prefs.height = Math.max(MAP_HEIGHT_MIN, parsed.height);
      if (parsed.layers && (typeof parsed.layers === 'object')) prefs.layers = parsed.layers;
    }
  } catch (e) { /* storage blocked or garbled: the defaults will do */ }
  return prefs;
}
function mapPrefsSave(projectMt, prefs) {
  try {
    localStorage.setItem(mapPrefsKey(projectMt), JSON.stringify({ v: MAP_PREFS_VERSION, ...prefs }));
  } catch (e) { /* the map still works, it just forgets */ }
}

// Geolocation exists only in a secure context, so an offline Pi on plain HTTP hides "I'm here"
// rather than offering a button that fails
function canLocate() {
  return !!(window.isSecureContext && navigator.geolocation);
}
function locate(cb) {
  navigator.geolocation.getCurrentPosition(
    (p) => cb(null, { lat: p.coords.latitude, lon: p.coords.longitude }),
    (err) => cb(err),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// Classic scripts in order, once per page, however many maps ask. cb(err)
let leafletState = null;  // null | 'loading' | 'loaded' | Error
const leafletWaiting = [];
function leafletLoad(cb) {
  if (leafletState === 'loaded') return cb(null);
  if (leafletState instanceof Error) return cb(leafletState);
  leafletWaiting.push(cb);
  if (leafletState === 'loading') return;
  leafletState = 'loading';
  LEAFLET_CSS.forEach((href) => document.head.append(el('link', { rel: 'stylesheet', href })));
  const done = (err) => {
    leafletState = err || 'loaded';
    leafletWaiting.splice(0).forEach((waiting) => waiting(err || null));
  };
  const next = (i) => {
    if (i >= LEAFLET_SCRIPTS.length) return done(null);
    const script = document.createElement('script');
    script.src = LEAFLET_SCRIPTS[i];
    script.onload = () => next(i + 1);
    script.onerror = () => done(new Error(`Could not load ${LEAFLET_SCRIPTS[i]}`));
    document.head.append(script);
  };
  next(0);
}

class MqttMap extends HTMLElementExtendedMinimum {
  constructor() {
    super();
    this.state.elements = {};
    this.state.markers = new Map();  // nodeId -> L.Marker
    this.onGroupChanged = this.onGroupChanged.bind(this);
    this.onTopicsChanged = this.onTopicsChanged.bind(this);
    this.onHandleDown = this.onHandleDown.bind(this);
    this.onHandleKey = this.onHandleKey.bind(this);
    this.onPickClick = this.onPickClick.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onHighlight = this.onHighlight.bind(this);
    this.onMapMoved = this.onMapMoved.bind(this);
    this.onCardClick = this.onCardClick.bind(this);
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('frugaliot:groupchanged', this.onGroupChanged);
    document.addEventListener('frugaliot:topicschanged', this.onTopicsChanged);
    document.addEventListener('frugaliot:highlight', this.onHighlight);
    document.addEventListener('frugaliot:cardclick', this.onCardClick);
    this.state.tick = setInterval(() => this.scheduleSync(), STATUS_TICK_MS);
    if (this.state.tick && (typeof this.state.tick.unref === 'function')) this.state.tick.unref();
    this.addEventListener('keydown', this.onKeyDown);
  }
  disconnectedCallback() {
    document.removeEventListener('frugaliot:groupchanged', this.onGroupChanged);
    document.removeEventListener('frugaliot:topicschanged', this.onTopicsChanged);
    document.removeEventListener('frugaliot:highlight', this.onHighlight);
    document.removeEventListener('frugaliot:cardclick', this.onCardClick);
    clearInterval(this.state.tick);
    this.removeEventListener('keydown', this.onKeyDown);
  }

  get projectMt() { return this.mt; }
  get isOpen() { return !this.hidden; }
  get isPicking() { return !!this.state.pick; }
  get isOrganization() { return !!(this.mt && this.mt.isOrganization); }

  // Rendered once - Leaflet owns the canvas's children from then on, and a re-render would drop them
  render0() {
    const e = this.state.elements;
    const handle = e.handle = el('button', { class: 'fi-map__handle', type: 'button', title: 'Resize map' });
    // Not via el(): EL wires only onclick, onchange and onsubmit
    handle.addEventListener('pointerdown', this.onHandleDown);
    handle.addEventListener('keydown', this.onHandleKey);
    e.pickBar = el('div', { class: 'fi-map__pick', hidden: true }, [
      e.pickName = el('span', { class: 'fi-map__pickname', i8n: false }),
      e.pickHint = el('span', { class: 'fi-map__hint', textContent: 'Tap the map' }),
      e.here = el('button', { class: 'fi-btn', type: 'button', textContent: "I'm here", onclick: () => this.pickHere() }),
      e.clear = el('button', { class: 'fi-btn', type: 'button', textContent: 'Clear', onclick: () => this.pickEnd('clear') }),
      el('button', { class: 'fi-btn', type: 'button', textContent: 'Cancel', onclick: () => this.pickEnd('cancel') }),
      e.save = el('button', { class: 'fi-btn fi-map__save', type: 'button', textContent: 'Save', onclick: () => this.pickEnd('save') }),
    ]);
    // Organization level only: its status is as of page load, so this is how it catches up (M-15)
    e.reload = el('button', { class: 'fi-btn fi-map__reload', type: 'button', title: 'Refresh', textContent: '↻', hidden: true,
      onclick: () => this.reload() });
    // Imagery and the like - filled once the map is made, since that is when config is certain to be in
    e.layers = el('span', { class: 'fi-map__layers' });
    return [e.pickBar, e.canvas = el('div', { class: 'fi-map__canvas' }),
      el('div', { class: 'fi-map__corner' }, [e.layers, e.reload]), handle];
  }

  // A project, or an organization (MAPPING_PLAN.md M-17) - each starts from its own remembered
  // state, fitted to its own devices
  setProject(projectMt) {
    if (projectMt === this.mt) return;
    if (this.state.pick) this.pickEnd('cancel');
    this.mt = projectMt;
    this.state.elements.reload.hidden = !this.isOrganization;
    if (this.state.cluster) this.state.cluster.clearLayers();
    this.state.markers.clear();
    this.state.fitted = false;
    this.state.prefs = projectMt ? mapPrefsLoad(projectMt) : { open: false, height: MAP_HEIGHT_DEFAULT };
    this.style.height = `${this.state.prefs.height}px`;
    this.applyLayers();
    if (projectMt && this.state.prefs.open) this.open(); else this.hidden = true;
  }
  // Each switchable layer on or off as this project last had it - off unless chosen
  applyLayers() {
    const on = this.state.prefs.layers || {};
    Object.entries(this.state.overlays || {}).forEach(([name, group]) => {
      if (on[name]) group.addTo(this.state.map); else group.remove();
    });
    this.state.elements.layers.querySelectorAll('.fi-map__layer').forEach((b) =>
      b.setAttribute('aria-pressed', String(!!on[b.dataset.layer])));
  }
  toggleLayer(name) {
    const layers = { ...(this.state.prefs.layers || {}) };
    const button = this.state.elements.layers.querySelector(`.fi-map__layer[data-layer="${CSS.escape(name)}"]`);
    // Not deep enough to show anything yet: pressing it means "show me", so turn it on and go there
    const toZoom = button && (button.dataset.available === 'zoom');
    layers[name] = toZoom || !layers[name];
    this.savePrefs({ layers });
    this.applyLayers();
    if (toZoom) {
      const map = this.state.map;
      const c = map.getCenter();
      const devices = (this.mt ? this.mt.locatedNodes : []).map((n) => n.location);
      const t = layerZoomTarget(this.state.sources, name, this.viewOf(map), { lat: c.lat, lon: c.lng }, devices);
      if (t) map.setView([t.lat, t.lon], t.zoom);
    }
  }
  viewOf(map) {
    const b = map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }
  toggle() { if (this.isOpen) this.close(); else this.open(); }
  open() {
    this.hidden = false;
    this.savePrefs({ open: true });
    this.ensureMap((err) => {
      if (err) return;
      this.state.map.invalidateSize();  // it was laid out while hidden, at no size at all
      this.sync();
    });
  }
  close() {
    if (this.state.pick) this.pickEnd('cancel');
    this.hidden = true;
    this.savePrefs({ open: false });
  }
  savePrefs(changes) {
    if (!this.projectMt) return;
    Object.assign(this.state.prefs, changes);
    mapPrefsSave(this.projectMt, this.state.prefs);
  }

  // The map underneath, and a group per switchable name (M-28). The map is enlarged past its own
  // depth, so zoomed into imagery that goes deeper there is still a map around its edges.
  addSources(L, map, sources) {
    const TileLayer = fallbackTileLayer(L);
    const deepest = Math.max(...sources.map((s) => s.maxzoom));
    this.state.overlays = {};
    sources.forEach((s) => {
      const base = s.name === BASE_NAME;
      const layer = new TileLayer(s.url, {
        attribution: s.attribution,
        minZoom: s.minzoom,
        ...(base ? { maxNativeZoom: s.maxzoom, maxZoom: deepest } : { maxZoom: s.maxzoom }),
        ...(s.bounds ? { bounds: L.latLngBounds(s.bounds) } : {}),
      });
      if (base) layer.addTo(map);
      else (this.state.overlays[s.name] = this.state.overlays[s.name] || L.layerGroup()).addLayer(layer);
    });
    this.state.sources = sources;
    this.state.elements.layers.replaceChildren(...mapLayerNames(sources).map((name) => {
      const b = el('button', { class: 'fi-btn fi-map__layer', type: 'button', textContent: name, onclick: () => this.toggleLayer(name) });
      b.dataset.layer = name;
      return b;
    }));
    map.on('moveend', this.onMapMoved);
    this.applyLayers();
    map.whenReady(this.onMapMoved);   // the view is set after this, when the map is fitted to its devices
  }
  // A switch only where it would show something; a choice made stays made as it comes and goes
  onMapMoved() {
    const map = this.state.map;
    if (!map || !this.state.sources) return;
    const view = this.viewOf(map);
    this.state.elements.layers.querySelectorAll('.fi-map__layer').forEach((button) => {
      const available = layerAvailability(this.state.sources, button.dataset.layer, view, map.getZoom());
      button.dataset.available = available;
      button.hidden = (available === 'hidden');
      button.title = (available === 'zoom') ? getString('Zoom in') : '';
    });
  }

  ensureMap(cb) {
    if (this.state.map) return cb(null);
    leafletLoad((err) => {
      if (err) {
        XXX(['map: Leaflet did not load', err.message]);
        this.state.elements.canvas.replaceChildren(el('p', { class: 'fi-map__error', textContent: 'Map unavailable' }));
        return cb(err);
      }
      if (this.state.map) return cb(null);  // two opens raced the load
      const L = window.L;
      const map = this.state.map = L.map(this.state.elements.canvas, { worldCopyJump: true });
      this.addSources(L, map, mapSources());
      this.state.cluster = L.markerClusterGroup({
        maxClusterRadius: 40,
        showCoverageOnHover: false,
        iconCreateFunction: (cluster) => {
          const status = worstStatus(cluster.getAllChildMarkers().map((m) => m.fiStatus));
          return L.divIcon({ className: 'fi-pin-icon', iconSize: [30, 30],
                             html: `<span class="fi-pin fi-pin--cluster fi-pin--${status}">${cluster.getChildCount()}</span>` });
        },
      }).addTo(map);
      // Covers the drag handle, the window, the page reflowing, and first being shown at all
      if (window.ResizeObserver) {
        new ResizeObserver(() => {
          map.invalidateSize();
          if (!this.state.fitted) this.sync();
        }).observe(this.state.elements.canvas);
      }
      cb(null);
    });
  }

  onGroupChanged(e) {
    if (this.projectMt && e.detail && e.detail.nodeMt && (this.projectMt.nodes[e.detail.nodeMt.nodeId] === e.detail.nodeMt)) this.scheduleSync();
  }
  onTopicsChanged(e) {
    if (e.detail && (e.detail.project === this.projectMt)) this.scheduleSync();
  }
  scheduleSync() {
    if (!this.isOpen || !this.state.map || this.state.syncPending) return;
    this.state.syncPending = true;
    const t = setTimeout(() => { this.state.syncPending = false; this.sync(); }, SYNC_DELAY_MS);
    if (t && (typeof t.unref === 'function')) t.unref();
  }

  // Bring the markers into line with the tree, moving and re-colouring rather than rebuilding, so an
  // open popup survives a reading arriving
  sync() {
    const L = window.L;
    if (!this.state.map || !L) return;
    // While picking, the draggable pin stands in for the device's own
    const picking = this.state.pick && this.state.pick.nodeMt.nodeId;
    const pins = mapPins(this.projectMt).filter((pin) => pin.nodeId !== picking);
    let restyled = false;
    pins.forEach((pin) => {
      let marker = this.state.markers.get(pin.nodeId);
      if (!marker) {
        marker = L.marker([pin.lat, pin.lon], { icon: this.pinIcon(pin), keyboard: true });
        marker.fiStatus = pin.status;
        marker.fiSource = pin.source;
        // Touch has no hover, and a tap opening a tooltip and a popup together is clutter
        if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
          marker.bindTooltip(() => this.pinContent(pin.nodeId, false), { direction: 'top', offset: [0, -8] });
        }
        marker.bindPopup(() => this.pinContent(pin.nodeId, true));
        // Lights the card, as the card lights this (ML-4). Leaflet's mouseover is the mouse's alone.
        marker.on('mouseover', () => document.dispatchEvent(new CustomEvent('frugaliot:highlight', { detail: { nodeId: pin.nodeId } })));
        marker.on('mouseout', () => document.dispatchEvent(new CustomEvent('frugaliot:highlight', { detail: { nodeId: null } })));
        this.state.markers.set(pin.nodeId, marker);
        this.state.cluster.addLayer(marker);
        return;
      }
      const at = marker.getLatLng();
      if ((at.lat !== pin.lat) || (at.lng !== pin.lon)) marker.setLatLng([pin.lat, pin.lon]);
      if ((marker.fiStatus !== pin.status) || (marker.fiSource !== pin.source)) {
        marker.fiStatus = pin.status;
        marker.fiSource = pin.source;
        marker.setIcon(this.pinIcon(pin));
        restyled = true;
      }
    });
    const located = new Set(pins.map((p) => p.nodeId));
    [...this.state.markers.keys()].filter((id) => !located.has(id)).forEach((id) => {
      this.state.cluster.removeLayer(this.state.markers.get(id));
      this.state.markers.delete(id);
    });
    if (restyled) this.state.cluster.refreshClusters();
    if (!this.state.fitted && pins.length) this.fit();
  }
  // One device at a time. A pin inside a cluster at this zoom cannot be seen, so its cluster is lit.
  onHighlight(e) {
    const nodeId = e.detail && e.detail.nodeId;
    if (this.state.highlighted) this.state.highlighted.classList.remove('fi-pin-icon--highlight');
    this.state.highlighted = null;
    const marker = nodeId && this.state.markers.get(nodeId);
    if (!marker || !this.isOpen || !this.state.cluster) return;
    const shown = this.state.cluster.getVisibleParent(marker) || marker;
    const iconEl = shown.getElement && shown.getElement();
    if (!iconEl) return;  // off the edge of the view
    iconEl.classList.add('fi-pin-icon--highlight');
    this.state.highlighted = iconEl;
  }
  // A card clicked: its device to the middle of the map, at the zoom the user chose
  onCardClick(e) {
    const marker = e.detail && this.state.markers.get(e.detail.nodeId);
    if (!marker || !this.isOpen || !this.state.map) return;
    this.state.map.panTo(marker.getLatLng());
  }
  // Once per project: after that the view is the user's, and a reading arriving must not move it
  fit() {
    const b = this.projectMt.locationBounds;
    // A map with no size yet fits to nothing; the ResizeObserver tries again when it has one
    if (!b || !this.state.elements.canvas.clientHeight) return;
    this.state.fitted = true;
    if ((b.south === b.north) && (b.west === b.east)) this.state.map.setView([b.south, b.west], 16);
    else this.state.map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [24, 24], maxZoom: 17 });
  }
  // The shape is a child: Leaflet positions the icon element itself with an inline transform
  pinIcon(pin) {
    const classes = `fi-pin fi-pin--${pin.status}${(pin.source === 'gps') ? ' fi-pin--gps' : ''}`;
    return window.L.divIcon({ className: 'fi-pin-icon', iconSize: [18, 18], html: `<span class="${classes}"></span>` });
  }
  // Built when it opens, so it is never stale - the same name and chips as the summary card
  pinContent(nodeId, withOpen) {
    const nodeMt = this.projectMt && this.projectMt.nodes[nodeId];
    if (!nodeMt) return '';
    // No chips: the organization's tree has no readings (M-16). Its project has, one tap away.
    if (this.isOrganization) {
      const projectMt = nodeMt._projectMt;
      return el('div', { class: 'fi-map__tip' }, [
        el('div', { class: 'fi-map__name' }, [el('span', { textContent: nodeMt.usableName, i8n: false })]),
        el('div', {}, [el('span', { textContent: projectMt.usableName, i8n: false })]),
        withOpen ? el('button', { class: 'fi-btn fi-map__open', type: 'button', textContent: 'Open project',
          onclick: () => {
            if (this.state.map) this.state.map.closePopup();
            document.dispatchEvent(new CustomEvent('frugaliot:projectopen', { detail: { project: projectMt.project, nodeId } }));
          } }) : null,
      ]);
    }
    return el('div', { class: 'fi-map__tip' }, [
      el('div', { class: 'fi-map__name' }, [el('span', { textContent: nodeMt.usableName, i8n: false })]),
      el('div', { class: 'fi-card__chips' },
        nodeMt.summaryChips.map((c) => el('span', { class: 'fi-chip', textContent: c.text, i8n: false }))),
      withOpen ? el('button', { class: 'fi-btn fi-map__open', type: 'button', textContent: 'Open card',
        onclick: () => {
          this.state.map.closePopup();
          document.dispatchEvent(new CustomEvent('frugaliot:cardopen', { detail: { nodeId } }));
        } }) : null,
    ]);
  }

  // ===== pick mode: setting one device's location (M-9) =====
  //
  // Every other device stays on the map, so "between the two greenhouses" can be placed by eye.
  // cb(null, how) when it ends - how is 'save', 'clear' or 'cancel'.
  pick(nodeMt, cb = () => {}) {
    if (this.isOrganization) return cb(null, 'cancel');  // a location is set from its device's card
    if (this.state.pick) this.pickEnd('cancel');
    const loc = nodeMt.location;
    this.state.pick = { nodeMt, at: loc ? { lat: loc.lat, lon: loc.lon } : null, wasOpen: this.isOpen, cb };
    const e = this.state.elements;
    e.pickName.textContent = nodeMt.usableName;
    e.here.hidden = !canLocate();
    e.clear.hidden = !loc;
    this.pickPlaced();
    e.pickBar.hidden = false;
    this.classList.add('fi-map--picking');
    this.open();
    this.ensureMap((err) => { if (!err) this.pickStart(); });
  }
  // Where it starts (M-10): the device, else the project's other pins, else here, else the world.
  // The other pins come before here because whoever sets a device up is often in the office.
  pickStart() {
    const pick = this.state.pick;
    if (!pick) return;
    const map = this.state.map;
    map.on('click', this.onPickClick);
    this.sync();
    if (pick.at) {
      this.placePick(pick.at);
      map.setView([pick.at.lat, pick.at.lon], Math.max(map.getZoom() || 0, 16));
      this.state.fitted = true;
    } else if (this.projectMt.locationBounds) {
      this.state.fitted = false;
      this.fit();
    } else {
      map.setView([0, 0], 2);
      this.state.fitted = true;
      if (canLocate()) locate((err, at) => { if (!err && (this.state.pick === pick)) map.setView([at.lat, at.lon], 16); });
    }
  }
  onPickClick(e) {
    // worldCopyJump lets the map scroll past 180°, and a click there is off the end of the world
    const p = e.latlng.wrap();
    this.placePick({ lat: p.lat, lon: p.lng });
  }
  placePick(at) {
    const L = window.L;
    const pick = this.state.pick;
    pick.at = at;
    if (!this.state.pickMarker) {
      const marker = this.state.pickMarker = L.marker([at.lat, at.lon], {
        draggable: true, keyboard: true, zIndexOffset: 1000,
        icon: L.divIcon({ className: 'fi-pin-icon', iconSize: [22, 22], html: '<span class="fi-pin fi-pin--pick"></span>' }),
      });
      marker.on('dragend', () => {
        const p = marker.getLatLng().wrap();
        if (this.state.pick) this.state.pick.at = { lat: p.lat, lon: p.lng };
      });
      marker.addTo(this.state.map);
    } else {
      this.state.pickMarker.setLatLng([at.lat, at.lon]);
    }
    this.pickPlaced();
  }
  // Nothing to save until there is a pin, and the hint is only for when there is not
  pickPlaced() {
    const placed = !!(this.state.pick && this.state.pick.at);
    this.state.elements.save.disabled = !placed;
    this.state.elements.pickHint.hidden = placed;
  }
  pickHere() {
    const here = this.state.elements.here;
    here.disabled = true;
    locate((err, at) => {
      here.disabled = false;
      if (err) { XXX(['map: no position', err.message]); return; }
      if (!this.state.pick || !this.state.map) return;
      this.placePick(at);
      this.state.map.setView([at.lat, at.lon], Math.max(this.state.map.getZoom() || 0, 17));
    });
  }
  pickEnd(how) {
    const pick = this.state.pick;
    if (!pick) return;
    const locationMt = pick.nodeMt.locationMt;
    if ((how === 'save') && pick.at && locationMt) locationMt.publish(locationPayload(pick.at.lat, pick.at.lon));
    if ((how === 'clear') && locationMt) locationMt.publish('');  // the node echoes it empty, which clears the retained copy too
    this.state.pick = null;
    if (this.state.map) this.state.map.off('click', this.onPickClick);
    if (this.state.pickMarker) { this.state.pickMarker.remove(); this.state.pickMarker = null; }
    this.state.elements.pickBar.hidden = true;
    this.classList.remove('fi-map--picking');
    if (!pick.wasOpen) this.close(); else this.sync();
    pick.cb(null, how);
  }
  onKeyDown(e) {
    if ((e.key === 'Escape') && this.state.pick) { e.preventDefault(); this.pickEnd('cancel'); }
  }

  reload() {
    const button = this.state.elements.reload;
    button.disabled = true;
    this.mt.reload((err) => {
      button.disabled = false;
      if (err) { XXX(['map: reload failed', err.message]); return; }
      this.sync();
    });
  }

  // ===== resizing: the handle on the bottom edge =====
  setHeight(px) {
    const max = Math.max(MAP_HEIGHT_MIN, Math.round(window.innerHeight * 0.85));
    const height = Math.round(Math.max(MAP_HEIGHT_MIN, Math.min(max, px)));
    this.style.height = `${height}px`;
    return height;
  }
  onHandleDown(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = this.getBoundingClientRect().height || this.state.prefs.height;
    let height = startHeight;
    const move = (m) => { height = this.setHeight(startHeight + (m.clientY - startY)); };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      this.savePrefs({ height });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
  onHandleKey(e) {
    const step = { ArrowUp: -40, ArrowDown: 40 }[e.key];
    if (!step) return;
    e.preventDefault();
    this.savePrefs({ height: this.setHeight((this.getBoundingClientRect().height || this.state.prefs.height) + step) });
  }
}
customElements.define('mqtt-map', MqttMap);

export { MqttMap, ancestorTile, canLocate, fallbackTileLayer, layerAvailability, layerZoomTarget, mapLayerNames, mapPins, mapPrefsLoad, mapPrefsSave, mapSources, worstStatus };
