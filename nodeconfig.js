/*
 * Frugal IoT client - configuring a node over USB serial: the line protocol and the profile.
 *
 * Nothing here touches the DOM or a port, so it is tested directly. flash.js owns the port and the
 * screen. The node's side is system/serialconfig.h in the firmware; see CONFIG_PLAN.md.
 */

// Short enough that an SSID plus password, percent-encoded, fits the node's line buffer
export const SsidMax = 32;
export const PasswordMax = 63;
export const ProjectMin = 2;
export const ProjectMax = 15;

// %, TAB, CR, LF and other control characters - the only bytes that would break a line or a field
export function serialEncode(raw) {
  return String(raw).replace(/[%\x00-\x1f]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
export function serialDecode(enc) {
  return String(enc).replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
export function setLine(twig, value) {
  return `~set\t${serialEncode(twig)}\t${serialEncode(value)}`;
}

// "~ok\tfrugal_iot/org" -> {cmd: 'ok', fields: ['frugal_iot/org']}. The status field is JSON, not encoded.
export function parseReply(line) {
  const parts = line.replace(/^~/, '').split('\t');
  const cmd = parts.shift();
  return {cmd, fields: cmd === 'status' ? parts : parts.map(serialDecode)};
}

/*
 * Splits what a monitor reads into the node's protocol lines and everything else. A chunk can end
 * anywhere, so a line is only known to be protocol once its first character has arrived; a protocol
 * line is held until its newline, and a log line is passed through as it comes, so a boot log still
 * appears live. Protocol lines never reach the log - which is also why nothing in them can be
 * mistaken for output.
 */
export class LineRouter {
  constructor(onProtocol, onLog) {
    this.onProtocol = onProtocol;
    this.onLog = onLog;
    this.mode = 'start'; // start of a line, or part-way through a protocol or log line
    this.held = '';
  }
  feed(text) {
    let rest = text;
    while (rest.length) {
      if (this.mode === 'start') this.mode = rest[0] === '~' ? 'protocol' : 'log';
      const nl = rest.indexOf('\n');
      const piece = nl < 0 ? rest : rest.slice(0, nl);
      if (this.mode === 'protocol') {
        this.held += piece;
        if (nl >= 0) { this.onProtocol(this.held.replace(/\r$/, '')); this.held = ''; }
      } else {
        this.onLog(nl < 0 ? piece : piece + '\n');
      }
      if (nl >= 0) this.mode = 'start';
      rest = nl < 0 ? '' : rest.slice(nl + 1);
    }
  }
}

// What the node's error codes mean to a person; the node sends codes and the client translates
export const ErrorStrings = {format: "Not understood", unknown: "Not understood", too_long: "Too long"};

/*
 * A profile is what every board in a batch gets: the org and project the admin is working in, the
 * enrolment secret for that org, the broker, and the WiFi networks. The node's name is not in it -
 * each board already has its own.
 */
export function profileNew(org, project, broker) {
  return {org: org || '', project: project || '', secret: '', broker: broker || '', wifi: [{ssid: '', password: ''}]};
}
// Keys for getString - what is wrong with a profile that Apply could not send
export function profileProblems(p) {
  const problems = [];
  if (!p.org || !p.project) problems.push("No active project");
  else if (p.project.length < ProjectMin || p.project.length > ProjectMax) problems.push("Project name length");
  const networks = p.wifi.filter((w) => w.ssid);
  if (!networks.length) problems.push("Add a WiFi network");
  if (networks.some((w) => w.ssid.includes('/') || w.ssid.length > SsidMax || w.password.length > PasswordMax)) {
    problems.push("WiFi network not valid");
  }
  return problems;
}
/*
 * In the order the node needs them. Org and project change the topic prefix and enrolment presents
 * both with the secret, so those go first; WiFi connecting is what triggers enrolment, so it goes
 * last. The node holds a restart those need until ~apply, so the order costs no reboot.
 */
export function profileCommands(p) {
  const commands = [
    {twig: 'frugal_iot/org', value: p.org},
    {twig: 'frugal_iot/project', value: p.project},
  ];
  if (p.secret) commands.push({twig: 'mqtt/enrol_secret', value: p.secret, secret: true});
  if (p.broker) commands.push({twig: 'mqtt/hostname', value: p.broker});
  p.wifi.filter((w) => w.ssid).forEach((w) => commands.push({twig: `wifi/${w.ssid}`, value: w.password}));
  return commands;
}
