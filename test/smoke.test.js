// Every registered element must construct, connect and render without throwing.
//
// The data-tree and old-UI tests do not reach mqtt-admin, mqtt-flash, mqtt-login or mqtt-graph, so
// splitting webcomponents.js could break those with nothing to notice. This is the coarsest possible
// net - it proves the module still loads and each element still renders - and it is what makes the
// phase 3 split safe to do at all.
import './setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));

// mqtt-toggle is registered with a stray space in its define() call, hence the odd name here
const TAGS = [
  'language-picker', 'mqtt-client', 'mqtt-login', 'tabbed-display', 'mqtt-flash', 'mqtt-admin',
  'mqtt-text', 'mqtt-color', 'mqtt-toggle', 'mqtt-bar', 'mqtt-gauge', 'mqtt-slider',
  'mqtt-choosetopic', 'mqtt-wrapper', 'mqtt-project', 'mqtt-node', 'mqtt-group',
  'mqtt-groupledbuiltin', 'mqtt-grouprelay', 'mqtt-groupsoil', 'mqtt-groupota', 'mqtt-groupbattery',
  'mqtt-groupht', 'mqtt-groupsht', 'mqtt-groupdht', 'mqtt-groupcontrolhysteresis',
  'mqtt-groupcontrolhysterisis', 'mqtt-groupfrugaliot', 'mqtt-graph', 'mqtt-graphdataset',
];

before(async () => {
  const mock = await import('./mock.js');
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
