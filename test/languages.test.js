// The language files, and the page in English - which fetches none of them. French, loaded, is in
// language-fr.test.js: the language is fixed when core.js loads, so it needs its own process.
import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import yaml from 'js-yaml';
// Dynamic, so setup.js has registered its resolve hook before core.js's own imports are resolved
const { getString, language, languageIndex, languageMatch } = await import('../core.js');

const dir = new URL('../languages/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''));
const load = (code) => yaml.load(readFileSync(new URL(`${code}.yaml`, dir), 'utf8'));
const catalogue = load('en');

describe('the files', () => {
  test('en.yaml maps every key to itself', () => {
    const differ = Object.entries(catalogue).filter(([k, v]) => k !== v).map(([k]) => k);
    assert.deepEqual(differ, []);
  });
  for (const code of files.filter((c) => c !== 'en')) {
    test(`${code} has every key in en.yaml, and no other`, () => {
      const words = load(code);
      assert.deepEqual(Object.keys(catalogue).filter((k) => !(k in words)), [], `missing from ${code}.yaml`);
      assert.deepEqual(Object.keys(words).filter((k) => !(k in catalogue)), [], `in ${code}.yaml but not en.yaml`);
    });
  }
  test('every language in the index has a file, and every file is in the index', () => {
    assert.deepEqual(Object.keys(languageIndex).sort(), files.sort());
  });
});

describe('choosing a language', () => {
  test('matches exactly, then on the language alone', () => {
    assert.equal(languageMatch('FR'), 'fr');
    assert.equal(languageMatch('fr-CA'), 'fr');
    assert.equal(languageMatch(' hi '), 'hi');
    assert.equal(languageMatch('fil-PH'), 'tl', 'Filipino, as browsers call Tagalog');
  });
  test('an unsupported code matches nothing', () => {
    assert.equal(languageMatch('xx'), null);
    assert.equal(languageMatch(''), null);
    assert.equal(languageMatch(null), null);
  });
  test('with no ?lang= the page is English', () => {
    assert.equal(language, 'en');
    assert.equal(document.documentElement.lang, 'en');
  });
});

describe('English', () => {
  test('a key is its own text, so nothing needs loading', () => {
    assert.equal(getString('Yes'), 'Yes');
    assert.equal(getString('Not reported recently'), 'Not reported recently');
  });
  test('a tag that is not a string comes back unchanged', () => {
    assert.equal(getString(42), 42);
  });
});
