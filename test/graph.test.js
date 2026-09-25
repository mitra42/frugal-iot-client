// What a graph line is called and what colour it is drawn in. Chart.js cannot draw in jsdom (no
// canvas), so these test the two decisions made before the chart is built.
import '../test/setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock;

before(async () => {
  mock = await import('./mock.js');
  await import('../core.js');
  await import('../graph.js');
  mock.loadConfig(config);
});

describe('a legend entry names the device', () => {
  test('the label a graphdataset is given says which node the reading came from', () => {
    const { projectMt } = mock.runScenario('one-device');
    const mt = projectMt.nodes['esp8266-fb94bb'].groups.sht.topics.temperature;
    // The label createGraph passes; it went through node (the element), absent on the card UI
    assert.equal(mt.fullName, 'Greenhouse North:SHT:Temperature');
  });
});

describe('lines sharing a schema colour are told apart', () => {
  const graph = () => new (customElements.get('mqtt-graph'))();
  const added = (g, baseColor) => {
    const ds = { baseColor };
    g.assignColor(ds);
    g.datasets.push(ds);
    return ds;
  };

  test('the first line keeps its colour, later ones differ from it and each other', () => {
    const g = graph();
    const colors = [0, 1, 2].map(() => added(g, '#008000').borderColor);
    assert.equal(colors[0], '#008000');
    assert.equal(new Set(colors).size, 3);
  });

  test('a different base colour is unaffected by how many share the first', () => {
    const g = graph();
    added(g, '#008000');
    added(g, '#008000');
    assert.equal(added(g, '#0000ff').borderColor, '#0000ff');
  });

  test('removing a line frees its colour for the next one', () => {
    const g = graph();
    added(g, 'brown');
    const second = added(g, 'brown');
    g.datasets.splice(g.datasets.indexOf(second), 1);
    assert.equal(added(g, 'brown').borderColor, second.borderColor);
  });

  test('a fill is the line colour at 30%', () => {
    const g = graph();
    assert.equal(added(g, '#008000').backgroundColor, 'rgba(0, 128, 0, 0.3)');
    assert.match(added(g, '#008000').backgroundColor, /^rgba\(\d+, \d+, \d+, 0\.3\)$/);
  });

  test('black has no hue to rotate, so its variants still differ', () => {
    const g = graph();
    const colors = [0, 1, 2].map(() => added(g, '#000000').borderColor);
    assert.equal(new Set(colors).size, 3);
  });
});
