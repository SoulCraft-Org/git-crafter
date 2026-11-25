// Copy of soulcraft-org/compute-crafter tests/private-terms.test.mjs at 9ed8c0166ba9ec68a66ffaf039cb8ce2c3ad7a12 (issue 511).
// tools/private_terms.py in a throwaway git repo: its exit codes (0 clean, 1 a hit, 2 no secret), the notice a fork's or
// Dependabot's pull request gets, and that no matched text ever reaches the log.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'private_terms.py');
const TERM = 'quokka-secret';

// A git repo whose index holds tools/private_terms.py and these files ({ path: text or Buffer }).
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'private-terms-'));
  mkdirSync(join(dir, 'tools'));
  copyFileSync(SCRIPT, join(dir, 'tools', 'private_terms.py'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const git = (...args) => spawnSync('git', args, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir } });
  git('init', '-q');
  git('add', '-A');
  return dir;
}

// The script's exit code and everything it printed, with only the env named here.
function scan(dir, env = {}) {
  const r = spawnSync('python3', ['-I', 'tools/private_terms.py'], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('private terms: a clean repo exits 0', () => {
  const r = scan(repo({ 'a.txt': 'nothing here\n' }), { PRIVATE_TERMS: TERM });
  assert.equal(r.code, 0);
  assert.match(r.out, /private terms: 0 hit\(s\)/);
});

test('private terms: a hit exits 1 and names the file and line, never the matched text', () => {
  const r = scan(repo({ 'notes.txt': `line one\nthe ${TERM.toUpperCase()} is here\n` }), { PRIVATE_TERMS: TERM });
  assert.equal(r.code, 1);
  assert.match(r.out, /file=notes\.txt,line=2/);
  assert.doesNotMatch(r.out, /quokka/i);
});

test('private terms: a (?i) prefix on the secret is read as the flag', () => {
  assert.equal(scan(repo({ 'a.txt': `${TERM}\n` }), { PRIVATE_TERMS: `(?i)${TERM}` }).code, 1);
});

test('private terms: a path holding a term is counted and never printed', () => {
  const r = scan(repo({ [`${TERM}.txt`]: 'plain\n' }), { PRIVATE_TERMS: TERM });
  assert.equal(r.code, 1);
  assert.match(r.out, /tracked file #\d+ \(git ls-files order\) has a private term in its path/);
  assert.doesNotMatch(r.out, /quokka/i);
});

test('private terms: UTF-16 text is read, a binary file is skipped', () => {
  const utf16 = Buffer.from(`﻿the ${TERM}\n`, 'utf16le');
  assert.equal(scan(repo({ 'wide.txt': utf16 }), { PRIVATE_TERMS: TERM }).code, 1);
  const binary = Buffer.concat([Buffer.from(TERM), Buffer.from([0, 1, 2])]);
  assert.equal(scan(repo({ 'blob.bin': binary }), { PRIVATE_TERMS: TERM }).code, 0);
});

test('private terms: a string listed in .github/private-terms-allow is cut out before the match', () => {
  const files = { '.github/private-terms-allow': `# public on purpose\n${TERM}-public\n`, 'a.txt': `the ${TERM}-public handle\n` };
  assert.equal(scan(repo(files), { PRIVATE_TERMS: TERM }).code, 0);
  assert.equal(scan(repo({ ...files, 'b.txt': `${TERM} alone\n` }), { PRIVATE_TERMS: TERM }).code, 1);
});

test('private terms: no secret exits 2', () => {
  const r = scan(repo({ 'a.txt': 'x\n' }));
  assert.equal(r.code, 2);
  assert.match(r.out, /::error::PRIVATE_TERMS is empty/);
});

test('private terms: a secret that is not a regex exits 2 and the log holds none of it', () => {
  const r = scan(repo({ 'a.txt': 'x\n' }), { PRIVATE_TERMS: `${TERM}-(` });
  assert.equal(r.code, 2);
  assert.match(r.out, /PRIVATE_TERMS is not a valid regex/);
  assert.doesNotMatch(r.out, /quokka/i);
});

test('private terms: a fork\'s or Dependabot\'s pull request only notes the skip, any other without the secret is exit 2', () => {
  const dir = repo({ 'a.txt': 'x\n' });
  const event = (name) => {
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { head: { repo: { full_name: name } } } }));
    return { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_REPOSITORY: 'org/repo' };
  };
  const fork = scan(dir, event('someone/fork'));
  assert.equal(fork.code, 0);
  assert.match(fork.out, /::notice::PRIVATE_TERMS is not available to this pull request/);
  const bot = scan(dir, { ...event('org/repo'), GITHUB_ACTOR: 'dependabot[bot]' });
  assert.equal(bot.code, 0);
  assert.match(bot.out, /::notice::/);
  assert.equal(scan(dir, event('org/repo')).code, 2, 'a pull request from this repo must have the secret');
});
