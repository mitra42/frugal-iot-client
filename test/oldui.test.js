// Regression protection for the existing node/group UI.
//
// These snapshots must not change while the card work happens - they are the check that splitting
// webcomponents.js and moving the summary roll-up down to MqttTopicGroup leave the old UI alone.
// Regenerate deliberately with:  UPDATE_SNAPSHOTS=1 node --test test/oldui.test.js
import './setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { snapshot } from './serialize.js';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
const update = !!process.env.UPDATE_SNAPSHOTS;
let mock;

before(async () => {
  mock = await import('./mock.js');
  mock.loadConfig(config);
});

function checkSnapshot(name, text) {
  const file = new URL(`./snapshots/${name}.txt`, import.meta.url);
  if (update || !existsSync(file)) {
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, 'utf8'), `snapshot ${name} changed`);
}

describe('existing node/group UI renders unchanged', () => {
  for (const name of ['one-device', 'control-wired', 'mixed-sensors', 'default-front', 'no-readings', 'unknown-module']) {
    test(name, () => {
      const container = document.createElement('div');
      document.body.append(container);
      const { projectEl } = mock.runScenario(name, { headless: false, container });
      checkSnapshot(name, snapshot(projectEl));
      container.remove();
    });
  }
});
