export interface LfShape {
  readonly te: number;
  readonly tp: number;
  readonly ta: number;
  readonly alpha: number;
  readonly epsilon: number;
  readonly omega: number;
  readonly e0: number;
  readonly returnTail: number;
}

export function rdToTimingRatios(rd: number): { readonly ra: number; readonly rk: number; readonly rg: number } {
  const clamped = Math.min(2.7, Math.max(0.3, rd));
  const ra = (-1 + 4.8 * clamped) / 100;
  const rk = (22.4 + 11.8 * clamped) / 100;
  const rg = rk / (4 * ((0.11 * clamped) / (0.5 + 1.2 * rk) - ra));
  return { ra: Math.max(0.005, ra), rk, rg };
}

export function solveLfShape(rd: number): LfShape {
  const { ra, rk, rg } = rdToTimingRatios(rd);
  const tp = 1 / (2 * rg);
  const te = tp * (1 + rk);
  const ta = ra;
  const tc = 1;
  const omega = Math.PI / tp;
  const tail = tc - te;
  let epsilon = 1 / ta;
  for (let iteration = 0; iteration < 60; iteration++) {
    const next = (1 - Math.exp(-epsilon * tail)) / ta;
    if (Math.abs(next - epsilon) < 1e-9 * Math.max(1, epsilon)) {
      epsilon = next;
      break;
    }
    epsilon = next;
  }
  const returnTail = Math.exp(-epsilon * tail);
  const returnArea = (1 / (epsilon * ta)) * ((1 - returnTail) / epsilon - tail * returnTail);
  const theta = omega * te;
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const openArea = (alpha: number): number => {
    const expo = Math.exp(alpha * te);
    const numerator = expo * (alpha * sinTheta - omega * cosTheta) + omega;
    return -numerator / ((alpha * alpha + omega * omega) * expo * sinTheta);
  };
  let low = -200;
  let high = 200;
  let alpha = 0;
  for (let iteration = 0; iteration < 100; iteration++) {
    alpha = (low + high) / 2;
    const value = openArea(alpha);
    if (value > returnArea) low = alpha;
    else high = alpha;
    if (high - low < 1e-8) break;
  }
  const e0 = -1 / (Math.exp(alpha * te) * sinTheta);
  return { te, tp, ta, alpha, epsilon, omega, e0, returnTail };
}

export function lfDerivative(shape: LfShape, phase: number): number {
  if (phase < shape.te) {
    return shape.e0 * Math.exp(shape.alpha * phase) * Math.sin(shape.omega * phase);
  }
  const tail = Math.exp(-shape.epsilon * (phase - shape.te));
  return -(tail - shape.returnTail) / (shape.epsilon * shape.ta);
}

const SHAPE_CACHE_STEPS = 48;
const shapeCache: (LfShape | undefined)[] = new Array<LfShape | undefined>(SHAPE_CACHE_STEPS + 1).fill(undefined);

export function lfShapeFor(rd: number): LfShape {
  const clamped = Math.min(2.7, Math.max(0.3, rd));
  const slot = Math.round(((clamped - 0.3) / 2.4) * SHAPE_CACHE_STEPS);
  const cached = shapeCache[slot];
  if (cached !== undefined) return cached;
  const shape = solveLfShape(0.3 + (slot / SHAPE_CACHE_STEPS) * 2.4);
  shapeCache[slot] = shape;
  return shape;
}

export function lfOpenPhaseWeight(shape: LfShape, phase: number): number {
  if (phase >= shape.te) return 0;
  const rise = shape.tp;
  return phase < rise ? phase / rise : 1 - (phase - rise) / (shape.te - rise);
}
