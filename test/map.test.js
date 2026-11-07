// The map: what it draws comes from the tree, so it is tested here with no Leaflet at all - jsdom
// never loads the scripts. Drawing, clustering and the resize handle need a browser (and a look).
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock, core, map;

before(async () => {
  mock = await import('./mock.js');
  core = await import('../core.js');
  await import('../widgets.js');
  await import('../graph.js');
  await import('../cards.js');
  map = await import('../map.js');
  mock.loadConfig(config);
});
beforeEach(() => { mock.setNow(null); localStorage.clear(); });

const showProject = (page, projectMt) => document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
  { detail: { projectMt, organization: 'dev', project: 'lotus' } }));

describe('pins', () => {
  test('one per located device, with where it came from and its status', () => {
    const { projectMt } = mock.runScenario('located-devices');
    const pins = Object.fromEntries(map.mapPins(projectMt).map((p) => [p.nodeId, p]));
    assert.equal(Object.keys(pins).length, 6);
    assert.equal(pins['esp8266-workbench'], undefined, 'no location, no pin');
    assert.deepEqual(pins['esp32-tractor'], { nodeId: 'esp32-tractor', lat: -6.215, lon: 106.842, source: 'gps', status: 'live' });
    assert.equal(pins['esp8266-farfield'].status, 'offline');
  });

  test('a cluster shows its worst member', () => {
    assert.equal(map.worstStatus(['live', 'live']), 'live');
    assert.equal(map.worstStatus(['live', 'stale', 'live']), 'stale');
    assert.equal(map.worstStatus(['stale', 'never']), 'never');
    assert.equal(map.worstStatus(['never', 'offline', 'live']), 'offline');
  });

  test('no project, no pins', () => {
    assert.deepEqual(map.mapPins(null), []);
  });
});

describe('tiles', () => {
  const NSW = { id: 'nsw', name: 'Imagery', url: '/tiles/nsw/{z}/{x}/{y}', attribution: 'NSW',
                bounds: [[-38.4, 138.4], [-26.5, 159.3]], minzoom: 15, maxzoom: 21 };
  const OSM = { id: 'osm', name: 'Map', url: '/tiles/osm/{z}/{x}/{y}', attribution: 'OSM', maxzoom: 19 };

  test('OpenStreetMap unless config says otherwise', () => {
    const [osm, ...rest] = map.mapSources();
    assert.match(osm.url, /tile\.openstreetmap\.org/);
    assert.match(osm.attribution, /OpenStreetMap/);
    assert.equal(osm.name, 'Map');
    assert.deepEqual(rest, []);
  });

  test('config.json can list other sources - an offline Pi serving its own, or imagery', () => {
    core.configSet({ ...config, mapping: { sources: [{ id: 'osm', name: 'Map', url: '/tiles/osm/{z}/{x}/{y}' }, NSW] } });
    const sources = map.mapSources();
    assert.deepEqual(sources.map((s) => s.url), ['/tiles/osm/{z}/{x}/{y}', '/tiles/nsw/{z}/{x}/{y}']);
    assert.equal(sources[0].maxzoom, 19, 'what it does not say keeps its default');
    core.configSet(config);
  });

  test('one switch per name, so sources sharing a name switch together', () => {
    assert.deepEqual(map.mapLayerNames([OSM]), [], 'nothing to switch to');
    assert.deepEqual(map.mapLayerNames([OSM, NSW, { ...NSW, id: 'vic' }]), ['Imagery']);
  });

  // Enough of Leaflet to see which layers end up on the map, and with what options
  function fakeLeaflet() {
    const onMap = new Set();
    const L = {
      Util: { extend: Object.assign, template: (u) => u },
      latLngBounds: (b) => ({ bounds: b }),
      TileLayer: { extend: (proto) => Object.assign(function Layer(url, options) { this._url = url; this.options = options; },
        { prototype: { ...proto, addTo(m) { onMap.add(this); return this; } } }) },
      layerGroup: () => ({ layers: [], addLayer(l) { this.layers.push(l); return this; },
        addTo() { onMap.add(this); return this; }, remove() { onMap.delete(this); return this; } }),
    };
    return { L, onMap };
  }
  // Views as Leaflet reports them: the farm in NSW, close and far, and Jakarta
  const LOTUS = { south: -33.9, west: 151.2, north: -33.8, east: 151.3 };
  const JAKARTA = { south: -6.3, west: 106.7, north: -6.1, east: 106.9 };
  function fakeMap(view, zoom) {
    const handlers = {};
    return {
      view, zoom,
      on(ev, fn) { handlers[ev] = fn; },
      getBounds() { const v = this.view; return { getSouth: () => v.south, getWest: () => v.west, getNorth: () => v.north, getEast: () => v.east }; },
      getZoom() { return this.zoom; },
      moveTo(view, zoom) { this.view = view; this.zoom = zoom; handlers.moveend(); },
    };
  }
  const withSources = (sources, view = LOTUS, zoom = 16) => {
    const { projectMt } = mock.runScenario('located-devices');
    const mapEl = document.createElement('mqtt-map');
    document.body.append(mapEl);
    mapEl.setProject(projectMt);
    const { L, onMap } = fakeLeaflet();
    mapEl.state.map = fakeMap(view, zoom);
    mapEl.addSources(L, mapEl.state.map, sources);
    return { mapEl, projectMt, onMap, button: mapEl.querySelector('.fi-map__layer') };
  };

  test('the map underneath, enlarged past its depth where imagery goes deeper', () => {
    const { mapEl, onMap, button } = withSources([OSM, NSW]);
    const [base] = [...onMap];
    assert.equal(onMap.size, 1, 'imagery is off until chosen');
    assert.equal(base._url, OSM.url);
    assert.deepEqual([base.options.maxNativeZoom, base.options.maxZoom], [19, 21]);
    assert.equal(button.textContent, 'Imagery');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    mapEl.remove();
  });

  test('imagery only inside its bounds and zooms, switched on and off, and remembered', () => {
    const { mapEl, projectMt, onMap, button } = withSources([OSM, NSW]);
    button.click();
    const group = [...onMap].find((l) => l.layers);
    assert.ok(group, 'on the map');
    assert.deepEqual(group.layers[0].options, { attribution: 'NSW', minZoom: 15, maxZoom: 21, bounds: { bounds: NSW.bounds } });
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(map.mapPrefsLoad(projectMt).layers, { Imagery: true });
    button.click();
    assert.equal(onMap.has(group), false);
    assert.deepEqual(map.mapPrefsLoad(projectMt).layers, { Imagery: false });
    mapEl.remove();
  });

  test('a project opens with the layers it last had', () => {
    const { projectMt } = mock.runScenario('located-devices');
    map.mapPrefsSave(projectMt, { open: false, height: 320, layers: { Imagery: true } });
    const { mapEl, onMap, button } = withSources([OSM, NSW]);
    assert.ok([...onMap].some((l) => l.layers));
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    mapEl.remove();
  });

  test('moving to another project takes up that project\'s choice', () => {
    const { mapEl, onMap, button } = withSources([OSM, NSW]);
    button.click();
    const { organizationMt } = mock.runOrganization('located-organization');
    mapEl.setProject(organizationMt);
    assert.equal([...onMap].some((l) => l.layers), false, 'the organization map has not chosen imagery');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    mapEl.remove();
    core.mqtt_unsubscribe_organization('dev');
  });

  test('the switch only where it would show something', () => {
    assert.equal(map.layerAvailability([OSM, NSW], 'Imagery', JAKARTA, 16), 'hidden');
    assert.equal(map.layerAvailability([OSM, NSW], 'Imagery', LOTUS, 12), 'zoom');
    assert.equal(map.layerAvailability([OSM, NSW], 'Imagery', LOTUS, 15), 'ready');
    const world = { south: -80, west: -180, north: 80, east: 180 };
    assert.equal(map.layerAvailability([OSM, NSW], 'Imagery', world, 2), 'zoom', 'a view that takes in NSW');
    assert.equal(map.layerAvailability([OSM, { ...NSW, bounds: undefined }], 'Imagery', JAKARTA, 16), 'ready');
  });

  test('and follows the map as it moves - the choice made stays made', () => {
    const { mapEl, button } = withSources([OSM, NSW], JAKARTA, 16);
    assert.equal(button.hidden, true, 'over Indonesia');
    mapEl.state.map.moveTo(LOTUS, 12);
    assert.deepEqual([button.hidden, button.disabled, button.title], [false, true, 'Zoom in']);
    mapEl.state.map.moveTo(LOTUS, 16);
    assert.deepEqual([button.hidden, button.disabled, button.title], [false, false, '']);
    button.click();
    mapEl.state.map.moveTo(JAKARTA, 16);
    assert.equal(button.hidden, true);
    mapEl.state.map.moveTo(LOTUS, 16);
    assert.equal(button.getAttribute('aria-pressed'), 'true', 'still on when it comes back');
    mapEl.remove();
  });

  test('no switch when there is only the map', () => {
    const { mapEl } = withSources([OSM]);
    assert.equal(mapEl.querySelector('.fi-map__layer'), null);
    mapEl.remove();
  });
});

describe('past what is kept, an ancestor enlarged', () => {
  test('the parent, the grandparent, and which part of each', () => {
    assert.deepEqual(map.ancestorTile({ x: 13001, y: 8451, z: 15 }, 1), { x: 6500, y: 4225, z: 14, scale: 2, dx: 1, dy: 1 });
    assert.deepEqual(map.ancestorTile({ x: 13001, y: 8451, z: 15 }, 2), { x: 3250, y: 2112, z: 13, scale: 4, dx: 1, dy: 3 });
    assert.deepEqual(map.ancestorTile({ x: 5, y: 9, z: 4 }, 0), { x: 5, y: 9, z: 4, scale: 1, dx: 0, dy: 0 });
  });

  // Enough of Leaflet for the layer: extend, the URL template, and what TileLayer would supply
  const L = {
    Util: {
      extend: Object.assign,
      template: (url, d) => url.replace(/\{(\w+)\}/g, (m, k) => d[k]),
    },
    TileLayer: { extend: (proto) => Object.assign(function Layer(url, options) { this._url = url; this.options = options; },
      { prototype: { ...proto, getTileSize: () => ({ x: 256, y: 256 }), _getSubdomain: () => '' } }) },
  };
  const layer = () => { const Layer = map.fallbackTileLayer(L); return new Layer('/tiles/osm/{z}/{x}/{y}.png', {}); };
  const fail = (tile) => tile.querySelector('img').dispatchEvent(new Event('error'));

  test('a kept tile is itself, unscaled', () => {
    let result;
    const tile = layer().createTile({ x: 13001, y: 8451, z: 15 }, (err, t) => { result = { err, t }; });
    const img = tile.querySelector('img');
    assert.equal(img.getAttribute('src'), '/tiles/osm/15/13001/8451.png');
    assert.equal(img.style.width, '256px');
    img.dispatchEvent(new Event('load'));
    assert.equal(result.err, null);
    assert.equal(result.t, tile);
  });

  test('a missing one becomes its parent\'s quarter, twice the size, then the grandparent\'s', () => {
    const tile = layer().createTile({ x: 13001, y: 8451, z: 15 }, () => {});
    fail(tile);
    let img = tile.querySelector('img');
    assert.equal(img.getAttribute('src'), '/tiles/osm/14/6500/4225.png');
    assert.deepEqual([img.style.width, img.style.left, img.style.top], ['512px', '-256px', '-256px']);
    fail(tile);
    img = tile.querySelector('img');
    assert.equal(img.getAttribute('src'), '/tiles/osm/13/3250/2112.png');
    assert.deepEqual([img.style.width, img.style.left, img.style.top], ['1024px', '-256px', '-768px']);
    assert.equal(tile.querySelectorAll('img').length, 1, 'one image at a time');
    assert.equal(tile.style.overflow, 'hidden', 'only this tile\'s part shows');
  });

  test('and never below the source\'s own minzoom, where it has nothing', () => {
    let err;
    const Layer = map.fallbackTileLayer(L);
    const tile = new Layer('/tiles/nsw/{z}/{x}/{y}', { minZoom: 15 }).createTile({ x: 60000, y: 39000, z: 16 }, (e) => { err = e; });
    fail(tile);
    assert.match(tile.querySelector('img').getAttribute('src'), /^\/tiles\/nsw\/15\//);
    fail(tile);
    assert.ok(err);
  });

  test('and gives up - at the top of the world, or once it would be too blurred to help', () => {
    let err;
    const top = layer().createTile({ x: 1, y: 0, z: 1 }, (e) => { err = e; });
    fail(top);
    assert.equal(top.querySelector('img').getAttribute('src'), '/tiles/osm/0/0/0.png');
    fail(top);
    assert.ok(err, 'nothing above zoom 0');
    err = undefined;
    const deep = layer().createTile({ x: 13001, y: 8451, z: 15 }, (e) => { err = e; });
    for (let i = 0; i < 8; i++) fail(deep);
    assert.equal(deep.querySelector('img').getAttribute('src'), '/tiles/osm/7/50/33.png');
    assert.equal(err, undefined);
    fail(deep);
    assert.ok(err);
  });
});

describe('remembered per project', () => {
  test('open and height round-trip', () => {
    const { projectMt } = mock.runScenario('located-devices');
    map.mapPrefsSave(projectMt, { open: true, height: 450 });
    assert.deepEqual(map.mapPrefsLoad(projectMt), { open: true, height: 450 });
  });

  test('nothing stored, or something garbled, is closed at the default height', () => {
    const { projectMt } = mock.runScenario('located-devices');
    assert.equal(map.mapPrefsLoad(projectMt).open, false);
    localStorage.setItem('frugaliot:map:v1:dev/lotus', '{not json');
    assert.equal(map.mapPrefsLoad(projectMt).open, false);
  });

  test('a height too small to use is raised to the minimum', () => {
    const { projectMt } = mock.runScenario('located-devices');
    map.mapPrefsSave(projectMt, { open: true, height: 5 });
    assert.ok(map.mapPrefsLoad(projectMt).height >= 100);
  });
});

describe('on the page', () => {
  test('no map button when no device has a location', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, mock.runScenario('one-device').projectMt);
    assert.equal(page.querySelector('.fi-header__map .fi-btn'), null);
    assert.equal(page.querySelector('mqtt-map').style.display, 'none');
    page.remove();
  });

  test('the button appears with the first location, which changes no topic list', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, mock.runScenario('one-device').projectMt);
    mock.deliver('dev/lotus/esp8266-fb94bb/frugal_iot/location', '-6.2088,106.8456');
    assert.ok(page.querySelector('.fi-header__map .fi-btn'), 'groupchanged should have offered the map');
    page.remove();
  });

  test('the button opens and closes the map, and it is remembered', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    const { projectMt } = mock.runScenario('located-devices');
    showProject(page, projectMt);
    const mapEl = page.querySelector('mqtt-map');
    assert.equal(mapEl.hidden, true, 'closed until asked for');
    page.querySelector('.fi-header__map .fi-btn').click();
    assert.equal(mapEl.hidden, false);
    assert.equal(map.mapPrefsLoad(projectMt).open, true);
    page.querySelector('.fi-header__map .fi-btn').click();
    assert.equal(mapEl.hidden, true);
    assert.equal(map.mapPrefsLoad(projectMt).open, false);
    page.remove();
  });

  test('a map left open comes back open', () => {
    const { projectMt } = mock.runScenario('located-devices');
    map.mapPrefsSave(projectMt, { open: true, height: 400 });
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, projectMt);
    const mapEl = page.querySelector('mqtt-map');
    assert.equal(mapEl.hidden, false);
    assert.equal(mapEl.style.height, '400px');
    page.remove();
  });

  test('the map survives devices arriving, which rebuild the body', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    const { projectMt } = mock.runScenario('located-devices');
    showProject(page, projectMt);
    const mapEl = page.querySelector('mqtt-map');
    document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: projectMt } }));
    assert.equal(page.querySelector('mqtt-map'), mapEl);
    page.remove();
  });

  test('the map is not on the project back', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, mock.runScenario('located-devices').projectMt);
    page.querySelector('.fi-header__gear .fi-btn').click();
    assert.equal(page.querySelector('mqtt-map').style.display, 'none');
    assert.equal(page.querySelector('.fi-header__map .fi-btn'), null);
    page.remove();
  });

  test('Open card on a pin opens that card on its front', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, mock.runScenario('located-devices').projectMt);
    const card = [...page.querySelectorAll('mqtt-devicecard')].find((c) => c.mt.nodeId === 'esp8266-pump');
    assert.equal(card.mode, 'summary');
    document.dispatchEvent(new CustomEvent('frugaliot:cardopen', { detail: { nodeId: 'esp8266-pump' } }));
    assert.equal(card.mode, 'front');
    page.remove();
  });

  test('a card already showing its back is left on its back', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, mock.runScenario('located-devices').projectMt);
    const card = [...page.querySelectorAll('mqtt-devicecard')].find((c) => c.mt.nodeId === 'esp8266-pump');
    card.mode = 'back';
    document.dispatchEvent(new CustomEvent('frugaliot:cardopen', { detail: { nodeId: 'esp8266-pump' } }));
    assert.equal(card.mode, 'back');
    page.remove();
  });
});

// Pick mode: the back's 📍 hands the device to the project's map. Placing the pin is Leaflet's, and
// needs a browser; everything either side of it - which device, what is published, Pending - is here.
describe('setting a location', () => {
  let sent;
  beforeEach(() => {
    sent = [];
    core.setMqttClient({ connected: false, publish: (topic, payload, opts) => sent.push([topic, payload, opts]) });
  });
  const pageWithBack = (nodeId) => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    const { projectMt } = mock.runScenario('located-devices');
    showProject(page, projectMt);
    const card = [...page.querySelectorAll('mqtt-devicecard')].find((c) => c.mt.nodeId === nodeId);
    card.mode = 'back';
    return { page, projectMt, card, mapEl: page.querySelector('mqtt-map') };
  };
  const locationRow = (card) => card.querySelector('.fi-location');

  test('the back says where it is, and offers 📍', () => {
    const { page, card } = pageWithBack('esp8266-north');
    assert.match(locationRow(card).textContent, /-6\.20880, 106\.84560/);
    assert.ok(locationRow(card).querySelector('.fi-location__pick'));
    page.remove();
  });

  test('not set is said, and can be set', () => {
    const { page, card } = pageWithBack('esp8266-workbench');
    assert.match(locationRow(card).textContent, /Not set/);
    assert.ok(locationRow(card).querySelector('.fi-location__pick'));
    page.remove();
  });

  test('a GPS fix is shown as from GPS, with nothing to set', () => {
    const { page, card } = pageWithBack('esp32-tractor');
    assert.match(locationRow(card).textContent, /-6\.21500, 106\.84200.*From GPS/);
    assert.equal(locationRow(card).querySelector('.fi-location__pick'), null);
    page.remove();
  });

  test('without WRITE it is shown, not offered', () => {
    mock.loadConfig({ ...config, user: { id: 2, name: 'test', permissions: [{ org: 'dev', capability: 'READ' }] } });
    const { page, card } = pageWithBack('esp8266-north');
    assert.match(locationRow(card).textContent, /-6\.20880/);
    assert.equal(locationRow(card).querySelector('.fi-location__pick'), null);
    page.remove();
    mock.loadConfig(config);
  });

  test('📍 opens the project map picking that device', () => {
    const { page, card, mapEl } = pageWithBack('esp8266-north');
    locationRow(card).querySelector('.fi-location__pick').click();
    assert.equal(mapEl.isPicking, true);
    assert.equal(mapEl.hidden, false);
    assert.equal(mapEl.querySelector('.fi-map__pick').hidden, false);
    assert.equal(mapEl.querySelector('.fi-map__pickname').textContent, card.mt.usableName);
    assert.equal(mapEl.querySelector('.fi-map__save').disabled, false, 'it already has a place to save');
    assert.equal(card.mode, 'back', 'picking does not flip the card');
    page.remove();
  });

  test('Save publishes lat,lon to the set path, and it is Pending until the node echoes', () => {
    const { page, card, mapEl } = pageWithBack('esp8266-north');
    locationRow(card).querySelector('.fi-location__pick').click();
    mapEl.querySelector('.fi-map__save').click();
    assert.deepEqual(sent.map(([t, p]) => [t, p]), [['dev/lotus/esp8266-north/set/frugal_iot/location', '-6.208800,106.845600']]);
    assert.equal(sent[0][2].qos, 1, 'a node asleep gets it when it wakes');
    assert.equal(mapEl.isPicking, false);
    assert.equal(mapEl.hidden, true, 'closed again, as it was before');
    assert.match(locationRow(card).textContent, /Pending/);
    // Our own set comes back to us - the node has still said nothing
    mock.deliver('dev/lotus/esp8266-north/set/frugal_iot/location', '-6.208800,106.845600');
    assert.match(locationRow(card).textContent, /Pending/);
    mock.deliver('dev/lotus/esp8266-north/frugal_iot/location', '-6.208800,106.845600');
    assert.doesNotMatch(locationRow(card).textContent, /Pending/);
    assert.equal(card.mode, 'back', 'back to the card, still on its back');
    page.remove();
  });

  test('Clear publishes empty, and the echo takes the pin away', () => {
    const { page, projectMt, card, mapEl } = pageWithBack('esp8266-north');
    locationRow(card).querySelector('.fi-location__pick').click();
    mapEl.querySelector('.fi-map__pick button:nth-of-type(2)').click();  // Clear
    assert.deepEqual(sent.map(([t, p]) => [t, p]), [['dev/lotus/esp8266-north/set/frugal_iot/location', '']]);
    mock.deliver('dev/lotus/esp8266-north/frugal_iot/location', '');
    assert.equal(projectMt.nodes['esp8266-north'].location, null);
    assert.match(locationRow(card).textContent, /Not set/);
    page.remove();
  });

  test('Cancel, or Escape, publishes nothing', () => {
    const { page, card, mapEl } = pageWithBack('esp8266-north');
    locationRow(card).querySelector('.fi-location__pick').click();
    mapEl.querySelector('.fi-map__pick button:nth-of-type(3)').click();  // Cancel
    assert.equal(mapEl.isPicking, false);
    locationRow(card).querySelector('.fi-location__pick').click();
    mapEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(mapEl.isPicking, false);
    assert.deepEqual(sent, []);
    page.remove();
  });

  test('a map the user had open stays open afterwards', () => {
    const { page, card, mapEl } = pageWithBack('esp8266-north');
    page.querySelector('.fi-header__map .fi-btn').click();
    locationRow(card).querySelector('.fi-location__pick').click();
    mapEl.querySelector('.fi-map__pick button:nth-of-type(3)').click();
    assert.equal(mapEl.hidden, false);
    page.remove();
  });

  test('the first location in a project: the map appears to pick it, and goes if cancelled', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    showProject(page, mock.runScenario('one-device').projectMt);
    const mapEl = page.querySelector('mqtt-map');
    const card = page.querySelector('mqtt-devicecard');
    card.mode = 'back';
    locationRow(card).querySelector('.fi-location__pick').click();
    assert.notEqual(mapEl.style.display, 'none', 'shown while picking - it has Cancel, so it is never stranded');
    assert.equal(mapEl.querySelector('.fi-map__save').disabled, true, 'nothing to save until the map is tapped');
    assert.equal(mapEl.querySelector('.fi-map__hint').hidden, false);
    assert.equal(mapEl.querySelector('.fi-map__pick button:nth-of-type(2)').hidden, true, 'nothing to clear');
    mapEl.querySelector('.fi-map__pick button:nth-of-type(3)').click();
    assert.equal(mapEl.style.display, 'none');
    page.remove();
  });

  test("I'm here needs a secure context - plain HTTP on a Pi has no geolocation", () => {
    assert.equal(map.canLocate(), false);  // jsdom is not a secure context
    const { page, card, mapEl } = pageWithBack('esp8266-north');
    locationRow(card).querySelector('.fi-location__pick').click();
    assert.equal(mapEl.querySelector('.fi-map__pick button:nth-of-type(1)').hidden, true);
    page.remove();
  });
});

// ML-4: hovering a card lights its pin, and a pin its card. One event, either way.
describe('card and pin light each other', () => {
  const page = () => {
    const pageEl = document.createElement('mqtt-dashboard');
    document.body.append(pageEl);
    showProject(pageEl, mock.runScenario('located-devices').projectMt);
    const cards = [...pageEl.querySelectorAll('mqtt-devicecard')];
    return { pageEl, cards, card: (id) => cards.find((c) => c.mt.nodeId === id), mapEl: pageEl.querySelector('mqtt-map') };
  };
  const heard = () => {
    const seen = [];
    const listen = (e) => seen.push(e.detail.nodeId);
    document.addEventListener('frugaliot:highlight', listen);
    return { seen, stop: () => document.removeEventListener('frugaliot:highlight', listen) };
  };

  test('a mouse over a card names it, and leaving clears it', () => {
    const { pageEl, card } = page();
    const h = heard();
    card('esp8266-pump').dispatchEvent(new MouseEvent('pointerenter'));
    card('esp8266-pump').dispatchEvent(new MouseEvent('pointerleave'));
    h.stop();
    assert.deepEqual(h.seen, ['esp8266-pump', null]);
    pageEl.remove();
  });

  test('so does keyboard focus, from anywhere inside the card', () => {
    const { pageEl, card } = page();
    const h = heard();
    card('esp8266-north').firstElementChild.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    h.stop();
    assert.deepEqual(h.seen, ['esp8266-north']);
    pageEl.remove();
  });

  test('not on touch - a tap already opens the card', () => {
    const { pageEl, card } = page();
    const h = heard();
    const tap = new MouseEvent('pointerenter');
    Object.defineProperty(tap, 'pointerType', { value: 'touch' });  // jsdom has no PointerEvent
    card('esp8266-pump').dispatchEvent(tap);
    h.stop();
    assert.deepEqual(h.seen, []);
    pageEl.remove();
  });

  test('a pin lights its card, one at a time', () => {
    const { pageEl, card, cards } = page();
    const light = (nodeId) => document.dispatchEvent(new CustomEvent('frugaliot:highlight', { detail: { nodeId } }));
    light('esp8266-pump');
    assert.deepEqual(cards.filter((c) => c.classList.contains('fi-highlight')), [card('esp8266-pump')]);
    light('esp8266-north');
    assert.deepEqual(cards.filter((c) => c.classList.contains('fi-highlight')), [card('esp8266-north')]);
    light(null);
    assert.equal(cards.filter((c) => c.classList.contains('fi-highlight')).length, 0);
    pageEl.remove();
  });

  // Leaflet does not run here, so its two calls are stood in for: where a marker's icon is, and
  // which cluster hides it at this zoom
  test('a card lights its pin - or the cluster it is hidden in', () => {
    const { pageEl, mapEl } = page();
    mapEl.hidden = false;
    const pinEl = document.createElement('div');
    const clusterEl = document.createElement('div');
    const alone = { getElement: () => pinEl };
    const clustered = { getElement: () => null };
    const clusterMarker = { getElement: () => clusterEl };
    mapEl.state.markers.set('esp8266-pump', alone);
    mapEl.state.markers.set('esp8266-north', clustered);
    mapEl.state.cluster = { getVisibleParent: (m) => ((m === clustered) ? clusterMarker : m) };
    const light = (nodeId) => document.dispatchEvent(new CustomEvent('frugaliot:highlight', { detail: { nodeId } }));
    light('esp8266-pump');
    assert.ok(pinEl.classList.contains('fi-pin-icon--highlight'));
    light('esp8266-north');
    assert.ok(!pinEl.classList.contains('fi-pin-icon--highlight'), 'the last one goes out');
    assert.ok(clusterEl.classList.contains('fi-pin-icon--highlight'));
    light(null);
    assert.ok(!clusterEl.classList.contains('fi-pin-icon--highlight'));
    mapEl.state.cluster = null;
    mapEl.state.markers.clear();
    pageEl.remove();
  });
});
