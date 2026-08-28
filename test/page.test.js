// The page and the project's back (CARDS_PLAN.md phase 7).
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock, cards, core;

// The fixture's user has READ only; each test says what this one can do
function withCapabilities(...caps) {
  mock.loadConfig({ ...base, user: { id: 2, name: 'test',
    permissions: caps.map((capability) => ({ org: 'dev', capability })) } });
}

before(async () => {
  mock = await import('./mock.js');
  cards = await import('../cards.js');
  core = await import('../core.js');
});
beforeEach(() => { withCapabilities('READ'); try { localStorage.clear(); } catch (e) { /* none */ } });

describe('which admin cards a user gets', () => {
  test('a reader gets none at all', () => {
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), []);
  });

  test('each capability brings its own card, and no others', () => {
    withCapabilities('READ', 'OTAUPDATE');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['ota']);
    withCapabilities('READ', 'OTAFLASH');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['flash']);
    withCapabilities('READ', 'ADMIN');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['admin', 'nodes', 'api']);
  });

  test('flashing and pushing an OTA binary are separate capabilities', () => {
    // Neither implies the other - more people will have OTAFLASH, because it needs the device in
    // your hand, where an OTA push reaches every device at once
    withCapabilities('OTAFLASH');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['flash']);
    withCapabilities('OTAUPDATE');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['ota']);
  });

  test('a capability on another organization does not count', () => {
    mock.loadConfig({ ...base, user: { id: 2, permissions: [{ org: 'other', capability: 'ADMIN' }] } });
    assert.deepEqual(cards.adminCardsFor('dev'), []);
  });
});

describe('the project back', () => {
  test('renders one card per permitted function', () => {
    withCapabilities('READ', 'ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    assert.equal(back.querySelectorAll('.fi-admincard').length, 3);
    back.remove();
  });

  test('a card is its name until opened - seven forms at once is a wall', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    assert.equal(back.querySelectorAll('mqtt-admin').length, 0, 'nothing should be built yet');
    back.querySelector('.fi-admincard__head').click();
    assert.equal(back.querySelectorAll('mqtt-admin').length, 1, 'opening should build one');
    assert.ok(back.querySelector('.fi-admincard--open'));
    back.remove();
  });

  test('an opened card keeps its content when closed, so a half-filled form survives', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    const head = back.querySelector('.fi-admincard__head');
    head.click();
    const built = back.querySelector('mqtt-admin');
    head.click();
    assert.ok(!back.querySelector('.fi-admincard--open'), 'it should be closed');
    head.click();
    assert.equal(back.querySelector('mqtt-admin'), built, 'it should be the same element');
    back.remove();
  });

  test('renders nothing for someone with no admin capability', () => {
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    assert.equal(back.querySelectorAll('.fi-admincard').length, 0);
    back.remove();
  });

  test('each card holds the existing admin element, not a reimplementation', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.querySelectorAll('.fi-admincard__head').forEach((h) => h.click());
    const sections = [...back.querySelectorAll('mqtt-admin')].map((a) => a.getAttribute('section'));
    assert.deepEqual(sections, ['admin', 'nodes', 'api']);
    back.remove();
  });
});

describe('the page', () => {
  test('with no project chosen it says so rather than showing an empty grid', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.ok(page.querySelector('.fi-empty'), 'no empty state');
    assert.equal(page.querySelector('mqtt-devicegrid'), null);
    page.remove();
  });

  test('the header carries the wrapper, which supplies the selectors and the connection', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.ok(page.querySelector('.fi-header mqtt-wrapper[headless]'));
    assert.ok(page.querySelector('.fi-header language-picker'));
    assert.ok(page.querySelector('.fi-header .fi-header__break'), 'no break to split the two rows');
    page.remove();
  });

  test('the language picker drops its name when the header is narrow', () => {
    const picker = document.createElement('language-picker');
    document.body.append(picker);
    const named = [...picker.shadowRoot.querySelectorAll('option')].map((o) => o.textContent);
    assert.ok(named.some((t) => t.startsWith('English')), `expected names, got ${named}`);
    picker.toggleAttribute('compact', true);
    const flags = [...picker.shadowRoot.querySelectorAll('option')].map((o) => o.textContent);
    assert.ok(flags.every((t) => !t.includes(' ')), `expected flags only, got ${flags}`);
    assert.equal(flags.length, named.length, 'the same languages, just shorter');
    picker.remove();
  });

  test('a project with no devices waits for them, and shows the grid once one arrives', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    const { projectMt } = mock.runScenario('no-readings');
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
      { detail: { projectMt, organization: 'dev', project: 'lotus' } }));
    assert.ok(page.querySelector('mqtt-devicegrid'), 'a discovered device should get a card');
    page.remove();
  });

  test('no gear when turning the project over would show nothing (D-29)', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
      { detail: { projectMt: mock.runScenario('one-device').projectMt, organization: 'dev' } }));
    assert.equal(page.querySelector('.fi-header .fi-btn'), null, 'a reader has nothing to administer');
    page.remove();
  });

  test('the gear appears as soon as an organization is chosen, before any project', () => {
    // Capabilities are per organization, so waiting for a project to be picked was too late
    withCapabilities('READ', 'ADMIN');
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.equal(page.querySelector('.fi-header .fi-btn'), null, 'nothing chosen yet');
    document.dispatchEvent(new CustomEvent('frugaliot:organizationchanged',
      { detail: { organization: 'dev' } }));
    assert.ok(page.querySelector('.fi-header .fi-btn'), 'an admin should get a gear');
    page.remove();
  });

  test('changing organization drops the previous project and closes the back', () => {
    withCapabilities('READ', 'ADMIN');
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
      { detail: { projectMt: mock.runScenario('one-device').projectMt, organization: 'dev' } }));
    page.querySelector('.fi-header .fi-btn').click();
    assert.ok(page.querySelector('mqtt-projectback'));
    document.dispatchEvent(new CustomEvent('frugaliot:organizationchanged',
      { detail: { organization: 'dev' } }));
    assert.equal(page.querySelector('mqtt-projectback'), null, 'the back should close');
    assert.ok(page.querySelector('.fi-empty'), 'and the old project should be gone');
    page.remove();
  });

  test('the gear appears for an admin, and turns the project over', () => {
    withCapabilities('READ', 'ADMIN');
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
      { detail: { projectMt: mock.runScenario('one-device').projectMt, organization: 'dev' } }));
    const gear = page.querySelector('.fi-header .fi-btn');
    assert.ok(gear, 'an admin should get a gear');
    // The span is the flex item, so it is the span that has to be ordered, not the button in it
    assert.ok(gear.closest('.fi-header__gear'), 'the gear is not in the box that gets ordered');
    gear.click();
    assert.ok(page.querySelector('mqtt-projectback'), 'the gear did not turn it over');
    assert.equal(page.querySelector('mqtt-devicegrid'), null, 'the grid should be gone');
    page.querySelector('.fi-header .fi-btn').click();
    assert.ok(page.querySelector('mqtt-devicegrid'), 'and back again');
    page.remove();
  });
});
