/*
 * Frugal IoT client - login, the tab strip, and the admin panel: OTA, permissions, projects, nodes
 * and the API tools.
 */

import {EL, GET, HTMLElementExtended} from '/node_modules/html-element-extended/htmlelementextended.js';
import mqtt from '/node_modules/mqtt/dist/mqtt.esm.js'; // https://www.npmjs.com/package/mqtt
import { CssUrl, POST, XXX, configSet, el, getString, locationParameterChange, mqtt_client, preferedLanguageSet, preferedLanguages, redirectToLogin, server_config } from './core.js';

class MqttLogin extends HTMLElementExtended { // TODO-89 may depend on organization
  constructor(props) {
    super(props);
    this.state = {register: false};
  }
  static get observedAttributes() { return ['register','message','url','lang']; }
  static get boolAttributes() { return ['register']; }

  connectedCallback() {
    this.loadAttributesFromURL();
    super.connectedCallback();
  }
  changeAttribute(name, value) {
    if (name === "lang") {
      if (value.includes(',')) {
        preferedLanguages = (value.split(',')).map(v => v.toUpperCase());
      } else if (!value) {
        preferedLanguageSet('EN');
        locationParameterChange("lang", preferedLanguages.join(','));
      } else {
        preferedLanguageSet(value.toUpperCase());
      }
    }
    super.changeAttribute(name, value);
  }

  tabRegister(register) {
    this.changeAttribute('register', register);
    this.renderAndReplace();
  }
  // this.state.url (the page to return to after login) may already have its own query string, so set
  // "lang" via the URL API rather than naively concatenating "?lang=...", which would produce a second
  // "?" if one is already present.
  urlWithLang(urlStr) {
    if (!urlStr) { return urlStr; }
    try {
      const u = new URL(urlStr, window.location.origin);
      u.searchParams.set('lang', preferedLanguages.join(','));
      return u.toString();
    } catch (e) {
      return urlStr;
    }
  }
  render() { //TODO-89 needs styles
    // TODO-89 organization should be dropdown
    // TODO-89 merge login & register
    if (preferedLanguages.length === 0) { XXX("Tracking down issue with lang"); }
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'mqtt-login'},[
        // This is a top bar, holds message and language picker
        el('div',{class: 'message'},[
          el('span', {textContent: this.state.message}),
          el('language-picker'),
        ]),
        el('tabbed-display', {tab: this.state.register ? 1 : 0 }, [
          el('section', {title: "Sign In"}, [
            el('form', {action:  '/login', method: "post"}, [
              el('section', {}, [
                el('label', {for: "username", textContent: 'Username'}),
                el('input', {id: "username", name: "username", type: "text", autocomplete: "username", required: true, autofocus: true}),
              ]),
              el('section', {}, [
                el('label', {for: "password", textContent: "Password"}),
                el('input', {id: "password", name: "password", type: "password", autocomplete: "current-password", required: true}),
              ]),
              el('input', {id: "url", name: "url", type: "hidden", value: this.urlWithLang(this.state.url)}),
              el('button', {class: "submit", type: "submit",
                textContent: (this.state.register ? 'Submit' : 'Submit')}),
            ]),
          ]),
          el('section', {title: "Register"}, [
            el('form', {action: '/register', method: "post"}, [
              el('section', {}, [
                el('label', {for: "username", textContent: 'Username'}),
                el('input', {id: "username", name: "username", type: "text", autocomplete: "username", required: true, autofocus: true}),
              ]),
              el('section', {}, [
                el('label', {for: "password", textContent: "Password"}),
                el('input', {id: "password", name: "password", type: "password", autocomplete: "current-password", required: true}),
              ]),
              // TODO-22 TODO-14 organization should be a drop-down
              el('section', {}, [
                el('label', {for: "organization", textContent: "Organization"}),
                el('span', {textContent: "Note this is your organization - not the organizations whose devices you want to access." }),
                el('br'),
                el('input', {id: "organization", name: "organization", type: "text", autocomplete: "organization", required: false}),
              ]),
              el('section', {}, [
                el('label', {for: "name", textContent: "Name"}),
                el('input', {id: "name", name: "name", type: "text", autocomplete: "name", required: true}),
              ]),
              el('section', {}, [
                el('label', {for: "email", textContent: "Email"}),
                el('input', {id: "email", name: "email", type: "text", autocomplete: "email", required: true}),
              ]),
              el('section', {}, [
                el('label', {for: "phone", textContent: "Phone or Whatsapp"}),
                el('input', {id: "phone", name: "phone", type: "text", autocomplete: "phone", required: true}),
              ]),
              el('input', {id: "url", name: "url", type: "hidden", value: this.urlWithLang(this.state.url)}),
              el('button', {class: "submit", type: "submit", textContent: 'Submit'}),
            ]),
          ]),
        ]),
      ]),
    ];
  }
}
customElements.define('mqtt-login', MqttLogin);
class TabbedDisplay extends HTMLElementExtended {
  constructor() {
    super();
    this.state = {tab: 0};
    this.tabs = [];
  }
  static get observedAttributes() { return ['tab']; }
  static get integerAttributes() { return ['tab']; }

  tabSelect(tab) {
    this.changeAttribute('tab', tab);
    this.renderAndReplace();
    // Let a parent lazily load a tab's data only once it's actually selected, rather than eagerly
    // for every tab whenever e.g. the organization changes - see MqttAdmin.onTabChange.
    const title = this.children[tab] && this.children[tab].getAttribute('title');
    this.dispatchEvent(new CustomEvent('tabchange', {detail: {tab, title}}));
  }
  updateActive(value) {
    // Note this may get called before children added, so careful not to change 'tab'
    if (this.children.length && this.tabs.length) {
      if (value < 0) value = 0;
      if (value >= this.children.length) value = this.children.length - 1;
      for (let i = 0; i < this.children.length; i++) {
        //if (this.children[i].tagName.toLowerCase() === 'section') {
        if (i === value) {
          // TODO could do this more easily with classList, but need to edit CSS
          this.children[i].className = "tabbed-section active";
          this.tabs[i].className = "tab active";
        } else {
          this.children[i].className = "tabbed-section inactive";
          this.tabs[i].className = "tab inactive";
        }
        //}
      }
    }
  }
  changeAttribute(name, value) {
    super.changeAttribute(name, value); // will set this.state.tab if name is "tab"
    if (name === "tab") {
      this.updateActive(this.state.tab);
    }
  }
  render() {
    //let contents = [];
    let i = 0;
    this.tabs = Array.from(this.children).map((c, i) =>
      el('button', {
        onclick: this.tabSelect.bind(this, i),
        textContent: c.getAttribute('title') })
    );
    this.updateActive(this.state.tab); // sets active/inactive on children and tabs
    this.classList.toggle('solo', this.tabs.length <= 1); // light-DOM class so CSS can suppress border
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'tabbed-display'}, [
        this.tabs.length > 1 ? el('section', {class: 'tabs'}, this.tabs) : null,
        el('slot',{}), // Children are the sections i.e. each tabs content
      ]),
    ];
  }
}
customElements.define('tabbed-display', TabbedDisplay);

// ---------- USB flashing over WebSerial ----------
// The .bin files the OTA tab handles are application images. An ESP32 also needs a bootloader,
// partition table and otadata, which are app-independent and kept in base/ - see FLASH_PLAN.md.
class MqttAdmin extends HTMLElementExtended { // TODO-89 may depend on organization
  constructor(props) {
    super(props);
    this.state = {register: false, ota_files: [], people_list: [], projects_list: [], platforms_list: [], farms_list: [], farm_nodes_list: [],
      selected_platform_id: null, selected_farm_id: null, selected_farm_node: null, device_schema: null, selected_action: null,
      // Default tab is "Dashboard" (index 0 in render()) - tabsNeedingLoad tracks which of the other,
      // network-backed tabs (OTA/Admin/API) still need their data (re-)fetched for the current
      // organization; see setOrganization and onTabChange.
      activeTabTitle: 'Dashboard', tabsNeedingLoad: new Set()};
    this.state.elements = {};
  }
  static get observedAttributes() { return ['register','message','url','lang','org','section']; }
  static get boolAttributes() { return ['register']; }

  message(msg, i8n=true) {
    const i8nmsg = i8n ? getString(msg) : msg;
    console.error(i8nmsg);
    this.state.message = i8nmsg;
    if (this.state.elements.message) {
      this.state.elements.message.textContent = i8nmsg;
    }
    //this.append(el('div', {class: 'message', textContent: msg}));
  }
  orgsByPerm(capability) {
    return server_config.user.permissions
      .filter(o => o.capability === capability)
      .map(o => [ o.org, server_config.organizations[o.org].name ])
  }
  get adminOrgs() {
    return this.orgsByPerm("ADMIN");
  }
  get otaOrgs() {
    return this.orgsByPerm("OTAUPDATE");
  }
  connectedCallback() {
    // TODO-22 security this will be replaced by a subset of config.yaml,
    //  that is public, but in the same format, so safe to build on this for now
    // This should always succeed because index.html would have redirected to login.html if not logged in
    if (server_config) { // Already fetched, by the page or by another admin element beside this one
      this.loadAttributesFromURL();
      this.renderAndReplace();
      this.setDefaultOrganization();
      return;
    }
    GET("/config.json", {}, (err, json) => {
      if (err) {
        //if (err.message.includes("401")) { // This can happen if accessing from service worker which has /dashboard cached
          redirectToLogin();
        //} else {
        //  this.message(err);
        //}
        return;
      } else { // got config
        configSet(json);
        this.loadAttributesFromURL();
        this.renderAndReplace(); // TODO check, but should not need to renderAndReplace as render is (currently) fully static
        // setDefaultOrganization -> setOrganization already (lazily) loads whichever tab is active -
        // no need to separately fetch OTA/Admin data here too.
        this.setDefaultOrganization();
      }
    });
    //super.connectedCallback(); // Not doing as finishes with a re-render.
  }
  changeAttribute(name, value) {
    if (name === "lang") {
      if (value.includes(',')) {
        preferedLanguages = (value.split(',')).map(v => v.toUpperCase());
      } else if (!value) {
        preferedLanguageSet('EN');
        locationParameterChange("lang", preferedLanguages.join(','));
      } else {
        preferedLanguageSet(value.toUpperCase());
      }
    }
    // org - changes state, may need to get ota files and rerender
    super.changeAttribute(name, value);
  }
  projectDropdown(org) {
    if (!org) { return el('span', {textContent: "No projects to display until organization selected"}); }
    return el('select', {id: 'projects', name: 'project' /*onchange: this.onOrganization.bind(this)*/}, [
      //el('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
      el('option', {value: "+", textContent: "All", selected: true}),
      Object.entries(server_config.organizations[org].projects)
        .map(([pid, p]) => [ pid, p.name ])
        .map(([pid, name]) =>
          el('option', {value: pid, textContent: `${pid}: ${name}`, selected: false}))
    ]);
  }

  // Content behind an organization dropdown (OTA/Admin/Nodes/API tabs) should not show until an
  // organization is selected. contentFn is a MqttAdmin method, called with `this` bound.
  gatedContent(contentFn) {
    return this.state.org ? contentFn.call(this) : el('p', {textContent: "Select an organization to continue."});
  }
  // An "Add X" button that expands into buildForm() once clicked, and stays expanded - used for the
  // "Add Project", "Add Platform" and "Add Farm" forms so they don't clutter the tab until the admin wants to add one.
  collapsibleArea(key, label, buildForm) {
    this.state.expanded = this.state.expanded || {};
    if (this.state.expanded[key]) {
      return buildForm.call(this);
    }
    return el('button', {class: 'submit', type: 'button', textContent: `+ ${label}`, onclick: () => {
      this.state.expanded[key] = true;
      this.replaceElement(key, this.collapsibleArea(key, label, buildForm));
    }});
  }
  orgDropdown(org, list, id) {
    return el('section', {}, [
      el('label', {for: 'organizations', textContent: "Organization"}),
      el('select', {id: id, name: 'organization', onchange: this.onOrganization.bind(this)}, [
        org ? null : // Display unselected if haven't picked one
          el('option', {value: "", textContent: "Not selected", selected: true}),
        list.map(([oid, name]) =>
          el('option', {value: oid, textContent: `${oid}: ${name}`, selected: org == oid}))
      ]),
    ]);
  }
// Fetch ota files and display
  getOrDeleteOtaFiles(url) {
    GET(url, {}, (err, json) => {
      if (err) {
        this.message(err);
        return;
      } else { // got config
        this.state.ota_files = json;
        this.replaceElement("ota_files", this.otaFilesList());
      }
    });
  }
  getOtaFiles() {
    if (this.state.org) {
      if (this.otaOrgs.map(o => o[0]).includes(this.state.org)) {
        this.getOrDeleteOtaFiles(`/ota_list/${this.state.org}`);
      }
    }
  }
  onOtaDelete(val, ev) {
    console.log(ev,val);
    this.getOrDeleteOtaFiles(`/ota_delete/${val}`);
  }
  onOtaFlash(path) {
    const flashEl = this.state.elements.flash;
    if (flashEl) flashEl.setRemoteSource(this.state.org, path);
  }
  otaFilesList() {
    return this.state.ota_files.length === 0 ?
      el('p', {textContent: "No OTA files uploaded yet."}) :
      el('p', {}, this.state.ota_files.map(f => [
        el('span', {class: 'pseudolink', title: getString("Flash this over USB"), textContent: '⚡', onclick: this.onOtaFlash.bind(this, f)}),
        el('span', {class: 'pseudolink', textContent: `🗑  ${f}`, onclick: this.onOtaDelete.bind(this,`${this.state.org}/${f}`)}),
        el('br', {}),
        ])
      );
  }
  // Fetch people and display
  getOrChangeAdminPeople(url) {
    GET(url, {}, (err, json) => {
      if (err) {
        this.message(err.message);
        return;
      } else { // got config
        this.state.people_list = json; // { peopleperms, people }
        this.replaceElement("people_perms_list", this.peoplePermList());
        this.replaceElement("people_list", this.peopleList());
      }
    });
  }
  getPeopleList() {
    if (this.state.org) {
      this.getOrChangeAdminPeople(`/people_list/${this.state.org}`);
    }
  }
  // Fetch projects and display
  getOrChangeAdminProjects(url) {
    GET(url, {}, (err, json) => {
      if (err) {
        this.message(err.message);
        return;
      } else { // got projects
        this.state.projects_list = json; // [{id, name}]
        this.replaceElement("projects_display_list", this.projectsDisplayList());
      }
    });
  }
  getProjectsList() {
    if (this.state.org) {
      this.getOrChangeAdminProjects(`/projects_list/${this.state.org}`);
    }
  }
  onPermissionsDelete(val, ev) {
    console.log(ev,val);
    this.getOrChangeAdminPeople(`/permissions_delete/${val}`);
  }
  onPublishMessage(ev) {
    const topic = this.state.elements.msg_topic.value;
    const value = this.state.elements.msg_value.value;
    const retain = this.state.elements.msg_retain.checked;
    const qos = parseInt(this.state.elements.msg_qos.value);

    if (!topic || !value) {
      this.message("Topic and Value are required");
      return;
    }
    if (!mqtt_client) { // Not connected until an organization is chosen, as its credentials are needed
      this.message("Choose an organization first, so there is a broker connection to publish on");
      return;
    }

    mqtt_client.publish(topic, value, {retain: retain, qos: qos});
    this.message(`${getString('Published to ')}${topic}`, false);

    // Clear the form
    this.state.elements.msg_topic.value = '';
    this.state.elements.msg_value.value = '';
    this.state.elements.msg_retain.checked = false;
    this.state.elements.msg_qos.value = '0';
  }
  peoplePermList() {
    return ((!this.state.people_list) || (!this.state.people_list.peopleperms) || (this.state.people_list.peopleperms.length === 0)) ?
      el('p', {textContent: "Nobody added for this organization yet."}) :
      el('p', {}, this.state.people_list.peopleperms.map(f => [
          el('span', {class: 'pseudolink', textContent: ' 🗑 ', onclick: this.onPermissionsDelete.bind(this,`${this.state.org}?id=${f.id}&capability=${f.capability}`)}),
          `${f.name}: ${f.capability}`,
          el('br', {}),
        ])
      );
  }
  peopleList() {
    let EL = el('form', {action: `/add_permission/${this.state.org}`, method: "post"}, [
      el('input', {id: "url3", name: "url", type: "hidden", value: `/dashboard/`}),
      el('input', {id: "lang", name: "lang", type: "hidden", value: preferedLanguages.join(',')}),
      // dropdown for name and for permissions
      el('div', {class: 'dropdownsadmin'}, [
        //el('label', {for: 'projects', textContent: "Project"}),
        el('select', {id: 'id', name: 'id'}, [
          el('option', {value: -1, textContent: "Not selected", selected: !this.state.value}),

          ((this.state.people_list) && (this.state.people_list.people) && (this.state.people_list.people.length > 0)) &&
          this.state.people_list.people.map(x =>
            el('option', {value: x.id, textContent: x.name, selected: false, i8n: false})
          )
        ]),
        el('select', {id: 'capability', name: 'capability'}, [
          el('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
          ["OTAUPDATE","ADMIN","READ"].map(x =>
            el('option', {value: x, textContent: x, selected: false, i8n: false})
          )
        ]),
        el('button', {class: "submit", type: "submit", textContent: 'Add'}),
      ]),
    ]);
    EL.addEventListener('submit', (e) => {
      e.preventDefault();
      const urlparms =  new URLSearchParams(new FormData(this.state.elements.people_list)).toString();
      this.getOrChangeAdminPeople(`/add_permission/${this.state.org}?${urlparms}`);
    });
    return EL;
  }
  projectsDisplayList() {
    return ((!this.state.projects_list) || (this.state.projects_list.length === 0)) ?
      el('p', {textContent: "No projects added for this organization yet."}) :
      el('p', {}, this.state.projects_list.map(p => [
          `${p.id}: ${p.name}`,
          el('br', {}),
        ])
      );
  }
  projectsAddForm() {
    let EL = el('form', {}, [
      el('div', {class: 'dropdownsadmin'}, [
        el('label', {for: 'project_id', textContent: "Project ID"}),
        el('input', {id: 'project_id', name: 'id', type: 'text', placeholder: 'id', required: true,
          pattern: '[a-z0-9]+', title: "Lower-case letters and numbers only, no spaces or punctuation"}),
        el('label', {for: 'project_name', textContent: "Project Name"}),
        el('input', {id: 'project_name', name: 'name', type: 'text', placeholder: 'Name', required: true}),
        el('button', {class: "submit", type: "submit", textContent: 'Add'}),
      ]),
    ]);
    EL.addEventListener('submit', (e) => {
      e.preventDefault();
      const urlparms = new URLSearchParams(new FormData(EL)).toString();
      this.getOrChangeAdminProjects(`/add_project/${this.state.org}?${urlparms}`);
      EL.reset();
    });
    return EL;
  }
  // Fetch all registered Farm-Platforms, and display. Not org-scoped - a platform is a many-to-many
  // relationship with orgs/projects, recorded per-mapping in api_farms (see getFarmsList).
  getPlatformsList() {
    if (this.state.org) {
      GET(`/api/platforms/list`, {}, (err, json) => {
        if (err) {
          this.message(err.message);
          return;
        }
        this.state.platforms_list = json;
        // Keep the current selection if still present, default to the only platform if there's exactly one,
        // otherwise leave unselected so the admin has to choose.
        if (!json.some(p => p.id === this.state.selected_platform_id)) {
          this.state.selected_platform_id = json.length === 1 ? json[0].id : null;
        }
        this.replaceElement("platforms_list_display", this.platformsListDisplay());
        this.replaceElement("add_farm", this.collapsibleArea('add_farm', "Add Farm", this.farmRegisterForm));
      });
    }
  }
  onPlatformSelect(ev) {
    this.state.selected_platform_id = parseInt(ev.target.value, 10);
  }
  platformLabel(p) {
    return `${p.name} — user: ${p.user}` + (p.base_url ? ` — ${p.base_url}` : '');
  }
  platformsListDisplay() {
    const platforms = this.state.platforms_list || [];
    if (platforms.length === 0) {
      return el('p', {textContent: "No platforms registered yet."});
    }
    if (platforms.length === 1) {
      return el('p', {textContent: this.platformLabel(platforms[0]), i8n: false});
    }
    return el('select', {id: 'platforms_select', onchange: this.onPlatformSelect.bind(this)}, [
      platforms.map(p =>
        el('option', {value: p.id, textContent: this.platformLabel(p), selected: p.id === this.state.selected_platform_id, i8n: false}))
    ]);
  }
  postPlatformRegister(body, formEl) {
    POST('/api/platforms/register', body, (err, json) => {
      if (err) {
        this.message(err.message);
        return;
      }
      this.message("Platform registered");
      formEl.reset();
      this.getPlatformsList();
    });
  }
  platformRegisterForm() {
    let EL = el('form', {}, [
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'platform_name', textContent: "Platform Name *"}),
        this.state.elements.platform_name = el('input', {id: 'platform_name', name: 'name', type: 'text', placeholder: 'e.g. LiteFarm', required: true}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'platform_user', textContent: "Frugal-IoT Username *"}),
        this.state.elements.platform_user = el('input', {id: 'platform_user', name: 'user', type: 'text', required: true}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'platform_base_url', textContent: "Base URL"}),
        this.state.elements.platform_base_url = el('input', {id: 'platform_base_url', name: 'base_url', type: 'url', placeholder: 'https://...'}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'platform_auth_token', textContent: "Auth Token"}),
        this.state.elements.platform_auth_token = el('input', {id: 'platform_auth_token', name: 'auth_token', type: 'text'}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'platform_cookie_name', textContent: "Cookie Name"}),
        this.state.elements.platform_cookie_name = el('input', {id: 'platform_cookie_name', name: 'cookie_name', type: 'text'}),
      ]),
      el('button', {class: 'submit', type: 'submit', textContent: 'Register Platform'}),
    ]);
    EL.addEventListener('submit', (e) => {
      e.preventDefault();
      this.postPlatformRegister({
        name: this.state.elements.platform_name.value,
        user: this.state.elements.platform_user.value,
        base_url: this.state.elements.platform_base_url.value || undefined,
        auth_token: this.state.elements.platform_auth_token.value || undefined,
        cookie_name: this.state.elements.platform_cookie_name.value || undefined,
      }, EL);
    });
    return el('div', {}, [el('h3', {textContent: "Register Platform"}), EL]);
  }
  // Fetch farm-to-project mappings registered for the selected organization, and display
  getFarmsList() {
    if (this.state.org) {
      GET(`/api/farms/list?org=${encodeURIComponent(this.state.org)}`, {}, (err, json) => {
        if (err) {
          this.message(err.message);
          return;
        }
        this.state.farms_list = json;
        if (!json.some(f => f.id === this.state.selected_farm_id)) {
          this.state.selected_farm_id = json.length ? json[0].id : null;
        }
        this.state.selected_farm_node = null;
        this.replaceElement("farms_list_display", this.farmsListDisplay());
        this.getFarmNodesList();
        this.replaceElement("farm_node_actions", this.farmNodeActions());
        this.getDeviceActionSchema();
      });
    }
  }
  onFarmSelect(ev) {
    this.state.selected_farm_id = parseInt(ev.target.value, 10);
    this.state.selected_farm_node = null;
    this.getFarmNodesList();
    this.replaceElement("farm_node_actions", this.farmNodeActions());
    this.getDeviceActionSchema();
  }
  farmLabel(f) {
    return `${f.farm_id} → ${f.org}/${f.project}`;
  }
  farmsListDisplay() {
    const farms = this.state.farms_list || [];
    if (farms.length === 0) {
      return el('p', {textContent: "No farms registered for this organization yet."});
    }
    if (farms.length === 1) {
      return el('p', {textContent: this.farmLabel(farms[0]), i8n: false});
    }
    return el('select', {id: 'farms_select', onchange: this.onFarmSelect.bind(this)}, [
      farms.map(f =>
        el('option', {value: f.id, textContent: this.farmLabel(f), selected: f.id === this.state.selected_farm_id, i8n: false}))
    ]);
  }
  postFarmRegister(body, formEl) {
    POST('/api/farms/register', body, (err, json) => {
      if (err) {
        this.message(err.message);
        return;
      }
      this.message("Farm registered");
      formEl.reset();
      this.getFarmsList();
    });
  }
  farmRegisterForm() {
    const platforms = this.state.platforms_list || [];
    if (platforms.length === 0) {
      return el('div', {}, [el('h3', {textContent: "Register Farm"}), el('p', {textContent: "Register a platform above before adding a farm."})]);
    }
    let EL = el('form', {}, [
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'farm_platform_id', textContent: "Platform *"}),
        this.state.elements.farm_platform_id = el('select', {id: 'farm_platform_id', name: 'platform_id', required: true}, [
          platforms.map(p => el('option', {value: p.id, textContent: this.platformLabel(p), i8n: false}))
        ]),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'farm_farm_id', textContent: "Farm ID *"}),
        this.state.elements.farm_farm_id = el('input', {id: 'farm_farm_id', name: 'farm_id', type: 'text', required: true}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'farm_org', textContent: "Organization"}),
        el('input', {id: 'farm_org', type: 'text', value: this.state.org, disabled: true, i8n: false}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'farm_project', textContent: "Project ID *"}),
        this.state.elements.farm_project = el('input', {id: 'farm_project', name: 'project', type: 'text', placeholder: 'id', required: true,
          pattern: '[a-z0-9]+', title: "Lower-case letters and numbers only, no spaces or punctuation"}),
      ]),
      el('button', {class: 'submit', type: 'submit', textContent: 'Register Farm'}),
    ]);
    EL.addEventListener('submit', (e) => {
      e.preventDefault();
      this.postFarmRegister({
        platform_id: parseInt(this.state.elements.farm_platform_id.value, 10),
        'farm-platform-farm-id': this.state.elements.farm_farm_id.value,
        'device-platform-farm-id': `${this.state.org}/${this.state.elements.farm_project.value}`,
      }, EL);
    });
    return el('div', {}, [el('h3', {textContent: "Register Farm"}), EL]);
  }
  // A "farm" is identified by (platform_id, farm_id) - api_farms can have more than one row for the
  // same farm when it maps to more than one Frugal-IoT project, so gather every project mapped to
  // whichever row is currently selected, not just that one row's project.
  selectedFarmProjectIds() {
    const farms = this.state.farms_list || [];
    const selected = farms.find(f => f.id === this.state.selected_farm_id);
    if (!selected) { return []; }
    return farms
      .filter(f => (f.platform_id === selected.platform_id) && (f.farm_id === selected.farm_id))
      .map(f => f.project);
  }
  // Fetch the selected farm's nodes via GET /api/devices/list (API.md 6.7) rather than reading
  // server_config locally - this is the API tab, so it should exercise the same API a real
  // Farm-Platform would use. A farm can map to more than one project, so one request per project id,
  // joined into a single row set once all have replied.
  getFarmNodesList() {
    const org = this.state.org;
    const projectIds = this.selectedFarmProjectIds();
    if (!org || projectIds.length === 0) {
      this.state.farm_nodes_list = [];
      this.replaceElement("farm_nodes_table", this.farmNodesTable());
      return;
    }
    let remaining = projectIds.length;
    let allNodes = [];
    projectIds.forEach(projectId => {
      const devicePlatformFarmId = `${org}/${projectId}`;
      GET(`/api/devices/list?device-platform-farm-id=${encodeURIComponent(devicePlatformFarmId)}`, {}, (err, json) => {
        if (err) {
          this.message(err.message);
        } else {
          json.forEach(device => {
            allNodes.push({
              projectId,
              nodeId: device.id.split('/').slice(2).join('/'),
              name: device.title || "",
              description: device.description || "",
              lastSeen: this.formatLastSeen(device.lastSeen ? device.lastSeen * 1000 : null),
              otakey: device.otaKey || ""
            });
          });
        }
        if (--remaining === 0) {
          this.state.farm_nodes_list = allNodes;
          this.replaceElement("farm_nodes_table", this.farmNodesTable());
        }
      });
    });
  }
  onFarmNodeSelect(projectId, nodeId) {
    this.state.selected_farm_node = `${projectId}/${nodeId}`;
    this.replaceElement("farm_node_actions", this.farmNodeActions());
    this.getDeviceActionSchema();
  }
  // Fully qualified device id (org/project/node) for whichever node is currently selected in the farm's
  // nodes table, or null if none is selected.
  selectedFarmNodeDevice() {
    if (!this.state.selected_farm_node) { return null; }
    return `${this.state.org}/${this.state.selected_farm_node}`;
  }
  onFarmNodeSchema() {
    const device = this.selectedFarmNodeDevice();
    if (!device) { return; }
    window.open(`/api/devices/schema?device=${encodeURIComponent(device)}`, '_blank');
  }
  onFarmNodeData(e) {
    e.preventDefault();
    const device = this.selectedFarmNodeDevice();
    if (!device) { return; }
    // datetime-local values omit seconds (YYYY-MM-DDTHH:mm) - parseTimestamp on the server requires them.
    const withSeconds = (v) => v && (v.length === 16 ? `${v}:00` : v);
    const from = withSeconds(this.state.elements.farm_node_from.value);
    if (!from) {
      // No date range given - show current values instead (API.md 6.6.5.2, property omitted).
      window.open(`/api/devices/property?deviceId=${encodeURIComponent(device)}`, '_blank');
      return;
    }
    const to = withSeconds(this.state.elements.farm_node_to.value);
    let url = `/api/data?device=${encodeURIComponent(device)}&from=${encodeURIComponent(from)}`;
    if (to) { url += `&to=${encodeURIComponent(to)}`; }
    window.open(url, '_blank');
  }
  // Actions for whichever node is currently selected in "Nodes in Farm": fetch its schema, or its data
  // over a date range (or, with no From date, its current property values) - all open the raw JSON
  // response in a new window/tab.
  farmNodeActions() {
    if (!this.state.selected_farm_node) {
      return el('p', {textContent: "Select a node above to see actions."});
    }
    let EL = el('form', {}, [
      el('button', {class: 'submit', type: 'button', textContent: 'Schema', onclick: this.onFarmNodeSchema.bind(this)}),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'farm_node_from', textContent: "From"}),
        this.state.elements.farm_node_from = el('input', {id: 'farm_node_from', type: 'datetime-local'}),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'farm_node_to', textContent: "To"}),
        this.state.elements.farm_node_to = el('input', {id: 'farm_node_to', type: 'datetime-local'}),
      ]),
      el('button', {class: 'submit', type: 'submit', textContent: 'Data'}),
    ]);
    EL.addEventListener('submit', this.onFarmNodeData.bind(this));
    return EL;
  }
  // Fetch the selected node's Device Schema so the Action section can list its actions - triggered
  // whenever the selected node changes.
  getDeviceActionSchema() {
    const device = this.selectedFarmNodeDevice();
    this.state.device_schema = null;
    this.state.selected_action = null;
    if (!device) {
      this.replaceElement("action_section", this.actionSection());
      return;
    }
    GET(`/api/devices/schema?device=${encodeURIComponent(device)}`, {}, (err, json) => {
      if (err) {
        this.message(err.message);
        return;
      }
      this.state.device_schema = json;
      this.replaceElement("action_section", this.actionSection());
    });
  }
  // Everything the Action section can invoke: genuine actions, plus properties that are also writable
  // (per the schema's own writeproperty op) - a read-write field doesn't get a separate action entry,
  // it's modelled as one property with both ops (see frugal-iot-logger's getDeviceSchema). Each entry
  // normalizes the bits that differ between an action's "input" and a property's own schema fields.
  controllableFields() {
    const schema = this.state.device_schema || {};
    const actions = Object.entries(schema.actions || {}).map(([key, def]) => ({
      key,
      kind: 'action',
      label: def.description || def.title || key,
      dataSchema: def.input || {},
      href: def.forms && def.forms[0] && def.forms[0].href
    }));
    const writableProperties = Object.entries(schema.properties || {})
      .filter(([, def]) => (def.forms || []).some(f => (f.op || []).includes('writeproperty')))
      .map(([key, def]) => ({
        key,
        kind: 'property',
        label: def.description || def.title || key,
        dataSchema: def,
        href: def.forms && def.forms[0] && def.forms[0].href
      }));
    return [...actions, ...writableProperties];
  }
  onActionSelect(ev) {
    this.state.selected_action = ev.target.value;
    this.replaceElement("action_value", this.actionValueField());
  }
  actionDropdown() {
    const fields = this.controllableFields();
    if (!this.state.selected_action || !fields.some(f => f.key === this.state.selected_action)) {
      this.state.selected_action = fields.length ? fields[0].key : null;
    }
    return el('select', {id: 'action_select', onchange: this.onActionSelect.bind(this)}, [
      fields.map(f =>
        el('option', {value: f.key, textContent: f.label, selected: f.key === this.state.selected_action, i8n: false}))
    ]);
  }
  // The Value field's type/constraints follow the selected field's DataSchema (API.md Annex A.2/A.3):
  // boolean -> toggle, number/integer -> number box constrained to minimum/maximum, anything else -> text.
  actionValueField() {
    const field = this.controllableFields().find(f => f.key === this.state.selected_action);
    const dataSchema = (field && field.dataSchema) || {};
    let input;
    if (dataSchema.type === 'boolean') {
      input = el('input', {id: 'action_value', type: 'checkbox'});
    } else if (dataSchema.type === 'number' || dataSchema.type === 'integer') {
      input = el('input', {id: 'action_value', type: 'number',
        min: dataSchema.minimum, max: dataSchema.maximum, step: dataSchema.type === 'integer' ? 1 : 'any'});
    } else {
      input = el('input', {id: 'action_value', type: 'text'});
    }
    return input;
  }
  onActionSend() {
    const device = this.selectedFarmNodeDevice();
    const field = this.controllableFields().find(f => f.key === this.state.selected_action);
    if (!device || !field) { return; }
    if (!field.href) {
      this.message("This field has no invocation URL (forms[0].href) in its schema");
      return;
    }
    const valueField = this.state.elements.action_value;
    let value;
    if (field.dataSchema.type === 'boolean') {
      value = valueField.checked ? 1 : 0;
    } else if (field.dataSchema.type === 'number' || field.dataSchema.type === 'integer') {
      value = Number(valueField.value);
    } else {
      value = valueField.value;
    }
    if (field.kind === 'action') {
      // The schema's href is a WoT Form - it can only express a URL, not a JSON body - so invoke via
      // GET /devices/action (API.md Section 6.6.2.1), appending "value" as a query param. href already
      // carries deviceId/action, matching what GET /devices/action reads.
      GET(`${field.href}&value=${encodeURIComponent(value)}`, {}, (err, json) => {
        if (err) {
          this.message(err.message);
          return;
        }
        this.message(`${getString("Action")} ${field.key} ${getString("sent")}`, false);
      });
    } else {
      // Property forms.href already carries deviceId/property (also used for GET-to-read) - PUT the
      // new value as a JSON body, there being no standard WoT convention for a writeproperty body.
      PUT(field.href, {value}, (err, json) => {
        if (err) {
          this.message(err.message);
          return;
        }
        this.message(`${getString("Property")} ${field.key} ${getString("set")}`, false);
      });
    }
  }
  // "Action" section - lets the admin invoke any action, or set any writable property, from the
  // selected node's Device Schema.
  actionSection() {
    if (!this.state.selected_farm_node) {
      return el('p', {textContent: "Select a node above to send an action."});
    }
    if (!this.state.device_schema) {
      return el('p', {textContent: "Loading schema..."});
    }
    if (this.controllableFields().length === 0) {
      return el('p', {textContent: "This node has no actions or writable properties in its schema."});
    }
    let EL = el('form', {}, [
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'action_select', textContent: "Action *"}),
        this.state.elements.action_select = this.actionDropdown(),
      ]),
      el('div', {class: 'formgroup'}, [
        el('label', {for: 'action_value', textContent: "Value *"}),
        this.state.elements.action_value = this.actionValueField(),
      ]),
      el('button', {class: 'submit', type: 'submit', textContent: 'Send'}),
    ]);
    EL.addEventListener('submit', (e) => { e.preventDefault(); this.onActionSend(); });
    return EL;
  }
  // Nodes for the selected farm's project(s) - same fields/UI as the Nodes tab (via nodesTableFor),
  // fetched from GET /api/devices/list by getFarmNodesList() rather than read locally, since this is
  // the API tab and should exercise the real Farm-Platform-facing API.
  farmNodesTable() {
    if (!this.state.selected_farm_id) {
      return el('p', {textContent: "Select a farm above to see its nodes."});
    }
    return this.nodesTableFor(
      'farm_nodes_table',
      () => this.state.farm_nodes_list || [],
      "No nodes found for this farm's project(s).",
      {
        label: "Select",
        cell: (node) => {
          const key = `${node.projectId}/${node.nodeId}`;
          return el('td', {}, [
            el('input', {type: 'radio', name: 'farm_node_select', value: key,
              checked: this.state.selected_farm_node === key,
              onchange: this.onFarmNodeSelect.bind(this, node.projectId, node.nodeId)}),
          ]);
        }
      }
    );
  }
  replaceElement(name, newElement) {
    if (this.state.elements[name]) {
      let oldEl = this.state.elements[name];
      oldEl.replaceWith(this.state.elements[name] = newElement);
    }
    return this.state.elements[name];
  }
  setOrganization(org) {
    this.state.org =  org;
    this.state.selected_platform_id = null;
    this.state.selected_farm_id = null;
    // Reset sort order for every nodes table back to the default before rebuilding them below.
    this.state.nodesSort = {nodes_table: {field: 'projectId', asc: true}, farm_nodes_table: {field: 'projectId', asc: true}};
    // Clear out data fetched for the previous organization so a not-yet-visited tab shows an empty/
    // loading state rather than briefly showing the previous organization's data.
    this.state.ota_files = [];
    this.state.people_list = [];
    this.state.projects_list = [];
    this.state.platforms_list = [];
    this.state.farms_list = [];
    this.state.farm_nodes_list = [];
    // Rebuild the gated content of each tab first, since it re-creates the elements (e.g. ota_files,
    // people_perms_list, platforms_list_display) that loadTabData() below then asynchronously replaces.
    this.replaceElement('ota_rest', this.gatedContent(this.otaRestContent));
    this.replaceElement('admin_rest', this.gatedContent(this.adminRestContent));
    this.replaceElement('nodes_rest', this.gatedContent(this.nodesRestContent));
    this.replaceElement('api_rest', this.gatedContent(this.apiRestContent));
    // Only OTA/Admin/API tabs do their own network fetch (Nodes reads server_config, already loaded,
    // and Dashboard is handled by mqtt-wrapper) - mark them all as needing a refetch for the new
    // organization, but only actually fetch whichever tab is currently active; the rest load lazily
    // if/when the user switches to them (see onTabChange), to avoid a server-side fetch per tab on
    // every organization change.
    this.state.tabsNeedingLoad = new Set(['OTA', 'Admin', 'API']);
    this.loadTabIfNeeded(this.state.activeTabTitle);
    // Note both these dropdowns are fine if this.state.org is undefined
    this.replaceElement("otaorgsdropdown", this.orgDropdown(this.state.org, this.otaOrgs,"otaorganizations"));
    this.replaceElement("adminorgsdropdown", this.orgDropdown(this.state.org, this.adminOrgs,"adminorganizations"));
    this.replaceElement("nodesorgsdropdown", this.orgDropdown(this.state.org, this.adminOrgs,"nodesorganizations"));
    this.replaceElement("apiorgsdropdown", this.orgDropdown(this.state.org, this.adminOrgs,"apiorganizations"));
    // Keep the Dashboard tab's own organization in sync with the shared dropdown above.
    if (this.state.elements.mqttWrapper) {
      this.state.elements.mqttWrapper.setOrganization(org);
    }
  }
  setDefaultOrganization() {
    let org = this.state.org;
    if ((this.otaOrgs.length === 1) && (this.adminOrgs.length <= 1)) {
      org = this.otaOrgs[0][0];
    } else if ((this.adminOrgs.length === 1) && (this.otaOrgs.length <= 1)) {
      org = this.adminOrgs[0][0];
    }
    this.setOrganization(org);
  }
  onOrganization(e) {
    this.setOrganization(e.target.value);
  }
  // Fired by tabbed-display's 'tabchange' event (see TabbedDisplay.tabSelect) whenever the user
  // switches tabs - lazily loads that tab's data if it hasn't been fetched yet for the current org.
  onTabChange({title}) {
    this.state.activeTabTitle = title;
    this.loadTabIfNeeded(title);
  }
  loadTabIfNeeded(title) {
    if (!this.state.tabsNeedingLoad.has(title)) { return; }
    this.state.tabsNeedingLoad.delete(title);
    this.loadTabData(title);
  }
  // Only OTA/Admin/API have their own server round trip - Nodes and Dashboard need nothing here.
  loadTabData(title) {
    if (title === 'OTA') {
      this.getOtaFiles();
    } else if (title === 'Admin') {
      this.getPeopleList();
      this.getProjectsList();
    } else if (title === 'API') {
      this.getPlatformsList();
      this.getFarmsList();
    }
  }
   onFile(e) {
     //TODO-14 do some sanity check on the files. See https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file
   }

   formatLastSeen(dateString) {
     // Format ISO date string to local timezone in format: 2026-04-27 10:34
     if (!dateString || dateString === getString("Never seen")) {
       return getString("Never seen");
     }
     try {
       const date = new Date(dateString);
       // Use toLocaleString with options for YYYY-MM-DD HH:MM format
       return date.toLocaleString('sv-SE', {
         year: 'numeric',
         month: '2-digit',
         day: '2-digit',
         hour: '2-digit',
         minute: '2-digit',
         second: undefined,
         hour12: false
       }).replace(' ', ' ');
     } catch (e) {
       return dateString; // Return original if parsing fails
     }
   }

   // Flattens server_config's nodes-by-project data for one org into the row shape nodesTableFor() renders.
   nodesForOrg(org) {
     const projects = (server_config.organizations[org] || {}).projects || {};
     return this.nodesForProjects(org, Object.keys(projects));
   }
   // Same, but restricted to a specific set of project ids (e.g. those api_farms maps to a farm).
   nodesForProjects(org, projectIds) {
     const projects = (server_config.organizations[org] || {}).projects || {};
     let nodes = [];
     projectIds.forEach(projectId => {
       const project = projects[projectId];
       if (!project) { return; }
       Object.entries(project.nodes || {}).forEach(([nodeId, nodeData]) => {
         nodes.push({
           projectId,
           nodeId,
           name: nodeData["frugal_iot/name"] || "",
           description: nodeData["frugal_iot/description"] || "",
           lastSeen: this.formatLastSeen(nodeData.lastseen),
           otakey: nodeData["ota/key"] || ""
         });
       });
     });
     return nodes;
   }

   nodesTable() {
     return this.nodesTableFor('nodes_table', () => this.nodesForOrg(this.state.org), "No nodes found for this organization");
   }

   // Shared, sortable nodes table with an editable Project ID cell - used by both the Nodes tab
   // (nodesTable) and the API tab's "Nodes in Farm" list (farmNodesTable).
   // tableKey scopes both the sort state and the this.state.elements entry used to replace the table
   // in place; getNodes() returns the (unsorted) rows to display; extraColumn, if given, adds a leading
   // column (e.g. a selection radio) as {label, cell(node)}.
   nodesTableFor(tableKey, getNodes, emptyMessage, extraColumn) {
     if (!this.state.org) {
       return el('p', {textContent: "No organization selected"});
     }
     let allNodes = getNodes();
     if (allNodes.length === 0) {
       return el('p', {textContent: emptyMessage});
     }

     this.state.nodesSort = this.state.nodesSort || {};
     const sort = this.state.nodesSort[tableKey] || (this.state.nodesSort[tableKey] = {field: 'projectId', asc: true});

     allNodes.sort((a, b) => {
       let aVal = a[sort.field] || "";
       let bVal = b[sort.field] || "";

       if (typeof aVal === 'string') {
         aVal = aVal.toLowerCase();
         bVal = bVal.toLowerCase();
       }

       if (aVal < bVal) return sort.asc ? -1 : 1;
       if (aVal > bVal) return sort.asc ? 1 : -1;
       return 0;
     });

     const rerender = () => this.replaceElement(tableKey, this.nodesTableFor(tableKey, getNodes, emptyMessage, extraColumn));
     const onSort = (field) => {
       if (sort.field === field) { sort.asc = !sort.asc; } else { sort.field = field; sort.asc = true; }
       rerender();
     };

     const columns = [
       {label: "Project ID", field: 'projectId', cell: (node) => this.renderProjectIdCell(node, rerender)},
       {label: "Node ID", field: 'nodeId', cell: (node) => el('td', {textContent: node.nodeId, i8n: false})},
       {label: "Node Name", field: 'name', cell: (node) => el('td', {textContent: node.name, i8n: false})},
       {label: "Description", field: 'description', cell: (node) => el('td', {textContent: node.description, i8n: false})},
       {label: "Last Seen", field: 'lastSeen', cell: (node) => el('td', {textContent: node.lastSeen, i8n: false})},
       {label: "OTA Key", field: 'otakey', cell: (node) => el('td', {textContent: node.otakey, i8n: false})},
     ];

     const headerCells = [
       extraColumn ? el('th', {textContent: extraColumn.label}) : null,
       columns.map(col =>
         el('th', {
           style: 'cursor: pointer; user-select: none; padding-right: 10px;',
           title: 'Click to sort',
           onclick: () => onSort(col.field),
         }, [
           el('span', {textContent: col.label}),
           sort.field === col.field ? (sort.asc ? ' ↑' : ' ↓') : '',
         ])
       ),
     ];

     const tableRows = allNodes.map((node) => el('tr', {}, [
       extraColumn ? extraColumn.cell(node) : null,
       columns.map(col => col.cell(node)),
     ]));

     return el('table', {class: 'nodes-table', style: 'border-collapse: collapse; width: 100%;'}, [
       el('thead', {}, [
         el('tr', {}, headerCells)
       ]),
       el('tbody', {}, tableRows),
     ]);
   }

    projectsDropdownForNode(org, currentProjectId) {
      // Create dropdown for selecting a different project for a node
      if (!org) { return el('span', {textContent: "No organization"}); }
      return el('select', {name: 'project'}, [
        Object.entries(server_config.organizations[org].projects)
          .map(([pid, p]) => [ pid, p.name ])
          .map(([pid, name]) =>
            el('option', {value: pid, textContent: `${pid}: ${name}`, selected: pid === currentProjectId}))
      ]);
    }

    onNodeProjectChange(nodeId, oldProjectId, selectElement, onChanged) {
      // Handle project change for a node
      const newProjectId = selectElement.value;
      if (newProjectId === oldProjectId) {
        return; // No change
      }

      // Send MQTT message to update project
      const topic = `${this.state.org}/${oldProjectId}/${nodeId}/set/frugal_iot/project`;
      const message = newProjectId;

      console.log(`Publishing ${topic} = ${message}`);
      mqtt_client.publish(topic, message, {retain: false, qos: 1});
      this.message(`${getString("Project changed to")} ${newProjectId} ${getString("for node")} ${nodeId}`);

      // Refresh the table after a short delay
      setTimeout(onChanged, 500);
    }

    renderProjectIdCell(node, onChanged) {
      // Create an editable cell for projectId that opens a dropdown on click
      return el('td', {
        style: 'cursor: pointer; position: relative;',
        title: 'Click to change project',
        onclick: (e) => {
          // Replace with dropdown
          const dropdown = this.projectsDropdownForNode(this.state.org, node.projectId);
          dropdown.addEventListener('change', (changeEvent) => {
            this.onNodeProjectChange(node.nodeId, node.projectId, changeEvent.target, onChanged);
          });
          e.target.replaceWith(dropdown);
          dropdown.focus();
          // Close dropdown if focus lost
          dropdown.addEventListener('blur', onChanged);
        }
      }, [node.projectId]);
    }

   // Content of the OTA tab below the organization dropdown - only rendered once an org is selected
   otaRestContent() {
     return el('div', {}, [
       el('form', {action: '/ota_update', method: "post", enctype: "multipart/form-data"}, [
         el('input', {id: "url2", name: "url", type: "hidden", value: `/dashboard/`}),
         el('input', {id: "lang", name: "lang", type: "hidden", value: preferedLanguages.join(',')}),
         el('section', {}, [
           el('label', {for: 'projects', textContent: "Project"}),
           this.state.elements.projectdropdown = this.projectDropdown(this.state.org)
         ]),
         el('section', {}, [
           el('label', {for: 'otakey', textContent: "OTA Key or Device ID"}),
           el('input', {id: "otakey", name: "otakey", type: "text", autocomplete: "otakey", required: true}),
         ]),
         el('section', {}, [
           el('label', {for: 'file', textContent: "File"}),
           // Files should be either frugal-iot.ino.bin or firmware.bin
           el('input', {id: "file", name: "file", type: "file", accept: ".bin",  onchange: this.onFile.bind(this), required: true}),
           el('p', {textContent: "(Max 4MB, .bin only, typically frugal-iot.ino.bin or firmware.bin)"}),
           el('p', {}, [getString("On PlatformIO The file is typically in "), el('code',{}, ['<project>/.pio/build/<your board>/firmware.bin'])]),
           el('p', {textContent: "If this directory is invisible to the file picker, copy the file somewhere else OR make an an alias to the .pio directory without a leading '.'"}),
           el('p', {}, [getString("On ArduinoIDE the file is typically in "), el('code',{}, ["<project>/build/<your board>/frugal-iot.ino.bin"])]),
           ]),
         el('button', {class: "submit", type: "submit", textContent: 'Upload'}),
       ]), //form
       el('section', {}, [
         el('h3', {textContent: "Existing OTA Files"}),
         this.state.elements.ota_files = this.otaFilesList(),
       ]), // section ota
       el('section', {}, [
         this.state.section ? null : (this.state.elements.flash = el('mqtt-flash', {})), // its own card on the project back
       ]), // section flash
     ]);
   }
   // Content of the Admin tab below the organization dropdown - only rendered once an org is selected
   adminRestContent() {
     return el('div', {}, [
       el('section', {}, [
             el('h3', {textContent: "Permissions"}),
             // List of people and their permissions, with option to delete,
             this.state.elements.people_perms_list = this.peoplePermList(), // This gets replaced when actions taken
             // and form to add (dropdown of people and permissions)
             this.state.elements.people_list = this.peopleList(),
       ]),
       el('section', {}, [
             el('h3', {textContent: "Projects"}),
             // List of existing projects for this organization,
             this.state.elements.projects_display_list = this.projectsDisplayList(),
             // and, once expanded, a form to add a new project (id and name)
             this.state.elements.add_project = this.collapsibleArea('add_project', "Add Project", this.projectsAddForm),
       ]),
       // TODO-CSS cleanup - labels are too big
       // This should really use a superuser permission but for now its just the super admin can do this
       server_config.user.id !== 1 ? null : // Only show publish message to super admin, as not really a feature, more for testing and debugging
         el('section', {}, [
           el('h3', {textContent: "Publish Message"}),
           el('form', {}, [
             el('div', {class: 'formgroup'}, [
               el('label', {for: 'msg_topic', textContent: "Topic"}),
               this.state.elements.msg_topic = el('input', {id: 'msg_topic', name: 'topic', type: 'text', placeholder: 'Enter topic', required: true}),
             ]),
             el('div', {class: 'formgroup'}, [
               el('label', {for: 'msg_value', textContent: "Value"}),
               el('label', {for: 'msg_value', textContent: "Value"}),
               this.state.elements.msg_value = el('input', {id: 'msg_value', name: 'value', type: 'text', placeholder: 'Enter value', required: true}),
             ]),
             el('div', {class: 'formgroup'}, [
               el('label', {for: 'msg_retain', textContent: "Retain"}),
               this.state.elements.msg_retain = el('input', {id: 'msg_retain', name: 'retain', type: 'checkbox'}),
             ]),
             el('div', {class: 'formgroup'}, [
               el('label', {for: 'msg_qos', textContent: "QoS"}),
               this.state.elements.msg_qos = el('select', {id: 'msg_qos', name: 'qos'}, [
                 el('option', {value: 0, textContent: "0", selected: true}),
                 el('option', {value: 1, textContent: "1"}),
                 el('option', {value: 2, textContent: "2"}),
               ]),
             ]),
             el('button', {class: 'submit', type: 'button', textContent: 'SEND', onclick: this.onPublishMessage.bind(this)}),
           ]),
         ]),
     ]);
   }
   // Content of the Nodes tab below the organization dropdown - only rendered once an org is selected
   nodesRestContent() {
     return el('div', {}, [
       el('h3', {textContent: "Nodes in Organization"}),
       this.state.elements.nodes_table = this.nodesTable(),
     ]);
   }
   // Content of the API tab below the organization dropdown - only rendered once an org is selected
   apiRestContent() {
     return el('div', {}, [
       el('section', {}, [
         el('h3', {textContent: "Registered Platforms"}),
         this.state.elements.platforms_list_display = this.platformsListDisplay(),
       ]),
       el('section', {}, [
         this.state.elements.add_platform = this.collapsibleArea('add_platform', "Add Platform", this.platformRegisterForm),
       ]),
       el('section', {}, [
         el('h3', {textContent: "Farms"}),
         this.state.elements.farms_list_display = this.farmsListDisplay(),
       ]),
       el('section', {}, [
         this.state.elements.add_farm = this.collapsibleArea('add_farm', "Add Farm", this.farmRegisterForm),
       ]),
       el('section', {}, [
         el('h3', {textContent: "Nodes in Farm"}),
         this.state.elements.farm_nodes_table = this.farmNodesTable(),
       ]),
       el('section', {}, [
         el('h3', {textContent: "Node Actions"}),
         this.state.elements.farm_node_actions = this.farmNodeActions(),
         this.state.elements.action_section = this.actionSection(),
       ]),
     ]);
   }
   // The admin functions, described once. The tabbed view below shows them all; the project back
   // (CARDS_UX.md 11) puts each in its own card, by setting section="ota" and so on.
   adminSections() {
     return [
       { key: 'ota',   title: "OTA",   orgs: 'otaOrgs',   dropdown: 'otaorgsdropdown',   rest: 'ota_rest',   content: this.otaRestContent },
       { key: 'admin', title: "Admin", orgs: 'adminOrgs', dropdown: 'adminorgsdropdown', rest: 'admin_rest', content: this.adminRestContent },
       { key: 'nodes', title: "Nodes", orgs: 'adminOrgs', dropdown: 'nodesorgsdropdown', rest: 'nodes_rest', content: this.nodesRestContent },
       { key: 'api',   title: "API",   orgs: 'adminOrgs', dropdown: 'apiorgsdropdown',   rest: 'api_rest',   content: this.apiRestContent },
     ];
   }
   // Just one section, with no tab strip around it - what an admin card holds
   renderSection(key) {
     if (key === 'flash') return el('div', {class: 'mqtt-admin'}, [el('mqtt-flash', {})]);
     const section = this.adminSections().find((s) => s.key === key);
     if (!section) { XXX(["No such admin section", key]); return null; }
     if (!this[section.orgs].length) return null; // no permission for it
     return el('div', {class: 'mqtt-admin'}, [
       this.state.elements[section.dropdown] = el('span', {textContent: "Waiting"}),
       this.state.elements[section.rest] = this.gatedContent(section.content),
     ]);
   }

   render() { //TODO-89 needs styles
     if (this.state.section) {
       return [el('link', {rel: 'stylesheet', href: CssUrl}), this.renderSection(this.state.section)];
     }
     const tabbedDisplay = el('tabbed-display', {tab: 0}, [
           el('section', {title: "Dashboard"}, [
             this.state.elements.mqttWrapper = el('mqtt-wrapper'),
           ]),
           !this.otaOrgs.length ? null :
             el('section', {title: "OTA"}, [
                this.state.elements.otaorgsdropdown = el('span',{ textContent: "Waiting"}),
                this.state.elements.ota_rest = this.gatedContent(this.otaRestContent),
            ]
          ), // OTA tab

          !this.adminOrgs.length ? null :
            el('section', {title: "Admin"}, [
              this.state.elements.adminorgsdropdown = el('span',{ textContent: "Waiting"}),
              this.state.elements.admin_rest = this.gatedContent(this.adminRestContent),
             ]), // Admin tab

           !this.adminOrgs.length ? null :
             el('section', {title: "Nodes"}, [
               this.state.elements.nodesorgsdropdown = el('span',{ textContent: "Waiting"}),
               this.state.elements.nodes_rest = this.gatedContent(this.nodesRestContent),
             ]), // Nodes tab

           !this.adminOrgs.length ? null :
             el('section', {title: "API"}, [
               this.state.elements.apiorgsdropdown = el('span',{ textContent: "Waiting"}),
               this.state.elements.api_rest = this.gatedContent(this.apiRestContent),
             ]), // API tab
     ]);
     // Lazily load a tab's data only once the user actually switches to it - see onTabChange.
     tabbedDisplay.addEventListener('tabchange', (e) => this.onTabChange(e.detail));
     return [
       el('link', {rel: 'stylesheet', href: CssUrl}),
       el('div', {class: 'mqtt-admin'},[
         // This is a top bar, holds message and language picker
         el('div',{class: 'message'},[
           this.state.elements.message = el('span', {textContent: this.state.message}),
           el('language-picker'),
         ]),
         tabbedDisplay,
       ]),
     ];
   }
}
customElements.define('mqtt-admin', MqttAdmin);

