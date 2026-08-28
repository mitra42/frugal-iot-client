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
import { el, getString, ImagesUrl, relativeTime, XXX } from './core.js';

// Shape as well as colour, so status survives sunlight and colour blindness
const STATUS_MARK = { live: '●', stale: '◌', offline: '○', never: '·' };

class MqttDeviceCard extends HTMLElementExtendedMinimum {
  static get observedAttributes() { return ['mode']; }

  constructor() {
    super();
    this.state.elements = {};
    this.state.mode = 'summary';
    this.onGroupChanged = this.onGroupChanged.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    // Every message fires this, in both the element and the headless paths, so it is the one signal
    // a card needs. Filtered to this device below.
    document.addEventListener('frugaliot:groupchanged', this.onGroupChanged);
  }
  disconnectedCallback() {
    document.removeEventListener('frugaliot:groupchanged', this.onGroupChanged);
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
    return this.state.elements.card = el('div', {
      class: `fi-card fi-card--${this.mode} fi-status-${this.nodeMt.status}`,
      onclick: () => { if (this.mode === 'summary') this.mode = 'front'; }, // only the summary is one target
    }, body);
  }
}
customElements.define('mqtt-devicecard', MqttDeviceCard);

export { MqttDeviceCard };
