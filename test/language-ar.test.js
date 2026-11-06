// A right-to-left page. Its own process, since the language is fixed when core.js loads.
import { dom } from './setup.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let core;
before(async () => {
  dom.reconfigure({ url: 'https://localhost:8080/dashboard/?lang=ar' });
  core = await import('../core.js');
  await import('../widgets.js');
});

test('the page is right to left', () => {
  assert.equal(document.documentElement.lang, 'ar');
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(core.getString('Yes'), 'نعم');
});

test('a reading is isolated, so its number and unit stay in order inside Arabic', () => {
  const mt = core.standaloneTopic('dev/p/n1/sht/temperature', { type: 'float', units: '°C' });
  mt.state.value = 23.5;
  assert.equal(mt.formatted, '⁦23.5°C⁩');
});

test('a name dropped into a sentence is isolated too', () => {
  assert.equal(core.getStringWith('Forget %s?', 'esp32-abc'), 'نسيان ⁦esp32-abc⁩؟');
});

test('with no flag to show, the compact picker shows the code', () => {
  const picker = document.createElement('language-picker');
  picker.setAttribute('compact', '');
  document.body.append(picker);
  assert.equal(picker.shadowRoot.querySelector('option:checked').textContent, 'AR');
});

test('a slider runs from the right, as a bar fills from the right', () => {
  document.body.innerHTML =
    '<mqtt-slider topic="dev/p/n1/sht/setpoint" min="0" max="100" value="0" type="float" label="Setpoint"></mqtt-slider>';
  const slider = document.querySelector('mqtt-slider');
  // jsdom lays nothing out, so give the track and the thumb their widths
  Object.defineProperty(slider.slider, 'offsetWidth', { value: 200 });
  Object.defineProperty(slider.thumb, 'offsetWidth', { value: 10 });
  assert.equal(slider.mirrored, true);
  slider.state.value = 0;
  assert.equal(slider.leftOffset, 195, 'the minimum is at the right-hand end');
  slider.state.value = 100;
  assert.equal(slider.leftOffset, -5, 'the maximum at the left');
  assert.equal(slider.leftToValue(195), 0, 'and dragging there gives the minimum back');
});
