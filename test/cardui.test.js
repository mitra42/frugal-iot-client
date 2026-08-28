// The card element (CARDS_PLAN.md phase 5). Rendering, not data - the values it shows are already
// covered by cards.test.js, so these are about the element behaving like an element.
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { snapshot } from './serialize.js';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
const T0 = 1800000000000;
const update = !!process.env.UPDATE_SNAPSHOTS;
let mock, core;

before(async () => {
  mock = await import('./mock.js');
  core = await import('../core.js');
  await import('../cards.js');
  mock.loadConfig(config);
});
beforeEach(() => mock.setNow(null));

function cardFor(scenario, nodeId, opts = {}) {
  const { projectMt } = mock.runScenario(scenario, { at: opts.at || null });
  const card = document.createElement('mqtt-devicecard');
  card.mt = projectMt.nodes[nodeId];
  card.setAttribute('mode', opts.mode || 'summary');
  document.body.append(card);
  return { card, nodeMt: projectMt.nodes[nodeId], projectMt };
}

describe('the card is a light-DOM element', () => {
  test('it renders into itself, so page CSS reaches it', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb');
    assert.equal(card.shadowRoot, null);
    assert.ok(card.querySelector('.fi-card'), 'no card body in the light DOM');
    card.remove();
  });

  test('it renders nothing until it is bound to a device', () => {
    const card = document.createElement('mqtt-devicecard');
    document.body.append(card);          // no .mt
    assert.equal(card.querySelector('.fi-card'), null);
    card.remove();
  });
});

describe('summary mode', () => {
  test('shows the device name, its status and its chips', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { at: T0 });
    assert.equal(card.querySelector('.fi-card__name').textContent, 'Greenhouse North');
    assert.deepEqual([...card.querySelectorAll('.fi-chip')].map((c) => c.textContent),
      ['30.1°C', '85.1%RH']);
    assert.match(card.querySelector('.fi-card').className, /fi-status-live/);
    card.remove();
  });

  test('status is carried by a shape as well as a colour', () => {
    const { card, nodeMt } = cardFor('one-device', 'esp8266-fb94bb', { at: T0 });
    const live = card.querySelector('.fi-status').textContent;
    mock.setNow(T0 + (nodeMt.expectedInterval || core.DEFAULT_REPORT_INTERVAL_MS) * 10);
    card.refresh();
    assert.notEqual(card.querySelector('.fi-status').textContent, live, 'offline must not look live');
    assert.match(card.querySelector('.fi-card').className, /fi-status-offline/);
    card.remove();
  });

  test('a device that has never reported says so instead of showing stale values', () => {
    const { card } = cardFor('no-readings', 'esp8266-newborn', { at: T0 });
    assert.match(card.querySelector('.fi-card').className, /fi-status-never/);
    assert.equal(card.querySelectorAll('.fi-chip').length, 0);
    card.remove();
  });

  test('the whole card is one target - nothing inside it is separately clickable', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb');
    assert.equal(card.querySelectorAll('input, button, select').length, 0);
    card.remove();
  });

  test('clicking opens the front', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb');
    card.querySelector('.fi-card').click();
    assert.equal(card.getAttribute('mode'), 'front');
    card.remove();
  });
});

describe('it updates in place as messages arrive', () => {
  test('a new value changes the chip without rebuilding the card', () => {
    const { card, nodeMt, projectMt } = cardFor('one-device', 'esp8266-fb94bb', { at: T0 });
    const body = card.querySelector('.fi-card');
    core.mqtt_deliver('dev/lotus/esp8266-fb94bb/sht/temperature', '31.7');
    assert.equal(card.querySelectorAll('.fi-chip')[0].textContent, '31.7°C');
    assert.equal(card.querySelector('.fi-card'), body, 'the card element itself should survive');
    card.remove();
  });

  test('it stops listening once removed', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { at: T0 });
    card.remove();
    core.mqtt_deliver('dev/lotus/esp8266-fb94bb/sht/temperature', '99.9'); // must not throw
  });
});

describe('rendered output', () => {
  for (const [scenario, nodeId] of [['one-device', 'esp8266-fb94bb'], ['mixed-sensors', 'esp8266-agri']]) {
    test(`${scenario} summary card`, () => {
      const { card } = cardFor(scenario, nodeId, { at: T0 });
      const file = new URL(`./snapshots/card-${scenario}.txt`, import.meta.url);
      const text = snapshot(card);
      if (update || !existsSync(file)) writeFileSync(file, text);
      else assert.equal(text, readFileSync(file, 'utf8'));
      card.remove();
    });
  }
});
