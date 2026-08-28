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
  widgetFor(row) {
    const mt = row.mt;
    const common = {
      topic: mt.topicPath, label: row.label, type: mt.type, color: mt.color,
      value: (mt.state.value === undefined) ? undefined : String(mt.state.value),
      graphable: mt.graphable ? 'true' : undefined,
    };
    const ranged = { ...common, min: String(mt.min), max: String(mt.max) };
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
        el('button', {
          class: 'fi-btn', title: getString('Settings'), i8n: false, textContent: '⚙',
          onclick: (e) => { e.stopPropagation(); this.mode = 'back'; },
        }),
        // A close mark, not a chevron - a "⌄" reads as "there is more below", which is the
        // opposite of what it does
        el('button', {
          class: 'fi-btn fi-btn--close', title: getString('Collapse'), i8n: false, textContent: '✕',
          onclick: (e) => { e.stopPropagation(); this.mode = 'summary'; },
        }),
      ]),
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
    const body = (this.mode === 'summary') ? this.renderSummary() : this.renderFront();
    return this.state.elements.card = el('div', {
      class: `fi-card fi-card--${this.mode} fi-status-${this.nodeMt.status}`,
      onclick: () => { if (this.mode === 'summary') this.mode = 'front'; }, // only the summary is one target
    }, body);
  }
}
customElements.define('mqtt-devicecard', MqttDeviceCard);

export { MqttDeviceCard };
