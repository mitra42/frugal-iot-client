// Every registered element must construct, connect and render without throwing.
//
// The other tests do not reach mqtt-admin, mqtt-flash, mqtt-login or mqtt-graph, so a change in one
// of those modules could break it with nothing to notice. This is the coarsest possible net: it
// proves each module still loads and each element still renders.
//
// The modules are imported here by name. They used to arrive together through webcomponents.js,
// which is gone - so an element in a module nobody imports would silently not be tested.
import './setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));

// mqtt-toggle is registered with a stray space in its define() call, hence the odd name here
const TAGS = [
  'language-picker', 'mqtt-client', 'mqtt-login', 'mqtt-flash', 'mqtt-admin',
  'mqtt-text', 'mqtt-color', 'mqtt-toggle', 'mqtt-bar', 'mqtt-gauge', 'mqtt-slider',
  'mqtt-choosetopic', 'mqtt-wrapper', 'mqtt-graph', 'mqtt-graphdataset',
  'mqtt-devicecard', 'mqtt-devicegrid', 'mqtt-projectback', 'mqtt-dashboard',
];

before(async () => {
  const mock = await import('./mock.js');
  await import('../widgets.js');
  await import('../graph.js');
  await import('../admin.js');
  await import('../flash.js');
  await import('../login.js');
  await import('../cards.js');
  mock.loadConfig(config);
});

describe('every element is registered', () => {
  for (const tag of TAGS) {
    test(tag, () => assert.ok(customElements.get(tag), `${tag} is not defined`));
  }
});

describe('every element connects without throwing', () => {
  for (const tag of TAGS) {
    test(tag, () => {
      const el = document.createElement(tag);
      document.body.append(el);   // triggers connectedCallback and the first render
      el.remove();
    });
  }
});
