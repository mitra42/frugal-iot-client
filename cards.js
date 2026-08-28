/*
 * Frugal IoT client - the device card: one card per device, in three modes.
 *
 *   summary  a line: is it alive, and roughly what is it saying
 *   front    the readings and controls that matter, watchable at a glance
 *   back     settings and background - see CARDS_UX.md section 3
 *
 * Light DOM, not shadow DOM (CARDS_UX.md O-2), so the card is styled from frugaliot.css like any
 * other page content. That means it must render every one of its own children - renderAndReplace
 * clears its render root, and <slot> means nothing here.
 *
 * Everything it displays comes from getters on the data tree (nodeMt.summaryChips, .frontRows,
 * .status), never from walking the tree itself. If this file starts traversing groups and topics,
 * the logic has been put in the wrong place.
 */
import { HTMLElementExtendedMinimum } from '/node_modules/html-element-extended/htmlelementextended.js';
import { el, getString, ImagesUrl, relativeTime, server_config, XXX } from './core.js';

// Shape as well as colour, so status survives sunlight and colour blindness
const STATUS_MARK = { live: '●', stale: '◌', offline: '○', never: '·' };

class MqttDeviceCard extends HTMLElementExtendedMinimum {
  static get observedAttributes() { return ['mode', 'movable']; }
  static get boolAttributes() { return ['movable']; }

  constructor() {
    super();
    this.state.elements = {};
    this.state.mode = 'summary';
    this.onGroupChanged = this.onGroupChanged.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    // Every message fires this, in both the element and the headless paths, so it is the one signal
    // a card needs. Filtered to this device below.
    document.addEventListener('frugaliot:groupchanged', this.onGroupChanged);
    this.addEventListener('keydown', this.onKeyDown);
    // Not via el(): EL only assigns onclick, onchange and onsubmit as properties - any other
    // function it is handed goes into el.state and is never wired up at all.
    this.addEventListener('pointerdown', this.onPointerDown);
  }
  disconnectedCallback() {
    document.removeEventListener('frugaliot:groupchanged', this.onGroupChanged);
    this.removeEventListener('keydown', this.onKeyDown);
    this.removeEventListener('pointerdown', this.onPointerDown);
    // Deliberately not endDrag(): reordering re-appends the cards, so the one being dragged is
    // disconnected and reconnected on its very first move. Ending the drag there killed it after a
    // single step, which looked from the outside like dragging not working at all. The drag lives
    // on document listeners so it survives being re-parented, and pointerup is what ends it.
  }
  changeAttribute(name, valueString) {
    const rerender = super.changeAttribute(name, valueString);
    // Tell whoever is arranging these that this one opened or closed, so it can be remembered
    if ((name === 'mode') && this.mt) {
      this.dispatchEvent(new CustomEvent('frugaliot:cardmode', {
        bubbles: true, detail: { nodeId: this.mt.nodeId, mode: valueString },
      }));
    }
    return rerender;
  }
  onGroupChanged(e) {
    if (e.detail && (e.detail.nodeMt === this.mt)) this.refresh();
  }

  get nodeMt() { return this.mt; }
  get mode() { return this.state.mode || 'summary'; }
  set mode(m) { this.setAttribute('mode', m); }

  // How long since it last said anything. Shown whenever it is not live, because that is exactly
  // when someone needs to know.
  get ageText() {
    const age = this.nodeMt.age;
    return (age === null) ? getString('Never seen') : relativeTime(age);
  }
  // Just the icon on the summary - it is a glanceable view, and the level is in the icon's shape.
  // The percentage is on the title, and appears as text on the front.
  renderBattery() {
    const battery = this.nodeMt.battery;
    if (!battery || (battery.level === null)) return null;
    return el('img', {
      class: 'fi-battery',
      src: `${ImagesUrl}Battery${battery.level}.png`,
      alt: `${getString('Battery')} ${battery.percent}%`,
      title: `${battery.mt.formatted} (${battery.percent}%)`,
      i8n: false,
    });
  }

  // Update in place rather than re-rendering: a full render would rebuild any child elements and
  // break their binding to the data tree.
  refresh() {
    const e = this.state.elements;
    const nodeMt = this.nodeMt;
    if (!e.card) return;
    e.card.className = `fi-card fi-card--${this.mode} fi-status-${nodeMt.status}`;
    if (e.status) {
      e.status.textContent = STATUS_MARK[nodeMt.status];
      e.status.setAttribute('title', getString(nodeMt.status));
    }
    if (e.name) e.name.textContent = nodeMt.usableName;
    if (e.meta) e.meta.replaceChildren(...this.renderMeta());
    if (e.chips) e.chips.replaceChildren(...this.renderChips());
    if (e.footer) e.footer.replaceChildren(...this.renderFooter().childNodes);
    // Push values into the widgets rather than letting them subscribe, so nothing competes for
    // mt.element - see widgetFor
    (e.widgets || []).forEach(({ row, widget }) => {
      if (row.mt.state.value !== undefined) widget.valueSet(row.mt.state.value);
      widget.parentElement?.classList.toggle('fi-row--outofrange', row.mt.outOfRange);
    });
    // A row can appear or disappear - a sensor starts reporting, a control gets wired
    if (e.rows && (e.widgets.length !== nodeMt.frontRows.filter((r) => r.mt).length)) this.renderAndReplace();
  }

  renderMeta() {
    return [
      this.renderBattery(),
      (this.nodeMt.status === 'live') ? null : el('span', { class: 'fi-age', i8n: false, textContent: this.ageText }),
    ].filter(Boolean);
  }

  // ===== being moved =====
  //
  // Three ways to reorder, all ending in the same event so the grid decides what it means:
  // the ▲▼ buttons, the keyboard, and dragging. The buttons are not a fallback nobody uses - on a
  // low-end phone they are more reliable than a long-press (D-13).

  requestMove(delta) {
    this.dispatchEvent(new CustomEvent('frugaliot:cardmove', {
      bubbles: true, detail: { nodeId: this.mt.nodeId, delta },
    }));
  }
  requestMoveOver(targetNodeId) {
    if (targetNodeId === this.mt.nodeId) return;
    this.dispatchEvent(new CustomEvent('frugaliot:cardmoveover', {
      bubbles: true, detail: { nodeId: this.mt.nodeId, targetNodeId },
    }));
  }

  renderMoveButtons() {
    if (!this.state.movable) return [];
    return [
      el('button', { class: 'fi-btn fi-btn--move', title: getString('Move up'), i8n: false, textContent: '▲',
        onclick: (e) => { e.stopPropagation(); this.requestMove(-1); } }),
      el('button', { class: 'fi-btn fi-btn--move', title: getString('Move down'), i8n: false, textContent: '▼',
        onclick: (e) => { e.stopPropagation(); this.requestMove(1); } }),
    ];
  }

  // Space to pick up, arrows to move, Space or Escape to put down - the same shape as a drag, for
  // someone who cannot make one.
  onKeyDown(e) {
    if (!this.state.movable) return;
    if (e.key === ' ') {
      e.preventDefault();
      this.setGrabbed(!this.state.grabbed);
      return;
    }
    if (!this.state.grabbed) return;
    if (e.key === 'Escape') { this.setGrabbed(false); return; }
    const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    this.requestMove(delta);
  }
  setGrabbed(on) {
    this.state.grabbed = on;
    this.classList.toggle('fi-grabbed', on);
  }

  // Pointer Events rather than HTML5 drag-and-drop, which is unreliable on Android - the platform
  // this has to work on. Touch needs a hold first, or the page cannot be scrolled.
  onPointerDown(e) {
    if (!this.state.movable || (e.button !== undefined && e.button !== 0)) return;
    this.state.drag = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
    if (e.pointerType === 'touch') {
      this.state.drag.timer = setTimeout(() => this.beginDrag(e), 400); // hold to lift
    }
    // On document, not on the card: a reorder re-parents the card mid-drag, and listeners on it
    // would go with it
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('pointercancel', this.onPointerUp);
  }
  beginDrag(e) {
    if (!this.state.drag) return;
    this.state.drag.active = true;
    this.classList.add('fi-dragging');
    // No setPointerCapture: capture is lost the moment the card is re-parented by a reorder, and
    // the document listeners below do the same job without that problem.
  }
  onPointerMove(e) {
    const drag = this.state.drag;
    if (!drag) return;
    if (!drag.active) {
      const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      if (e.pointerType === 'touch') { if (moved > 10) this.endDrag(); return; } // a scroll, not a drag
      if (moved < 6) return;                                                     // not yet a drag
      this.beginDrag(e);
    }
    // Hit-testing while the dragged card is under the pointer finds the dragged card, so take it
    // out of the way for the one call
    this.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    this.style.pointerEvents = '';
    const other = under && under.closest && under.closest('mqtt-devicecard');
    if (other && (other !== this) && other.mt) this.requestMoveOver(other.mt.nodeId);
  }
  onPointerUp() { this.endDrag(); }
  endDrag() {
    if (this.state.drag) clearTimeout(this.state.drag.timer);
    this.state.drag = null;
    this.classList.remove('fi-dragging');
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('pointercancel', this.onPointerUp);
  }

  // ===== front =====
  //
  // Each row is built from a resolved entry of nodeMt.frontRows, and the widgets are the ones the
  // rest of the client already uses. Deliberately NOT bound as mt.element: only one element can hold
  // that at a time, so binding would mean this card fighting a graph, a second card, or the old UI
  // for the same topic. The card pushes new values into its own children in refresh() instead.
  widgetFor(row, extra = {}) {
    const mt = row.mt;
    const common = {
      ...extra,
      topic: mt.topicPath, label: row.label, type: mt.type, color: mt.color,
      value: (mt.state.value === undefined) ? undefined : String(mt.state.value),
      graphable: mt.graphable ? 'true' : undefined,
    };
    const ranged = { ...common };
    if (mt.min !== undefined) ranged.min = String(mt.min);
    if (mt.max !== undefined) ranged.max = String(mt.max);
    let widget;
    switch (mt.display) {
      case 'bar':    widget = el('mqtt-bar', ranged, []); break;
      case 'gauge':  widget = el('mqtt-gauge', ranged, []); break;
      case 'toggle': widget = el('mqtt-toggle', common, []); break;
      case 'slider': widget = el('mqtt-slider', ranged, []); break;
      case 'color':  widget = el('mqtt-color', common, []); break;
      case 'text':   widget = el('mqtt-text', ranged, []); break;
      default:
        XXX(['No widget for display', mt.display, 'on', mt.topicPath]);
        return el('div', { class: 'fi-row__unknown', i8n: false, textContent: `${row.label}: ${mt.formatted}` });
    }
    widget.mt = mt; // Pre-bind so connectedCallback does not fabricate a topic of its own
    return widget;
  }

  renderFrontRow(row) {
    if (row.kind === 'control') {
      // Read-only here: the rule and what it produced. Editing it is the back's job.
      return el('div', { class: 'fi-row fi-row--control' }, [
        el('span', { class: 'fi-row__label', i8n: false, textContent: row.label }),
        el('span', { class: 'fi-row__rule', i8n: false, textContent: row.groupMt.summaryText() }),
      ]);
    }
    const widget = this.widgetFor(row);
    this.state.elements.widgets.push({ row, widget });
    return el('div', {
      class: `fi-row fi-row--${row.kind}${row.mt.outOfRange ? ' fi-row--outofrange' : ''}`,
    }, [widget]);
  }

  renderFront() {
    this.state.elements.widgets = [];
    return [
      this.renderHead(),
      this.state.elements.rows = el('div', { class: 'fi-card__rows' },
        this.nodeMt.frontRows.map((row) => this.renderFrontRow(row))),
      this.renderFooter(),
    ];
  }

  // ===== back =====
  //
  // Flat sections in a fixed order - Device, Controls, Readings by module, Advanced - and no
  // drop-downs except Advanced. Someone who has turned a card over wants everything about it
  // (CARDS_UX.md 3.3), so hiding it behind more clicks defeats the point.
  //
  // Editing is not gated yet: the WRITE capability arrives in CARDS_PLAN.md phase 8, and until then
  // this is as editable as the existing UI is.

  section(title, rows) {
    const kept = rows.filter(Boolean);
    if (!kept.length) return null;
    return el('section', { class: 'fi-section' }, [
      el('h4', { class: 'fi-section__title', textContent: title }),
      ...kept,
    ]);
  }
  // One labelled line. `value` may be a string or an element.
  field(label, value) {
    if (value === null || value === undefined || value === '') return null;
    return el('div', { class: 'fi-field' }, [
      el('span', { class: 'fi-field__label', textContent: label }),
      (typeof value === 'string')
        ? el('span', { class: 'fi-field__value', i8n: false, textContent: value })
        : el('span', { class: 'fi-field__value' }, [value]),
    ]);
  }
  // The widget for a topic, labelled by hand rather than by the topic's own name
  widgetForTopic(mt, label, extra) {
    return this.widgetFor({ mt, label, kind: (mt.rw === 'w') ? 'actuator' : 'reading' }, extra);
  }

  renderDeviceSection() {
    const nodeMt = this.nodeMt;
    const fi = nodeMt.groups.frugal_iot;
    const health = nodeMt.groups.health;
    const ota = nodeMt.groups.ota;
    const battery = nodeMt.battery;
    const wifi = health && [health.topics.wifibars, health.topics.wifissid]
      .map((mt) => mt && mt.formatted).filter(Boolean).join(' ');
    return this.section(getString('Device'), [
      fi && fi.topics.name ? this.field(getString('Name'), this.widgetForTopic(fi.topics.name, '')) : null,
      fi && fi.topics.description ? this.field(getString('Description'), this.widgetForTopic(fi.topics.description, '')) : null,
      this.field(getString('Node ID'), nodeMt.nodeId),
      this.field(getString('Last seen'), this.ageText),
      battery ? this.field(getString('Battery'), `${battery.mt.formatted} (${battery.percent}%)`) : null,
      wifi ? this.field(getString('WiFi'), wifi) : null,
      ota && ota.topics.key ? this.field(getString('OTA Key'), ota.topics.key.state.value) : null,
    ]);
  }

  // The compact form from dashboard_example: [>] [32.0] ± [3.0], rather than a labelled row each
  // for direction, limit and hysteresis (D-19).
  renderControlSection(groupId, groupMt) {
    const t = groupMt.topics;
    const hyst = t.hysteresis || t.hysterisis;
    const when = [t.greater, t.limit, hyst].some(Boolean) ? el('div', { class: 'fi-when' }, [
      t.greater ? this.compact(t.greater, { labels: '<,>' }) : null,
      t.limit ? this.compact(t.limit, {}) : null,
      hyst ? el('span', { class: 'fi-when__pm', i8n: false, textContent: '±' }) : null,
      hyst ? this.compact(hyst, {}) : null,
    ].filter(Boolean)) : null;
    return this.section(groupMt.state.name || groupId, [
      t.now ? this.field(getString('Input'), this.widgetForTopic(t.now, '', { wiring: 'open' })) : null,
      when ? this.field(getString('When'), when) : null,
      t.out ? this.field(getString('Output'), this.widgetForTopic(t.out, '', { wiring: 'open' })) : null,
      t.manual ? this.field(getString('Manual'), this.widgetForTopic(t.manual, '')) : null,
    ]);
  }
  // A bare input with no label of its own, for the inline "when" row
  compact(mt, extra) {
    const widget = el(mt.type === 'bool' ? 'mqtt-toggle' : 'mqtt-text', {
      topic: mt.topicPath, label: '', type: mt.type, wiring: 'none',
      value: (mt.state.value === undefined) ? undefined : String(mt.state.value),
      ...extra,
    }, []);
    widget.mt = mt;
    this.state.elements.widgets.push({ row: { mt }, widget });
    return widget;
  }

  renderReadingSection(groupId, groupMt) {
    return this.section(groupMt.state.name || groupId,
      Object.values(groupMt.topics).map((mt) => {
        const widget = this.widgetForTopic(mt, mt.name);
        this.state.elements.widgets.push({ row: { mt }, widget });
        return el('div', {
          class: `fi-field fi-field--reading${mt.outOfRange ? ' fi-row--outofrange' : ''}`,
        }, [widget]);
      }));
  }

  // Anything the device publishes that modules.yaml does not describe. Shown, not swallowed:
  // developers add modules, and until the schema catches up this is the only place the readings
  // appear at all.
  renderUnrecognisedSection() {
    const unknown = this.nodeMt.unrecognisedTopics;
    if (!unknown.length) return null;
    return this.section(getString('Not in the schema'),
      unknown.map((u) => this.field(u.twig, String(u.value))));
  }

  // The one thing still collapsed: paths and internals, for debugging rather than for the field
  renderAdvanced() {
    const nodeMt = this.nodeMt;
    return el('details', { class: 'fi-advanced' }, [
      el('summary', { textContent: getString('Advanced') }),
      this.field(getString('Topic'), nodeMt.topicPath),
      this.field(getString('OTA Key'), nodeMt.otaKey),
      this.field(getString('Reporting every'), nodeMt.expectedInterval
        ? `${Math.round(nodeMt.expectedInterval / 1000)}s` : getString('Unknown')),
    ]);
  }

  get backGroups() {
    const nodeMt = this.nodeMt;
    return nodeMt.orderedGroupIds
      .map((groupId) => [groupId, nodeMt.groups[groupId]])
      .filter(([groupId]) => (groupId !== 'frugal_iot') && !nodeMt.isStatusStripGroup(groupId));
  }

  renderBack() {
    this.state.elements.widgets = [];
    const groups = this.backGroups;
    return [
      this.renderHead(),
      el('div', { class: 'fi-card__sections' }, [
        this.renderDeviceSection(),
        ...groups.filter(([id]) => id.startsWith('control')).map(([id, g]) => this.renderControlSection(id, g)),
        ...groups.filter(([id]) => !id.startsWith('control')).map(([id, g]) => this.renderReadingSection(id, g)),
        this.renderUnrecognisedSection(),
        this.renderAdvanced(),
      ].filter(Boolean)),
    ];
  }

  // Battery and last-seen, small and grey, always present
  renderFooter() {
    const nodeMt = this.nodeMt;
    const battery = nodeMt.battery;
    return this.state.elements.footer = el('div', { class: 'fi-card__foot' }, [
      battery ? el('span', { class: 'fi-foot__battery', i8n: false, textContent: battery.mt.formatted }) : null,
      el('span', { class: 'fi-foot__age', i8n: false, textContent: this.ageText }),
    ].filter(Boolean));
  }

  renderChips() {
    return this.nodeMt.summaryChips.map((chip) =>
      el('span', { class: 'fi-chip', i8n: false, textContent: chip.text }));
  }

  renderHead() {
    const nodeMt = this.nodeMt;
    return el('div', { class: 'fi-card__head' }, [
      this.state.elements.status = el('span', {
        class: 'fi-status', i8n: false,
        textContent: STATUS_MARK[nodeMt.status], title: getString(nodeMt.status),
      }),
      this.state.elements.name = el('span', { class: 'fi-card__name', i8n: false, textContent: nodeMt.usableName }),
      this.state.elements.meta = el('span', { class: 'fi-card__meta' }, this.renderMeta()),
      ...this.renderMoveButtons(),
      ...((this.mode === 'summary') ? [] : [
        // No gear on the back - that is where the gear goes, so it would do nothing
        (this.mode === 'front') ? el('button', {
          class: 'fi-btn', title: getString('Settings'), i8n: false, textContent: '⚙',
          onclick: (e) => { e.stopPropagation(); this.mode = 'back'; },
        }) : null,
        // A close mark, not a chevron - "⌄" reads as "there is more below", the opposite of what it
        // does. It returns to wherever you came from: the front from the back, the summary from the
        // front.
        el('button', {
          class: 'fi-btn fi-btn--close', title: getString('Collapse'), i8n: false, textContent: '✕',
          onclick: (e) => { e.stopPropagation(); this.mode = (this.mode === 'back') ? 'front' : 'summary'; },
        }),
      ].filter(Boolean)),
    ]);
  }

  renderSummary() {
    return [
      this.renderHead(),
      this.state.elements.chips = el('div', { class: 'fi-card__chips' }, this.renderChips()),
    ];
  }

  render() {
    if (!this.mt) return null; // Not bound to a device yet
    this.state.elements = {};
    // front and back are built next - see CARDS_PLAN.md phase 5, which does the modes in order.
    // Until then every mode shows the summary, so the mode attribute and its class are already real.
    const body = (this.mode === 'summary') ? this.renderSummary()
      : (this.mode === 'back') ? this.renderBack()
      : this.renderFront();
    if (this.state.movable && !this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    return this.state.elements.card = el('div', {
      class: `fi-card fi-card--${this.mode} fi-status-${this.nodeMt.status}`,
      onclick: () => { if (this.mode === 'summary') this.mode = 'front'; }, // only the summary is one target
    }, body);
  }
}
customElements.define('mqtt-devicecard', MqttDeviceCard);


/* ===========================================================================
 * Layout store
 *
 * Which cards are in what order, and which are open. Local presentation, not a change to anything
 * in the system, so it stays in this browser and needs no WRITE capability (CARDS_UX.md 10.2).
 *
 * Every access is wrapped: localStorage throws outright in some private-browsing modes, and a
 * storage failure must degrade to "no remembered layout", never to a broken grid.
 * ======================================================================== */
const LAYOUT_VERSION = 1;
const layoutDefault = () => ({ v: LAYOUT_VERSION, order: [], mode: {} });

function layoutKey(projectMt) {
  return `frugaliot:layout:v${LAYOUT_VERSION}:${projectMt.twig}`;
}
function layoutLoad(projectMt) {
  try {
    const raw = localStorage.getItem(layoutKey(projectMt));
    if (!raw) return layoutDefault();
    const parsed = JSON.parse(raw);
    // A layout written by a future version, or by something else entirely, is not ours to read
    if (!parsed || (parsed.v !== LAYOUT_VERSION)) return layoutDefault();
    return { v: LAYOUT_VERSION, order: Array.isArray(parsed.order) ? parsed.order : [],
             mode: (parsed.mode && typeof parsed.mode === 'object') ? parsed.mode : {} };
  } catch (e) {
    return layoutDefault();
  }
}
function layoutSave(projectMt, layout) {
  try {
    localStorage.setItem(layoutKey(projectMt), JSON.stringify(layout));
    return true;
  } catch (e) {
    return false; // Out of quota, or storage blocked - the grid still works, it just forgets
  }
}

/* ===========================================================================
 * The grid
 *
 * Renders once (render0) and mutates in place afterwards, because a light-DOM element's
 * renderAndReplace clears its own children - which here are the cards. See CARDS_PLAN.md phase 1.
 * ======================================================================== */
class MqttDeviceGrid extends HTMLElementExtendedMinimum {
  constructor() {
    super();
    this.state.cards = new Map();  // nodeId -> mqtt-devicecard
    this.onTopicsChanged = this.onTopicsChanged.bind(this);
    this.onCardMove = this.onCardMove.bind(this);
    this.onCardMoveOver = this.onCardMoveOver.bind(this);
    this.onModeChanged = this.onModeChanged.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    // Nodes arrive over time, so the order has to be applied per arrival rather than once (O-10)
    document.addEventListener('frugaliot:topicschanged', this.onTopicsChanged);
    this.addEventListener('frugaliot:cardmove', this.onCardMove);
    this.addEventListener('frugaliot:cardmoveover', this.onCardMoveOver);
    this.addEventListener('frugaliot:cardmode', this.onModeChanged);
    this.sync();
  }
  disconnectedCallback() {
    document.removeEventListener('frugaliot:topicschanged', this.onTopicsChanged);
  }
  onTopicsChanged() { this.sync(); }

  get projectMt() { return this.mt; }
  get layout() { return this.state.layout || (this.state.layout = layoutLoad(this.projectMt)); }
  save() { layoutSave(this.projectMt, this.layout); }

  render0() {
    return el('div', { class: 'fi-grid__hint', hidden: true }); // Cards are appended, not rendered
  }

  // The order cards should appear in: remembered ones first, in the remembered order, then any the
  // layout has not seen. A device retired since the layout was saved simply is not there any more.
  orderedNodeIds() {
    if (!this.projectMt) return [];
    const known = Object.keys(this.projectMt.nodes);
    const remembered = this.layout.order.filter((id) => known.includes(id));
    return remembered.concat(known.filter((id) => !remembered.includes(id)));
  }

  // Add cards for devices that have appeared, and put every card in its place. Called on each
  // arrival, so a device discovered late lands where the layout says rather than at the end.
  sync() {
    if (!this.projectMt) return;
    const order = this.orderedNodeIds();
    order.forEach((nodeId) => {
      if (!this.state.cards.has(nodeId)) this.state.cards.set(nodeId, this.makeCard(nodeId));
    });
    // Drop cards for devices that are gone, so nothing stale keeps listening
    [...this.state.cards.keys()].filter((id) => !order.includes(id)).forEach((id) => {
      this.state.cards.get(id).remove();
      this.state.cards.delete(id);
    });
    order.forEach((nodeId) => this.append(this.state.cards.get(nodeId))); // append moves in place
  }

  makeCard(nodeId) {
    const nodeMt = this.projectMt.nodes[nodeId];
    const card = el('mqtt-devicecard', { mode: this.initialMode(nodeId), movable: true });
    card.mt = nodeMt;
    return card;
  }
  // A remembered mode, else the front for a project small enough that a grid of summaries would be
  // a wasted screen (D-15). Only decided when the card is made - cards collapsing as siblings
  // arrive would be worse than a stale choice.
  initialMode(nodeId) {
    const remembered = this.layout.mode[nodeId];
    if (remembered) return remembered;
    return (Object.keys(this.projectMt.nodes).length <= 2) ? 'front' : 'summary';
  }

  onModeChanged(e) {
    this.layout.mode[e.detail.nodeId] = e.detail.mode;
    this.save();
  }

  // ===== reordering =====
  //
  // One model, three ways in: the buttons, the keyboard and the pointer drag all end up here, so
  // what happens is testable without needing layout or a pointer.

  get currentOrder() { return this.orderedNodeIds(); }

  moveTo(nodeId, index) {
    const order = this.currentOrder.filter((id) => id !== nodeId);
    const at = Math.max(0, Math.min(order.length, index));
    order.splice(at, 0, nodeId);
    this.layout.order = order;
    this.save();
    this.sync();
    return order;
  }
  moveBy(nodeId, delta) {
    const order = this.currentOrder;
    const from = order.indexOf(nodeId);
    if (from === -1) return order;
    return this.moveTo(nodeId, from + delta);
  }
  // Put one card where another currently is. The target's index has to be read BEFORE the dragged
  // card is taken out of the list, or dragging downwards never gets anywhere: removing A from
  // [A,B,C] leaves B at index 0, and inserting A at 0 puts it straight back.
  moveOver(nodeId, targetNodeId) {
    const at = this.currentOrder.indexOf(targetNodeId);
    return (at === -1) ? this.currentOrder : this.moveTo(nodeId, at);
  }

  onCardMoveOver(e) {
    e.stopPropagation();
    this.moveOver(e.detail.nodeId, e.detail.targetNodeId);
  }
  onCardMove(e) {
    e.stopPropagation();
    this.moveBy(e.detail.nodeId, e.detail.delta);
    // Keep the focus on the card that moved, or a run of presses walks away from it
    const card = this.state.cards.get(e.detail.nodeId);
    if (card) card.focus();
  }
}
customElements.define('mqtt-devicegrid', MqttDeviceGrid);



/* ===========================================================================
 * The project: a grid of device cards on the front, the administration on the back.
 *
 * The card metaphor one level up (CARDS_UX.md 11). What used to be <mqtt-admin>'s tabs are cards
 * here, each shown only if the user's capabilities allow it - and the gear is omitted entirely when
 * that leaves nothing, rather than opening an empty back (D-29).
 * ======================================================================== */

// Which admin card needs which capability. Deliberately the same gating the tabs already had:
// widening who can see an organization's inventory is not something a card redesign should do.
const ADMIN_CARDS = [
  { section: 'ota',   title: 'OTA',             capability: 'OTAUPDATE' },
  { section: 'flash', title: 'Flash over USB',  capability: 'OTAFLASH' },
  { section: 'admin', title: 'Permissions',     capability: 'ADMIN' },
  { section: 'nodes', title: 'Nodes',           capability: 'ADMIN' },
  { section: 'api',   title: 'API',             capability: 'ADMIN' },
];

// The user's capabilities for an organization, from the permissions the server sent
function hasCapability(org, capability) {
  const perms = (server_config && server_config.user && server_config.user.permissions) || [];
  return perms.some((p) => (p.capability === capability) && (p.org === org));
}
function adminCardsFor(org) {
  return ADMIN_CARDS.filter((c) => hasCapability(org, c.capability));
}

class MqttProjectBack extends HTMLElementExtendedMinimum {
  static get observedAttributes() { return ['organization']; }

  constructor() {
    super();
    this.state.elements = {};
    this.state.open = {};
  }

  // An admin card has a summary and a back, and nothing that makes sense as a front: it is its name
  // until you open it. Seven expanded at once is a wall of forms.
  // The content is built on first open and then kept, so switching between cards does not discard a
  // half-filled form - and an unopened card costs nothing.
  toggle(section) {
    const open = !this.state.open[section];
    this.state.open[section] = open;
    const card = this.state.elements[section];
    if (open && !card.querySelector('mqtt-admin')) {
      // The existing admin element renders the section - none of it is redesigned (D-30)
      card.append(el('mqtt-admin', { section, org: this.state.organization }));
    }
    card.classList.toggle('fi-admincard--open', open);
  }

  render() {
    const cards = adminCardsFor(this.state.organization);
    if (!cards.length) return null; // The gear should not have been offered at all
    return el('div', { class: 'fi-adminwrap' }, cards.map((c) =>
      this.state.elements[c.section] = el('section', { class: 'fi-card fi-admincard' }, [
        el('button', { class: 'fi-admincard__head', type: 'button', textContent: c.title,
          onclick: () => this.toggle(c.section) }),
      ])));
  }
}
customElements.define('mqtt-projectback', MqttProjectBack);

export { MqttDeviceCard, MqttDeviceGrid, MqttProjectBack, MqttDashboard,
  adminCardsFor, hasCapability, layoutLoad, layoutSave, layoutKey, LAYOUT_VERSION };

/* ===========================================================================
 * The page.
 *
 * A thin shell: the wrapper supplies the organization and project selectors, the broker connection
 * and the data tree; this decides what fills the space below them - the grid of device cards, the
 * administration on the back, or one of the states where there is nothing to show yet (8.1).
 * ======================================================================== */
class MqttDashboard extends HTMLElementExtendedMinimum {
  static get observedAttributes() { return ['organization', 'project', 'mode']; }

  constructor() {
    super();
    this.state.elements = {};
    this.state.mode = 'front';
    this.onProjectChanged = this.onProjectChanged.bind(this);
    this.onOrganizationChanged = this.onOrganizationChanged.bind(this);
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('frugaliot:projectchanged', this.onProjectChanged);
    document.addEventListener('frugaliot:topicschanged', this.onProjectChanged);
    document.addEventListener('frugaliot:organizationchanged', this.onOrganizationChanged);
    // CSS cannot set an attribute, and the language name has to actually leave the DOM rather than
    // be hidden, or the select stays as wide as its longest option
    if (window.matchMedia) {
      this.state.narrow = window.matchMedia('(max-width: 700px)');
      this.onNarrow = () => this.state.elements.language
        && this.state.elements.language.toggleAttribute('compact', this.state.narrow.matches);
      this.state.narrow.addEventListener('change', this.onNarrow);
      this.onNarrow();
    }
  }
  disconnectedCallback() {
    document.removeEventListener('frugaliot:projectchanged', this.onProjectChanged);
    document.removeEventListener('frugaliot:topicschanged', this.onProjectChanged);
    document.removeEventListener('frugaliot:organizationchanged', this.onOrganizationChanged);
    if (this.state.narrow) this.state.narrow.removeEventListener('change', this.onNarrow);
  }
  // A different organization means different capabilities, and the previous project is gone
  onOrganizationChanged(e) {
    this.state.organization = e.detail.organization;
    this.state.projectMt = null;
    this.state.mode = 'front';
    this.refreshBody();
  }
  onProjectChanged(e) {
    if (e.detail && e.detail.projectMt) this.state.projectMt = e.detail.projectMt;
    if (e.detail && e.detail.organization) this.state.organization = e.detail.organization;
    this.refreshBody();
  }

  get projectMt() { return this.state.projectMt; }
  get canAdminister() { return adminCardsFor(this.state.organization).length > 0; }

  // Rendered once: the wrapper below owns the broker connection, and rebuilding it would drop it
  render0() {
    return [
      el('header', { class: 'fi-header' }, [
        el('span', { class: 'fi-header__title', textContent: 'Frugal IoT', i8n: false }),
        // Supplies the organization and project selectors, the connection status, and the data tree
        this.state.elements.wrapper = el('mqtt-wrapper', {
          headless: true,
          organization: this.getAttribute('organization') || undefined,
          project: this.getAttribute('project') || undefined,
        }),
        this.state.elements.language = el('language-picker'),
        this.state.elements.gear = el('span', { class: 'fi-header__gear' }),
        // Forces the organization and project selectors onto a second row when the header is
        // narrow - see .fi-header__break. Nothing to look at, so it is hidden from assistive tech.
        el('span', { class: 'fi-header__break', 'aria-hidden': 'true' }),
      ]),
      this.state.elements.body = el('div', { class: 'fi-body' }, [this.renderBody()]),
    ];
  }

  refreshBody() {
    const e = this.state.elements;
    if (!e.body) return;
    e.body.replaceChildren(this.renderBody());
    // The gear only appears if turning the project over would show something (D-29)
    e.gear.replaceChildren(...(this.canAdminister ? [el('button', {
      class: 'fi-btn', title: getString('Settings'), i8n: false,
      textContent: (this.state.mode === 'back') ? '✕' : '⚙',
      onclick: () => { this.state.mode = (this.state.mode === 'back') ? 'front' : 'back'; this.refreshBody(); },
    })] : []));
  }

  renderBody() {
    if (this.state.mode === 'back') {
      return el('mqtt-projectback', { organization: this.state.organization });
    }
    if (!this.projectMt) {
      return this.emptyState(getString('Choose a project to see its devices'));
    }
    if (!Object.keys(this.projectMt.nodes).length) {
      return this.emptyState(getString('Waiting for devices'));
    }
    const grid = el('mqtt-devicegrid', {});
    grid.mt = this.projectMt;
    return grid;
  }
  emptyState(text) {
    return el('div', { class: 'fi-empty' }, [el('p', { textContent: text })]);
  }
}
customElements.define('mqtt-dashboard', MqttDashboard);
