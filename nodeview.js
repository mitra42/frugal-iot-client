/*
 * Frugal IoT client - the original project / node / module display, where each node is a box and
 * each module a <details> drop-down.
 *
 * This retires with index.html once the cards cover everything it does, so its removal should be a
 * file deletion. Nothing new belongs in here.
 */

import { CssUrl, ImagesUrl, Watchdog, el, getString, server_config } from './core.js';
import { MqttElement, MqttReceiver } from './widgets.js';

class MqttProject extends MqttReceiver {
  constructor() {
    super();
  }
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['discover', 'name']); }
  static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}

  // DOM layer for node creation. Data-tree MqttTopicNode is created by MqttTopicProject.addNode;
  // this method creates the mqtt-node element and links it to the data-tree node.
  addNode(id) {
    const elNode = el('mqtt-node', {id, topic: `${this.mt.topicPath}/${id}`, discover: this.state.discover, name: "", description: ""}, []);
    elNode.state.project = this;
    const mt = this.mt.addNode(id); // Data-tree: creates MqttTopicNode, sets _projectMt, subscribes
    mt.element = elNode;
    elNode.mt = mt;
    mt._groups = elNode.topicGroups; // Share element's topicGroups with the data-tree node
    elNode.addStandardChildren(); // Runs after mt is linked so addGroupFromTemplate can delegate to this.mt
    this.append(elNode);
    this.rebuildTopicDropdowns();
    return elNode;
  }
  // noinspection JSCheckFunctionSignatures
  // Two cases either from a discovery message for a new node, OR from Wrapper calling valueSet on new Project
  // Note: routing of MQTT discovery messages is now handled by MqttTopicProject.topicValueSet (data-tree class).
  valueSet(val, force) {  //TODO-REFACTOR maybe dont use "force", (only used by wrapper)
    // val is a node id such as esp8266-12ab3c
    if (this.state.discover || force) {
      if (this.mt.nodes[val]) {
        // Already have the node, but reset its watchdog
        this.mt.nodes[val].element.tickle();
      } else {
        this.addNode(val);
      }
    }
    return false; // Should not need to rerender
  }
  nodesFromConfig(nodes) { // { id: { lastseen, ...} }
    nodes.filter(([id,nc]) => ((id !== '+') && (nc.lastseen)))
      .forEach(([id,nc]) => {
        if (!this.mt.nodes[id]) { // Use data tree as canonical source
          let n = this.addNode(id); // Will try and do a discover to fill it in but offline for now
          n.offline();
          n.updateLastSeen(nc.lastseen); // Creates lastseen element
      }
    });
  }
  findTopic(topicPath) {
    // Currently only used in renderMaybeWired and wiredTopic getter.
    // Navigates through the data tree: project → node → group → topic (no element access required).
    let parts = topicPath.split("/");
    if (parts[3] === "set") {
      parts.splice(3, 1); // Remove "set" to normalise read and write paths
    }
    const nodeMt = this.mt.nodes[parts[2]];
    const groupMt = nodeMt && nodeMt.groups[parts[3]];
    return groupMt && groupMt.topics[parts[4]];
  }
  // Iterates MqttNode elements for all nodes; skips nodes without a rendered element (headless mode).
  nodesForEach(cb) {
    Object.values(this.mt.nodes).forEach(nodeMt => { if (nodeMt.element) cb(nodeMt.element); });
  }
  // Rebuild all embedded mqtt-choosetopic.
  // Note you can't use querySelectorAll to find them because they are in the Shadow DOM of the nodes, so instead each node will have to have a function that finds the choosetopics in its Shadow DOM and calls their renderAndReplace function.
  rebuildTopicDropdowns() {
    this.nodesForEach((node) => { node.rebuildTopicDropdowns(); } ); //TODO-N200
    // Notify external choosers (e.g. in a custom settings panel) that the topic list has changed.
    document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this.mt } }));
  }

  render() {
    return  !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "outer mqtt-project"}, [
        el('div', {class: "title"},[
          el('span',{class: 'projectname', textContent: this.mt.twig }), // twig should be e.g. dev/lotus
          el('span',{class: 'name', i8n: false, textContent: this.state.name}),
        ]),
        el('div', {class: "nodes"},[
          el('slot', {}),
        ]),
      ])
    ];
  }
}
customElements.define('mqtt-project', MqttProject);
class MqttNode extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['id', 'name', 'description','discover']); }
  static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}
  static get integerAttributes() { return MqttReceiver.integerAttributes.concat(['days'])}

  constructor() {
    super(); // (Comment used to say "subscribes to topic" but doesn't look like it
    this.state.topics = {}; // Index of MqttTopic - TODO-13 is this topicLeafs or topicPaths ?
    this.state.days = 0;
    this.watchdog = new Watchdog(this);
    this.state.lastseen = 0;
    this.groups = {}; // Index of DOM group elements: groupId → MqttGroup element
    this.topicGroups = {}; // Index of data-tree groups: groupId → MqttTopicGroup (mirrored to this.mt.groups after mt is set)
    // Special case elements whose text is changed at top level , not inside a group or the ShadowRoot
  }
  addStandardChildren() {
    // These go in slots in the Node's render.
    // Need the group first else the addDiscoveredTopicsToNode will create a new group.
    this.addGroupFromTemplate("frugal_iot"); // Add group and topics
    this.state.topics["frugal_iot/id/#"].element.valueSet(this.state.id); // Set manually as it is not a message it is a field
  }
  changeAttribute(leaf, valueString) {
    super.changeAttribute(leaf, valueString);  // Convert and set value on state
    if (this.state.elements[leaf]) { // This will be false during constructor
      // This is for downwards (Node->element) flow of values, and I think this only happens with node/frugal_iot/xxx
      // Elements (like the MqttText for the "name") have a slot specified, addGroupFromTemplate sets state.elements to point at itself
      //this.state.elements[leaf].textContent = this.state[leaf]; // OLD WAY
      this.state.elements[leaf].setAttribute("value", valueString); // NEW WAY (30Nov2025)
      //TODO-42 maybe these should just go straight to the frugal_iot group except for id (which not sure ever see) (with care!)
    }
    return false;
  }
  // Getters
  get isNode() { return true; } // Overrides superclass in MqttReceiver

  get usableName() {
    // This used to refer to this.state.name, and fallback to this.state.id BUT name no longer appears to be used.
    // Instead it is frugal_iot/name so need to get from group, fallback to id (don't use group.usableName because that could be "frugal_iot"
    return (this.groups.frugal_iot && this.groups.frugal_iot.state.name) || this.state.id;
  }
  // Filter the topics on this node by type e.g. "bool" "float" or ["float","int"]
  topicsByType(types, rw) { // [ { name, topic: topicpath } ]
    let usableName = this.usableName;
    return Object.values(this.state.topics)
      .filter( t => types.includes(t.type))
      .filter(t => t.rw.includes(rw))
      // TODO-154 when have groups as a Webcomponent - use the groups name, and be clever e.g. ledbuiltin/on is LED, but temperature/max is Temperature Max
      // Note its intentionally t.topicPath even if rw=w because drop-down needs to subscribe to the topicPath , and set the topicSetPath
      .map(t=> { return({name: `${usableName}:${t.usableName}`, topic: t.topicPath, setTopic: t.topicSetPath})});
  }

  topicsForEach(cb) {
    Object.entries(this.state.topics).forEach(k => cb(k[1]));
  }
  elementsForEach(cb) {
    Object.entries(this.state.topics).forEach(k => {
      let elx = k[1].element; // Not "el" - that is the element builder, in scope here
      if (elx) { cb(k[1].element); } // Dont call callback if element empty (currently captive/language_code is empty)
    } );
  }
  // Rebuild all embedded mqtt-choosetopic.
  rebuildTopicDropdowns() {
    this.elementsForEach(el => { el.rebuildTopicDropdown(); } );
  }
  // Add a topic (either from group template, or because received a value and adding automatically)
  // DOM layer for topic creation. Data-tree MqttTopic is created by MqttTopicNode.addTopicFromTemplate;
  // this method adds the element reference, flat index, and DOM element on top.
  addTopicFromTemplate(topicTemplate, groupId) {
    if (!this.mt.addTopicFromTemplate(topicTemplate, groupId)) return false;
    const mt = this.mt.groups[groupId].topics[topicTemplate.leaf];
    mt.node = this; // Element reference for DOM-specific getters (project, projectMt via closest())
    this.state.topics[mt.twig + "/#"] = mt; // Flat index used by topicsByType / topicsForEach
    const elx = mt.createElement();
    if (mt.slot) {
      elx.setAttribute('slot', mt.slot);
      elx.setAttribute('class', mt.slot);
      if (groupId === "frugal_iot") this.state.elements[mt.slot] = elx;
    }
    this.groups[groupId].append(elx);
    return true;
  }
  // DOM layer for group creation. Data-tree MqttTopicGroup and its topics are created by
  // MqttTopicNode.addGroupFromTemplate; this method creates the DOM element and the per-topic elements.
  addGroupFromTemplate(groupId) {
    if (this.groups[groupId]) return false;
    const moduleTemplate = server_config.schema.modules[groupId];
    const groupName = moduleTemplate ? moduleTemplate.name : groupId;
    let grouptag = (groupId === "frugal_iot") ? 'mqtt-groupfrugaliot' : `mqtt-group${groupId}`;
    grouptag = customElements.get(grouptag) ? grouptag : 'mqtt-group';
    this.groups[groupId] = el(grouptag, {class: `group ${groupId}`, group: groupId, name: groupName, slot: ((moduleTemplate && moduleTemplate.slot) || null)}, []);
    // Data-tree: creates MqttTopicGroup + all template topics (also fires frugaliot:controlgroup)
    this.mt.addGroupFromTemplate(groupId);
    // DOM: populate topic elements into the group before connecting it to the node
    Object.values(this.mt.groups[groupId].topics).forEach(mt => {
      mt.node = this;
      this.state.topics[mt.twig + "/#"] = mt;
      const elx = mt.createElement();
      if (mt.slot) {
        elx.setAttribute('slot', mt.slot);
        elx.setAttribute('class', mt.slot);
        if (groupId === "frugal_iot") this.state.elements[mt.slot] = elx;
      }
      this.groups[groupId].append(elx);
    });
    // Append after topics are in place so the group is never rendered empty
    if (moduleTemplate && moduleTemplate.insidefrugaliot) {
      this.groups["frugal_iot"].append(this.groups[groupId]);
    } else {
      this.append(this.groups[groupId]);
    }
    return true;
  }

  /*
  shouldLoadWhenConnected() {
  // For now relying on retention of advertisement by broker
    return this.state.id && super.shouldLoadWhenConnected() ;
  }
 */
  // TODO-13 do we just set state here, or change the render ?
  // TODO-42 this is not called currently - will want this code somewhere, probably in roll-up (MqttGroupBattery)
  topicChanged(leaf, value) {
    switch (leaf) {
      case "battery":
        let bars = Math.min(6,Math.floor(parseInt(value) * 6/4200));
        this.groups.frugal_iot.state.elements.batteryIndicator.src = `${ImagesUrl}Battery${bars}.png`;
        break;
    }
  }
  render() {
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      this.state.outerDiv = el('div', {class: 'outer mqtt-node'+((this.state.online) ? '' : ' offline')}, [
        this.groups.frugal_iot,
        el('div', {class: "topics"},[
          el('slot', {}), // Groups are children of Node
        ]),
  ])
    ]
  }
  //document.getElementsByTagName('body')[0].classList.add('category');
  tickle() {
    let now = Date.now();
    this.updateLastSeen(now);
    this.watchdog.tickle(now);
    this.state.online = true;
    this.state.outerDiv.classList.remove('offline');
  }
  offline() {
    this.state.outerDiv.classList.add('offline');
    this.state.online = false;
  }
  updateLastSeen(lastseentime) {
    this.state.lastseen = lastseentime;
    let value = lastseentime ? new Date(lastseentime).toLocaleString() : "Never seen";
    this.state.elements.lastseen.setAttribute('value', value);
    /*
    if (this.state.elements.lastSeen) {
      this.groups.frugal_iot.removeChild(this.state.elements.lastSeen);
    }
    //TODO-113 could probably also do by replacing inner text if it flickers
    this.state.elements.lastSeen = el('span', {slot: "lastseen", class: 'lastseen', textContent: value});
    this.groups.frugal_iot.append(this.state.elements.lastSeen);
    */
  }
}
customElements.define('mqtt-node', MqttNode);
class MqttGroup extends MqttElement { // TODO-40 may extend MqttReceiver if needed ....
  constructor() {
    super();
    this.topics = {}
    this.state.elements = {}
  }
  // Instance of MqttNode
  get node() {
    return this.parentElement;
  }
  // instance of MqttProject
  get project() {
    return this.node.project;
  }
  findLeaf(leaf) {
    for (const child of this.children) {
      if (child.mt && child.mt.leaf === leaf) return child;
    }
    return null;
  }

  reSummarize() {
    let oldSummary = this.state.elements.summary;
    if (oldSummary) { // Will be false during constructor
      oldSummary.replaceWith(this.state.elements.summary = this.renderSummary());
    }
  }
  changeAttribute(name, valueString) {
    // This will get called as normal for constructor-time but also when something inside the group changes will be e.g. battery_battery or ledbuiltin_on
    super.changeAttribute(name, valueString); //TODO-42 needs to pass up to parent 
    // This catches the textual ones such as sht/name - note these should all be elements of the group, not children of the group
    if (this.state.elements[name]) { // This will be false during constructor
      this.state.elements[name].setAttribute("value", valueString); // NEW WAY (30Nov2025)
    }
    //TODO-42 may need to roll up to parent
    this.reSummarize();
    return false; // Should be no need to rerender.
  }
  static get observedAttributes() { return ['group','name']; }

  renderSummary() {
    return null; // Default is no extra summary (just the name)
  }
  render () {
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('details', {class: `mqtt-group ${this.state.group}`}, [
        el('summary',{},[
          el('span', {textContent: this.state.name || this.state.group}),
          this.state.elements.summary = this.renderSummary(),
        ]),
        el('slot'), // Children go here
      ]),
    ];
  }
}
customElements.define('mqtt-group', MqttGroup);

// TODO-42 build a group here for any module we want to roll up values.
//  It will be found in "addGroupFromTemplate" if it exists and matches a group id
// MqttReceiver.topicValueSet passes the value from subelement up to group
class MqttSummaryGroup extends MqttGroup {
  renderSummary() {
    return el('div', {style:`display:inline-block;margin-left:20px;vertical-align:middle;`}, [
      el('span', {i8n: false, textContent: this.summaryText()})
    ]); // Colored circle with thin black border
  }
  trueFalseSymbol(val) {
    return (val === undefined) ? '?' : (val ? '✓' : '✗');
  }
}
class MqttGroupLedbuiltin extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['on']);}
  static get boolAttributes() { return MqttGroup.boolAttributes.concat(['on']);}

  renderSummary() {
    let style = this.state.on ? "background:#ff0;" : "background:#444;";
    return el('div', {style:`${style};width:12px;height:12px;border-radius:50%;border:1px solid #000;display:inline-block;margin-left:20px;vertical-align:middle;`}); // Colored circle with thin black border
  }
}
customElements.define('mqtt-groupledbuiltin', MqttGroupLedbuiltin);
class MqttGroupRelay extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['on']);}
  static get boolAttributes() { return MqttGroup.boolAttributes.concat(['on']);}

  summaryText() {
        return `${this.trueFalseSymbol(this.state.on)}`
  }
}
customElements.define('mqtt-grouprelay', MqttGroupRelay);
class MqttGroupSoil extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['soil']);}
  static get floatAttributes() { return MqttGroup.boolAttributes.concat(['soil']);}

  summaryText() {
    return `${this.state.soil}%`
  }
}
customElements.define('mqtt-groupsoil', MqttGroupSoil);
class MqttGroupOta extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['key']);}

  summaryText() {
    return `${this.state.key}`
  }
}
customElements.define('mqtt-groupota', MqttGroupOta);
class MqttGroupBattery extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['battery']);}
  static get integerAttributes() { return MqttGroup.boolAttributes.concat(['battery']);}

  summaryText() {
    return `${this.state.battery}`
  }
}
customElements.define('mqtt-groupbattery', MqttGroupBattery);
class MqttGroupDS18B20 extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['ds18b20']);}
  static get floatAttributes() { return MqttGroup.boolAttributes.concat(['ds18b20']);}

  summaryText() {
    return `${this.state.ds18b20}°C`
  }
}
customElements.define('mqtt-groupds18b20', MqttGroupDS18B20);
class MqttGroupHt extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['temperature', 'humidity']);}
  static get floatAttributes() { return MqttGroup.boolAttributes.concat(['temperature', 'humidity']);}

  summaryText() {
    return `${this.state.temperature}°C ${this.state.humidity}%RH`
  }
}
customElements.define('mqtt-groupht', MqttGroupHt);
class MqttGroupSht extends MqttGroupHt {
}
customElements.define('mqtt-groupsht', MqttGroupSht);
class MqttGroupDht extends MqttGroupHt {
}
customElements.define('mqtt-groupdht', MqttGroupDht);
class MqttGroupControlHysteresis extends MqttSummaryGroup {
  static get observedAttributes() { return MqttGroup.observedAttributes.concat(['on','now','now_wired','greater','limit','limit_wired','hysteresis','hysterisis','out_wired', 'manual']);}
  static get boolAttributes() { return MqttGroup.boolAttributes.concat(['on', 'greater', 'manual']);}
  static get floatAttributes() { return MqttGroup.floatAttributes.concat(['now','limit','hysteresis','hysterisis']);}

  //constructor() { super(); } // Just for debugging - TODO remove

  nameOrValue(val,wired) {
    return wired && this.project.findTopic(wired) && this.project.findTopic(wired).usableName || val;
  }
  summaryText() {
    let hysteresis = this.state.hysteresis || this.state.hysterisis || 0
    return this.state.manual
      ? getString('Manual')
      : `${this.nameOrValue("",this.state.out_wired)} = ${this.nameOrValue(this.state.now,this.state.now_wired)} ${this.state.greater ? ">" : "<"} ${this.nameOrValue(this.state.limit,this.state.limit_wired)} ${hysteresis ? "+/-" : ""} ${hysteresis ? hysteresis : ""} ${this.trueFalseSymbol(this.state.on)}`;
  }
}
customElements.define('mqtt-groupcontrolhysteresis', MqttGroupControlHysteresis);
// TODO - delete when sure all nodes updated (esp Winam)
class MqttGroupControlHysterisis extends MqttGroupControlHysteresis { }
customElements.define('mqtt-groupcontrolhysterisis', MqttGroupControlHysterisis); // TODO-legacy-hysterisis
class MqttGroupFrugalIot extends MqttGroup {
  static get observedAttributes() {
    return MqttGroup.observedAttributes.concat(['battery_battery', 'ledbuiltin_on']); } //TODO_42 do something with these

  render() {
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('details', {}, [
        el('summary', {}, [
          el('slot', {name: 'name', class: 'name'}), /* frugal_iot.id is specified with `slot: name` */
          //Starts off as 1px empty image, changed when battery message received
          this.state.elements.batteryIndicator = el('img', { /* Changed in MqttNode.topicChanged */
            class: "batteryimg",
            src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
          }),
        ]),
        el('slot', {name: 'description', class: 'description'}),
        el('slot', {name: 'lastseen', class: 'lastseen'}),
        el('slot', {name: 'id', class: 'id'}),
        el('div', {class: "health"}, [
          el('slot', {name: 'ledbuiltin'}),
          el('slot', {name: 'battery'}),
        ]),
        el('slot', {name: 'ota', class: 'ota'}),
        el('slot'), // Should probably be unused slot for any other children
      ]),
    ];
  }
}
customElements.define('mqtt-groupfrugaliot', MqttGroupFrugalIot);

/* This could be part of MqttBar, but maybe better standalone */

