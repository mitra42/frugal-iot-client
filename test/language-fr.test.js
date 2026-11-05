// A page opened in French: core.js reads ?lang= when it loads and fetches languages/fr.yaml before
// anything renders, so the URL has to be set before the first import.
import { dom } from './setup.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let core;
before(async () => {
  // A legacy list, in the old upper case - still sent by the server and by old links. The browser
  // prefers Indonesian, which ?lang= overrides.
  dom.reconfigure({ url: 'https://localhost:8080/dashboard/?lang=FR,EN' });
  Object.defineProperty(navigator, 'languages', { value: ['id-ID'], configurable: true });
  core = await import('../core.js');
});

test('the first of a list is the language, lower-cased', () => {
  assert.equal(core.language, 'fr');
  assert.equal(document.documentElement.lang, 'fr');
});

test('the file was loaded before core.js finished importing', () => {
  assert.equal(core.getString('Yes'), 'Oui');
});

test('a phrase not in the file is translated word by word, and an unknown word shown as itself', () => {
  assert.equal(core.getString('Yes Zebra'), 'Oui Zebra');
});

test('the picker shows French as selected', () => {
  const picker = document.createElement('language-picker');
  document.body.append(picker);
  const selected = picker.shadowRoot.querySelector('option:checked');
  assert.equal(selected.value, 'fr');
  assert.equal(selected.textContent, 'Français 🇫🇷');
});

test('a dashboard can add words in the old upper-case form', () => {
  core.addVocabulary('FR:\n  Zebra: Zèbre\n');
  assert.equal(core.getString('Zebra'), 'Zèbre');
});
