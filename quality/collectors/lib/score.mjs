// The scorer's checks a collector's test reads its targets with: the engine's
// own (quality/score.mjs), so a test never imports the engine by path.
export { CHARTS, loadTargets, scoreMetric, TEXT_FIELDS } from '../../score.mjs';
