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

describe('front mode', () => {
  test('one row per front row, in the declared order', () => {
    const { card, nodeMt } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    assert.equal(card.querySelectorAll('.fi-row').length, nodeMt.frontRows.length);
    card.remove();
  });

  test('a reading becomes the widget its display: asks for, with its range', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    const bar = card.querySelector('mqtt-bar');
    assert.ok(bar, 'temperature has display: bar');
    assert.equal(bar.getAttribute('min'), '0');
    assert.equal(bar.getAttribute('max'), '50');
    assert.ok(bar.mt, 'pre-bound, so it does not fabricate a topic of its own');
    card.remove();
  });

  test('a widget is not bound as mt.element, so nothing competes for the topic', () => {
    const { card, nodeMt } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    assert.equal(nodeMt.groups.sht.topics.temperature.element, undefined);
    card.remove();
  });

  test('the label is the disambiguated one, not the raw topic name', () => {
    const { card } = cardFor('default-front', 'esp8266-two-temps', { mode: 'front', at: T0 });
    const labels = [...card.querySelectorAll('mqtt-bar')].map((b) => b.getAttribute('label'));
    assert.ok(labels.includes('Soil Temperature'), `got ${labels}`);
    card.remove();
  });

  test('an actuator is a live control the user can tap', () => {
    // default-front takes the default ordering, which puts actuators after the readings
    const { card } = cardFor('default-front', 'esp8266-two-temps', { mode: 'front', at: T0 });
    assert.ok(card.querySelector('.fi-row--actuator mqtt-toggle'), 'the relay should be tappable');
    card.remove();
  });

  test('a control module is read-only on the front, and shows its rule', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    const control = card.querySelector('.fi-row--control');
    assert.ok(control, 'the control should have a row');
    assert.equal(control.querySelectorAll('input, button, select').length, 0, 'read-only on the front');
    assert.match(control.textContent, /> 32/, 'and the rule, not just the state');
    card.remove();
  });

  test('a device only shows what its entry declares - the rest is on the back', () => {
    // This device publishes relay/on, but the sht30 entry does not list it, so it is not on the front
    const { card, nodeMt } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    assert.ok(nodeMt.groups.relay, 'the device does have a relay');
    assert.equal(card.querySelector('.fi-row--actuator'), null);
    card.remove();
  });

  test('an out-of-range reading is marked at both ends of the range', () => {
    const { card } = cardFor('out-of-range', 'esp8266-broken', { mode: 'front', at: T0 });
    assert.equal(card.querySelectorAll('.fi-row--outofrange').length, 2);
    const [below, above] = [...card.querySelectorAll('mqtt-bar')];
    // A value under min gave a negative width, so the fill shrank to its own text instead of
    // emptying; one over max would have overflowed the track
    assert.equal(below.width, 0, 'below min should empty the bar');
    assert.equal(above.width, 100, 'above max should fill it');
    assert.match(below.mt.formatted, /-999/, 'and the real value is still shown');
    assert.match(above.mt.formatted, /118.4/);
    card.remove();
  });

  test('the footer carries battery and last seen', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    const foot = card.querySelector('.fi-card__foot');
    assert.match(foot.textContent, /3940 mV/);
    assert.ok(foot.querySelector('.fi-foot__age'));
    card.remove();
  });

  test('collapse goes back to the summary, the gear goes to the back', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    card.querySelector('.fi-btn:not(.fi-btn--close)').click();
    assert.equal(card.getAttribute('mode'), 'back');
    card.setAttribute('mode', 'front');
    card.querySelector('.fi-btn--close').click();
    assert.equal(card.getAttribute('mode'), 'summary');
    card.remove();
  });

  test('the front is not one big click target', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'front', at: T0 });
    card.querySelector('.fi-card').click();
    assert.equal(card.getAttribute('mode'), 'front', 'clicking the body must not change mode');
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
  for (const [scenario, nodeId, mode] of [
    ['one-device', 'esp8266-fb94bb', 'summary'],
    ['mixed-sensors', 'esp8266-agri', 'summary'],
    ['control-wired', 'esp8266-fb94bb', 'front'],
  ]) {
    test(`${scenario} ${mode} card`, () => {
      const { card } = cardFor(scenario, nodeId, { at: T0, mode });
      const file = new URL(`./snapshots/card-${scenario}-${mode}.txt`, import.meta.url);
      const text = snapshot(card);
      if (update || !existsSync(file)) writeFileSync(file, text);
      else assert.equal(text, readFileSync(file, 'utf8'));
      card.remove();
    });
  }
});
