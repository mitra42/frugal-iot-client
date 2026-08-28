/*
 * Frugal IoT client - the leaf display and control elements: bar, gauge, text, toggle, slider,
 * colour, and the topic chooser. Each renders into its own shadow root.
 *
 * Usable with nothing but core.js - index-embedded.html puts an mqtt-bar on a page with no wrapper,
 * no project tree and no server config.
 */

import {HTMLElementExtended} from '/node_modules/html-element-extended/htmlelementextended.js';
import { CssUrl, ImagesUrl, RECEIVER_ATTRIBUTES, XXX, el, leafAttribute, nextUniqueId } from './core.js';

class MqttElement extends HTMLElementExtended {
  // TODO - maybe move this to HTMElementExtended
  // Called whenever an attribute is added or changed,
  // https://developer.mozilla.org/en-US/docs/Web/Web_Components/Using_custom_elements#using_the_lifecycle_callbacks
  // unlikely to be subclassed except to change behavior of when calls renderAndReplace
  typeOfAttribute(attributeName) {
    if (this.constructor.integerAttributes.includes(attributeName)) { return "integer"; }
    if (this.constructor.floatAttributes.includes(attributeName)) { return "float"; }
    if (this.constructor.boolAttributes.includes(attributeName)) { return "boolean"; }
    if (this.constructor.observedAttributes.includes(attributeName)) { return "string"; }
    return undefined;
  }
  attributeChangedCallback(name, oldValue, newValue) {
    // console.log(this.localName, 'Attribute Changed', name); // uncomment for debugging
    if (oldValue !== newValue) {
      let needReRender = this.changeAttribute(name, newValue); // Sets state{} may also munge value (e.g. string to boolean)
      // reconsider if now have sufficient data to load content
      if (this.isConnected && this.constructor.observedAttributes.includes(name) && this.shouldLoadWhenConnected()) {
        this.loadContent();
      }
      // note this render happens before the loadContent completes
      if (needReRender !== false) {  // Testing this way as old changeAttributes returned undefined and assumed a reRender
        this.renderAndReplace();
      }
    }
  }
}
class MqttReceiver extends MqttElement {
  constructor() {
    super();
    this.state.elements = {}; // Pointer to specific elements (for special case updates)
  }
  static get observedAttributes() { return [...RECEIVER_ATTRIBUTES]; }
  static get boolAttributes() { return ['graphable']; }

  get isNode() { return false; } // Overridden in MqttNode
  get node() {
    return this.mt.node;
  }
  get groupElement() {
    // Its also mt.node.state.groups[this.mt.group]
    return this.parentElement;
  }
  // Return the topic this is wired to or undefined
  get wiredTopic() {
    return this.mt.wiredTopic; // May be undefined
  }
  // Returns the path for wiring this topic - e.g. /org/proj/device/control/now/wired
  get topicWiredPath() {
    return this.mt.topicWiredPath;
  }
  connectedCallback() {
    if (this.state.topic && !this.mt) {
      // Created with a topic string, which should be a path, so create the MqttTopic
      // only used when embedding, may not work
      this.createTopic();
    }
    super.connectedCallback();
  }
  // Binds this element to its MqttTopic by looking it up in the discovery data tree.
  // The topic must already be in the tree (it has to be there for the user to have selected it),
  // so there is no need to create a parallel MqttTopic with fabricated paths.
  createTopic() {
    const wrapper = document.querySelector('mqtt-wrapper');
    const mt = wrapper?.projectMt?.findTopic(this.state.topic);
    if (mt) {
      this.mt = mt;
      mt.element = this; // Route wildcard subscription messages to this element
      mt.subscribe();    // No-op if already subscribed; sets up direct subscription otherwise
    } else {
      XXX(["createTopic: topic not found in data tree", this.state.topic]);
    }
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // Change from string to number etc and store on this.state
    // TODO - could set width, color, name, on sub-elements and return false then copy this to other elements
    if (name === 'wired') {
      this.mt.setWired(valueString);
      this.rebuildWiredInput(); // Rebuild wired input as now know where wired
      if (this.state.elements.chooseTopic) {
        this.state.elements.chooseTopic.setAttribute('value', valueString); // Update the dropdown if it exists
      } else {
        XXX("received 'wired' but no dropdown to pass it to");
      }
      return false; // ChooseTopic will re-render if needed
    } else {
      return true;
    }
  }
  // Rebuild any topic dropdowns, this is needed if wired differently or may have access to previously unknown names
  rebuildTopicDropdown() {
    if (this.state.elements.chooseTopic) {
      this.state.elements.chooseTopic.rebuildDropdown(); // Just rebuilds the dropdown, not the entire MqttReceiver
    }
    this.rebuildWiredInput();
  }
  // rebuild wired Input - this is needed if wired differently or may have access to previously unknown names
  rebuildWiredInput() {
  if (this.state.elements.wiredInput) {
    this.state.elements.wiredInput.replaceWith(this.state.elements.wiredInput = this.renderWiredInput());
  }
}

// Return true if need to rerender
  // Note overridden in MqttNode and MqttProject
  topicValueSet(topicPath, message) {
    if ([this.mt.topicPath, this.mt.topicSetPath, this.mt.wired].includes(topicPath)) {
      // Its trying to set our value
      let value = this.mt.valueFromText(message);
      let now = Date.now();
      // Update the data tree before anything is told to re-render. The group roll-up below triggers
      // reSummarize, and a summary built from the data tree would otherwise be a message behind -
      // or empty, for a topic that has only reported once.
      this.mt.state.value = value;
      this.mt.data.push({value, time: now}); // Same format as graph dataset expects
      const leafAttr = leafAttribute(topicPath);
      const groupMt = this.mt.groupMt;
      if (groupMt) groupMt.state[leafAttr] = value; // Mirror to data-tree group (headless-safe roll-up)
      if (this.groupElement) this.groupElement.setAttribute(leafAttr, value); // DOM roll-up for element-based rendering
      if (groupMt && this.mt.node?.mt) {
        document.dispatchEvent(new CustomEvent('frugaliot:groupchanged', {
          detail: { nodeMt: this.mt.node.mt, groupId: this.mt.group, groupMt, changed: [leafAttr] }
        }));
      }
      return this.valueSet(value); // Subclassed for each element e.g. MqttText
    } else if ((topicPath.startsWith(this.mt.topicPath)) || (topicPath.startsWith(this.mt.topicSetPath))) {
      // Trying to set a parameter
      // topic like org/project/node/set/sht/temperature/max or ...set/sht/temperature/max
      let parameter = topicPath.split("/").pop();
      this.parameterSet(parameter, message); // True if need to rerender
      const leafAttr = leafAttribute(topicPath);
      const groupMt = this.mt.groupMt;
      if (groupMt) groupMt.state[leafAttr] = message; // Mirror to data-tree group (headless-safe roll-up)
      if (this.groupElement) this.groupElement.setAttribute(leafAttr, message); // DOM roll-up for element-based rendering
      if (groupMt && this.mt.node?.mt) {
        document.dispatchEvent(new CustomEvent('frugaliot:groupchanged', {
          detail: { nodeMt: this.mt.node.mt, groupId: this.mt.group, groupMt, changed: [leafAttr] }
        }));
      }
      return false; // parameterSet will have rerendered if needed
    } else {
      // Most likely cause of an "unhandled" topicPath is because received topicPath after changing "wired" - that is ok, can safely ignore
      // XXX("Unhandled topicValueSet", topicPath, message);
      return false;
    }
  }
  //TODO maybe able to just setAttribute("value", val) - which would also do type conversion string to number
  valueSet(val) {
    // Note val can be of many types - it will be subclass dependent
    this.state.value = val;
    if (this.mt) this.mt.state.value = val; // Mirror to data tree so wiredTopic.state.value works headlessly
    return true; // Rerender by default - subclass will often return false
  }
  // Subclass "changeAttribute" to edit rendered elements and return true if do not want to rerender
  parameterSet(parameter, message) {
    // Note this will be silently ignored if parameter is not "observed"
    //this.mt[parameter] = Number(message); // Not setting on topic as not needed and do not know HERE if number or string
    // causes a re-render (setAttribute->attributeChangedCallback->changeAttribute->renderAndReplace)
    if (!this.constructor.observedAttributes.includes(parameter)) {
      XXX(["Good chance parameter is not observed:", parameter]);
    }
    this.setAttribute(parameter, message); // Type will be set in changeAttribute
    if (parameter === "wired") {
      this.mt.setWired(message); // setWired sets mt.wired and subscribes; parameterSet can't handle it (wired starts as undefined)
    } else {
      this.mt.parameterSet(parameter, message, this.typeOfAttribute(parameter)); // Ensure MqttTopic tracks same parameters
    }
  }
  get project() { // Note this will only work once the element is connected
    // noinspection CssInvalidHtmlTagReference
    return this.closest("mqtt-project");
  }

// Event gets called when graph icon is clicked - asks topic to add a line to the graph
  // noinspection JSUnusedLocalSymbols
  opengraph(e) {
    this.mt.createGraph();
  }
  onwiredchange(e) {
    let newPath = e.target.value;
    this.mt.setWired(newPath); // Set on MT, and subscribe if required
    // Turn new path into a setpath (e.g. org/project/node/set/sht/temperature/max)
    if ((this.mt.rw === 'r') && e.target.value) {
      let parts = e.target.value.split("/");
      parts.splice(3,0,"set");
      newPath = parts.join("/");
    }
    // Send value out, this triggers change on nodes or other UX
    this.mt.publishWired(newPath);
    // Rerender - but could just change attribute probably TODO-64

    this.renderAndReplace();
  }
  renderLabel() {
    // noinspection JSUnresolvedVariable
    return [
      el('label', {for: this.mt.topicPath, textContent: this.mt.name}),
      !this.state.graphable ? null
      : el('img', {class: "icon", src: `${ImagesUrl}icon_graph.svg`, onclick: this.opengraph.bind(this)})
    ];
  }
  renderWiredInput() {
    let wiredTopicValue = (this.wiredTopic && this.wiredTopic.state.value != null && this.wiredTopic.state.value.toString()) || this.state.value;
    this.state.elements.textValue = undefined; // Will be defined below if renderValue creates it
    this.state.elements.inputValue = undefined; // Will be defined below if renderInput creates it
    return this.mt.wired
      ? el('span', {class: 'wiredinput'}, [
          this.renderValue(wiredTopicValue), // Value is changed because this call sets elements.textValue, and changeAttribute changes it
          this.renderWiredName()
        ])
      : this.renderInput()
  }

  renderWiredName() {
    let wiredTopicName = this.wiredTopic ? `${this.wiredTopic.node.usableName}:${this.wiredTopic.usableName}` : undefined;
    return el('span', {class: 'wired', textContent: wiredTopicName})
  }
  renderDropdown() {
    // noinspection JSUnresolvedVariable
    return el('mqtt-choosetopic', {name: this.mt.name, type: this.mt.type, value: this.getAttribute('wired'), rw: (this.mt.rw === 'r' ? 'w' : 'r'), projectMt: this.mt.projectMt, onchange: this.onwiredchange.bind(this)});
  }
  // Handle cases ....
  // r/!wireable - text value
  // r/wireable/!wired - text value + hidden dropdown NOT DONE YET
  // r/wireable/wired - text value and wired topic name and hidden dropdown NOT DONE YET
  // w/!wireable - input box with value
  // w/wireable/!wired - input box with value + hidden dropdown
  // w/wireable/wired - text value(from wired) and wired topic name and hidden dropdown

  // For Bool all same except:
  // renderInput - checkbox with value
  // renderValue - check mark if value true, empty if false

  renderMaybeWired(className) {
    if (!this.mt) {
      return []; // Dont render till have mt set
    }
    // noinspection JSUnresolvedVariable

    let wiredTopicValue = this.wiredTopic ? (this.wiredTopic.state.value ?? this.state.value) : this.state.value;
    // noinspection JSUnresolvedReference
      return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: className + " outer"},
        // noinspection JSUnresolvedVariable
        this.mt.rw === 'r'
          ? [
            // noinspection JSUnresolvedVariable
            this.mt.wireable
              ? // rw==r && wireable  (e.g. manual or out
              el('details', {} , [
                el('summary', {}, [
                  this.renderLabel(),
                  this.renderValue(this.state.value),
                  !this.mt.wired ? null : this.renderWiredName() //TODO-64 may want to look more like the wiredInput version below
                ]),
                this.state.elements.chooseTopic = this.renderDropdown(),
              ])
              : [
                this.renderLabel(),
                this.renderValue(this.state.value),
              ]
          ] : [ // rw==='w'
            this.mt.wireable
              ? // rw==w && wireable   e.g. now or limit
              el('details', {} , [
                el('summary', {}, [
                  this.renderLabel(),
                  this.state.elements.wiredInput = this.renderWiredInput(),
                ]),
                this.state.elements.chooseTopic = this.renderDropdown(),
              ])
              : [ // rw==w !wireable
                this.renderLabel(),
                this.renderInput(),
              ]
          ])
    ]
  }
}
class MqttTransmitter extends MqttReceiver {
  // TODO - make sure this doesn't get triggered by a message from server.
  get valueGet() { // Needs to return an integer or a string
    return this.state.value
    // TODO could probably use a switch in MqttNode rather than overriding in each subclass
  } // Overridden for booleans

  publish() {
    this.mt.publish(this.valueGet);
  }
}
class MqttText extends MqttTransmitter {
  // constructor() { super(); }
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['min','max','wired']); }
  static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['min','max']); }

  valueSet(val) {
    super.valueSet(val);
    if (this.state.elements.textValue) {
      this.state.elements.textValue.textContent = val;
    } else if (this.state.elements.inputValue) {
      this.state.elements.inputValue.value = val;
    }
    return false; // Dont need to rerender - done above
  }

  // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    //console.log("Changed"+e.target.checked);
    this.state.value = this.mt.valueFromText(e.target.value); // Convert, for example, to float
    this.publish();
  }
  /*
  onClick(e) {
  }
   */
  renderInput() {
    return this.state.elements.inputValue = el('input', {class: "val", id: this.mt.topicPath, name: this.mt.topicPath, value: this.state.value, type: this.mt.inputType, min: this.state.min, max: this.state.max, onchange: this.onChange.bind(this)});
  }
  renderValue(val) {
    // I think val should always be this.state.value, even when called in renderMaybeWired with wiredTopicValue
    //if (val != this.state.value) { XXX(["Mistaken assumption in MqttText.renderValue"])} // TODO-64
    return this.state.elements.textValue = el('span',{class: "val", textContent: val || "", i8n: false, /*onclick: this.onClick.bind(this)*/});
  }
  render() {
    return this.renderMaybeWired("mqtt-text "+(this.mt && this.mt.twig && this.mt.twig.replaceAll('/','_') || ""));
  }

}
customElements.define('mqtt-text', MqttText);
class MqttColor extends MqttTransmitter {
  // constructor() { super(); }
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['wired']); }
  ; static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['min','max']); }

  // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    //console.log("Changed"+e.target.checked);
    this.state.value = this.mt.valueFromText(e.target.value); // Convert, for example, to float
    this.publish();
  }
  /*
  onClick(e) {
  }
   */
  renderInput() {
    return el('input', {class: "val", id: this.mt.topicPath, name: this.mt.topicPath, value: this.state.value, type: "color", onchange: this.onChange.bind(this)});
  }
  renderValue(val) {
    return el('span',{class: "val", textContent: val || "", i8n: false, /*onclick: this.onClick.bind(this)*/});
  }
  render() {
    return this.renderMaybeWired("mqtt-text "+(this.mt && this.mt.twig && this.mt.twig.replaceAll('/','_') || ""));
  }

}
customElements.define('mqtt-color', MqttColor);
class MqttToggle extends MqttTransmitter {
  // When the labels attribute is absent, renders a checkbox.
  // When labels="false-label,true-label" is set, renders a two-option select dropdown instead.
  valueSet(val) {
    super.valueSet(val);
    this.state.indeterminate = false; // Checkbox should default to indeterminate till get a message
    if (this.state.elements.inputValue) {
      if (this.hasLabels) {
        this.state.elements.inputValue.value = val ? '1' : '0';
      } else {
        this.state.elements.inputValue.checked = !!this.state.value;
        this.state.elements.inputValue.indeterminate = typeof(this.state.value) == "undefined";
      }
    }
    if (this.state.elements.textValue) {
      this.state.elements.textValue.textContent = this.textValue;
    }
    return false; // No need to re-render
  }
  get valueGet() {
    // TODO use Mqtt to convert instead of subclassing
    return (+this.state.value).toString(); // Implicit conversion from bool to int then to String.
  }
  static get observedAttributes() {
    return MqttTransmitter.observedAttributes.concat(['checked','indeterminate','wired','labels']);
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // Change from string to number etc and store on this.state
    if (name === 'labels' && valueString) {
      // Split on first comma so labels can contain commas after the first
      const idx = valueString.indexOf(',');
      if (idx !== -1) {
        this.state.falseLabel = valueString.substring(0, idx);
        this.state.trueLabel  = valueString.substring(idx + 1);
      }
    }
    return true; // Need to rerender
  }

  // True when a labels="false-label,true-label" attribute has been parsed
  get hasLabels() {
    return this.state.falseLabel !== undefined && this.state.trueLabel !== undefined;
  }

  // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    // Select option values are '0'/'1'; checkbox uses .checked
    this.state.value = this.hasLabels ? (e.target.value === '1') : e.target.checked;
    this.publish();
  }
  get textValue() {
    // Note same code in MqttGroupControlHysteresis but no obvious common parent
    if (this.hasLabels) {
      return (this.state.value === undefined) ? '?' : (this.state.value ? this.state.trueLabel : this.state.falseLabel);
    }
    return (this.state.value === undefined) ? '?' : (this.state.value ? '✓' : '✗')
  }
  // Handle cases ....
  // r/!wireable - text value
  // r/wireable/!wired - text value + hidden dropdown NOT DONE YET
  // r/wireable/wired - text value and wired topic name and hidden dropdown NOT DONE YET
  // w/!wireable - input box with value
  // w/wireable/!wired - input box with value + hidden dropdown
  // w/wireable/wired - text value(from wired) and wired topic name and hidden dropdown

  // For Bool all same except:
  // renderInput - checkbox or two-option select (when labels attribute set)
  // renderValue - label text or check mark (✓/✗) depending on hasLabels

  renderInput() {
    if (this.hasLabels) {
      // Two-option select where option values are '0' (false) and '1' (true)
      return this.state.elements.inputValue = el('select', {class: 'val', onchange: this.onChange.bind(this)}, [
        el('option', {value: '0', textContent: this.state.falseLabel, selected: !this.state.value}),
        el('option', {value: '1', textContent: this.state.trueLabel,  selected: !!this.state.value}),
      ]);
    }
    return this.state.elements.inputValue = el('input', {class: 'val', type: 'checkbox', id: this.mt.topicPath,
      checked: !!this.state.value, indeterminate: typeof(this.state.value) == "undefined",
      onchange: this.onChange.bind(this)});
  }
  renderValue(val) {
    return this.state.elements.textValue = el('span',{class: 'val', textContent: this.textValue});
  }
  render() {
    return this.renderMaybeWired("mqtt-toggle");
  }
}
customElements.define(  'mqtt-toggle', MqttToggle);
class MqttBar extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['min', 'max']); }
  static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['value', 'min', 'max']); }

  constructor() {
    super();
  }
  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val); // TODO could get smarter about setting width in span rather than rerender
    if (this.state.elements.inner) {
      this.state.elements.inner.style.width = `${this.width}%`;
    }
    if (this.state.elements.textValue) {
      this.state.elements.textValue.textContent = val;
    }
    return false; // Note will not re-render children like a MqttSlider because these are inserted into DOM via a "slot"
  }
  get width() {
    return this.state.type === "exponential"
      ? 100*(Math.log(this.state.value/(this.state.min||1))/Math.log(this.state.max/(this.state.min||1)))
      : 100*(this.state.value-this.state.min)/(this.state.max-this.state.min)
    ;
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // Change from string to number etc and store on this.state
    // TODO - could set width, color, name, on sub-elements and return false then copy this to other elements
    return true; // Need to rerender -TODO-optimize this
  }
  // This is a WIP, trying to use "innerHtml", not called anywhere yet, and only partially works.
  renderInner() {
    return `
      <link rel="stylesheet" href="${CssUrl}">
      <div  class="outer mqtt-bar">
        <div class="name">
          <label for="${this.mt.topicPath}">${this.mt.name}</label>
          ${this.state.graphable ? `<img class="icon" src="${ImagesUrl}icon_graph.svg" onclick="${this.opengraph.bind(this)}">` : ''}
        </div>
        <div class="bar" id="${this.mt.topicPath}">
          <span class="left" style="width:${this.width}%; background-color:${this.state.color};"><!--needs to set state.elements.inner -->
            <span class="val">${this.state.value}</span><!-- needs to set state.elements.textValue -->
          </span>
        </div>
        <slot></slot><!-- Children would be a setpoint, but not using currently -->
      </div>
   `;
  }
  render() {
    return !(this.isConnected && this.mt) ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "outer mqtt-bar"}, [

        el('div', {class: "name"}, [
          el('label', {for: this.mt.topicPath, textContent: this.mt.name}),
          !this.state.graphable ? null
          : el('img', {class: "icon", src: `${ImagesUrl}icon_graph.svg`, onclick: this.opengraph.bind(this)}),
        ]),
        el('div', {class: "bar", id: this.mt.topicPath},[
          // Note width overridden as value changes
          this.state.elements.inner = el('span', {class: "left", style: `width:${this.width}%; background-color:${this.state.color};`},[
            this.state.elements.textValue = el('span', {class: "val", textContent: this.state.value}),
          ]),
          //Do not appear to need this - and it sometimes wraps, so if re-enabled, need to make sure always horiz next to left
          //el('span', {class: "right", style: "width:"+(100-width)+"%"}),
        ]),
        el('slot',{}), // Children would be a setpoint, but not using currently
      ]),
    ];
  }
}
customElements.define('mqtt-bar', MqttBar);
class MqttGauge extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['min','max']); }
  static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['value','min','max']); }

  constructor() {
    super();
  }
  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val); // TODO could get smarter about setting with in span rather than rerender
    this.state.elements.dg.setAttribute('value',val);
    return false; // Note will not re-render children like a MqttSlider because these are inserted into DOM via a "slot"
  }
  render() {
    //this.state.changeable.addEventListener('change', this.onChange.bind(this));
    //let width = 100*(this.state.value-this.state.min)/(this.state.max-this.state.min);
    // noinspection JSUnresolvedReference
    return !(this.isConnected && this.mt) ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "outer mqtt-gauge"}, [
        this.state.elements.dg = el('dial-gauge', {
          "main-title": this.mt.name,
          "sub-title": "",
          "scale-start": this.state.min,
          "scale-end": this.state.max,
          "value": this.state.value,
          "scale-offset": 45,
          "style": `--dg-arc-color:${this.state.color}`,
        }),
        !this.state.graphable ? null
          : el('img', {class: "icon", src: `${ImagesUrl}icon_graph.svg`, onclick: this.opengraph.bind(this)}),
      ]),
    ];
  }
}
customElements.define('mqtt-gauge', MqttGauge);

// TODO Add some way to do numeric display, numbers should change on mousemoves.
class MqttSlider extends MqttTransmitter {
  static get observedAttributes() { return MqttTransmitter.observedAttributes.concat(['min','max','color','setpoint','continuous']); }
  static get floatAttributes() { return MqttTransmitter.floatAttributes.concat(['value','min','max', 'setpoint']); }
  static get boolAttributes() { return MqttTransmitter.boolAttributes.concat(['continuous'])}

  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val);
    this.thumb.style.left = this.leftOffset + "px";
    return true; // Rerenders on moving based on any received value but not when dragged
    // TODO could get smarter about setting with rather than rerendering
  }
  get valueGet() {
    // TODO use mqttTopic for conversion instead of subclassing
    return (this.state.value).toPrecision(3); // Conversion from int to String (for MQTT)
  }
  leftToValue(l) {
    // TODO - I doubt this is workign with exponential
    if (this.state.type === "exponential") { XXX(["exponential sliders not tested"]); }
    return (l+this.thumb.offsetWidth/2)/this.slider.offsetWidth * (this.state.max-this.state.min) + this.state.min;
  }
  get leftOffset() {
    return ((this.state.type === "exponential")
      ? (Math.log(this.state.value/(this.state.min||1))/Math.log(this.state.max/(this.state.min||1)))
      : ((this.state.value-this.state.min)/(this.state.max-this.state.min))
    ) * (this.slider.offsetWidth) - this.thumb.offsetWidth/2;
  }
  onmousedown(event) {
    event.preventDefault();
    let shiftX = event.clientX - this.thumb.getBoundingClientRect().left; // Pixels of mouse click from left
    let thumb = this.thumb;
    let slider = this.slider;
    let tt = this;
    let lastvalue = this.state.value;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    function onMouseMove(event) {
      let newLeft = event.clientX - shiftX - slider.getBoundingClientRect().left;
      // if the pointer is out of slider => lock the thumb within the boundaries
      newLeft = Math.min(Math.max( -thumb.offsetWidth/2, newLeft,), slider.offsetWidth - thumb.offsetWidth/2);
      tt.valueSet(tt.leftToValue(newLeft));
      // noinspection JSUnresolvedReference
      if (tt.state.continuous && (tt.state.value !== lastvalue)) { tt.publish(); lastvalue = tt.state.value; }
    }
    // noinspection JSUnusedLocalSymbols
    function onMouseUp(event) {
      tt.publish();
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onMouseMove);
    }
    // shiftY not needed, the thumb moves only horizontally
  }
  renderAndReplace() {
    super.renderAndReplace();
    if (this.thumb) {
      this.thumb.style.left = this.leftOffset + "px";
    }
  }
  render() {
    if ((!this.slider) && (this.children.length > 0)) {
      // Build once as don't want re-rendered - but do not render till after children added (end of EL)
      this.thumb = el('div', {class: "setpoint"}, this.children);
      this.slider = el('div', {class: "pointbar",},[this.thumb]);
      this.slider.onmousedown = this.onmousedown.bind(this);
    }
    // noinspection JSUnresolvedReference
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "mqtt-slider outer"}, [
        el('div', {class: "name"}, [ //TODO maybe use a label
          // noinspection JSUnresolvedReference
          el('span', {textContent: this.mt.name}),
          el('span', {class: "val", textContent: this.state.value}), // TODO restrict number of DP
        ]),
        this.slider,  // <div.setpoint><child></div
      ])
    ];
  }
}
customElements.define('mqtt-slider', MqttSlider);

// Class to display a drop down that can select from topics of the right type (e.g. rw float's)
class MqttChooseTopic extends MqttElement {
  // type = "bool" for boolean topics (matches t.type on others)
  // value = the topic path of the currently wired topic,
  static get observedAttributes() { return MqttTransmitter.observedAttributes.concat(['name', 'type','value', 'projectMt','rw','onchange']); }

  get findTopics() {
    const projectMt = this.state.projectMt;
    if (!projectMt) return [];
    // For type="control", return the list of discovered control groups rather than typed topics.
    // Option value is "nodeId/groupId" so the caller can look up nodeMt from the data tree.
    if (this.state.type === 'control') {
      return projectMt.controlGroupList.map(({ nodeMt, groupId }) => {
        const value = `${nodeMt.nodeId}/${groupId}`;
        const groupMt = nodeMt.groups[groupId];
        const label = `${nodeMt.usableName} / ${(groupMt && groupMt.state.name) || groupId}`;
        return { name: label, topic: value, setTopic: value };
      });
    }
    const allowableTypes = {
      "float": ["float", "int", "exponential"],
      "text": ["text", "float", "exponential", "int", "bool"],
    };
    return Object.values(projectMt.nodes)
      .flatMap(n => n.topicsByType(allowableTypes[this.state.type] || this.state.type, this.state.rw));
  }

  // noinspection JSCheckFunctionSignatures
  valueSet(val) { // val is new path to topic wired to.
    this.state.value = (val);
    this.renderAndReplace();
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // convert and store on state
    return true; // Rerender - will use new value, name etc.
    // Note that value is expected to change when topic is rewired
  }
  // This should be called when the list of topics to choose from changes, for example new Node added
  rebuildDropdown() {
    this.renderAndReplace(); // This could be optimized, but its about as simple as it gets.
  }
  render() {
    // noinspection JSUnresolvedReference
    // One id, used by both the label and the select it labels
    const selectId = 'choosetopic' + nextUniqueId();
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'outer mqtt-choosetopic', part: 'row'}, [
        el('label', {for: selectId, textContent: this.state.name, part: 'label'}),
        el('select', {id: selectId, onchange: (e) => this.onchange && this.onchange(e), part: 'select'}, [
          el('option', {value: "", textContent: "Unused", selected: !this.state.value}),
          this.findTopics.map( t => { // { name, type etc. }
            const val = this.state.rw === 'w' ? t.setTopic : t.topic;
            // Check all three forms in case the stored wiredPath uses a different format
            return el('option', {value: val, textContent: t.name, selected: this.state.value === val || this.state.value === t.topic || this.state.value === t.setTopic});
          }),
        ]),
      ]),
    ];
  }
}
customElements.define('mqtt-choosetopic', MqttChooseTopic);

// Outer element of the client - Top Level logic
// If specifies org / project / node then believe it and build to that
// otherwise get config from server
// Add appropriate internals

// Functions on the configuration object returned during discovery - see more in frugal-iot-logger

export {
  MqttElement,
  MqttReceiver,
};
