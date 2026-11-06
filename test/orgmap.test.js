// The organization map (MAPPING_PLAN.md M-12 to M-18): a slim tree of every project's locations, on
// the page between choosing an organization and choosing a project. As with the project map, the
// drawing is Leaflet's and needs a browser; what it is given, and where its popup leads, is here.
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock, core;

before(async () => {
  mock = await import('./mock.js');
  core = await import('../core.js');
  await import('../widgets.js');
  await import('../cards.js');
  mock.loadConfig(config);
});
beforeEach(() => { mock.setNow(null); localStorage.clear(); mock.loadConfig(config); });

const withPermissions = (permissions) => mock.loadConfig({ ...config, user: { id: 2, name: 'test', permissions } });

describe('topic matching', () => {
  test('+ is exactly one level, anywhere', () => {
    assert.ok(core.topicMatches('dev/+/+/frugal_iot/#', 'dev/lotus/esp8266-north/frugal_iot/location'));
    assert.ok(core.topicMatches('dev/+/+/gps/latitude', 'dev/ricefield/esp32-tractor/gps/latitude'));
    assert.ok(!core.topicMatches('dev/+/+/gps/latitude', 'dev/lotus/esp32-tractor/gps/speed'));
    assert.ok(!core.topicMatches('dev/+/+/frugal_iot/#', 'dev/lotus/esp8266-north/set/frugal_iot/location'),
      'a set is not the node saying where it is');
    assert.ok(!core.topicMatches('dev/+', 'dev/lotus/esp8266-north'));
  });

  test('# is what it always was: the level itself and anything below', () => {
    assert.ok(core.topicMatches('dev/lotus/esp8266-north/#', 'dev/lotus/esp8266-north'));
    assert.ok(core.topicMatches('dev/lotus/esp8266-north/#', 'dev/lotus/esp8266-north/sht/temperature'));
    assert.ok(!core.topicMatches('dev/lotus/esp8266-north/#', 'dev/lotus/esp8266-northwest/sht/temperature'));
    assert.ok(core.topicMatches('dev/lotus', 'dev/lotus'));
    assert.ok(!core.topicMatches('dev/lotus', 'dev/lotus/esp8266-north'));
  });
});

describe('only for READ on the whole organization', () => {
  test('an organization-wide grant counts', () => {
    assert.equal(core.hasOrganizationCapability('dev', 'READ'), true);
  });

  test('READ on every project of it does not - the broker would refuse the wildcard', () => {
    withPermissions([{ org: 'dev', capability: 'READ', project: 'lotus' }, { org: 'dev', capability: 'READ', project: 'ricefield' }]);
    assert.equal(core.hasOrganizationCapability('dev', 'READ'), false);
    assert.equal(core.hasCapability('dev', 'READ'), true, 'which is why hasCapability could not be the test');
  });

  test('the wrapper builds no organization tree without it', () => {
    withPermissions([{ org: 'dev', capability: 'READ', project: 'lotus' }]);
    const announced = [];
    const listen = (e) => announced.push(e.detail.organizationMt);
    document.addEventListener('frugaliot:organizationtree', listen);
    const w = document.createElement('mqtt-wrapper');
    w.setAttribute('organization', 'dev');
    w.appender();   // as the lastseen tests do: connectedCallback would fetch /config.json
    document.removeEventListener('frugaliot:organizationtree', listen);
    assert.equal(w.organizationMt, null);
    assert.deepEqual(announced, []);
  });

  test('and with it, builds one and says so', () => {
    core.mqtt_unsubscribe_organization('dev');
    const announced = [];
    const listen = (e) => announced.push(e.detail.organizationMt);
    document.addEventListener('frugaliot:organizationtree', listen);
    const w = document.createElement('mqtt-wrapper');
    w.setAttribute('organization', 'dev');
    w.appender();
    document.removeEventListener('frugaliot:organizationtree', listen);
    assert.ok(w.organizationMt);
    assert.deepEqual(announced, [w.organizationMt]);
    w.dropOrganizationTree();
    core.mqtt_unsubscribe_organization('dev');
  });
});

describe('the organization tree', () => {
  test('locations from every project, GPS still winning', () => {
    const { organizationMt } = mock.runOrganization('located-organization');
    assert.deepEqual(Object.keys(organizationMt.projects).sort(), ['lotus', 'ricefield']);
    assert.equal(organizationMt.locatedNodes.length, 8);
    assert.deepEqual(organizationMt.nodes['esp32-tractor'].location, { lat: -6.215, lon: 106.842, source: 'gps' });
    assert.equal(organizationMt.nodes['esp8266-paddy1'].usableName, 'Paddy 1');
    assert.deepEqual(organizationMt.locationBounds, { south: -6.597, west: 106.79, north: -6.2088, east: 106.86 });
  });

  test('only what it subscribed to - no readings', () => {
    const { organizationMt } = mock.runOrganization('located-organization');
    const paddy = organizationMt.nodes['esp8266-paddy1'];
    assert.equal(paddy.groups.sht, undefined, 'the scenario sent sht readings; this tree never asked for them');
    assert.deepEqual(organizationMt.subscriptionPaths,
      ['dev/+/+/frugal_iot/#', 'dev/+/+/gps/latitude', 'dev/+/+/gps/longitude', 'dev/+/+/gps/satellites']);
  });

  test('dropping it stops it hearing anything', () => {
    const { organizationMt } = mock.runOrganization('located-organization');
    organizationMt.unsubscribe();
    mock.deliver('dev/ricefield/esp8266-paddy1/frugal_iot/location', '-7,107');
    assert.equal(organizationMt.nodes['esp8266-paddy1'].location.lat, -6.595);
  });

  test('status comes from lastseen, and a reload re-seeds it', () => {
    const AN_HOUR = 60 * 60 * 1000;
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.organizations.dev.projects.lotus.nodes = { 'esp8266-quiet': { lastseen: new Date(Date.now() - AN_HOUR).toISOString() } };
    mock.loadConfig(cfg);
    core.mqtt_unsubscribe_organization('dev');
    const organizationMt = new core.MqttTopicOrganization('dev');
    organizationMt.subscribe();
    core.mqtt_deliver('dev/lotus/esp8266-quiet/frugal_iot/location', '-6.2,106.8', true);  // retained: not contact
    const quiet = organizationMt.nodes['esp8266-quiet'];
    assert.equal(quiet.status, 'offline');
    cfg.organizations.dev.projects.lotus.nodes['esp8266-quiet'].lastseen = new Date().toISOString();
    organizationMt.seed(quiet, cfg);
    assert.equal(quiet.status, 'live', 'it has been heard from since the page loaded');
    core.mqtt_unsubscribe_organization('dev');
  });
});

describe('on the organization page', () => {
  const orgPage = () => {
    const page = document.createElement('mqtt-dashboard');
    page.setAttribute('organization', 'dev');
    document.body.append(page);
    const { organizationMt } = mock.runOrganization('located-organization');
    document.dispatchEvent(new CustomEvent('frugaliot:organizationtree', { detail: { organizationMt } }));
    return { page, organizationMt, mapEl: page.querySelector('mqtt-map') };
  };

  test('the map is offered, at organization level, with a reload', () => {
    const { page, mapEl } = orgPage();
    assert.ok(page.querySelector('.fi-header__map .fi-btn'));
    assert.equal(mapEl.isOrganization, true);
    assert.equal(mapEl.querySelector('.fi-map__reload').hidden, false);
    page.remove();
  });

  test('the organization tree making projects does not rebuild the page', () => {
    const { page } = orgPage();
    const body = page.querySelector('.fi-body').firstChild;
    mock.deliver('dev/ricefield/esp8266-paddy3/frugal_iot/location', '-6.6,106.8');
    assert.equal(page.querySelector('.fi-body').firstChild, body);
    page.remove();
  });

  test('a pin names its project and goes there, not to a card', () => {
    const { page, mapEl } = orgPage();
    const tip = mapEl.pinContent('esp8266-paddy1', true);
    assert.match(tip.textContent, /Paddy 1.*ricefield.*Open project/);
    assert.equal(tip.querySelector('.fi-chip'), null, 'no readings at this level');
    assert.match(mapEl.pinContent('esp8266-north', false).textContent, /Lotus Ponds/, 'the project by its name');
    page.remove();
  });

  test('no pick mode at organization level', () => {
    const { page, organizationMt, mapEl } = orgPage();
    let how;
    mapEl.pick(organizationMt.nodes['esp8266-north'], (err, h) => { how = h; });
    assert.equal(mapEl.isPicking, false);
    assert.equal(how, 'cancel');
    page.remove();
  });

  test('↻ re-reads, and the pins are redrawn', () => {
    const { page, organizationMt, mapEl } = orgPage();
    let synced = 0;
    organizationMt.reload = (cb) => cb(null);   // the network edge: /config.json, with no server here
    mapEl.sync = () => { synced += 1; };
    mapEl.querySelector('.fi-map__reload').click();
    assert.equal(synced, 1);
    assert.equal(mapEl.querySelector('.fi-map__reload').disabled, false);
    page.remove();
  });

  test('Open project lands on the project, with that card open on its front', () => {
    const { page, mapEl } = orgPage();
    mapEl.pinContent('esp8266-north', true).querySelector('.fi-map__open').click();
    assert.equal(page.querySelector('mqtt-wrapper').organizationMt, null, 'the organization tree is dropped');
    assert.equal(mapEl.isOrganization, false, 'the map is the project\'s now');
    // The device announces itself after the page changed - its card is made already open
    mock.messagesOf('located-devices').forEach(([topic, payload]) => mock.deliver(topic, payload));
    const card = [...page.querySelectorAll('mqtt-devicecard')].find((c) => c.mt.nodeId === 'esp8266-north');
    assert.ok(card, 'the project page lists its devices');
    assert.equal(card.mode, 'front');
    const other = [...page.querySelectorAll('mqtt-devicecard')].find((c) => c.mt.nodeId === 'esp8266-pump');
    assert.equal(other.mode, 'summary', 'only that one');
    page.remove();
    core.mqtt_unsubscribe_organization('dev');
  });
});
