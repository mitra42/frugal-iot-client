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
  test('OpenStreetMap unless config says otherwise', () => {
    assert.match(map.mapTiles().url, /tile\.openstreetmap\.org/);
    assert.match(map.mapTiles().attribution, /OpenStreetMap/);
  });

  test('config.json can point at other tiles - an offline Pi serving its own', () => {
    core.configSet({ ...config, map: { tiles: { url: '/tiles/{z}/{x}/{y}.png', attribution: 'local' } } });
    assert.equal(map.mapTiles().url, '/tiles/{z}/{x}/{y}.png');
    assert.equal(map.mapTiles().maxZoom, 19, 'what it does not say keeps its default');
    core.configSet(config);
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
