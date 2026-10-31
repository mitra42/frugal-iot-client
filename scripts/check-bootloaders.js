#!/usr/bin/env node
/*
 * Check base/bootloader/ against the toolchains - run as part of a release, and after updating
 * PlatformIO's pioarduino or the Arduino IDE's ESP32 core:
 *   node scripts/check-bootloaders.js [--update[=arduino|pioarduino]] [--strict] [--offline]
 *
 * We do not develop in the Arduino IDE, so a new release of its core can go unnoticed - and firmware
 * built with it is refused by the flasher until its bootloader is shipped. Three things are checked:
 *   1. the latest published Arduino core / pioarduino release has a bootloader here, and is installed
 *      on this machine (so it can be rebuilt and compared)
 *   2. every installed toolchain's bootloader, rebuilt with the recipe in FLASH_PLAN.md, is what is
 *      shipped for its IDF release (ignoring the build date) - and the newest installed one has an entry
 *   3. no two entries share an IDF release, because the flasher picks by release and could not tell
 *      them apart
 * --update brings an out-of-date toolchain up to the latest first: arduino-cli for the Arduino core,
 * and for PlatformIO the same pioarduino "stable" zip the demo's platformio.ini names - not the
 * official espressif32, which lacks boards we need. A toolchain that is not installed is skipped;
 * --strict makes that a failure, for a release machine that should have both. --offline skips the
 * check of what is latest. ESPTOOL overrides the esptool found in PlatformIO's penv or on PATH.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const strict = process.argv.includes('--strict');
const offline = process.argv.includes('--offline');
// --update brings all toolchains up to date; --update=arduino (or =pioarduino) only that one
const updateArg = process.argv.find((a) => a.startsWith('--update'));
const updates = (name) => !!updateArg && (!updateArg.includes('=') || name.toLowerCase().startsWith(updateArg.split('=')[1].toLowerCase()));
const base = new URL('../base/', import.meta.url);
const boards = JSON.parse(readFileSync(new URL('boards.json', base), 'utf8'));
const home = homedir();
const arduinoRoot = platform() === 'darwin' ? join(home, 'Library/Arduino15') : join(home, '.arduino15');
const PioPlatformUrl = 'https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip';
const pioPackages = join(home, '.platformio/packages');
const esptool = process.env.ESPTOOL
  || [join(home, '.platformio/penv/bin/esptool')].find(existsSync) || 'esptool';

const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const idfVerIn = (bytes) => (/v5\.\d+\.\d+/.exec(Buffer.from(bytes).toString('latin1')) || [])[0];
const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

// Each toolchain: its name as boards.json spells it, the core version installed, and where each
// chip's ELF is. Arduino keeps every version it has installed; pioarduino keeps one.
const TOOLCHAINS = {
  pioarduino: {
    installed: (chip) => {
      const version = (read(join(pioPackages, 'framework-arduinoespressif32/package.json')) || {}).version;
      const elf = join(pioPackages, 'framework-arduinoespressif32-libs', chip, 'bin/bootloader_qio_80m.elf');
      return version && existsSync(elf) ? [{ version, elf }] : [];
    },
    coreVersions: () => [(read(join(pioPackages, 'framework-arduinoespressif32/package.json')) || {}).version].filter(Boolean),
    // pio sees a URL as an unchanging version ("already installed", "already up-to-date"), so a newer
    // "stable" needs the platform removed first. Its frameworks otherwise wait for the first build.
    update: () => {
      if (!run('pio', ['pkg', 'uninstall', '--global', '--platform', PioPlatformUrl])) return false;
      if (!run('pio', ['pkg', 'install', '--global', '--platform', PioPlatformUrl])) return false;
      const platform = read(join(home, '.platformio/platforms/espressif32/platform.json'));
      const urls = ['framework-arduinoespressif32', 'framework-arduinoespressif32-libs'].map((n) => platform.packages[n].version);
      return urls.every((url) => run('pio', ['pkg', 'install', '--global', '--tool', url]));
    },
  },
  'Arduino IDE': {
    installed: (chip) => {
      const dir = join(arduinoRoot, 'packages/esp32/tools', `${chip}-libs`);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).sort(byVersion)
        .map((version) => ({ version, elf: join(dir, version, 'bin/bootloader_qio_80m.elf') }))
        .filter((i) => existsSync(i.elf));
    },
    coreVersions: () => {
      const dir = join(arduinoRoot, 'packages/esp32/hardware/esp32');
      return existsSync(dir) ? readdirSync(dir).filter((v) => /^\d/.test(v)).sort(byVersion) : [];
    },
    update: () => run('arduino-cli', ['core', 'update-index']) && run('arduino-cli', ['core', 'upgrade', 'esp32:esp32']),
  },
};
function run(command, args) {
  console.log(`....  ${command} ${args.join(' ')}`);
  try { execFileSync(command, args, { stdio: 'inherit' }); return true; } catch (e) { say(false, `${command} failed (${e.code || e.status})`); return false; }
}
// Two builds of one release differ in the build timestamp inside the image and in the checksum and
// SHA-256 that end it - nothing else - so those are ignored
function significant(bytes) {
  const copy = Buffer.from(bytes);
  for (const m of copy.toString('latin1').matchAll(/[A-Z][a-z]{2} [ \d]\d \d{4} \d\d:\d\d:\d\d/g)) copy.fill(0, m.index, m.index + m[0].length);
  return copy.fill(0, copy.length - 33);
}
const sameBootloader = (a, b) => a.length === b.length && significant(a).equals(significant(b));

let failed = false;
const say = (ok, text) => {
  console.log(`${ok === null ? 'skip' : ok ? ' ok ' : 'FAIL'}  ${text}`);
  if (ok === false || (ok === null && strict)) failed = true;
};

const github = async (path) => {
  const res = await fetch(`https://api.github.com/repos/pioarduino/platform-espressif32/${path}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
};
// What each toolchain would install now. Our pioarduino URL is a moving "stable" release whose body
// says which core it carries; Arduino's is the newest stable in its package index.
async function latestCores() {
  const stable = /core (\d+\.\d+\.\d+)/.exec((await github('releases/tags/stable')).body || '');
  const index = await (await fetch('https://espressif.github.io/arduino-esp32/package_esp32_index.json', { signal: AbortSignal.timeout(30000) })).json();
  const arduino = index.packages[0].platforms.filter((p) => p.architecture === 'esp32' && /^\d+\.\d+\.\d+$/.test(p.version))
    .map((p) => p.version).sort(byVersion).pop();
  if (!stable) throw new Error('cannot read the core from the pioarduino "stable" release');
  return { pioarduino: stable[1], 'Arduino IDE': arduino };
}
// pioarduino's release titles name the IDF: "Arduino Release v3.3.12 based on ESP-IDF v5.5.5". Both
// projects use the same core numbers, so this serves Arduino's too.
async function idfForCore(core) {
  const release = (await github('releases?per_page=50')).find((r) => (r.name || '').includes(`v${core} `) && /ESP-IDF v\d/.test(r.name));
  return release && /ESP-IDF (v\d+\.\d+\.\d+)/.exec(release.name)[1];
}

async function checkLatest() {
  let latest;
  try { latest = await latestCores(); } catch (e) { say(null, `could not find the latest releases (${e.message})`); return; }
  const shippedIdf = Object.values(boards.bootloadersByChip).flat().map((b) => b.idfVer);
  for (const [name, t] of Object.entries(TOOLCHAINS)) {
    const want = latest[name];
    let have = t.coreVersions();
    if (!have.length) { say(null, `${name} is not installed`); continue; }
    if (byVersion(have[have.length - 1], want) < 0 && updates(name) && t.update()) have = t.coreVersions();
    const newest = have[have.length - 1];
    const current = byVersion(newest, want) >= 0;
    say(current, `${name} installed is ${newest}, latest is ${want}${current ? '' : ' - run with --update'}`);
    let idf = null;
    try { idf = await idfForCore(want); } catch (e) { /* reported below */ }
    if (!idf) say(null, `${name} ${want}: cannot tell which ESP-IDF it is built on`);
    else say(shippedIdf.includes(idf), `${name} ${want} is on ESP-IDF ${idf}: ${shippedIdf.includes(idf) ? 'a bootloader is shipped' : 'NO bootloader is shipped - firmware built with it is refused'}`);
  }
}

function rebuild(chip, elf) {
  const out = join(tmpdir(), `bootloader-${chip}-${process.pid}.bin`);
  execFileSync(esptool, ['--chip', chip, 'elf2image', '--flash-mode', 'dio', '--flash-freq', '80m', '--flash-size', '4MB', '-o', out, elf], { stdio: 'pipe' });
  return readFileSync(out);
}

function checkChip(chipName, options) {
  const chip = chipName.toLowerCase().replace('-', '');
  for (const entry of options) {
    const label = `${chipName} ${entry.core} ${entry.idfVer}`;
    const shipped = readFileSync(new URL(entry.path, base));
    if (idfVerIn(shipped) !== entry.idfVer) say(false, `${label}: ${entry.path} contains ${idfVerIn(shipped)}`);
  }
  const idfs = options.map((b) => b.idfVer);
  if (new Set(idfs).size !== idfs.length) say(false, `${chipName}: two entries share an ESP-IDF release (${idfs.join(', ')}) - the flasher picks by release and could not tell them apart`);
  for (const [name, t] of Object.entries(TOOLCHAINS)) {
    const installs = t.installed(chip);
    if (!installs.length) { say(null, `${chipName} ${name}: not installed, so not compared`); continue; }
    installs.forEach((inst, i) => {
      const built = rebuild(chip, inst.elf);
      const entry = options.find((e) => e.idfVer === idfVerIn(built));
      const label = `${chipName} ${name} ${inst.version} (${idfVerIn(built)})`;
      if (!entry) {
        // An older core with no entry is just one we do not support; the newest is one users will have
        if (i === installs.length - 1) say(false, `${label}: no entry in boards.json - firmware built with it is refused`);
        else console.log(`note  ${label}: no entry (an older core)`);
      } else if (sameBootloader(built, readFileSync(new URL(entry.path, base)))) say(true, `${label}: matches ${entry.path}`);
      else say(false, `${label}: same release as ${entry.path} but it differs beyond the build date - rebuild it`);
    });
  }
}

if (!offline) await checkLatest();
for (const [chipName, options] of Object.entries(boards.bootloadersByChip)) checkChip(chipName, options);
process.exit(failed ? 1 : 0);
