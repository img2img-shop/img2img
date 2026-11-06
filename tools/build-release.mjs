// Builds the store packages of the extension from the last commit (HEAD): uncommitted changes are left out, so a
// package always matches a commit. One ZIP per store family:
//
//   img2img-chromium-<version>.zip   Chrome Web Store, Opera add-ons (Brave, Vivaldi, Edge etc. use Chrome's)
//   img2img-firefox-<version>.zip    addons.mozilla.org (Firefox desktop and Android)
//
//   node tools/build-release.mjs            build into dist/extension/<version>/ and lint the Firefox package
//   node tools/build-release.mjs --no-lint  ...without the lint (it fetches web-ext with npx the first time)
//   node tools/build-release.mjs --force    rebuild a version already built from another commit
//
// The version is manifest.json's. Stores refuse a version they already have, so bump it for every release.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { PATTERNS_FILE, findPrivate, loadPrivatePatterns } from './private-check.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'extension';
const WEB_EXT = 'web-ext@10.8.0';

// Firefox's add-on ID is permanent once the add-on is listed on addons.mozilla.org
const GECKO_ID = 'img2img@img2img.shop';
// data_collection_permissions (required for new listings) needs Firefox 140, or 142 on Android. Page images go to
// the img2img server (server processing), with the account's API key.
const FIREFOX_SETTINGS = {
  gecko: {
    id: GECKO_ID,
    strict_min_version: '140.0',
    data_collection_permissions: { required: ['websiteContent', 'authenticationInfo'] },
  },
  gecko_android: { strict_min_version: '142.0' },
};

// Each target's manifest, from the committed one
const TARGETS = {
  // "key" only pins the ID of unpacked installs (ComfyUI's --enable-cors-header uses it); the stores refuse it
  chromium: ({ key, ...manifest }) => manifest,
  // Firefox has no extension service workers: the same script runs as an event page
  firefox: ({ key, background, ...manifest }) => ({
    ...manifest,
    background: { scripts: [background.service_worker] },
    browser_specific_settings: FIREFOX_SETTINGS,
  }),
};

const args = process.argv.slice(2);
const lint = !args.includes('--no-lint');
const force = args.includes('--force');

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: REPO, encoding: 'utf8' });
const commit = git('rev-parse', '--short', 'HEAD').trim();
// What the packages are made of: the committed extension folder (other commits don't change them)
const tree = git('rev-parse', `HEAD:${SOURCE}`).trim();
const changed = new Date(git('log', '-1', '--format=%cI', '--', SOURCE).trim());
if (git('status', '--porcelain', '--', SOURCE).trim()) {
  console.log(`Note: ${SOURCE}/ has uncommitted changes; they're not in the packages (built from ${commit})\n`);
}

const files = git('ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', SOURCE).split('\0').filter(Boolean)
  .map(file => ({ name: path.posix.relative(SOURCE, file), content: execFileSync('git', ['show', `HEAD:${file}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }) }));
const manifest = JSON.parse(files.find(file => file.name === 'manifest.json').content);
const version = manifest.version;

// Store packages are public (anyone can unzip them). Without a patterns file (e.g. a build from the public repo)
// there's nothing to check against.
const patterns = loadPrivatePatterns();
const problems = patterns ? findPrivate(files.map(({ name, content }) => ({ name: `${SOURCE}/${name}`, content })), patterns) : [];
if (!patterns) console.log(`Note: no private patterns file (${PATTERNS_FILE}), so the files aren't checked for private details\n`);
if (problems.length) {
  console.error('Not built: these files contain something private:');
  problems.forEach(problem => console.error(`  ${problem}`));
  process.exit(1);
}

const outDir = path.join(REPO, 'dist', 'extension', version);
const buildInfo = path.join(outDir, 'build.json');
const previous = fs.existsSync(buildInfo) && JSON.parse(fs.readFileSync(buildInfo, 'utf8'));
if (previous && previous.tree !== tree && !force) {
  console.error(`Version ${version} was already built from a different ${SOURCE}/ (at ${previous.commit}). Bump "version" in ${SOURCE}/manifest.json, or pass --force.`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const packages = {};
for (const [target, transform] of Object.entries(TARGETS)) {
  const targetFiles = files.map(file => file.name === 'manifest.json'
    ? { name: file.name, content: Buffer.from(JSON.stringify(transform(manifest), null, 2) + '\n') }
    : file);
  const zipName = `img2img-${target}-${version}.zip`;
  fs.writeFileSync(path.join(outDir, zipName), zip(targetFiles, changed));
  packages[target] = { zip: zipName, files: targetFiles };
  console.log(`${target}: dist/extension/${version}/${zipName} (${targetFiles.length} files)`);
}
fs.writeFileSync(buildInfo, JSON.stringify({ version, commit, tree, built: new Date().toISOString() }, null, 2) + '\n');

// addons-linter, the check addons.mozilla.org runs on upload; it reads a folder, so the package is unpacked first
if (lint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img2img-firefox-'));
  try {
    for (const { name, content } of packages.firefox.files) {
      fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    console.log(`\nLinting the Firefox package (${WEB_EXT})...`);
    // (One command line: npx is a .cmd on Windows, which needs a shell)
    const result = spawnSync(`npx --yes ${WEB_EXT} lint --source-dir "${dir}" --no-config-discovery`, { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      console.error('The Firefox package has lint errors (above)');
      process.exit(1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A ZIP of the files (deflated, all dated date, so the same extension folder gives the same bytes)
function zip(entries, date) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = zlib.deflateRawSync(content, { level: 9 });
    const crc = zlib.crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
