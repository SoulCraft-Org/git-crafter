import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeLiteral, stripAll } from './strip.mjs';

test('stripAll: a match one pass rejoins goes too, and plain text stays (#13)', () => {
  const comment = /<!--[\s\S]*?-->/g;
  // One pass would leave "<!-- b -->x".
  assert.equal(stripAll('<!<!-- a -->-- b -->x', comment), 'x');
  assert.equal(stripAll('<scr<script>x</script>ipt>y</SCRIPT >', /<script\b[\s\S]*?<\/script\b[^>]*>/gi), '', 'and so does an upper case tag the first pass rejoined');
  assert.equal(stripAll('a <b>c</b>', /<[^>]+>/g, ' '), 'a  c ');
  assert.equal(stripAll('no tags', /<[^>]+>/g), 'no tags');
});

// U+2028 and U+2029, the line and paragraph separators.
const SEPARATORS = [0x2028, 0x2029].map((c) => String.fromCharCode(c));

test('codeLiteral: the same value back, with no < > or line separator left raw in the code', () => {
  for (const v of ['</script><script>x', SEPARATORS.join('b'), "it's \"q\" \\ ok", { n: 1 }]) {
    const code = codeLiteral(v);
    assert.doesNotMatch(code, /[<>]/);
    assert.ok(SEPARATORS.every((s) => !code.includes(s)), code);
    assert.deepEqual(JSON.parse(code), v, 'still JSON, and so a JavaScript literal');
  }
});
