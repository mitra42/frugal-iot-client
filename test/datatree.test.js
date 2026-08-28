// Data-tree tests: no rendering, no elements. These are the assertions that survive the card work,
// because they are about what the tree holds, not how it looks.
import '../test/setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock;

before(async () => {
  mock = await import('./mock.js');
  mock.loadConfig(config);
});

describe('discovery', () => {
  test('a node id on the project topic creates a node', () => {
    const { projectMt } = mock.runScenario('one-device');
    assert.deepEqual(Object.keys(projectMt.nodes), ['esp8266-fb94bb']);
  });

  test('a silent device still becomes a node', () => {
    const { projectMt } = mock.runScenario('no-readings');
    assert.equal(Object.keys(projectMt.nodes).length, 1);
    const nodeMt = projectMt.nodes['esp8266-newborn'];
    assert.deepEqual(Object.keys(nodeMt.groups), []);
  });

  test('twelve devices all arrive', () => {
    const { projectMt } = mock.runScenario('twelve-devices');
    assert.equal(Object.keys(projectMt.nodes).length, 12);
  });
});

describe('routing', () => {
  test('values reach the right leaf topic', () => {
    const { projectMt } = mock.runScenario('one-device');
    const nodeMt = projectMt.nodes['esp8266-fb94bb'];
    assert.equal(nodeMt.groups.sht.topics.temperature.state.value, 30.142857);
    assert.equal(nodeMt.groups.sht.topics.humidity.state.value, 85.1);
  });

  test('schema metadata is attached from topics.yaml', () => {
    const { projectMt } = mock.runScenario('one-device');
    const mt = projectMt.nodes['esp8266-fb94bb'].groups.sht.topics.temperature;
    assert.equal(mt.type, 'float');
    assert.equal(mt.display, 'bar');
    assert.equal(mt.min, 0);
    assert.equal(mt.max, 50);
    assert.equal(mt.units, 'Cel');
  });

  test('topicPath and topicSetPath are built from the tree', () => {
    const { projectMt } = mock.runScenario('one-device');
    const mt = projectMt.nodes['esp8266-fb94bb'].groups.sht.topics.temperature;
    assert.equal(mt.topicPath, 'dev/lotus/esp8266-fb94bb/sht/temperature');
    assert.equal(mt.topicSetPath, 'dev/lotus/esp8266-fb94bb/set/sht/temperature');
  });

  test('findTopic normalises the set path back to the read path', () => {
    const { projectMt } = mock.runScenario('one-device');
    const viaRead = projectMt.findTopic('dev/lotus/esp8266-fb94bb/sht/temperature');
    const viaSet = projectMt.findTopic('dev/lotus/esp8266-fb94bb/set/sht/temperature');
    assert.ok(viaRead);
    assert.equal(viaRead, viaSet);
  });
});

describe('naming', () => {
  test('usableName prefers the published name over the node id', () => {
    const { projectMt } = mock.runScenario('one-device');
    const nodeMt = projectMt.nodes['esp8266-fb94bb'];
    assert.equal(nodeMt.groups.frugal_iot.topics.name.state.value, 'Greenhouse North');
  });

  test('a leaf usableName combines group and topic names', () => {
    const { projectMt } = mock.runScenario('one-device');
    const mt = projectMt.nodes['esp8266-fb94bb'].groups.sht.topics.temperature;
    assert.equal(mt.usableName, 'SHT:Temperature');
  });
});

describe('controls and wiring', () => {
  test('a wired control resolves its source topic', () => {
    const { projectMt } = mock.runScenario('control-wired');
    const nodeMt = projectMt.nodes['esp8266-fb94bb'];
    const nowMt = nodeMt.groups.controlhysteresis.topics.now;
    assert.equal(nowMt.wired, 'dev/lotus/esp8266-fb94bb/sht/temperature');
    assert.equal(nowMt.wiredTopic, nodeMt.groups.sht.topics.temperature);
  });

  test('an unwired control has no wiredTopic', () => {
    const { projectMt } = mock.runScenario('control-unwired');
    const nowMt = projectMt.nodes['esp8266-fb94bb'].groups.controlhysteresis?.topics?.now;
    assert.equal(nowMt && nowMt.wiredTopic, undefined);
  });

  test('controlGroups finds the control module', () => {
    const { projectMt } = mock.runScenario('control-wired');
    const nodeMt = projectMt.nodes['esp8266-fb94bb'];
    assert.deepEqual(Object.keys(nodeMt.controlGroups), ['controlhysteresis']);
  });

  test('controlGroupList spans the project', () => {
    const { projectMt } = mock.runScenario('control-wired');
    assert.equal(projectMt.controlGroupList.length, 1);
    assert.equal(projectMt.controlGroupList[0].groupId, 'controlhysteresis');
  });
});

describe('two temperature sources', () => {
  test('both are present under their own modules', () => {
    const { projectMt } = mock.runScenario('mixed-sensors');
    const nodeMt = projectMt.nodes['esp8266-two-temps'];
    assert.equal(nodeMt.groups.sht.topics.temperature.state.value, 30.142857);
    assert.equal(nodeMt.groups.ds18b20.topics.ds18b20.state.value, 18.3);
  });

  test('the module names are what disambiguates them', () => {
    const { projectMt } = mock.runScenario('mixed-sensors');
    const nodeMt = projectMt.nodes['esp8266-two-temps'];
    assert.equal(nodeMt.groups.sht.state.name, 'SHT');
    assert.equal(nodeMt.groups.ds18b20.state.name, 'Soil Temperature');
  });
});
