// The light-DOM rendering path, which the cards depend on (CARDS_PLAN.md phase 1).
// HTMLElementExtendedMinimum attaches no shadow root, so renderAndReplace must render into the
// element itself; HTMLElementExtended must keep rendering into its shadow root exactly as before.
import './setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

let EL, HTMLElementExtended, HTMLElementExtendedMinimum;

before(async () => {
  ({ EL, HTMLElementExtended, HTMLElementExtendedMinimum } =
    await import('/node_modules/html-element-extended/htmlelementextended.js'));

  class LightThing extends HTMLElementExtendedMinimum {
    static get observedAttributes() { return ['label']; }
    render() { return EL('div', { class: 'inner', textContent: this.state.label || 'unset' }); }
  }
  customElements.define('light-thing', LightThing);

  class ShadowThing extends HTMLElementExtended {
    render() { return EL('div', { class: 'inner', textContent: 'shadowed' }); }
  }
  customElements.define('shadow-thing', ShadowThing);
});

describe('light DOM (HTMLElementExtendedMinimum)', () => {
  test('renders into the element itself, with no shadow root', () => {
    const el = document.createElement('light-thing');
    document.body.append(el);
    assert.equal(el.shadowRoot, null);
    assert.equal(el.renderRoot, el);
    assert.equal(el.querySelector('.inner').textContent, 'unset');
    el.remove();
  });

  test('re-rendering replaces the previous children rather than appending', () => {
    const el = document.createElement('light-thing');
    document.body.append(el);
    el.setAttribute('label', 'first');
    el.setAttribute('label', 'second');
    assert.equal(el.querySelectorAll('.inner').length, 1);
    assert.equal(el.querySelector('.inner').textContent, 'second');
    el.remove();
  });
});

describe('shadow DOM (HTMLElementExtended) is unaffected', () => {
  test('still renders into the shadow root, not the element', () => {
    const el = document.createElement('shadow-thing');
    document.body.append(el);
    assert.ok(el.shadowRoot);
    assert.equal(el.renderRoot, el.shadowRoot);
    assert.equal(el.shadowRoot.querySelector('.inner').textContent, 'shadowed');
    assert.equal(el.querySelector('.inner'), null); // nothing leaked into the light DOM
    el.remove();
  });
});
