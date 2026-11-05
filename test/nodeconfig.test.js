import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LineRouter, parseReply, profileCommands, profileNew, profileProblems, serialDecode, serialEncode,
  setLine } from '../nodeconfig.js';

describe('the line protocol', () => {
  test('encodes only what would break a line or a field', () => {
    assert.equal(serialEncode('My Network'), 'My Network', 'spaces are common in an SSID and stay');
    assert.equal(serialEncode('a\tb\nc%d'), 'a%09b%0Ac%25d');
  });
  test('decoding undoes encoding for anything a person can type', () => {
    const nasty = 'p%a\tss\r\nw0rd 100%';
    assert.equal(serialDecode(serialEncode(nasty)), nasty);
  });
  test('a set line is one line with two tab-separated fields', () => {
    const line = setLine('wifi/Café 5G', 'tab\there');
    assert.equal(line.split('\t').length, 3);
    assert.ok(!line.includes('\n'));
  });
  test('a reply is split and its fields decoded, except a status’s JSON', () => {
    assert.deepEqual(parseReply('~ok\twifi/My%09Net'), {cmd: 'ok', fields: ['wifi/My\tNet']});
    assert.deepEqual(parseReply('~status\t{"a":"%41"}'), {cmd: 'status', fields: ['{"a":"%41"}']});
    assert.deepEqual(parseReply('~err\tline\ttoo_long'), {cmd: 'err', fields: ['line', 'too_long']});
  });
});

describe('telling protocol lines from the log', () => {
  function route(chunks) {
    const got = {protocol: [], log: ''};
    const router = new LineRouter((l) => got.protocol.push(l), (t) => { got.log += t; });
    chunks.forEach((c) => router.feed(c));
    return got;
  }
  test('a protocol line split across chunks is held until its newline', () => {
    const got = route(['~ok\twif', 'i/Home\r', '\n']);
    assert.deepEqual(got.protocol, ['~ok\twifi/Home']);
    assert.equal(got.log, '');
  });
  test('log lines pass straight through, so a boot log still appears as it arrives', () => {
    const got = route(['rst:0x1 (POWERON)', ' boot:0x13\n', 'next\n']);
    assert.equal(got.log, 'rst:0x1 (POWERON) boot:0x13\nnext\n');
    assert.deepEqual(got.protocol, []);
  });
  test('the two interleave without either leaking into the other', () => {
    const got = route(['before\n~hello\t1\tesp32-abc\tc3\nafter\n~sta', 'tus\t{}\n']);
    assert.deepEqual(got.protocol, ['~hello\t1\tesp32-abc\tc3', '~status\t{}']);
    assert.equal(got.log, 'before\nafter\n');
  });
  test('a blank log line is kept', () => {
    assert.equal(route(['a\n\nb\n']).log, 'a\n\nb\n');
  });
});

describe('the profile', () => {
  const profile = () => ({...profileNew('dev', 'lotus', 'mqtt.example.org'),
    wifi: [{ssid: 'Home', password: 'pw1'}, {ssid: 'Shed', password: ''}, {ssid: '', password: 'ignored'}]});

  test('goes to the node in the order that avoids a restart between settings', () => {
    const p = {...profile(), secret: 's3cret'};
    assert.deepEqual(profileCommands(p).map((c) => c.twig), [
      'frugal_iot/org', 'frugal_iot/project', 'mqtt/enrol_secret', 'mqtt/hostname', 'wifi/Home', 'wifi/Shed']);
  });
  test('the secret is left out when there is none, and marked so it is never logged', () => {
    assert.ok(!profileCommands(profile()).some((c) => c.twig === 'mqtt/enrol_secret'));
    assert.equal(profileCommands({...profile(), secret: 'x'}).find((c) => c.secret).twig, 'mqtt/enrol_secret');
  });
  test('an open network is sent with an empty password', () => {
    assert.equal(profileCommands(profile()).find((c) => c.twig === 'wifi/Shed').value, '');
  });
  test('needs an active project and at least one network', () => {
    assert.deepEqual(profileProblems(profile()), []);
    assert.deepEqual(profileProblems({...profile(), org: '', project: ''}), ["No active project"]);
    assert.deepEqual(profileProblems({...profile(), wifi: [{ssid: '', password: ''}]}), ["Add a WiFi network"]);
  });
  test('refuses what the node would mis-file', () => {
    // A slash in an SSID would be read as a path by the node, which keys the network by its twig
    assert.deepEqual(profileProblems({...profile(), wifi: [{ssid: 'a/b', password: ''}]}), ["WiFi network not valid"]);
    assert.deepEqual(profileProblems({...profile(), project: 'x'}), ["Project name must be 2 to 15 characters"]);
  });
});
