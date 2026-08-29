// The WRITE capability (CARDS_PLAN.md phase 8).
//
// This is decluttering, not a security boundary: every user of an organization shares one set of
// broker credentials, which reach the browser in /config.json, so anyone without WRITE can still
// publish with any MQTT client. Hiding controls prevents accidents and stops offering people
// actions that are not theirs. See CARDS_UX.md 10.3 and L-7.
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
const T0 = 1800000000000;
let mock, core;

function withCapabilities(...caps) {
  mock.loadConfig({ ...base, user: { id: 2, name: 'test',
    permissions: caps.map((capability) => ({ org: 'dev', capability })) } });
}
function cardFor(scenario, nodeId, mode) {
  const { projectMt } = mock.runScenario(scenario, { at: T0 });
  const card = document.createElement('mqtt-devicecard');
  card.mt = projectMt.nodes[nodeId];
  card.setAttribute('mode', mode);
  document.body.append(card);
  return { card, nodeMt: projectMt.nodes[nodeId] };
}

before(async () => {
  mock = await import('./mock.js');
  core = await import('../core.js');
  await import('../cards.js');
});
beforeEach(() => withCapabilities('READ', 'WRITE'));

describe('one gate, asked in one place', () => {
  test('canWrite follows the capability, per organization', () => {
    const { projectMt } = mock.runScenario('one-device');
    const mt = projectMt.nodes['esp8266-fb94bb'].groups.frugal_iot.topics.name;
    assert.equal(mt.organization, 'dev');
    assert.equal(mt.canWrite, true);
    withCapabilities('READ');
    assert.equal(mt.canWrite, false, 'READ alone must not allow changes');
    withCapabilities('WRITE');
    assert.equal(mt.canWrite, true);
  });

  test('a capability on another organization does not carry over', () => {
    mock.loadConfig({ ...base, user: { id: 2, permissions: [{ org: 'elsewhere', capability: 'WRITE' }] } });
    const { projectMt } = mock.runScenario('one-device');
    assert.equal(projectMt.nodes['esp8266-fb94bb'].groups.frugal_iot.topics.name.canWrite, false);
  });
});

describe('without WRITE, a control is shown rather than offered', () => {
  test('an editable field becomes its value', () => {
    withCapabilities('READ');
    const { card } = cardFor('one-device', 'esp8266-fb94bb', 'back');
    const name = card.querySelector('[topic$="frugal_iot/name"]');
    assert.equal(name.shadowRoot.querySelector('input'), null, 'still editable');
    assert.match(name.shadowRoot.textContent, /Greenhouse North/, 'but the value must still show');
    card.remove();
  });

  test('the wiring chooser goes - rewiring is a change like any other', () => {
    withCapabilities('READ');
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', 'back');
    const now = card.querySelector('[topic$="controlhysteresis/now"]');
    assert.ok(now, 'the row should still be there');
    assert.equal(now.shadowRoot.querySelector('mqtt-choosetopic'), null);
    card.remove();
  });

  test('an actuator is no longer tappable', () => {
    withCapabilities('READ');
    const { card } = cardFor('default-front', 'esp8266-two-temps', 'front');
    const toggle = card.querySelector('mqtt-toggle');
    assert.ok(toggle, 'the row should still be there');
    assert.equal(toggle.shadowRoot.querySelector('input, button'), null, 'but not operable');
    card.remove();
  });

  test('with WRITE, all of that comes back', () => {
    const { card } = cardFor('control-wired', 'esp8266-fb94bb', 'back');
    assert.ok(card.querySelector('[topic$="frugal_iot/name"]').shadowRoot.querySelector('input'));
    assert.ok(card.querySelector('[topic$="controlhysteresis/now"]')
      .shadowRoot.querySelector('mqtt-choosetopic'));
    card.remove();
  });

  test('the back is still shown - it is where you diagnose a quiet device', () => {
    // CARDS_UX.md D-26: hiding it would mean a reader cannot see last seen, battery or OTA key
    withCapabilities('READ');
    const { card } = cardFor('one-device', 'esp8266-fb94bb', 'back');
    const text = card.textContent;
    for (const wanted of ['esp8266-fb94bb', '3940 mV', 'sht30_c3_pico']) {
      assert.ok(text.includes(wanted), `a reader should still see ${wanted}`);
    }
    card.remove();
  });

  test('readings are unaffected - they were never writable', () => {
    withCapabilities('READ');
    const { card } = cardFor('one-device', 'esp8266-fb94bb', 'front');
    const bars = [...card.querySelectorAll('mqtt-bar')];
    assert.equal(bars.length, 2);
    // The value is in the bar's shadow root, not in the card's textContent
    assert.match(bars[0].shadowRoot.textContent, /30\.1/);
    card.remove();
  });
});

describe('what WRITE does not govern', () => {
  test('arranging your own cards is local presentation, not a change to anything', () => {
    // CARDS_UX.md 10.2 - the layout never leaves this browser
    withCapabilities('READ');
    const { projectMt } = mock.runScenario('every-device');
    const grid = document.createElement('mqtt-devicegrid');
    grid.mt = projectMt;
    document.body.append(grid);
    const ids = [...grid.querySelectorAll('mqtt-devicecard')].map((c) => c.mt.nodeId);
    grid.moveBy(ids[0], 1);
    assert.equal([...grid.querySelectorAll('mqtt-devicecard')][1].mt.nodeId, ids[0]);
    grid.remove();
  });

  test('a reader can still open and close a card', () => {
    withCapabilities('READ');
    const { card } = cardFor('one-device', 'esp8266-fb94bb', 'summary');
    card.querySelector('.fi-card').click();
    assert.equal(card.getAttribute('mode'), 'front');
    card.remove();
  });
});
