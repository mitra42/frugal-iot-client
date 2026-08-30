/*
 * Frugal IoT client - the login page: sign in, register, and the password reset.
 *
 * Split out of admin.js so that login.html can load core.js and this, rather than webcomponents.js,
 * which drags in Chart.js, esptool-js and the node/group UI to draw four text boxes.
 *
 * Light DOM (HTMLElementExtendedMinimum), like the cards - frugaliot.css then reaches the form
 * directly and the page shares the card UI's palette instead of restating it. See CARDS_UX.md.
 */

import { HTMLElementExtendedMinimum } from '/node_modules/html-element-extended/htmlelementextended.js';
import { XXX, el, getString, locationParameterChange, preferedLanguageSet, preferedLanguages } from './core.js';

// One card, four modes (CARDS_UX.md D-45). "register" is still accepted as an attribute because
// the server's redirects have been sending ?register=true|false since before there were modes.
const MODES = ['signin', 'register', 'forgot', 'reset'];

class MqttLogin extends HTMLElementExtendedMinimum { // TODO-89 may depend on organization
  constructor(props) {
    super(props);
    this.state = { mode: 'signin' };
  }
  static get observedAttributes() { return ['mode', 'register', 'message', 'messagetype', 'url', 'lang', 'username', 'code']; }
  static get boolAttributes() { return ['register']; }

  connectedCallback() {
    this.loadAttributesFromURL();
    // Nothing has set a language when the page is opened without "?lang=", and this is the one page
    // where somebody picks one before going further - so settle on English rather than leaving the
    // picker showing nothing and every getString falling through its "cannot translate" path.
    if (!preferedLanguages.length) { preferedLanguageSet('EN'); }
    // The emailed link carries the reset token in the query string, which is where the browser's
    // history, a bookmark and any Referer header would go on keeping it. It is in state by now and
    // the form holds it, so take it back out of the address bar.
    this.forgetCodeInUrl();
    super.connectedCallback();
  }
  forgetCodeInUrl() {
    if (!this.state.code || !window.history || !window.history.replaceState) { return; }
    const u = new URL(window.location.href);
    if (!u.searchParams.has('code')) { return; }
    u.searchParams.delete('code');
    window.history.replaceState(null, '', u.toString());
  }
  changeAttribute(name, value) {
    if (name === "lang") {
      if (value.includes(',')) {
        // Not "preferedLanguages = ..." - it is an imported binding, and assigning to one throws.
        // preferedLanguageSet unshifts, so feed them in reverse to end up in the order given.
        value.split(',').reverse().forEach((v) => preferedLanguageSet(v.trim().toUpperCase()));
      } else if (!value) {
        preferedLanguageSet('EN');
        locationParameterChange("lang", preferedLanguages.join(','));
      } else {
        preferedLanguageSet(value.toUpperCase());
      }
    }
    super.changeAttribute(name, value);
    // Map the legacy boolean onto the mode, but only when "mode" itself was not given - otherwise
    // ?mode=reset&register=false would land back on the sign-in form.
    if (name === "register" && !this.hasAttribute('mode')) {
      this.state.mode = this.state.register ? 'register' : 'signin';
    }
    if (name === "mode" && !MODES.includes(value)) {
      this.state.mode = 'signin';
    }
  }
  modeSet(mode) {
    this.state.mode = mode;
    // A message is about the request that produced it, so it does not survive moving to another form
    this.state.message = null;
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
  // label + input, the shape every field on this page has
  field(id, label, attributes = {}) {
    return el('div', { class: 'fi-login__field' }, [
      el('label', { for: id, textContent: label }),
      el('input', Object.assign({ id, name: id, type: 'text' }, attributes)),
    ]);
  }
  hiddenUrl() {
    return el('input', { name: "url", type: "hidden", value: this.urlWithLang(this.state.url) || '' });
  }
  // A button that reads as a link - switching mode is not a navigation, the card just changes
  link(label, mode) {
    return el('button', { type: 'button', class: 'fi-login__link', textContent: label,
      onclick: this.modeSet.bind(this, mode) });
  }
  renderSignin() {
    return [
      el('h1', { class: 'fi-login__title', textContent: 'Sign in' }),
      el('form', { action: '/login', method: "post" }, [
        // Named "username" because that is what passport reads; the server looks the value up as an
        // email address instead when it has an "@" in it.
        this.field("username", 'Username or email',
          { autocomplete: "username", required: true, autofocus: true }),
        this.field("password", 'Password', { type: "password", autocomplete: "current-password", required: true }),
        this.hiddenUrl(),
        el('button', { class: "fi-login__submit", type: "submit", textContent: 'Sign in' }),
      ]),
      el('div', { class: 'fi-login__links' }, [
        this.link('Forgot password?', 'forgot'),
        el('span', { class: 'fi-login__linkgroup' }, [
          el('span', { textContent: 'New here?' }),
          this.link('Create an account', 'register'),
        ]),
      ]),
    ];
  }
  renderRegister() {
    return [
      el('h1', { class: 'fi-login__title', textContent: 'Register' }),
      el('form', { action: '/register', method: "post" }, [
        this.field("username", 'Username', { autocomplete: "username", required: true, autofocus: true }),
        this.field("password", 'Password', { type: "password", autocomplete: "new-password", required: true }),
        this.field("name", 'Name', { autocomplete: "name", required: true }),
        // Required, not optional as it was: without it there is no way to reset a forgotten password
        this.field("email", 'Email', { type: "email", autocomplete: "email", required: true }),
        this.field("phone", 'Phone or Whatsapp', { autocomplete: "tel", required: true }),
        // TODO-22 TODO-14 organization should be a drop-down
        this.field("organization", 'Organization', { autocomplete: "organization", required: false }),
        el('p', { class: 'fi-login__hint',
          textContent: "Note this is your organization - not the organizations whose devices you want to access." }),
        this.hiddenUrl(),
        el('button', { class: "fi-login__submit", type: "submit", textContent: 'Submit' }),
      ]),
      el('div', { class: 'fi-login__links' }, [
        el('span', { class: 'fi-login__linkgroup' }, [
          el('span', { textContent: 'Already have an account?' }),
          this.link('Sign in', 'signin'),
        ]),
      ]),
    ];
  }
  renderForgot() {
    return [
      el('h1', { class: 'fi-login__title', textContent: 'Reset password' }),
      el('p', { class: 'fi-login__hint',
        textContent: "We will email you a code and a link to choose a new password." }),
      el('form', { action: '/forgotpassword', method: "post" }, [
        this.field("username", 'Username or email',
          { autocomplete: "username", required: true, autofocus: true, value: this.state.username || '' }),
        this.hiddenUrl(),
        el('button', { class: "fi-login__submit", type: "submit", textContent: 'Send reset code' }),
      ]),
      el('div', { class: 'fi-login__links' }, [
        this.link('I have a code', 'reset'),
        this.link('Back to sign in', 'signin'),
      ]),
    ];
  }
  renderReset() {
    return [
      el('h1', { class: 'fi-login__title', textContent: 'Reset password' }),
      el('p', { class: 'fi-login__hint',
        textContent: "Enter the code we emailed you, then choose a new password." }),
      el('form', { action: '/resetpassword', method: "post" }, [
        this.field("username", 'Username or email',
          { autocomplete: "username", required: true, value: this.state.username || '' }),
        // inputmode numeric so a phone offers the keypad, but not type=number: the link's token is
        // long hex, and a leading zero in a 6-digit code must survive
        this.field("code", 'Reset code', { required: true, autocomplete: "one-time-code",
          inputmode: "numeric", autofocus: !this.state.code, value: this.state.code || '' }),
        this.field("password", 'New password', { type: "password", autocomplete: "new-password",
          required: true, autofocus: !!this.state.code }),
        this.hiddenUrl(),
        el('button', { class: "fi-login__submit", type: "submit", textContent: 'Reset password' }),
      ]),
      el('div', { class: 'fi-login__links' }, [
        this.link('Send another code', 'forgot'),
        this.link('Back to sign in', 'signin'),
      ]),
    ];
  }
  renderMessage() {
    if (!this.state.message) { return null; }
    // Anything not explicitly flagged as an error reads as neutral news ("check your email"), so a
    // message from an older server that says nothing about its type does not shout in red.
    const kind = (this.state.messagetype === 'error') ? 'error' : 'info';
    return el('p', { class: `fi-login__message fi-login__message--${kind}`, role: 'alert',
      textContent: this.state.message });
  }
  render() {
    if (preferedLanguages.length === 0) { XXX("Tracking down issue with lang"); }
    const body = {
      signin: () => this.renderSignin(),
      register: () => this.renderRegister(),
      forgot: () => this.renderForgot(),
      reset: () => this.renderReset(),
    }[this.state.mode] || (() => this.renderSignin());
    return [
      el('div', { class: 'fi-login' }, [
        el('header', { class: 'fi-login__brand' }, [
          // The same mark and wordmark the dashboard header uses, so this reads as the same product
          el('a', { class: 'fi-brand', href: '/', title: getString('Frugal IoT project') }, [
            el('img', { src: '/images/icon-192x192.png', alt: 'Frugal IoT', i8n: false }),
            el('span', { class: 'fi-header__title', textContent: 'Frugal IoT', i8n: false }),
          ]),
          el('language-picker'),
        ]),
        el('div', { class: 'fi-card fi-login__card' }, [
          this.renderMessage(),
          body(),
        ]),
      ]),
    ];
  }
}
customElements.define('mqtt-login', MqttLogin);

export { MqttLogin, MODES };
