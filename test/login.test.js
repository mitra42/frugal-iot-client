// The login page: one card, four modes, and the forms each one posts.
//
// mqtt-login is light DOM, so everything here is reachable with querySelector - which is exactly
// why it was moved out of a shadow root (CARDS_UX.md D-45, and the "shadow content is not in
// textContent" lesson in CLAUDE.md).
import './setup.js';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

before(async () => {
  await import('../login.js');
});

function login(attributes = {}) {
  const el = document.createElement('mqtt-login');
  for (const [k, v] of Object.entries(attributes)) { el.setAttribute(k, v); }
  document.body.append(el);
  return el;
}
const form = (el) => el.querySelector('form');
const names = (el) => [...el.querySelectorAll('input')].map((i) => i.name);

beforeEach(() => { document.body.innerHTML = ''; });

describe('modes', () => {
  test('defaults to sign in', () => {
    const el = login();
    assert.equal(form(el).getAttribute('action'), '/login');
    assert.deepEqual(names(el), ['username', 'password', 'url']);
  });
  test('mode=register posts to /register and asks for the extra fields', () => {
    const el = login({ mode: 'register' });
    assert.equal(form(el).getAttribute('action'), '/register');
    assert.deepEqual(names(el), ['username', 'password', 'name', 'email', 'phone', 'organization', 'url']);
  });
  test('email is required to register - without one there is no way to reset', () => {
    const el = login({ mode: 'register' });
    assert.equal(el.querySelector('input[name=email]').required, true);
  });
  test('mode=forgot posts to /forgotpassword and asks only who you are', () => {
    const el = login({ mode: 'forgot' });
    assert.equal(form(el).getAttribute('action'), '/forgotpassword');
    assert.deepEqual(names(el), ['username', 'url']);
  });
  test('mode=reset posts to /resetpassword and takes the code plus a new password', () => {
    const el = login({ mode: 'reset' });
    assert.equal(form(el).getAttribute('action'), '/resetpassword');
    assert.deepEqual(names(el), ['username', 'code', 'password', 'url']);
  });
  test('an unknown mode falls back to sign in rather than rendering nothing', () => {
    assert.equal(form(login({ mode: 'banana' })).getAttribute('action'), '/login');
  });
  // The server has been sending ?register=true|false since before there were modes
  test('register=true still reaches the register form', () => {
    assert.equal(form(login({ register: 'true' })).getAttribute('action'), '/register');
  });
  test('mode wins over register when both are given', () => {
    assert.equal(form(login({ mode: 'reset', register: 'false' })).getAttribute('action'), '/resetpassword');
  });
});

describe('one field for username or email', () => {
  test('sign in labels the one field for both', () => {
    const el = login();
    const label = el.querySelector('label[for=username]');
    // Translated through getString, so compare against what EN holds rather than the tag
    assert.match(label.textContent, /email/i);
    assert.equal(el.querySelector('input[name=username]').getAttribute('autocomplete'), 'username');
  });
  test('registering asks for a username, not "or email" - that field becomes the account name', () => {
    const el = login({ mode: 'register' });
    assert.doesNotMatch(el.querySelector('label[for=username]').textContent, /email/i);
  });
});

describe('the reset link prefills the form', () => {
  test('username and code arrive as attributes and land in the inputs', () => {
    const el = login({ mode: 'reset', username: 'alice', code: 'abcdef0123456789abcdef0123456789' });
    assert.equal(el.querySelector('input[name=username]').value, 'alice');
    assert.equal(el.querySelector('input[name=code]').value, 'abcdef0123456789abcdef0123456789');
  });
  // type=number would drop a leading zero, and the link's token is not a number at all
  test('the code field is not type=number', () => {
    assert.notEqual(login({ mode: 'reset' }).querySelector('input[name=code]').type, 'number');
  });
});

describe('the message from the server', () => {
  test('messagetype=error is styled as an error', () => {
    const el = login({ message: 'Incorrect username or password', messagetype: 'error' });
    const p = el.querySelector('.fi-login__message');
    assert.ok(p.classList.contains('fi-login__message--error'));
    assert.match(p.textContent, /password/i);
  });
  // An older server says nothing about the type; that must not come out shouting in red
  test('no messagetype reads as information', () => {
    const el = login({ message: 'Please login' });
    assert.ok(el.querySelector('.fi-login__message').classList.contains('fi-login__message--info'));
  });
  test('no message renders no message box at all', () => {
    assert.equal(login().querySelector('.fi-login__message'), null);
  });
});

describe('where you are going afterwards', () => {
  test('url is carried through the hidden field, with the language appended', () => {
    const el = login({ url: '/dashboard?project=lotus' });
    const value = el.querySelector('input[name=url]').value;
    assert.match(value, /project=lotus/);
    assert.match(value, /lang=/);
    // One "?", however many parameters the return url already had
    assert.equal((value.match(/\?/g) || []).length, 1);
  });
  test('it survives switching mode, so a redirect is not lost by clicking Register', () => {
    const el = login({ url: '/dashboard' });
    el.querySelectorAll('.fi-login__link')[1].click();   // "Create an account"
    assert.equal(form(el).getAttribute('action'), '/register');
    assert.match(el.querySelector('input[name=url]').value, /\/dashboard/);
  });
});

describe('switching mode', () => {
  // Calling modeSet directly would pass even if the buttons were never wired up - CLAUDE.md
  test('the "Forgot password?" button really is connected', () => {
    const el = login();
    el.querySelector('.fi-login__link').click();
    assert.equal(form(el).getAttribute('action'), '/forgotpassword');
  });
  test('a message does not follow you to another form', () => {
    const el = login({ message: 'Incorrect username or password', messagetype: 'error' });
    el.querySelector('.fi-login__link').click();
    assert.equal(el.querySelector('.fi-login__message'), null);
  });
});
