export interface SignalStats {
  readonly peak: number;
  readonly rms: number;
  readonly dc: number;
  readonly finite: boolean;
  readonly clipped: number;
}

export function signalStats(
  samples: Float32Array | Float64Array,
  from: number = 0,
  to: number = samples.length,
): SignalStats {
  let peak = 0;
  let sum = 0;
  let total = 0;
  let clipped = 0;
  let finite = true;
  const count = Math.max(1, to - from);
  for (let index = from; index < to; index++) {
    const value = samples[index] ?? 0;
    if (!Number.isFinite(value)) finite = false;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= 0.999) clipped += 1;
    sum += value * value;
    total += value;
  }
  return { peak, rms: Math.sqrt(sum / count), dc: total / count, finite, clipped };
}

export interface PitchEstimate {
  readonly hz: number;
  readonly clarity: number;
}

export function estimatePitch(
  samples: Float32Array | Float64Array,
  sampleRate: number,
  from: number,
  to: number,
  minHz: number = 50,
  maxHz: number = 1500,
): PitchEstimate {
  const length = to - from;
  const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(length / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxLag <= minLag) return { hz: 0, clarity: 0 };
  let mean = 0;
  for (let index = from; index < to; index++) mean += samples[index] ?? 0;
  mean /= Math.max(1, length);
  const window = new Float64Array(length);
  for (let index = 0; index < length; index++) window[index] = (samples[from + index] ?? 0) - mean;
  const energy = new Float64Array(maxLag + 1);
  let bestLag = 0;
  let bestValue = -Infinity;
  const nsdf = new Float64Array(maxLag + 1);
  let e0 = 0;
  for (let index = 0; index < length; index++) e0 += (window[index] ?? 0) ** 2;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    let m = 0;
    for (let index = 0; index + lag < length; index++) {
      const a = window[index] ?? 0;
      const b = window[index + lag] ?? 0;
      acf += a * b;
      m += a * a + b * b;
    }
    energy[lag] = m;
    nsdf[lag] = m === 0 ? 0 : (2 * acf) / m;
  }
  const threshold = 0.9;
  const peaks: { lag: number; value: number }[] = [];
  let crossed = false;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const value = nsdf[lag] ?? 0;
    const previous = nsdf[lag - 1] ?? 0;
    if (previous <= 0 && value > 0) crossed = true;
    if (!crossed) continue;
    if (value > previous && value >= (nsdf[lag + 1] ?? 0) && value > 0.2) {
      peaks.push({ lag, value });
      if (value > bestValue) {
        bestValue = value;
        bestLag = lag;
      }
    }
  }
  if (bestLag === 0 || peaks.length === 0) return { hz: 0, clarity: 0 };
  let chosenLag = bestLag;
  let chosenValue = bestValue;
  for (const peak of peaks) {
    if (peak.value >= threshold * bestValue) {
      chosenLag = peak.lag;
      chosenValue = peak.value;
      break;
    }
  }
  const left = nsdf[chosenLag - 1] ?? chosenValue;
  const right = nsdf[chosenLag + 1] ?? chosenValue;
  const denominator = left - 2 * chosenValue + right;
  const shift = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
  const refined = chosenLag + Math.max(-1, Math.min(1, shift));
  if (e0 === 0) return { hz: 0, clarity: 0 };
  return { hz: sampleRate / refined, clarity: Math.max(0, Math.min(1, chosenValue)) };
}

export function centsBetween(measuredHz: number, targetHz: number): number {
  return 1200 * Math.log2(measuredHz / targetHz);
}

export interface SpectrumPeak {
  readonly hz: number;
  readonly db: number;
}

export function powerSpectrum(samples: Float32Array | Float64Array, from: number, size: number): Float64Array {
  const n = 1 << Math.ceil(Math.log2(Math.max(16, size)));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let index = 0; index < size && from + index < samples.length; index++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
    re[index] = (samples[from + index] ?? 0) * w;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  for (let size2 = 2; size2 <= n; size2 <<= 1) {
    const angle = (-2 * Math.PI) / size2;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size2) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size2 / 2; k++) {
        const a = start + k;
        const b = a + size2 / 2;
        const xr = (re[b] ?? 0) * cr - (im[b] ?? 0) * ci;
        const xi = (re[b] ?? 0) * ci + (im[b] ?? 0) * cr;
        re[b] = (re[a] ?? 0) - xr;
        im[b] = (im[a] ?? 0) - xi;
        re[a] = (re[a] ?? 0) + xr;
        im[a] = (im[a] ?? 0) + xi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  const out = new Float64Array(n / 2);
  for (let index = 0; index < n / 2; index++) out[index] = (re[index] ?? 0) ** 2 + (im[index] ?? 0) ** 2;
  return out;
}

export function spectralCentroid(
  samples: Float32Array | Float64Array,
  sampleRate: number,
  from: number,
  size: number,
): number {
  const spectrum = powerSpectrum(samples, from, size);
  const binHz = sampleRate / (spectrum.length * 2);
  let weighted = 0;
  let total = 0;
  for (let index = 1; index < spectrum.length; index++) {
    const power = spectrum[index] ?? 0;
    weighted += power * index * binHz;
    total += power;
  }
  return total === 0 ? 0 : weighted / total;
}

export function bandEnergyRatio(
  samples: Float32Array | Float64Array,
  sampleRate: number,
  from: number,
  size: number,
  lowHz: number,
  highHz: number,
): number {
  const spectrum = powerSpectrum(samples, from, size);
  const binHz = sampleRate / (spectrum.length * 2);
  let band = 0;
  let total = 0;
  for (let index = 1; index < spectrum.length; index++) {
    const hz = index * binHz;
    const power = spectrum[index] ?? 0;
    total += power;
    if (hz >= lowHz && hz < highHz) band += power;
  }
  return total === 0 ? 0 : band / total;
}
