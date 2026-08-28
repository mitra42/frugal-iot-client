// The derived values a card reads (CARDS_PLAN.md phase 4). All of these run with no DOM, which is
// the property that lets the card be built and reviewed without a browser or a broker.
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
const T0 = 1800000000000; // A fixed instant, so nothing here depends on when it is run
let mock, core;

before(async () => {
  mock = await import('./mock.js');
  core = await import('../core.js');
  mock.loadConfig(config);
});
beforeEach(() => mock.setNow(null));

describe('formatting a value', () => {
  test('width turns a raw reading into something readable', () => {
    const { projectMt } = mock.runScenario('one-device');
    const g = projectMt.nodes['esp8266-fb94bb'].groups;
    assert.equal(g.sht.topics.temperature.formatted, '30.1°C');   // arrived as 30.142857
    assert.equal(g.sht.topics.humidity.formatted, '85.1%RH');
  });

  test('a unit that is a word gets a space, a symbol does not', () => {
    const { projectMt } = mock.runScenario('one-device');
    const g = projectMt.nodes['esp8266-fb94bb'].groups;
    assert.equal(g.battery.topics.battery.formatted, '3940 mV');  // int, no decimals
    assert.equal(g.sht.topics.temperature.formatted, '30.1°C');
  });

  test('SenML codes become symbols, and count becomes nothing', () => {
    assert.equal(core.unitSymbol('Cel'), '°C');
    assert.equal(core.unitSymbol('deg'), '°');
    assert.equal(core.unitSymbol('count'), '');
    assert.equal(core.unitSymbol('mV'), 'mV');    // passes through
    assert.equal(core.unitSymbol(undefined), '');
  });

  test('decimals come from the range, so they do not shift as the value moves', () => {
    const { projectMt } = mock.runScenario('one-device');
    const mt = projectMt.nodes['esp8266-fb94bb'].groups.sht.topics.temperature;
    assert.equal(mt.decimals, 1);           // width 4, range 0..50 -> "30.1"
    mt.state.value = 9.87654;
    assert.equal(mt.formatted, '9.9°C');    // still one decimal below ten
  });

  test('a reading outside its range overflows rather than being truncated', () => {
    const { projectMt } = mock.runScenario('out-of-range');
    const mt = projectMt.nodes['esp8266-broken'].groups.sht.topics.temperature;
    assert.equal(mt.outOfRange, true);
    assert.equal(mt.formatted, '-999.0°C'); // wider than width 4 - never lie about the value
  });
});

describe('which devices.yaml entry applies', () => {
  test('an OTA key matches by prefix, so one entry covers every board', () => {
    const { projectMt } = mock.runScenario('one-device');
    const nodeMt = projectMt.nodes['esp8266-fb94bb'];
    assert.equal(nodeMt.otaKey, 'sht30_c3_pico');
    assert.deepEqual(nodeMt.deviceConfig.front, ['sht/temperature', 'sht/humidity', 'controlhysteresis']);
  });

  test('an unmatched OTA key falls back to the defaults', () => {
    const { projectMt } = mock.runScenario('default-front');
    assert.equal(projectMt.nodes['esp8266-two-temps'].deviceConfig, undefined);
  });
});

describe('the front of a card', () => {
  test('a declared list is used in the order it declares', () => {
    const { projectMt } = mock.runScenario('mixed-sensors');
    const rows = projectMt.nodes['esp8266-agri'].frontRows;
    assert.deepEqual(rows.map((r) => r.mt ? `${r.mt.group}/${r.mt.leaf}` : r.groupMt.group),
      ['soil/soil', 'ds18b20/ds18b20', 'sht/temperature', 'sht/humidity']);
  });

  test('a declared row is dropped when this device does not have that module', () => {
    // devices.yaml is keyed by application, so it lists what the application can have. A device
    // whose control never reported - or whose sensor failed to start - must not get an empty row.
    const { projectMt } = mock.runScenario('mixed-sensors');
    const nodeMt = projectMt.nodes['esp8266-agri'];
    assert.ok(nodeMt.deviceConfig.front.includes('controlhysteresis'));
    assert.equal(nodeMt.groups.controlhysteresis, undefined);
    assert.equal(nodeMt.frontRows.some((r) => r.kind === 'control'), false);
  });

  test('with no entry: readings, then actuators, then controls', () => {
    const { projectMt } = mock.runScenario('default-front');
    const rows = projectMt.nodes['esp8266-two-temps'].frontRows;
    const kinds = rows.map((r) => r.kind);
    assert.deepEqual([...new Set(kinds)], ['reading', 'actuator']); // no control in this scenario
    assert.equal(kinds.indexOf('actuator') > kinds.lastIndexOf('reading'), true);
  });

  test('two readings called Temperature are told apart by their module names', () => {
    const { projectMt } = mock.runScenario('default-front');
    const labels = projectMt.nodes['esp8266-two-temps'].frontRows.map((r) => r.label);
    assert.ok(labels.includes('Soil Temperature'), `expected a module name, got ${labels}`);
    assert.ok(!labels.includes('Temperature'), 'the ambiguous label should not survive');
  });

  test('a control shows its output state, from "out" not "on"', () => {
    // controlhysteresis has no "on" leaf - Control_Hysteresis publishes "out". Reading "on" here
    // made this symbol permanently "?".
    const { projectMt } = mock.runScenario('control-wired');
    const groupMt = projectMt.nodes['esp8266-fb94bb'].groups.controlhysteresis;
    assert.equal(groupMt.state.on, undefined, 'there is no "on" leaf to read');
    assert.equal(groupMt.state.out, true);
    assert.match(groupMt.summaryText(), /✓$/);
  });

  test('a control is one row, not one row per setting', () => {
    const { projectMt } = mock.runScenario('control-wired');
    const control = projectMt.nodes['esp8266-fb94bb'].frontRows.filter((r) => r.kind === 'control');
    assert.equal(control.length, 1);
    assert.match(control[0].groupMt.summaryText(), /SHT:Temperature > 32/);
  });

  test('the status strip modules never appear as rows', () => {
    const { projectMt } = mock.runScenario('default-front');
    const groups = projectMt.nodes['esp8266-two-temps'].frontRows.map((r) => (r.mt || r.groupMt).group);
    for (const inside of ['battery', 'ota', 'frugal_iot']) assert.ok(!groups.includes(inside), inside);
  });
});

describe('the summary line', () => {
  test('a declared summary wins', () => {
    const { projectMt } = mock.runScenario('mixed-sensors');
    assert.deepEqual(projectMt.nodes['esp8266-agri'].summaryChips.map((c) => c.text), ['38%', '18.3°C']);
  });

  test('with no summary declared it is the first two of front', () => {
    const { projectMt } = mock.runScenario('one-device');
    assert.deepEqual(projectMt.nodes['esp8266-fb94bb'].summaryChips.map((c) => c.text), ['30.1°C', '85.1%RH']);
  });

  test('with no entry at all it is the modules own summaries, capped at two', () => {
    const { projectMt } = mock.runScenario('default-front');
    const chips = projectMt.nodes['esp8266-two-temps'].summaryChips;
    assert.ok(chips.length <= 2, `${chips.length} chips is a paragraph, not a summary`);
    assert.ok(chips.every((c) => c.text));
  });

  test('a module summary works with no element - the point of moving it to the data tree', () => {
    const { projectMt } = mock.runScenario('control-wired', { headless: true });
    const groups = projectMt.nodes['esp8266-fb94bb'].groups;
    assert.equal(groups.sht.element, undefined, 'headless: there should be no element');
    assert.equal(groups.sht.summaryText(), '30.142857°C 85.1%RH');
    assert.match(groups.controlhysteresis.summaryText(), /^Relay = SHT:Temperature > 32/);
  });

  test('a module with nothing to say contributes nothing', () => {
    const { projectMt } = mock.runScenario('one-device');
    assert.equal(projectMt.nodes['esp8266-fb94bb'].groups.frugal_iot.summaryText(), null);
  });
});

describe('status', () => {
  test('a device that has said nothing is "never", not "offline"', () => {
    const { projectMt } = mock.runScenario('no-readings', { at: T0 });
    // The discovery message reaches the project, not the node, so the node has heard nothing itself
    assert.equal(projectMt.nodes['esp8266-newborn'].status, 'never');
  });

  test('live, then stale, then offline as time passes', () => {
    const { projectMt } = mock.runScenario('one-device', { at: T0 });
    const nodeMt = projectMt.nodes['esp8266-fb94bb'];
    const expected = nodeMt.expectedInterval || core.DEFAULT_REPORT_INTERVAL_MS;
    mock.setNow(T0 + expected);          assert.equal(nodeMt.status, 'live');
    mock.setNow(T0 + expected * 2);      assert.equal(nodeMt.status, 'stale');
    mock.setNow(T0 + expected * 10);     assert.equal(nodeMt.status, 'offline');
  });

  test('age is reported so a card can say how long ago', () => {
    const { projectMt } = mock.runScenario('one-device', { at: T0 });
    mock.setNow(T0 + 90000);
    assert.equal(projectMt.nodes['esp8266-fb94bb'].age, 90000);
  });
});
