// The grid and the layout store (CARDS_PLAN.md phase 6).
//
// Reordering is deliberately a model the buttons, the keyboard and the pointer drag all call into,
// so what happens is testable without layout or a pointer - jsdom has neither.
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let mock, cards;

before(async () => {
  mock = await import('./mock.js');
  cards = await import('../cards.js');
  mock.loadConfig(config);
});
beforeEach(() => { try { localStorage.clear(); } catch (e) { /* not always available */ } });

function gridFor(scenario) {
  const { projectMt } = mock.runScenario(scenario);
  const grid = document.createElement('mqtt-devicegrid');
  grid.mt = projectMt;
  document.body.append(grid);
  return { grid, projectMt };
}
const idsOf = (grid) => [...grid.querySelectorAll('mqtt-devicecard')].map((c) => c.mt.nodeId);

describe('the layout store', () => {
  test('an empty store gives a usable default', () => {
    const projectMt = { twig: 'dev/lotus' };
    assert.deepEqual(cards.layoutLoad(projectMt), { v: cards.LAYOUT_VERSION, order: [], mode: {} });
  });

  test('what is saved comes back', () => {
    const projectMt = { twig: 'dev/lotus' };
    cards.layoutSave(projectMt, { v: cards.LAYOUT_VERSION, order: ['b', 'a'], mode: { a: 'front' } });
    const back = cards.layoutLoad(projectMt);
    assert.deepEqual(back.order, ['b', 'a']);
    assert.equal(back.mode.a, 'front');
  });

  test('a layout from another version is ignored, not half-read', () => {
    const projectMt = { twig: 'dev/lotus' };
    localStorage.setItem(cards.layoutKey(projectMt), JSON.stringify({ v: 99, order: ['x'] }));
    assert.deepEqual(cards.layoutLoad(projectMt).order, []);
  });

  test('rubbish in storage does not throw', () => {
    const projectMt = { twig: 'dev/lotus' };
    localStorage.setItem(cards.layoutKey(projectMt), 'not json at all');
    assert.deepEqual(cards.layoutLoad(projectMt).order, []);
  });

  test('a project has its own layout', () => {
    assert.notEqual(cards.layoutKey({ twig: 'dev/lotus' }), cards.layoutKey({ twig: 'dev/other' }));
  });
});

describe('storage that is not there', () => {
  test('a grid still works when localStorage throws', () => {
    // Private browsing throws outright on access. A storage failure must lose the remembered
    // layout and nothing else.
    const real = globalThis.localStorage;
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true, writable: true });
    try {
      const { grid } = gridFor('every-device');
      assert.ok(idsOf(grid).length > 2, 'the grid should still build');
      const first = idsOf(grid)[0];
      grid.moveBy(first, 1);
      assert.equal(idsOf(grid)[1], first, 'and still reorder, it just will not be remembered');
      grid.remove();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true, writable: true });
    }
  });
});

describe('the grid', () => {
  test('one card per device', () => {
    const { grid, projectMt } = gridFor('every-device');
    assert.equal(idsOf(grid).length, Object.keys(projectMt.nodes).length);
    assert.ok(idsOf(grid).length > 2, 'needs enough devices to be a grid at all');
    grid.remove();
  });

  test('a small project opens its cards, a large one does not', () => {
    const one = gridFor('one-device');
    assert.equal(one.grid.querySelector('mqtt-devicecard').getAttribute('mode'), 'front');
    one.grid.remove();
    const many = gridFor('every-device');
    assert.equal(many.grid.querySelector('mqtt-devicecard').getAttribute('mode'), 'summary');
    many.grid.remove();
  });

  test('a device discovered later lands where the layout says, not at the end', () => {
    // The whole point of applying the order per arrival (O-10)
    const { grid, projectMt } = gridFor('one-device');
    grid.layout.order = ['esp8266-late', 'esp8266-fb94bb'];
    mock.deliver('dev/lotus', 'esp8266-late');
    assert.deepEqual(idsOf(grid), ['esp8266-late', 'esp8266-fb94bb']);
    grid.remove();
  });

  test('a device the layout has never seen goes to the end, disturbing nothing', () => {
    const { grid } = gridFor('every-device');
    const before = idsOf(grid);
    mock.deliver('dev/lotus', 'esp8266-newcomer');
    assert.deepEqual(idsOf(grid).slice(0, before.length), before);
    assert.equal(idsOf(grid).at(-1), 'esp8266-newcomer');
    grid.remove();
  });

  test('a remembered device that is gone is skipped, not left as a hole', () => {
    const { grid } = gridFor('one-device');
    grid.layout.order = ['esp8266-retired', 'esp8266-fb94bb'];
    grid.sync();
    assert.deepEqual(idsOf(grid), ['esp8266-fb94bb']);
    grid.remove();
  });
});

describe('reordering', () => {
  test('moving down and back up returns to where it started', () => {
    const { grid } = gridFor('every-device');
    const before = idsOf(grid);
    grid.moveBy(before[0], 1);
    assert.notDeepEqual(idsOf(grid), before);
    grid.moveBy(before[0], -1);
    assert.deepEqual(idsOf(grid), before);
    grid.remove();
  });

  test('moving past either end stays put rather than wrapping', () => {
    const { grid } = gridFor('every-device');
    const before = idsOf(grid);
    grid.moveBy(before[0], -1);
    assert.deepEqual(idsOf(grid), before, 'the first card cannot go up');
    grid.moveBy(before.at(-1), 1);
    assert.deepEqual(idsOf(grid), before, 'the last cannot go down');
    grid.remove();
  });

  test('moveOver puts one card where another is - what a drag amounts to', () => {
    const { grid } = gridFor('every-device');
    const ids = idsOf(grid);
    grid.moveOver(ids[5], ids[1]);
    assert.deepEqual(idsOf(grid).slice(0, 3), [ids[0], ids[5], ids[1]]);
    grid.remove();
  });

  test('a drag downwards moves the card, which it did not', () => {
    // Reading the target's index after removing the dragged card made this a no-op: taking A out of
    // [A,B,C] leaves B at 0, and putting A back at 0 changes nothing at all
    const { grid } = gridFor('every-device');
    const ids = idsOf(grid);
    grid.moveOver(ids[0], ids[1]);
    assert.deepEqual(idsOf(grid).slice(0, 2), [ids[1], ids[0]]);
    grid.remove();
  });

  test('a drag upwards moves it too, so the two directions agree', () => {
    const { grid } = gridFor('every-device');
    const ids = idsOf(grid);
    grid.moveOver(ids[3], ids[0]);
    assert.deepEqual(idsOf(grid).slice(0, 2), [ids[3], ids[0]]);
    grid.remove();
  });

  test('the order survives being rebuilt from storage', () => {
    const { grid, projectMt } = gridFor('every-device');
    const moved = grid.moveBy(idsOf(grid)[0], 3);
    grid.remove();
    const again = document.createElement('mqtt-devicegrid');
    again.mt = projectMt;
    document.body.append(again);
    assert.deepEqual(idsOf(again), moved);
    again.remove();
  });

  test('the buttons and the keyboard go through the same model', () => {
    const { grid } = gridFor('every-device');
    const first = idsOf(grid)[0];
    grid.querySelector('mqtt-devicecard').querySelector('.fi-btn--move:last-of-type')
      || grid.querySelector('.fi-btn--move');
    const card = grid.querySelector('mqtt-devicecard');
    [...card.querySelectorAll('.fi-btn--move')][1].click();  // ▼
    assert.equal(idsOf(grid)[1], first, 'the button did not move it');

    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.ok(card.classList.contains('fi-grabbed'), 'space should pick it up');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(idsOf(grid)[0], first, 'the keyboard did not move it back');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.ok(!card.classList.contains('fi-grabbed'), 'space should put it down');
    grid.remove();
  });

  test('arrows do nothing until the card is picked up', () => {
    const { grid } = gridFor('every-device');
    const before = idsOf(grid);
    const card = grid.querySelector('mqtt-devicecard');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.deepEqual(idsOf(grid), before);
    grid.remove();
  });

  test('a pointer drag reorders, hit-testing past the card being dragged', () => {
    // jsdom has no layout, so elementFromPoint is stubbed to behave as a browser does: the dragged
    // card is under the pointer, and is only seen past once it takes itself out of hit-testing.
    const { grid } = gridFor('every-device');
    const ids = idsOf(grid);
    const [dragged, target] = [...grid.querySelectorAll('mqtt-devicecard')];
    const realEFP = document.elementFromPoint;
    document.elementFromPoint = () => (dragged.style.pointerEvents === 'none') ? target : dragged;
    // Dispatched as real events rather than by calling the handlers, so this covers the wiring as
    // well as the logic - the handler was once perfectly correct and simply never connected
    const at = (type, y, target) => target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, button: 0, clientX: 0, clientY: y }));
    try {
      at('pointerdown', 0, dragged);
      at('pointermove', 40, document);
      assert.deepEqual(idsOf(grid).slice(0, 2), [ids[1], ids[0]], 'the drag did not move it');
      // Reordering re-appends the card, which disconnects and reconnects it. The drag has to
      // survive that or it dies after one step.
      assert.ok(dragged.classList.contains('fi-dragging'), 'the reorder killed the drag');
      at('pointermove', 80, document);
      assert.ok(dragged.state.drag && dragged.state.drag.active, 'the drag stopped after one move');
      at('pointerup', 80, document);
      assert.ok(!dragged.classList.contains('fi-dragging'), 'the drag never ended');
    } finally {
      document.elementFromPoint = realEFP;
    }
    grid.remove();
  });

  test('a touch that turns into a scroll does not drag', () => {
    const { grid } = gridFor('every-device');
    const before = idsOf(grid);
    const card = grid.querySelector('mqtt-devicecard');
    // pointerType only exists on a real PointerEvent, which jsdom does not implement, so the touch
    // path is driven through the handlers directly
    card.onPointerDown({ button: 0, pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
    card.onPointerMove({ pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 60 }); // finger moved first
    assert.ok(!card.classList.contains('fi-dragging'));
    assert.deepEqual(idsOf(grid), before);
    grid.remove();
  });

  test('opening a card is remembered', () => {
    const { grid, projectMt } = gridFor('every-device');
    const card = grid.querySelector('mqtt-devicecard');
    card.setAttribute('mode', 'front');
    assert.equal(cards.layoutLoad(projectMt).mode[card.mt.nodeId], 'front');
    grid.remove();
  });
});
