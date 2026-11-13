// The fixture pack's collector: it imports no engine file and reads only
// through lib, the helpers collect.mjs passes (quality/packs.test.mjs).
export const area = 'fixture-pack';

// Its one metric: params.done of params.steps, as a share.
export async function collect({ params, lib }) {
  return { 'fixture_pack.done_share': lib.measured(Math.round((100 * params.done) / params.steps), 'fixture pack params') };
}
