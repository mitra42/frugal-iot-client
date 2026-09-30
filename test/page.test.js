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
  // The widgets a card renders. They used to arrive with everything else through
  // webcomponents.js; each test now names what it renders.
  await import('../widgets.js');
  await import('../graph.js');
  await import('../admin.js');   // mqtt-admin - the project's back renders one per admin card
  await import('../flash.js');   // mqtt-flash - the Flash over USB card
  core = await import('../core.js');
});
beforeEach(() => { withCapabilities('READ'); try { localStorage.clear(); } catch (e) { /* none */ } });

// The permissions table outlives config.d - an organization dropped from it, or hosted on another
// server, keeps its rows, and buildConfigFor serves only the organizations the config has.
describe('a permission naming an organization that is not in the config', () => {
  const withStaleOrg = () => mock.loadConfig({ ...base, user: { id: 2, name: 'test', permissions: [
    { org: 'dev', capability: 'ADMIN' },
    { org: 'dev', capability: 'OTAUPDATE' },
    { org: 'gone', capability: 'ADMIN' },      // no such organization in this config
    { org: 'gone', capability: 'OTAUPDATE' },
  ] } });

  test('does not stop the section rendering', () => {
    withStaleOrg();
    const admin = document.createElement('mqtt-admin');
    admin.setAttribute('section', 'admin');
    document.body.append(admin);    // connectedCallback used to throw here
    assert.ok(admin.shadowRoot.querySelector('.mqtt-admin'), 'the section rendered nothing');
    admin.remove();
  });

  test('is left out, rather than offered and then failing on every card it opens', () => {
    withStaleOrg();
    const admin = document.createElement('mqtt-admin');
    admin.setAttribute('section', 'admin');
    document.body.append(admin);
    assert.deepEqual(admin.adminOrgs, [['dev', 'Development']]);
    assert.deepEqual(admin.otaOrgs, [['dev', 'Development']]);
    // Only one left, so it is chosen without asking - which is the point of dropping the other
    assert.equal(admin.state.org, 'dev');
    admin.remove();
  });

  test('an organization-wide and a project-scoped row list it once', () => {
    mock.loadConfig({ ...base, user: { id: 2, name: 'test', permissions: [
      { org: 'dev', capability: 'ADMIN' },
      { org: 'dev', capability: 'ADMIN', project: 'lotus' },
    ] } });
    const admin = document.createElement('mqtt-admin');
    admin.setAttribute('section', 'admin');
    document.body.append(admin);
    assert.deepEqual(admin.adminOrgs, [['dev', 'Development']]);
    admin.remove();
  });
});

describe('which admin cards a user gets', () => {
  test('a reader gets Info and nothing else', () => {
    // Info needs no capability: connection details are reference information, and having one card
    // that everyone gets is also what stops the project's back ever opening onto nothing
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['info']);
  });

  test('each capability brings its own card, and no others', () => {
    withCapabilities('READ', 'OTAUPDATE');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['info', 'ota']);
    withCapabilities('READ', 'OTAFLASH');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['info', 'flash']);
    withCapabilities('READ', 'ADMIN');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section),
      ['info', 'admin', 'projects', 'message', 'retained', 'nodes', 'bridges', 'api']);
  });

  test('flashing and pushing an OTA binary are separate capabilities', () => {
    // Neither implies the other - more people will have OTAFLASH, because it needs the device in
    // your hand, where an OTA push reaches every device at once
    withCapabilities('OTAFLASH');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['info', 'flash']);
    withCapabilities('OTAUPDATE');
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['info', 'ota']);
  });

  test('a capability on another organization does not count', () => {
    mock.loadConfig({ ...base, user: { id: 2, permissions: [{ org: 'other', capability: 'ADMIN' }] } });
    assert.deepEqual(cards.adminCardsFor('dev').map((c) => c.section), ['info'], 'only the ungated one');
  });
});

describe('the project back', () => {
  test('renders one card per permitted function, plus Info', () => {
    withCapabilities('READ', 'ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    assert.equal(back.querySelectorAll('.fi-admincard').length, 8);
    back.remove();
  });

  test('Info closes again when clicked - it is not an mqtt-admin, and was hidden by name', () => {
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    const head = back.state.elements.info.querySelector('.fi-admincard__head');
    head.click();
    assert.ok(back.state.elements.info.classList.contains('fi-admincard--open'));
    head.click();
    assert.ok(!back.state.elements.info.classList.contains('fi-admincard--open'), 'it stayed open');
    back.remove();
  });

  test('Info holds what the header used to expand to show', () => {
    // The connection details are wanted once, not in the corner of every screen
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.querySelector('.fi-admincard__head').click();
    const info = back.querySelector('.fi-infocard');
    assert.ok(info, 'no Info content');
    assert.match(info.textContent, /dev/, 'the organization');
    assert.equal(back.querySelector('mqtt-admin'), null, 'Info is not an admin section');
    back.remove();
  });

  test('a card is its name until opened - seven forms at once is a wall', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    assert.equal(back.querySelectorAll('mqtt-admin').length, 0, 'nothing should be built yet');
    back.state.elements.admin.querySelector('.fi-admincard__head').click();
    assert.equal(back.querySelectorAll('mqtt-admin').length, 1, 'opening should build one');
    assert.ok(back.querySelector('.fi-admincard--open'));
    back.remove();
  });

  test('an opened card keeps its content when closed, so a half-filled form survives', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    const head = back.state.elements.admin.querySelector('.fi-admincard__head');
    head.click();
    const built = back.querySelector('mqtt-admin');
    head.click();
    assert.ok(!back.querySelector('.fi-admincard--open'), 'it should be closed');
    head.click();
    assert.equal(back.querySelector('mqtt-admin'), built, 'it should be the same element');
    back.remove();
  });

  test('a reader gets Info and no admin cards', () => {
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    const titles = [...back.querySelectorAll('.fi-admincard__head')].map((h) => h.textContent);
    assert.deepEqual(titles, ['Info']);
    back.remove();
  });

  test('people, projects and raw publishing are three separate cards', () => {
    // Three different jobs: who may do what, what the organization contains, and writing straight
    // to the broker
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    const titles = [...back.querySelectorAll('.fi-admincard__head')].map((h) => h.textContent);
    assert.ok(titles.includes('Permissions'));
    assert.ok(titles.includes('Publish Message'));
    assert.ok(titles.includes('Projects'));
    // Reach into the shadow root: the card's own textContent does not see the section's headings
    const headings = (key) => {
      back.state.elements[key].querySelector('.fi-admincard__head').click();
      // The heading's first span is its title - the one beside it is the refresh control
      return [...back.state.elements[key].querySelector('mqtt-admin')
        .shadowRoot.querySelectorAll('h3')].map((h) => (h.querySelector('span') || h).textContent);
    };
    assert.deepEqual(headings('admin'), ['Permissions'], 'people only');
    assert.deepEqual(headings('projects'), ['Projects']);
    assert.deepEqual(headings('message'), ['Publish Message']);
    back.remove();
  });

  test('an opened section knows which data to load', () => {
    // The section is what decides which data setOrganization fetches. Left at its default it would
    // ask for "Dashboard", which needs nothing, and the card would sit there empty.
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.state.elements.admin.querySelector('.fi-admincard__head').click();
    const admin = back.querySelector('mqtt-admin');
    assert.equal(admin.getAttribute('section'), 'admin');
    assert.equal(admin.state.activeSectionTitle, 'Admin', 'it would have asked for Dashboard');
    back.remove();
  });

  test('the organization it is given is not guessed over', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.state.elements.admin.querySelector('.fi-admincard__head').click();
    assert.equal(back.querySelector('mqtt-admin').state.org, 'dev');
    back.remove();
  });

  test('each card holds the existing admin element, not a reimplementation', () => {
    withCapabilities('ADMIN');
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.querySelectorAll('.fi-admincard__head').forEach((h) => h.click());
    const sections = [...back.querySelectorAll('mqtt-admin')].map((a) => a.getAttribute('section'));
    assert.deepEqual(sections, ['admin', 'projects', 'message', 'retained', 'nodes', 'bridges', 'api']);
    back.remove();
  });
});

// The bolt is in the OTA card and the flasher is a card of its own, so this is the one path between
// two mqtt-admin elements that cannot be reached by either on its own.
describe('the bolt beside an OTA file', () => {
  // /ota_get is a real request the jsdom tests cannot make; record it instead
  function withFetchRecorded(fn) {
    const asked = [];
    const real = globalThis.fetch;
    globalThis.fetch = (url) => { asked.push(url); return Promise.resolve({ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4))}); };
    try { fn(asked); } finally { globalThis.fetch = real; }
  }
  function backWithOtaFile(file) {
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.state.elements.ota.querySelector('.fi-admincard__head').click();
    const otaAdmin = back.state.elements.ota.querySelector('mqtt-admin');
    otaAdmin.state.ota_files = [file];                              // what /ota_list would have said
    otaAdmin.replaceElement('ota_files', otaAdmin.otaFilesList());
    return {back, otaAdmin};
  }

  test('opens the Flash card and hands it the file', () => {
    withCapabilities('OTAUPDATE', 'OTAFLASH');
    const {back, otaAdmin} = backWithOtaFile('esp32/lotus/1.0.0');
    withFetchRecorded((asked) => {
      otaAdmin.shadowRoot.querySelector('.otaicon').click();       // the bolt, not a handler call
      assert.ok(back.state.elements.flash.classList.contains('fi-admincard--open'), 'Flash stayed shut');
      assert.deepEqual(asked, ['/ota_get/dev/esp32/lotus/1.0.0']);
    });
    back.remove();
  });

  test('is not offered without OTAFLASH, since there is then no Flash card to open', () => {
    withCapabilities('OTAUPDATE');
    const {back, otaAdmin} = backWithOtaFile('esp32/lotus/1.0.0');
    assert.equal(otaAdmin.shadowRoot.querySelector('.otaicon[title]').textContent, '\u{1f5d1}',
      'the only icon should be the basket');
    back.remove();
  });

  test('the name downloads rather than deleting - a mis-tap cost a file', () => {
    withCapabilities('OTAUPDATE');
    const {back, otaAdmin} = backWithOtaFile('esp32/lotus/1.0.0');
    const link = otaAdmin.shadowRoot.querySelector('a[download]');
    assert.ok(link, 'the file name should be a download link');
    assert.equal(link.textContent, 'esp32/lotus/1.0.0');
    assert.equal(link.getAttribute('href'), '/ota_get/dev/esp32/lotus/1.0.0');
    back.remove();
  });
});

// The server answers an OTA upload with a redirect, so a plain form post landed the whole page on
// /dashboard/ - no organization chosen, and the admin cards shut.
describe('uploading an OTA binary', () => {
  // Every request the card makes: the list it reads on opening, the upload, and the re-read after.
  // Node's Request wants an absolute URL, where a browser resolves one against the page, so GET()
  // cannot reach the stub without standing in for that too.
  function withFetch(fn) {
    const asked = [];
    const real = {fetch: globalThis.fetch, Request: globalThis.Request};
    globalThis.Request = class { constructor(url, init) { Object.assign(this, init); this.url = String(url); } };
    globalThis.fetch = (req, opts) => {
      const url = (req && req.url) || String(req);
      asked.push({url, method: (opts && opts.method) || (req && req.method) || 'GET'});
      if (url.startsWith('/ota_list')) return Promise.resolve({
        ok: true, status: 200, url,
        headers: {get: () => 'application/json'},
        json: () => Promise.resolve(['esp32/lotus/1.0.0']),
      });
      return Promise.resolve({ok: true, status: 200, body: null, // what the redirect lands on
        url: '/dashboard/?message=OTA%20binary%20uploaded&lang=EN'});
    };
    return Promise.resolve(fn(asked))
      .finally(() => { globalThis.fetch = real.fetch; globalThis.Request = real.Request; });
  }
  // Opening the card reads the OTA list, so the stub has to be in place before it is built
  function otaCardAdmin() {
    const back = document.createElement('mqtt-projectback');
    back.setAttribute('organization', 'dev');
    document.body.append(back);
    back.state.elements.ota.querySelector('.fi-admincard__head').click();
    return {back, otaAdmin: back.state.elements.ota.querySelector('mqtt-admin')};
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('stays on the card it was posted from', async () => {
    withCapabilities('OTAUPDATE');
    await withFetch(async (asked) => {
      const {back, otaAdmin} = otaCardAdmin();
      const form = otaAdmin.shadowRoot.querySelector('form');
      const notPrevented = form.dispatchEvent(new Event('submit', {cancelable: true, bubbles: true}));
      assert.equal(notPrevented, false, 'the browser would have navigated away');
      await settle();
      const upload = asked.find((a) => a.url === '/ota_update');
      assert.ok(upload, 'nothing was posted');
      assert.equal(upload.method, 'POST');
      assert.ok(back.querySelector('mqtt-admin'), 'the card should still be here');
      back.remove();
    });
  });

  test('says what the server said, and re-reads the list', async () => {
    withCapabilities('OTAUPDATE');
    await withFetch(async (asked) => {
      const {back, otaAdmin} = otaCardAdmin();
      await settle();                                  // the list the card reads on opening
      const before = asked.filter((a) => a.url === '/ota_list/dev').length;
      otaAdmin.shadowRoot.querySelector('form')
        .dispatchEvent(new Event('submit', {cancelable: true, bubbles: true}));
      await settle();
      assert.equal(otaAdmin.state.elements.message.textContent, 'OTA binary uploaded');
      assert.equal(asked.filter((a) => a.url === '/ota_list/dev').length, before + 1,
        'the list should have been re-read, which is what actually shows the upload arrived');
      back.remove();
    });
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

  test('there is a way to log out', () => {
    // There was none at all before, and a permissions change now ends the session
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    const out = page.querySelector('.fi-header__logout');
    assert.ok(out, 'no way out');
    assert.equal(out.getAttribute('href'), '/logout');
    page.remove();
  });

  test('a graph has somewhere to land', () => {
    // MqttGraph looks for #graph-container and otherwise appends to the end of the document, which
    // on this page is below everything
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.ok(page.querySelector('#graph-container'));
    page.remove();
  });

  test('the header links back to the project site', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    const brand = page.querySelector('.fi-brand');
    assert.ok(brand, 'no way back to the main site');
    assert.equal(brand.getAttribute('href'), '/');
    assert.ok(brand.querySelector('img'), 'the icon the main site uses in its own header');
    page.remove();
  });

  test('the header carries the wrapper, which supplies the selectors and the connection', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.ok(page.querySelector('.fi-header mqtt-wrapper'));
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

  test('a reader gets the gear too, because Info is always behind it', () => {
    // D-29 said omit the gear when the back would be empty. Info is ungated, so the back is never
    // empty and the gear is always offered - the guard stays, it simply no longer triggers.
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
      { detail: { projectMt: mock.runScenario('one-device').projectMt, organization: 'dev' } }));
    assert.ok(page.querySelector('.fi-header__gear .fi-btn'), 'even a reader has Info to look at');
    page.remove();
  });

  test('with no organization chosen there is still no gear', () => {
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.equal(page.querySelector('.fi-header__gear .fi-btn'), null);
    page.remove();
  });

  test('the gear appears as soon as an organization is chosen, before any project', () => {
    // Capabilities are per organization, so waiting for a project to be picked was too late
    withCapabilities('READ', 'ADMIN');
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    assert.equal(page.querySelector('.fi-header__gear .fi-btn'), null, 'nothing chosen yet');
    document.dispatchEvent(new CustomEvent('frugaliot:organizationchanged',
      { detail: { organization: 'dev' } }));
    assert.ok(page.querySelector('.fi-header__gear .fi-btn'), 'an admin should get a gear');
    page.remove();
  });

  test('changing organization drops the previous project and closes the back', () => {
    withCapabilities('READ', 'ADMIN');
    const page = document.createElement('mqtt-dashboard');
    document.body.append(page);
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged',
      { detail: { projectMt: mock.runScenario('one-device').projectMt, organization: 'dev' } }));
    page.querySelector('.fi-header__gear .fi-btn').click();
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
    const gear = page.querySelector('.fi-header__gear .fi-btn');
    assert.ok(gear, 'an admin should get a gear');
    // The span is the flex item, so it is the span that has to be ordered, not the button in it
    assert.ok(gear.closest('.fi-header__gear'), 'the gear is not in the box that gets ordered');
    gear.click();
    assert.ok(page.querySelector('mqtt-projectback'), 'the gear did not turn it over');
    assert.equal(page.querySelector('mqtt-devicegrid'), null, 'the grid should be gone');
    page.querySelector('.fi-header__gear .fi-btn').click();
    assert.ok(page.querySelector('mqtt-devicegrid'), 'and back again');
    page.remove();
  });
});
