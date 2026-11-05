// The picker's last choice, kept in localStorage, comes before the browser's languages. Its own
// process, since the language is fixed when core.js loads.
import './setup.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let core;
before(async () => {
  localStorage.setItem('frugaliot:language', 'id');
  Object.defineProperty(navigator, 'languages', { value: ['hi-IN'], configurable: true });
  core = await import('../core.js');
});

test('a language chosen with the picker before beats the browser', () => {
  assert.equal(core.language, 'id');
});

test('choosing with the picker remembers it', () => {
  const picker = document.createElement('language-picker');
  document.body.append(picker);
  const select = picker.shadowRoot.querySelector('select');
  select.value = 'fr';
  select.dispatchEvent(new Event('change'));
  assert.equal(localStorage.getItem('frugaliot:language'), 'fr');
});
