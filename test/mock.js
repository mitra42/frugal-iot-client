/*
 * Canned MQTT scenarios, replayed into the data tree with no broker.
 *
 * Works unchanged in node (see setup.js) and in a browser (see mock.html), because the only seam
 * it uses is mqtt_deliver - the same call the real client makes for every message it receives.
 */
import { configSet, el, mqtt_deliver, mqtt_unsubscribe_organization, setClock, MqttTopicProject } from '../webcomponents.js';

const ORG = 'dev';
const PROJECT = 'lotus';

// One device's worth of messages. `id` is the node id; `groups` maps twig -> payload.
// Values are strings because that is what arrives off the wire.
function device(id, name, twigs, { ota = 'sht30_c3_pico', battery = '3940', wifi = 'shed-ap' } = {}) {
  const msgs = [[`${ORG}/${PROJECT}`, id]]; // Discovery: node id published on the project topic
  const base = `${ORG}/${PROJECT}/${id}`;
  msgs.push([`${base}/frugal_iot/name`, name]);
  msgs.push([`${base}/frugal_iot/description`, `${name} - test scenario`]);
  if (ota) msgs.push([`${base}/ota/key`, ota]);
  if (battery) msgs.push([`${base}/battery/battery`, battery]);
  if (wifi) { msgs.push([`${base}/health/wifibars`, '3']); msgs.push([`${base}/health/wifissid`, wifi]); }
  Object.entries(twigs).forEach(([twig, val]) => msgs.push([`${base}/${twig}`, val]));
  return msgs;
}

// A control wired to a sensor and a relay: `wired` parameters arrive on the set path.
function wiring(id, groupId, wires) {
  const base = `${ORG}/${PROJECT}/${id}/set/${groupId}`;
  return Object.entries(wires).map(([leaf, target]) => [`${base}/${leaf}/wired`, target]);
}

const SHT = { 'sht/temperature': '30.142857', 'sht/humidity': '85.1' };

export const scenarios = {
  'one-device': {
    title: 'One device, SHT readings only',
    messages: device('esp8266-fb94bb', 'Greenhouse North', SHT),
  },

  'no-readings': {
    title: 'Device discovered but silent - no readings yet',
    messages: [[`${ORG}/${PROJECT}`, 'esp8266-newborn']],
  },

  'default-front': {
    // No devices.yaml entry matches "workbench_c3", so the default ordering applies - and two
    // temperature sources exercise the label-collision rule
    title: 'Unconfigured device (default front) with two temperature sources',
    messages: device('esp8266-two-temps', 'Two Temperatures', {
      ...SHT,
      'ds18b20/ds18b20': '18.3',
      'soil/soil': '38',
      'relay/on': 'true',
    }, { ota: 'workbench_c3' }),
  },

  'out-of-range': {
    // temperature is 0..50 and humidity 0..100 in topics.yaml, so one is far below its range and
    // the other above it - the two ends look different and both need checking
    title: 'Readings below and above their declared min/max',
    messages: device('esp8266-broken', 'Broken Probe', { 'sht/temperature': '-999', 'sht/humidity': '118.4' }),
  },

  'control-wired': {
    title: 'Control wired to a local sensor, driving a local relay',
    messages: [
      ...device('esp8266-fb94bb', 'Greenhouse North', {
        ...SHT,
        'relay/on': 'true',
        'controlhysteresis/now': '30.1',
        'controlhysteresis/limit': '32',
        'controlhysteresis/greater': 'true',
        'controlhysteresis/hysteresis': '3',
        'controlhysteresis/out': 'true',
      }),
      ...wiring('esp8266-fb94bb', 'controlhysteresis', {
        now: `${ORG}/${PROJECT}/esp8266-fb94bb/sht/temperature`,
        out: `${ORG}/${PROJECT}/esp8266-fb94bb/set/relay/on`,
      }),
    ],
  },

  'control-unwired': {
    title: 'Control present but nothing wired to it',
    messages: device('esp8266-fb94bb', 'Greenhouse North', {
      ...SHT,
      'controlhysteresis/limit': '32',
      'controlhysteresis/greater': 'true',
    }),
  },

  'unknown-module': {
    // Nothing in modules.yaml declares 'quantumflux' - must be visibly wrong, not silently dropped
    title: 'A module absent from modules.yaml',
    messages: device('esp8266-odd', 'Odd Device', { 'quantumflux/spin': '42' }),
  },

  'twelve-devices': {
    title: 'Twelve devices - grid layout and ordering',
    messages: Array.from({ length: 12 }, (_, i) =>
      device(`esp8266-dev${String(i).padStart(2, '0')}`, `Bed ${i + 1}`, {
        'sht/temperature': String(20 + i * 1.5),
        'sht/humidity': String(60 + i),
      }, { battery: String(3600 + i * 40) })
    ).flat(),
  },

  'mixed-sensors': {
    // The agri entry in devices.yaml declares soil and ds18b20 ahead of the SHT
    title: 'Soil, DS18B20 and SHT, ordered by the agri devices.yaml entry',
    messages: device('esp8266-agri', 'Bed 3', {
      ...SHT,
      'ds18b20/ds18b20': '18.3',
      'soil/soil': '38',
    }, { ota: 'agri_d1_mini' }),
  },
};

// `manual` is still absent: the node implements it in examples/sonoff, but no module declares it,
// so nothing arrives on that topic. See CARDS_UX.md L-2.

export function loadConfig(config) {
  configSet(config);
}

// Freeze "now" so status (live / stale / offline) can be tested without waiting for it.
// setNow(null) hands the clock back to Date.now.
export function setNow(t) {
  setClock(t === null ? null : () => t);
}

// Build a project data tree and replay a scenario into it.
// headless: true builds the data tree only. headless: false builds the existing node/group UI too,
// which is how the same scenarios give that UI a regression check - see CARDS_PLAN.md phase 0.
// Returns { projectMt, projectEl } (projectEl is null when headless).
export function runScenario(name, { headless = true, container = null, at = null } = {}) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`No such scenario: ${name}`);
  if (at !== null) setNow(at); // Deliver the whole scenario at one instant
  // Subscriptions are module-level and would otherwise leak between scenarios, delivering one
  // scenario's messages into the previous scenario's tree.
  mqtt_unsubscribe_organization(ORG);

  const projectMt = new MqttTopicProject();
  let projectEl = null;
  if (headless) {
    projectMt.initialize({ type: 'text', twig: `${ORG}/${PROJECT}`, headless: true });
  } else {
    projectEl = el('mqtt-project', { discover: true, id: PROJECT, name: 'Lotus Ponds' }, []);
    projectMt.initialize({ type: 'text', twig: `${ORG}/${PROJECT}`, element: projectEl });
    projectEl.mt = projectMt;
    (container || document.body).append(projectEl); // connectedCallback renders on append
  }
  projectMt.subscribe();
  scenario.messages.forEach(([topic, payload]) => mqtt_deliver(topic, payload));
  return { projectMt, projectEl };
}

// Deliver one extra message into a scenario already running - a device arriving late, say
export function deliver(topic, payload) {
  mqtt_deliver(topic, payload);
}

export { ORG, PROJECT };
