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
import { el, server_config, XXX } from './core.js';

const LEAFLET_SCRIPTS = [
  '/node_modules/leaflet/dist/leaflet.js',
  '/node_modules/leaflet.markercluster/dist/leaflet.markercluster.js',
];
const LEAFLET_CSS = [
  '/node_modules/leaflet/dist/leaflet.css',
  '/node_modules/leaflet.markercluster/dist/MarkerCluster.css',
];
const DEFAULT_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
};
const MAP_PREFS_VERSION = 1;
const MAP_HEIGHT_DEFAULT = 320;
const MAP_HEIGHT_MIN = 120;
const STATUS_TICK_MS = 10000;  // the cards' interval: a device going quiet sends nothing to re-draw it
const SYNC_DELAY_MS = 200;     // a node reports in a burst; draw once at the end of it
// Worse is higher. A cluster shows its worst member, so an offline device cannot hide in a green "5".
const STATUS_RANK = { live: 0, stale: 1, never: 2, offline: 3 };

// Where tiles come from: OpenStreetMap unless config.json says otherwise - an offline Pi serving its
// own, say (M-6). Leaflet only ever sees this, so a change of provider is a config change.
function mapTiles() {
  const configured = (server_config && server_config.map && server_config.map.tiles) || {};
  return { ...DEFAULT_TILES, ...configured };
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
    }
  } catch (e) { /* storage blocked or garbled: the defaults will do */ }
  return prefs;
}
function mapPrefsSave(projectMt, prefs) {
  try {
    localStorage.setItem(mapPrefsKey(projectMt), JSON.stringify({ v: MAP_PREFS_VERSION, ...prefs }));
  } catch (e) { /* the map still works, it just forgets */ }
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
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('frugaliot:groupchanged', this.onGroupChanged);
    document.addEventListener('frugaliot:topicschanged', this.onTopicsChanged);
    this.state.tick = setInterval(() => this.scheduleSync(), STATUS_TICK_MS);
    if (this.state.tick && (typeof this.state.tick.unref === 'function')) this.state.tick.unref();
  }
  disconnectedCallback() {
    document.removeEventListener('frugaliot:groupchanged', this.onGroupChanged);
    document.removeEventListener('frugaliot:topicschanged', this.onTopicsChanged);
    clearInterval(this.state.tick);
  }

  get projectMt() { return this.mt; }
  get isOpen() { return !this.hidden; }

  // Rendered once - Leaflet owns the canvas's children from then on, and a re-render would drop them
  render0() {
    const handle = this.state.elements.handle = el('button', { class: 'fi-map__handle', type: 'button', title: 'Resize map' });
    // Not via el(): EL wires only onclick, onchange and onsubmit
    handle.addEventListener('pointerdown', this.onHandleDown);
    handle.addEventListener('keydown', this.onHandleKey);
    return [this.state.elements.canvas = el('div', { class: 'fi-map__canvas' }), handle];
  }

  // A different project starts from its own remembered state, fitted to its own devices
  setProject(projectMt) {
    if (projectMt === this.mt) return;
    this.mt = projectMt;
    if (this.state.cluster) this.state.cluster.clearLayers();
    this.state.markers.clear();
    this.state.fitted = false;
    this.state.prefs = projectMt ? mapPrefsLoad(projectMt) : { open: false, height: MAP_HEIGHT_DEFAULT };
    this.style.height = `${this.state.prefs.height}px`;
    if (projectMt && this.state.prefs.open) this.open(); else this.hidden = true;
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
    this.hidden = true;
    this.savePrefs({ open: false });
  }
  savePrefs(changes) {
    if (!this.projectMt) return;
    Object.assign(this.state.prefs, changes);
    mapPrefsSave(this.projectMt, this.state.prefs);
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
      const tiles = mapTiles();
      const map = this.state.map = L.map(this.state.elements.canvas, { worldCopyJump: true });
      L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: tiles.maxZoom }).addTo(map);
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
    const pins = mapPins(this.projectMt);
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

export { MqttMap, mapPins, mapPrefsLoad, mapPrefsSave, mapTiles, worstStatus };
