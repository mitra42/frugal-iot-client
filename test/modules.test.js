// The point of the split (CARDS_PLAN.md phase 3) is that a page can import less than everything.
// These tests fail if a later edit reintroduces a dependency that takes that away.
import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const importsOf = (f) => [...read(f).matchAll(/^import [^\n]*from '\.\/([a-z]+)\.js'/gm)].map((m) => m[1]);

describe('the module graph stays a DAG', () => {
  test('core imports none of the other modules', () => {
    assert.deepEqual(importsOf('core.js'), []);
  });
  test('widgets needs only core', () => {
    assert.deepEqual(importsOf('widgets.js').sort(), ['core']);
  });
  test('graph and nodeview need only core and widgets', () => {
    assert.deepEqual(importsOf('graph.js').sort(), ['core', 'widgets']);
    assert.deepEqual(importsOf('nodeview.js').sort(), ['core', 'widgets']);
  });
  test('admin and flash need only core', () => {
    assert.deepEqual(importsOf('admin.js').sort(), ['core']);
    assert.deepEqual(importsOf('flash.js').sort(), ['core']);
  });
  test('core reaches the display elements by tag name, never by importing them', () => {
    // The rule that keeps core loadable alone - see CARDS_PLAN.md section 3.2
    assert.match(read('core.js'), /el\('mqtt-bar'/);
    assert.doesNotMatch(read('core.js'), /from '\.\/widgets\.js'/);
  });
});

describe('a page can load less than everything', () => {
  test('core alone builds a data tree, with no elements registered by it', async () => {
    const core = await import('../core.js');
    assert.ok(core.MqttTopicProject && core.mqtt_deliver && core.el);
    // core does register its own few elements, but none of the display widgets
    assert.equal(customElements.get('mqtt-bar'), undefined, 'widgets must not be pulled in by core');
    assert.equal(customElements.get('mqtt-graph'), undefined, 'graph must not be pulled in by core');
  });

  test('core + widgets is enough for a standalone mqtt-bar, as index-embedded.html does', async () => {
    await import('../widgets.js');
    assert.ok(customElements.get('mqtt-bar'));
    assert.equal(customElements.get('mqtt-graph'), undefined, 'still no chart.js');
    assert.equal(customElements.get('mqtt-node'), undefined, 'still no node UI');
  });
});
