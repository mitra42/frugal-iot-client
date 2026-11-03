// The Forwarders admin card. The server describes what can be added (GET /forwarders), and the card
// builds its form from that, so what is tested here is the form built from a description, what it
// sends, and that a secret is never put anywhere it could be read back.
import './setup.js';
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock;

const TYPES = {
  opensearch: { label: 'OpenSearch', help: 'Sends readings to OpenSearch', fields: [
    { key: 'node', label: 'OpenSearch URL', kind: 'url', required: true },
    { key: 'password', label: 'Password', kind: 'string', secret: true },
    { key: 'insecure', label: 'Do not check the certificate', kind: 'boolean' },
    { key: 'topics', label: 'Only these topics', kind: 'topics' },
    { key: 'flushSeconds', label: 'Send every (seconds)', kind: 'int' },
  ] },
  gsheet: { label: 'Google Sheets', help: 'Appends rows', links: [
    { label: 'The Apps Script to copy', url: 'https://raw.githubusercontent.com/x/y/main/gsheet_app' },
    { label: 'Not https', url: 'javascript:alert(1)' }], fields: [
    { key: 'url', label: 'Web app URL', kind: 'url', required: true, secret: true },
  ] },
};
const STORED = { source: 'db', id: 7, type: 'opensearch', name: 'Search', enabled: true,
  config: { node: 'https://localhost:9200', topics: ['dev/lotus/#'] }, secretsSet: ['password'] };
const FROM_FILE = { source: 'file', index: 0, type: 'gsheet', name: 'From the configuration file (#1)', enabled: true,
  config: { sheet: 'S1', intervalSeconds: 300, topics: ['a/b/c/d/e'] } };

let realFetch, RealRequest, calls, listing;
const json = (body, status = 200) => Promise.resolve({
  ok: status < 400, status, headers: { get: () => 'application/json' },
  json: async () => body, text: async () => JSON.stringify(body),
});
const tick = () => new Promise((r) => setTimeout(r, 10));

before(async () => {
  mock = await import('./mock.js');
  await import('../admin.js');
});
beforeEach(() => {
  mock.loadConfig({ ...base, user: { id: 2, name: 'test', permissions: [{ org: 'dev', capability: 'ADMIN' }, { org: 'dev', capability: 'READ' }] } });
  calls = [];
  listing = { types: TYPES, forwarders: [STORED], fromFile: [FROM_FILE] };
  realFetch = globalThis.fetch;
  // A browser resolves "/forwarders/dev" against the page; Node's Request insists on a full URL
  RealRequest = globalThis.Request;
  globalThis.Request = class extends RealRequest {
    constructor(u, i) { super(typeof u === 'string' && u.startsWith('/') ? `http://localhost${u}` : u, i); }
  };
  globalThis.fetch = (req, init) => {
    const url = typeof req === 'string' ? req : req.url;
    const path = new URL(url, 'http://localhost').pathname;
    const method = (init && init.method) || req.method || 'GET';
    calls.push({ method, path, body: init && init.body ? JSON.parse(init.body) : undefined });
    if (method === 'GET') return json(listing);
    if (path.endsWith('/delete')) return json({ deleted: true, applied: true });
    return json({ id: 8, applied: true }, path.includes('bad') ? 400 : 200);
  };
});
afterEach(() => { globalThis.fetch = realFetch; globalThis.Request = RealRequest; document.body.innerHTML = ''; });

async function card() {
  const admin = document.createElement('mqtt-admin');
  admin.setAttribute('section', 'forwarders');
  document.body.append(admin);
  admin.getForwarders();
  await tick();
  return admin;
}
const root = (admin) => admin.shadowRoot;
const text = (admin) => root(admin).textContent;

describe('the Forwarders card', () => {
  test('lists the stored forwarders and those from the file, the latter without buttons', async () => {
    const admin = await card();
    const rows = [...root(admin).querySelectorAll('table.nodestates tr')].slice(1);
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Search/);
    assert.match(rows[0].textContent, /OpenSearch/);
    assert.match(rows[0].textContent, /https:\/\/localhost:9200/);
    assert.equal(rows[0].querySelectorAll('button').length, 2);        // Edit, Delete
    assert.match(rows[1].textContent, /From the file/);
    assert.equal(rows[1].querySelectorAll('button').length, 0);        // read-only
  });

  test('says so when there are none', async () => {
    listing = { types: TYPES, forwarders: [], fromFile: [] };
    const admin = await card();
    assert.match(text(admin), /forwards its readings nowhere/);
  });

  test('builds the add form from what the server describes', async () => {
    const admin = await card();
    [...root(admin).querySelectorAll('button')].find((b) => /Add a forwarder/.test(b.textContent)).click();
    const labels = [...root(admin).querySelectorAll('.forwarder-form label')].map((l) => l.textContent);
    for (const want of ['OpenSearch URL *', 'Password', 'Do not check the certificate', 'Only these topics', 'Send every (seconds)']) {
      assert.ok(labels.some((l) => l.includes(want)), `no field "${want}"`);
    }
    assert.equal(root(admin).querySelector('input[type=password]') !== null, true, 'a secret must be a password box');
  });

  test('shows the links a type comes with, https only, opening in a new tab', async () => {
    const admin = await card();
    [...root(admin).querySelectorAll('button')].find((b) => /Add a forwarder/.test(b.textContent)).click();
    const sel = root(admin).querySelector('.forwarder-form select');
    sel.value = 'gsheet';
    sel.dispatchEvent(new window.Event('change'));
    const links = [...root(admin).querySelectorAll('.forwarder-form a.forwarder-link')];
    assert.equal(links.length, 1);
    assert.equal(links[0].getAttribute('href'), 'https://raw.githubusercontent.com/x/y/main/gsheet_app');
    assert.equal(links[0].getAttribute('target'), '_blank');
    assert.match(links[0].getAttribute('rel'), /noopener/);
  });

  test('sends what was typed, as the server takes it, and leaves blanks out', async () => {
    const admin = await card();
    [...root(admin).querySelectorAll('button')].find((b) => /Add a forwarder/.test(b.textContent)).click();
    admin.state.elements.forwarder_name.value = 'My search';
    const inputs = admin.state.forwarder_inputs;
    inputs.node.value = ' https://localhost:9200 ';
    inputs.password.value = 'pw';
    inputs.insecure.checked = true;
    inputs.topics.value = 'dev/lotus/#\n\n dev/magi/+/x/y \n';
    inputs.flushSeconds.value = '30';
    [...root(admin).querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await tick();
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.path, '/forwarders/dev');
    assert.deepEqual(post.body, {
      type: 'opensearch', name: 'My search', enabled: true,
      config: { node: 'https://localhost:9200', password: 'pw', insecure: true,
        topics: ['dev/lotus/#', 'dev/magi/+/x/y'], flushSeconds: 30 },
    });
  });

  test('wants a name', async () => {
    const admin = await card();
    [...root(admin).querySelectorAll('button')].find((b) => /Add a forwarder/.test(b.textContent)).click();
    [...root(admin).querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await tick();
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('editing shows a stored secret as set, never its value, and a blank keeps it', async () => {
    const admin = await card();
    admin.onForwarderEdit(STORED);
    const pw = admin.state.forwarder_inputs.password;
    assert.equal(pw.value, '');
    assert.match(pw.placeholder, /set - leave blank to keep it/);
    assert.equal(admin.state.forwarder_inputs.node.value, 'https://localhost:9200');
    assert.equal(admin.state.forwarder_inputs.topics.value, 'dev/lotus/#');
    [...root(admin).querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await tick();
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.body.id, 7);
    assert.equal('password' in post.body.config, false);   // blank is left out, so the server keeps it
  });

  test('switching one off is sent as enabled: false', async () => {
    const admin = await card();
    admin.onForwarderEdit(STORED);
    admin.state.elements.forwarder_enabled.checked = false;
    [...root(admin).querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await tick();
    assert.equal(calls.find((c) => c.method === 'POST').body.enabled, false);
  });

  test('deleting asks first, and sends the id', async () => {
    const admin = await card();
    const realConfirm = globalThis.window.confirm;
    let asked;
    globalThis.window.confirm = (q) => { asked = q; return false; };
    admin.onForwarderDelete(STORED);
    assert.match(asked, /Delete "Search"\?/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    globalThis.window.confirm = () => true;
    admin.onForwarderDelete(STORED);
    await tick();
    globalThis.window.confirm = realConfirm;
    assert.deepEqual(calls.find((c) => c.method === 'POST'),
      { method: 'POST', path: '/forwarders/dev/delete', body: { id: 7 } });
  });

  test('is only offered to an administrator', async () => {
    mock.loadConfig({ ...base, user: { id: 2, name: 'test', permissions: [{ org: 'dev', capability: 'READ' }] } });
    const admin = document.createElement('mqtt-admin');
    admin.setAttribute('section', 'forwarders');
    document.body.append(admin);
    assert.equal(admin.shadowRoot.querySelector('.mqtt-admin'), null);
  });
});

describe('the Grafana card', () => {
  async function grafanaCard(tokens = []) {
    listing = tokens;
    const admin = document.createElement('mqtt-admin');
    admin.setAttribute('section', 'grafana');
    document.body.append(admin);
    admin.getGrafanaTokens();
    await tick();
    return admin;
  }

  test('says so when nothing has access, and links the starter dashboard for this server and organization', async () => {
    const admin = await grafanaCard([]);
    assert.match(admin.shadowRoot.textContent, /No Grafana has been given access/);
    const link = admin.shadowRoot.querySelector('a.grafana-dashboard-download');
    assert.match(link.getAttribute('href'), /^\/grafana_token\/dev\/dashboard\?server=/);
  });

  test('lists tokens by name, with no token value anywhere', async () => {
    const admin = await grafanaCard([{ name: 'home', created_at: Date.now() - 86400000, last_used: null, mine: true }]);
    const row = admin.shadowRoot.querySelectorAll('table.nodestates tr')[1];
    assert.match(row.textContent, /home/);
    assert.match(row.textContent, /Never/);
    assert.equal(row.querySelectorAll('button').length, 1);
  });

  test('making a token shows it once, with a data source file that already holds it', async () => {
    const admin = await grafanaCard([]);
    globalThis.fetch = (req, init) => {
      const path = new URL(typeof req === 'string' ? req : req.url, 'http://localhost').pathname;
      calls.push({ method: (init && init.method) || 'GET', path, body: init && init.body ? JSON.parse(init.body) : undefined });
      return json((init && init.method === 'POST') ? { org: 'dev', name: 'home', token: 'fiot_SECRET123' } : []);
    };
    admin.state.elements.grafana_name.value = 'home';
    [...admin.shadowRoot.querySelectorAll('button')].find((b) => b.textContent === 'Make a token').click();
    await tick();
    assert.deepEqual(calls.find((c) => c.method === 'POST'), { method: 'POST', path: '/grafana_token/dev', body: { name: 'home' } });
    assert.match(admin.shadowRoot.textContent, /fiot_SECRET123/);
    const href = admin.shadowRoot.querySelector('a.grafana-datasource-download').getAttribute('href');
    const yaml = decodeURIComponent(href.replace('data:text/yaml;charset=utf-8,', ''));
    assert.match(yaml, /type: yesoreyeram-infinity-datasource/);
    assert.match(yaml, /auth_method: bearerToken/);
    assert.match(yaml, /bearerToken: "fiot_SECRET123"/);
    assert.match(yaml, /uid: "frugaliot-dev"/);
  });

  test('the data source file quotes its values, so a odd name cannot break the YAML', async () => {
    const admin = await grafanaCard([]);
    const yaml = admin.grafanaDataSourceYaml('de"v\n- x', 'https://iot.example.org', 'fiot_x');
    assert.ok(!/\n- x/.test(yaml), 'a newline in the name must not start a new YAML line');
  });

  test('revoking asks first, then sends the name', async () => {
    const admin = await grafanaCard([{ name: 'home', created_at: 1, last_used: null }]);
    let asked;
    const realConfirm = globalThis.window.confirm;
    globalThis.window.confirm = (q) => { asked = q; return true; };
    admin.onGrafanaRevoke({ name: 'home' });
    await tick();
    globalThis.window.confirm = realConfirm;
    assert.match(asked, /Revoke "home"\?/);
    assert.deepEqual(calls.find((c) => c.method === 'POST'),
      { method: 'POST', path: '/grafana_token/dev/revoke', body: { name: 'home' } });
  });
});

describe('the OpenSearch Dashboards card', () => {
  async function accessCard(state) {
    listing = state;
    const admin = document.createElement('mqtt-admin');
    admin.setAttribute('section', 'opensearch');
    document.body.append(admin);
    admin.getOpenSearchAccess();
    await tick();
    return admin;
  }
  const press = (admin, cls) => admin.shadowRoot.querySelector(`button.${cls}`).click();

  test('says what is missing when the server has no OpenSearch of its own', async () => {
    const admin = await accessCard({ available: false, reason: 'This server has no OpenSearch of its own set up' });
    assert.match(admin.shadowRoot.querySelector('.opensearch-unavailable').textContent, /no OpenSearch of its own/);
    assert.equal(admin.shadowRoot.querySelector('button.opensearch-make'), null);
  });

  test('offers to make a login when there is none, and to replace or remove it when there is', async () => {
    let admin = await accessCard({ available: true, exists: false, username: 'frugaliot_dev' });
    assert.equal(admin.shadowRoot.querySelector('button.opensearch-make').textContent, 'Make a login');
    assert.equal(admin.shadowRoot.querySelector('button.opensearch-revoke'), null);
    document.body.innerHTML = '';
    admin = await accessCard({ available: true, exists: true, username: 'frugaliot_dev' });
    assert.equal(admin.shadowRoot.querySelector('button.opensearch-make').textContent, 'Replace the password');
    assert.ok(admin.shadowRoot.querySelector('button.opensearch-revoke'));
  });

  test('making a login shows the lines to use, once, and sends nothing but the request', async () => {
    const admin = await accessCard({ available: true, exists: false, username: 'frugaliot_dev' });
    const config = 'opensearch.username: "frugaliot_dev"\nopensearch.password: "PW123"';
    globalThis.fetch = (req, init) => {
      const path = new URL(typeof req === 'string' ? req : req.url, 'http://localhost').pathname;
      calls.push({ method: (init && init.method) || 'GET', path, body: init && init.body ? JSON.parse(init.body) : undefined });
      return json((init && init.method === 'POST') ? { username: 'frugaliot_dev', password: 'PW123', config } : { available: true, exists: true, username: 'frugaliot_dev' });
    };
    press(admin, 'opensearch-make');
    await tick();
    assert.deepEqual(calls.find((c) => c.method === 'POST'), { method: 'POST', path: '/opensearch_access/dev', body: {} });
    assert.equal(admin.shadowRoot.querySelector('pre.opensearch-config').textContent, config);
  });

  test('an administrator sees everyone\'s logins and can remove one by name', async () => {
    const admin = await accessCard({ available: true, exists: true, username: 'frugaliot_dev_mitra', all: ['mitra', 'sam'] });
    const rows = admin.shadowRoot.querySelectorAll('.opensearch-all tr');
    assert.equal(rows.length, 2);
    const realConfirm = globalThis.window.confirm;
    globalThis.window.confirm = () => true;
    rows[1].querySelector('button').click();
    await tick();
    globalThis.window.confirm = realConfirm;
    assert.deepEqual(calls.find((c) => c.method === 'POST'), { method: 'POST', path: '/opensearch_access/dev/revoke', body: { username: 'sam' } });
  });

  test('removing your own sends no name, and asks first', async () => {
    const admin = await accessCard({ available: true, exists: true, username: 'frugaliot_dev' });
    let asked;
    const realConfirm = globalThis.window.confirm;
    globalThis.window.confirm = (q) => { asked = q; return false; };
    press(admin, 'opensearch-revoke');
    await tick();
    globalThis.window.confirm = realConfirm;
    assert.match(asked, /Remove the login/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
});
