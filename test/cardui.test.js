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

  test('a module with two readings does not label both of them with the module name', () => {
    // Every module at once made this obvious: "AHT20" appeared twice, with nothing to say which was
    // the temperature. The module name alone only works when it contributes a single reading.
    const { card } = cardFor('every-module', 'esp8266-everything', { mode: 'front', at: T0 });
    const labels = [...card.querySelectorAll('mqtt-bar, mqtt-text, mqtt-toggle, mqtt-gauge')]
      .map((w) => w.getAttribute('label')).filter(Boolean);
    assert.ok(labels.includes('AHT20 Temperature'), `got ${labels.slice(0, 8)}`);
    assert.ok(labels.includes('AHT20 Humidity'));
    assert.ok(labels.includes('Soil Temperature'), 'a single-reading module keeps its own name');
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

describe('back mode', () => {
  test('sections in a fixed order: device, controls, readings, advanced', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const titles = [...card.querySelectorAll('.fi-section__title')].map((h) => h.textContent);
    assert.equal(titles[0], 'Device');
    assert.ok(titles.includes('Control'), `no control section in ${titles}`);
    assert.ok(titles.indexOf('SHT') > titles.indexOf('Control'), 'readings come after controls');
    assert.ok(card.querySelector('details.fi-advanced'), 'Advanced is the only collapsed part');
    card.remove();
  });

  test('a widget told to have no label does not fall back to the topic name', () => {
    // The field row supplies the label; the widget repeating it read as "Name  Node Name  [input]"
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const nameWidget = card.querySelector('mqtt-text[topic$="frugal_iot/name"]');
    assert.equal(nameWidget.shadowRoot.querySelector('label'), null);
    card.remove();
  });

  test('a text topic gets no min or max attributes', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const nameWidget = card.querySelector('mqtt-text[topic$="frugal_iot/name"]');
    assert.equal(nameWidget.getAttribute('min'), null, 'String(undefined) put "undefined" here');
    assert.equal(nameWidget.getAttribute('max'), null);
    card.remove();
  });

  test('nothing but Advanced is collapsed', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    assert.equal(card.querySelectorAll('details').length, 1);
    card.remove();
  });

  test('the device section carries what you need to diagnose a quiet device', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const text = card.querySelector('.fi-section').textContent;
    for (const wanted of ['esp8266-fb94bb', '3940 mV', 'sht30_c3_pico']) {
      assert.ok(text.includes(wanted), `device section missing ${wanted}: ${text}`);
    }
    card.remove();
  });

  test('name and description are editable, the id is not', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const device = card.querySelector('.fi-section');
    assert.equal(device.querySelectorAll('mqtt-text').length, 2, 'name and description');
    card.remove();
  });

  test('the control is the compact form, not a labelled row per setting', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const when = card.querySelector('.fi-when');
    assert.ok(when, 'no inline when row');
    assert.ok(when.querySelector('mqtt-toggle'), 'the comparison is a two-state control');
    assert.equal(when.querySelectorAll('mqtt-text').length, 2, 'limit and hysteresis');
    assert.match(when.textContent, /±/, 'the symbol, not the word Hysteresis');
    // One item, so wrapping cannot leave the symbol on the line above its own value
    const pm = when.querySelector('.fi-when__pm');
    assert.ok(pm.parentElement.querySelector('mqtt-text'), 'the ± is not grouped with its value');
    card.remove();
  });

  test('the control input and output show their wiring chooser, already open', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const labels = [...card.querySelectorAll('.fi-field__label')].map((l) => l.textContent);
    assert.ok(labels.includes('Input'));
    assert.ok(labels.includes('Output'));
    for (const leaf of ['now', 'out']) {
      const w = card.querySelector(`[topic$="controlhysteresis/${leaf}"]`);
      const details = w.shadowRoot.querySelector('details');
      assert.ok(details, `${leaf} should offer wiring`);
      assert.ok(details.hasAttribute('open'), `${leaf}'s chooser was hidden behind a disclosure`);
      assert.ok(details.querySelector('mqtt-choosetopic'), `${leaf} has no chooser`);
    }
    card.remove();
  });

  test('the chooser shows what the topic is wired to, not "Unused"', () => {
    // The "wired" attribute is only ever set on the element path, so a headless card read null and
    // every chooser claimed to be unwired
    const { card, nodeMt } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const now = card.querySelector('[topic$="controlhysteresis/now"]');
    const chooser = now.shadowRoot.querySelector('mqtt-choosetopic');
    assert.equal(chooser.getAttribute('value'), nodeMt.groups.controlhysteresis.topics.now.wired);
    const selected = [...chooser.shadowRoot.querySelectorAll('option')].find((o) => o.selected);
    assert.ok(selected, 'no option selected at all');
    assert.equal(selected.textContent, 'Greenhouse North:SHT:Temperature');
    card.remove();
  });

  test('the wired source is named once, by the chooser, not twice', () => {
    // The summary also printed the source name, which then sat stale until the broker echoed the
    // change back - so the text and the chooser disagreed about what was wired
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const now = card.querySelector('[topic$="controlhysteresis/now"]');
    assert.equal(now.shadowRoot.querySelector('.wired'), null, 'named twice');
    assert.ok(now.shadowRoot.querySelector('mqtt-choosetopic'), 'and the chooser is what names it');
    card.remove();
  });

  test('with no chooser, the source is still named', () => {
    // wiring="none" suppresses the chooser, so the text is the only thing saying where the value
    // comes from and has to stay
    const { card, nodeMt } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const limit = nodeMt.groups.controlhysteresis.topics.limit;
    limit.setWired('dev/lotus/esp8266-fb94bb/sht/humidity');
    card.renderAndReplace();
    const w = card.querySelector('[topic$="controlhysteresis/limit"]');
    assert.equal(w.shadowRoot.querySelector('mqtt-choosetopic'), null, 'compact row has no chooser');
    assert.ok(w.shadowRoot.querySelector('.wired'), 'so it must say where the value comes from');
    card.remove();
  });

  test('the chooser does not repeat a label the row already carries', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const chooser = card.querySelector('[topic$="controlhysteresis/now"]')
      .shadowRoot.querySelector('mqtt-choosetopic');
    assert.equal(chooser.shadowRoot.querySelector('label').textContent, '',
      'the field row already says "Input"');
    card.remove();
  });

  test('the compact row carries no wiring chooser of its own', () => {
    // limit is wireable, so mqtt-text wrapped it in a <details> - a stray disclosure above the
    // field that revealed a second copy of the label and value when opened
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const limit = card.querySelector('[topic$="controlhysteresis/limit"]');
    assert.equal(limit.shadowRoot.querySelector('details'), null);
    assert.ok(limit.shadowRoot.querySelector('input'), 'but it is still editable');
    card.remove();
  });

  test('the comparison flips on one tap instead of being a menu', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const greater = card.querySelector('[topic$="controlhysteresis/greater"]');
    const button = greater.shadowRoot.querySelector('button.toggle');
    assert.ok(button, 'labels= used to render a two-option select');
    assert.equal(button.textContent, '>');
    button.click();
    assert.equal(button.textContent, '<');
    card.remove();
  });

  test('every widget actually renders - a throw in render leaves one silently empty', () => {
    // renderWiredName reached wiredTopic.node, the MqttNode element, which a headless page has
    // none of. It threw inside connectedCallback, so the widget just came out blank.
    for (const mode of ['front', 'back']) {
      const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode, at: T0 });
      const empty = [...card.querySelectorAll('mqtt-text, mqtt-toggle, mqtt-bar, mqtt-choosetopic')]
        .filter((w) => !w.shadowRoot || (w.shadowRoot.childNodes.length === 0))
        .map((w) => `${w.localName}[${w.getAttribute('topic')}]`);
      assert.deepEqual(empty, [], `${mode}: these rendered nothing`);
      card.remove();
    }
  });

  test('a bad reading is red on the back too, not only on the front', () => {
    const { card } = cardFor('out-of-range', 'esp8266-broken', { mode: 'back', at: T0 });
    assert.equal(card.querySelectorAll('.fi-row--outofrange').length, 2);
    card.remove();
  });

  test('wifi appears when the device reports it', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    assert.match(card.querySelector('.fi-section').textContent, /shed-ap/);
    card.remove();
  });

  test('the close mark returns to the front, not all the way to the summary', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    assert.equal(card.querySelectorAll('.fi-btn:not(.fi-btn--close)').length, 0, 'no gear on the back');
    card.querySelector('.fi-btn--close').click();
    assert.equal(card.getAttribute('mode'), 'front');
    card.remove();
  });

  test('every module gets a section, including ones the front leaves out', () => {
    // control-wired's device has a relay the sht30 front entry does not list - the back shows it
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const titles = [...card.querySelectorAll('.fi-section__title')].map((h) => h.textContent);
    assert.ok(titles.includes('Relay'), `relay missing from ${titles}`);
    card.remove();
  });

  test('a module the schema does not know still reaches the back', () => {
    // Developers add modules; a reading that is silently dropped is the hardest kind to chase
    const { card } = cardFor('unknown-module', 'esp8266-odd', { mode: 'back', at: T0 });
    const titles = [...card.querySelectorAll('.fi-section__title')].map((h) => h.textContent);
    assert.ok(titles.includes('Not in the schema'), `missing from ${titles}`);
    const text = card.textContent;
    assert.match(text, /quantumflux\/spin/);
    assert.match(text, /42/);
    card.remove();
  });

  test('a reading that never arrives has a row and no value, not a missing row', () => {
    const { card } = cardFor('module-no-data', 'esp8266-halfsht', { mode: 'back', at: T0 });
    assert.ok(card.querySelector('[topic$="sht/humidity"]'), 'the row should still be there');
    card.remove();
  });

  test('the status strip modules do not get sections of their own', () => {
    const { card } = cardFor('one-device', 'esp8266-fb94bb', { mode: 'back', at: T0 });
    const titles = [...card.querySelectorAll('.fi-section__title')].map((h) => h.textContent);
    for (const inside of ['Battery', 'OTA', 'System']) assert.ok(!titles.includes(inside), inside);
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
    ['control-wired', 'esp8266-fb94bb', 'back'],
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
