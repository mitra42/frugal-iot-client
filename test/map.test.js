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
