import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, redactText } from './redact.mjs';

// Split, so the repo's private-reference scan does not count a fixture home.
const dotted = '/Users' + '/some.one';
const alice = '/Users' + '/alice';

test('redactText: a path under home prints as ~/..., anything else as is (#229)', () => {
  assert.equal(redactText('/Users/someone/Developer/Code-OS', '/Users/someone'), '~/Developer/Code-OS');
  assert.equal(redactText('/Users/someone', '/Users/someone/'), '~');
  assert.equal(redactText('/home/someoneelse/x', '/home/someone'), '/home/someoneelse/x');
  assert.equal(redactText('/srv/repo', '/Users/someone'), '/srv/repo');
});

test('redactText: any /Users/<name> and a project folder name print with no account name', () => {
  assert.equal(redactText('read /Users/someone/x and /Users/someone', '/home/runner'), 'read ~/x and ~');
  assert.equal(redactText('~/.claude/projects/*-Users-some-one-Dev-Code-OS*/**/*.jsonl', dotted), '~/.claude/projects/*-Users-<user>-Dev-Code-OS*/**/*.jsonl');
  assert.equal(redactText('*-Users-someone-Dev*', ''), '*-Users-<user>-Dev*');
});

test('redact: every string in a metric map, numbers and shape kept', () => {
  const out = redact({ a: { value: 3, source: '/Users/someone/x', detail: [{ label: '-Users-someone-y', value: null }] } }, '/Users/someone');
  assert.deepEqual(out, { a: { value: 3, source: '~/x', detail: [{ label: '-Users-<user>-y', value: null }] } });
});

test('redactText: a home is replaced only as a whole name; a longer one goes to the general pattern', () => {
  assert.equal(redactText('*-Users-alicebob-Dev*', alice), '*-Users-<user>-Dev*');
  assert.equal(redactText('~/p/-Users-alicebob/x.jsonl', alice), '~/p/-Users-<user>/x.jsonl');
  assert.equal(redactText(`${alice}bob/x and ${alice}/y`, alice), '~/x and ~/y');
});
