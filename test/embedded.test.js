// index-embedded.html: widgets given a full topic path on a page with no mqtt-wrapper, no discovery
// tree and no server config. This broke twice unnoticed - once when createTopic() started requiring
// the tree, once when topicPath moved from node.mt to nodeMt - because nothing else exercises it.
import '../test/setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

let core;
before(async () => {
  core = await import('../core.js');
  await import('../widgets.js');
  await import('../graph.js');
});

describe('embedded widgets', () => {
  test('a bar binds itself and shows what arrives', () => {
    document.body.innerHTML =
      '<div><mqtt-bar max="45" min="0" topic="dev/lotus/esp32-784702/sht/temperature" label="Temperature" type="float" color="red"></mqtt-bar></div>';
    const bar = document.querySelector('mqtt-bar');
    assert.ok(bar.mt, 'bound without a wrapper to look in');
    assert.equal(bar.mt.topicPath, 'dev/lotus/esp32-784702/sht/temperature');
    assert.equal(bar.mt.topicSetPath, 'dev/lotus/esp32-784702/set/sht/temperature');
    assert.equal(bar.mt.groupMt, undefined); // No tree, so no group to roll up into
    core.mqtt_deliver('dev/lotus/esp32-784702/sht/temperature', '21.5');
    assert.equal(bar.mt.state.value, 21.5);
    assert.match(bar.shadowRoot.innerHTML, /21\.5/);
  });

  test('a toggle is writable - there is no permission list, only the broker credentials', () => {
    document.body.innerHTML =
      '<div><mqtt-toggle topic="dev/lotus/esp32-784702/ledbuiltin/on" label="LED" type="bool" color="blue"></mqtt-toggle></div>';
    const toggle = document.querySelector('mqtt-toggle');
    assert.equal(toggle.mt.canWrite, true);
    core.mqtt_deliver('dev/lotus/esp32-784702/ledbuiltin/on', 'true');
    const input = toggle.shadowRoot.querySelector('input[type=checkbox]');
    assert.ok(input, 'an input, not a read-only value');
    assert.equal(input.checked, true);
  });

  test('a graphdataset subscribes to the full path, not the twig', () => {
    document.body.innerHTML =
      '<mqtt-graph><mqtt-graphdataset topic="dev/lotus/esp32-784702/sht/temperature" color="red" label="Office Temperature" min=0 max=50 type="float"></mqtt-graphdataset></mqtt-graph>';
    const ds = document.querySelector('mqtt-graphdataset');
    assert.ok(ds.mt, 'made its own topic');
    assert.equal(ds.mt.topicPath, 'dev/lotus/esp32-784702/sht/temperature');
    assert.equal(ds.chartdataset.data, ds.mt.data, 'the chart line reads the topic history');
    // Not delivering a message here: dataChanged() calls chart.update(), and Chart.js cannot
    // measure text without a canvas, which jsdom does not have.
  });
});
