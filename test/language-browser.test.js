// A page opened with no ?lang= takes the first of the browser's languages that is supported. Like
// language-fr.test.js it needs its own process, since the language is fixed when core.js loads.
import './setup.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let core;
before(async () => {
  // Dutch is not supported, so it falls through to the next; hi-IN matches hi on its language alone
  Object.defineProperty(navigator, 'languages', { value: ['nl-NL', 'hi-IN', 'en'], configurable: true });
  core = await import('../core.js');
  await import('../login.js');
});

test('the first supported browser language is used, matched on its language alone', () => {
  assert.equal(core.language, 'hi');
  assert.equal(core.getString('Yes'), 'हाँ');
});

test('sign-in sends every browser language, unsupported ones too, and returns in the one chosen', () => {
  const login = document.createElement('mqtt-login');
  login.setAttribute('url', '/dashboard/');
  document.body.append(login);
  assert.equal(login.querySelector('input[name=browserlangs]').value, 'nl-NL,hi-IN,en');
  assert.match(login.querySelector('input[name=url]').value, /lang=hi/);
});
