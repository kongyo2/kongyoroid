import { checkAbort } from "../errors.ts";
import {
  AntiResonator,
  DcBlocker,
  HalfBandDecimator,
  OnePole,
  Resonator,
  dbToGain,
  smoothingCoefficient,
  softLimit,
} from "./filters.ts";
import type { LfShape } from "./glottal.ts";
import { lfDerivative, lfOpenPhaseWeight, lfShapeFor } from "./glottal.ts";
import type { PlannedSegment, SynthesisPlan, VibratoRegion } from "./plan.ts";
import {
  PARAM_COUNT,
  P_AF,
  P_AH,
  P_AV,
  P_B1,
  P_F1,
  P_FB1,
  P_FB2,
  P_FF1,
  P_FF2,
  P_FG1,
  P_FG2,
  P_FHP,
  P_NMIX,
  P_NPOLE,
  P_NZERO,
  P_RD,
  interpolatePitchLog,
} from "./plan.ts";
import { GaussianNoise, deriveSeed } from "./random.ts";

export const SOURCE_GAIN: number = 0.19;
export const ASPIRATION_GAIN: number = 0.6;
export const FRICATION_GAIN: number = 0.016;
export const LIMITER_KNEE: number = 0.85;
export const CONTROL_HOP_SECONDS: number = 0.001;

export interface RenderStats {
  readonly peak: number;
  readonly rms: number;
  readonly limitedSamples: number;
  readonly frames: number;
}

function buildSmoothTau(): readonly number[] {
  const tau: number[] = new Array<number>(PARAM_COUNT).fill(0.004);
  tau[P_AV] = 0.0025;
  tau[P_AH] = 0.0025;
  tau[P_AF] = 0.0012;
  tau[P_RD] = 0.02;
  tau[P_NMIX] = 0.006;
  tau[P_FG1] = 0.002;
  tau[P_FG2] = 0.002;
  return tau;
}

const SMOOTH_TAU: readonly number[] = buildSmoothTau();

export class PlanRenderer {
  public readonly plan: SynthesisPlan;
  public readonly frames: number;
  private readonly sampleRate: number;
  private readonly hop: number;
  private readonly smoothK: Float64Array;
  private readonly target: Float64Array = new Float64Array(PARAM_COUNT);
  private readonly current: Float64Array = new Float64Array(PARAM_COUNT);
  private readonly cascade: readonly Resonator[] = [
    new Resonator(),
    new Resonator(),
    new Resonator(),
    new Resonator(),
    new Resonator(),
  ];
  private readonly nasalPole: Resonator = new Resonator();
  private readonly nasalZero: AntiResonator = new AntiResonator();
  private readonly fricationA: Resonator = new Resonator();
  private readonly fricationB: Resonator = new Resonator();
  private readonly fricationHighpass: OnePole = new OnePole();
  private readonly aspirationLowpass: OnePole = new OnePole();
  private readonly dcBlocker: DcBlocker;
  private readonly decimator: HalfBandDecimator = new HalfBandDecimator(31);
  private readonly aspirationNoise: GaussianNoise;
  private readonly fricationNoise: GaussianNoise;
  private readonly jitterNoise: GaussianNoise;
  private readonly shimmerNoise: GaussianNoise;
  private readonly pitchCursor: { index: number } = { index: 0 };
  private readonly masterGain: number;
  private segmentIndex: number = 0;
  private cursor: number = 0;
  private phase: number = 1;
  private phaseStep: number = 0;
  private shape: LfShape;
  private shimmerGain: number = 1;
  private periodF0: number = 0;
  private avGain: number = 0;
  private ahGain: number = 0;
  private afGain: number = 0;
  private nasalMix: number = 0;
  private fricGainA: number = 1;
  private fricGainB: number = 0.5;
  private activeFormants: number = 5;
  private vibratoIndex: number = 0;
  private peak: number = 0;
  private sumSquares: number = 0;
  private limited: number = 0;
  private initialized: boolean = false;

  public constructor(plan: SynthesisPlan) {
    this.plan = plan;
    this.frames = plan.frames;
    this.sampleRate = plan.sampleRate;
    this.hop = Math.max(1, Math.round(plan.sampleRate * CONTROL_HOP_SECONDS));
    this.smoothK = new Float64Array(PARAM_COUNT);
    for (let index = 0; index < PARAM_COUNT; index++) {
      this.smoothK[index] = smoothingCoefficient(SMOOTH_TAU[index] ?? 0.004, this.hop, plan.sampleRate);
    }
    this.shape = lfShapeFor(plan.voice.rd);
    this.dcBlocker = new DcBlocker(20, plan.sampleRate);
    this.aspirationLowpass.setCutoff(3200, plan.sampleRate);
    this.aspirationNoise = new GaussianNoise(deriveSeed(plan.seed, "aspiration"));
    this.fricationNoise = new GaussianNoise(deriveSeed(plan.seed, "frication"));
    this.jitterNoise = new GaussianNoise(deriveSeed(plan.seed, "jitter"));
    this.shimmerNoise = new GaussianNoise(deriveSeed(plan.seed, "shimmer"));
    this.masterGain = dbToGain(plan.voice.gainDb) * plan.volume;
    let active = 0;
    const limit = plan.sampleRate * 0.45;
    const first = plan.segments[0]?.keyframes[0]?.values;
    for (let band = 0; band < 5; band++) {
      const frequency = first === undefined ? [700, 1150, 2450, 3400, 4300][band] : first[P_F1 + band];
      if ((frequency ?? 0) < limit) active = band + 1;
    }
    this.activeFormants = Math.max(3, Math.min(5, active));
  }

  public get position(): number {
    return this.cursor;
  }

  public get finished(): boolean {
    return this.cursor >= this.frames;
  }

  public stats(): RenderStats {
    return {
      peak: this.peak,
      rms: this.cursor === 0 ? 0 : Math.sqrt(this.sumSquares / this.cursor),
      limitedSamples: this.limited,
      frames: this.cursor,
    };
  }

  private evaluateTarget(sample: number): void {
    const segments = this.plan.segments;
    let segment = segments[this.segmentIndex];
    while (segment !== undefined && sample >= segment.end) {
      this.segmentIndex += 1;
      segment = segments[this.segmentIndex];
    }
    if (segment === undefined) {
      this.target[P_AV] = -120;
      this.target[P_AH] = -120;
      this.target[P_AF] = -120;
      return;
    }
    const local = (sample - segment.start) / this.sampleRate;
    const frames = segment.keyframes;
    let index = 0;
    while (index + 1 < frames.length && (frames[index + 1]?.at ?? Infinity) <= local) index += 1;
    const a = frames[index];
    const b = frames[index + 1];
    if (a === undefined) return;
    if (b === undefined || b.at <= a.at) {
      this.target.set(a.values);
      return;
    }
    const t = Math.min(1, Math.max(0, (local - a.at) / (b.at - a.at)));
    const av = a.values;
    const bv = b.values;
    for (let k = 0; k < PARAM_COUNT; k++) {
      const x = av[k] ?? 0;
      const y = bv[k] ?? 0;
      this.target[k] = x + (y - x) * t;
    }
  }

  private control(sample: number): void {
    this.evaluateTarget(sample);
    if (!this.initialized) {
      this.current.set(this.target);
      this.initialized = true;
    } else {
      for (let k = 0; k < PARAM_COUNT; k++) {
        const c = this.current[k] ?? 0;
        const t = this.target[k] ?? 0;
        this.current[k] = c + (t - c) * (this.smoothK[k] ?? 1);
      }
    }
    const rate = this.sampleRate;
    const limit = rate * 0.45;
    for (let band = 0; band < this.activeFormants; band++) {
      const frequency = Math.min(limit, Math.max(60, this.current[P_F1 + band] ?? 500));
      const bandwidth = Math.max(20, this.current[P_B1 + band] ?? 100);
      this.cascade[band]?.tune(frequency, bandwidth, rate);
    }
    this.nasalMix = Math.min(1, Math.max(0, this.current[P_NMIX] ?? 0));
    if (this.nasalMix > 0.0005) {
      this.nasalPole.tune(Math.max(100, this.current[P_NPOLE] ?? 270), 160, rate);
      this.nasalZero.tune(Math.max(200, Math.min(limit, this.current[P_NZERO] ?? 1000)), 120, rate);
    }
    this.fricationA.tune(
      Math.min(limit, Math.max(100, this.current[P_FF1] ?? 6000)),
      Math.max(100, this.current[P_FB1] ?? 1000),
      rate,
    );
    this.fricationB.tune(
      Math.min(limit, Math.max(100, this.current[P_FF2] ?? 8000)),
      Math.max(100, this.current[P_FB2] ?? 2000),
      rate,
    );
    this.fricationHighpass.setCutoff(Math.min(limit, Math.max(50, this.current[P_FHP] ?? 3000)), rate);
    this.fricGainA = this.current[P_FG1] ?? 1;
    this.fricGainB = this.current[P_FG2] ?? 0.5;
    this.avGain = dbToGain(this.current[P_AV] ?? -120);
    this.ahGain = dbToGain(this.current[P_AH] ?? -120);
    this.afGain = dbToGain(this.current[P_AF] ?? -120);
  }

  private vibratoFactor(sample: number): number {
    const regions = this.plan.vibrato;
    if (regions.length === 0) return 1;
    let index = this.vibratoIndex;
    while (index + 1 < regions.length && (regions[index + 1]?.start ?? Infinity) <= sample) index += 1;
    while (index > 0 && (regions[index]?.start ?? 0) > sample) index -= 1;
    this.vibratoIndex = index;
    const region: VibratoRegion | undefined = regions[index];
    if (
      region === undefined ||
      sample < region.start ||
      sample >= region.end ||
      region.depthCents <= 0 ||
      region.rateHz <= 0
    ) {
      return 1;
    }
    const t = (sample - region.start) / this.sampleRate;
    if (t < region.delaySeconds) return 1;
    const since = t - region.delaySeconds;
    const fade = region.fadeSeconds <= 0 ? 1 : Math.min(1, since / region.fadeSeconds);
    const cents = region.depthCents * fade * Math.sin(2 * Math.PI * region.rateHz * since);
    return 2 ** (cents / 1200);
  }

  private beginPeriod(sample: number): void {
    const plan = this.plan;
    let hz = interpolatePitchLog(plan.pitch, sample, this.pitchCursor);
    if (!(hz > 0)) hz = plan.voice.baseF0;
    hz *= this.vibratoFactor(sample);
    if (plan.flutter > 0) {
      const t = sample / this.sampleRate;
      const wobble =
        (Math.sin(2 * Math.PI * 12.7 * t) + Math.sin(2 * Math.PI * 7.1 * t) + Math.sin(2 * Math.PI * 4.7 * t)) / 3;
      hz *= 1 + plan.flutter * 0.01 * 3 * wobble;
    }
    if (plan.jitter > 0) {
      const g = Math.max(-2.5, Math.min(2.5, this.jitterNoise.next()));
      hz *= 1 + plan.jitter * g;
    }
    const minHz = 20;
    const maxHz = this.sampleRate * 0.25;
    hz = Math.min(maxHz, Math.max(minHz, hz));
    this.periodF0 = hz;
    this.phaseStep = hz / (2 * this.sampleRate);
    this.shape = lfShapeFor(this.current[P_RD] ?? plan.voice.rd);
    if (plan.shimmerDb > 0) {
      const g = Math.max(-2.5, Math.min(2.5, this.shimmerNoise.next()));
      this.shimmerGain = dbToGain(plan.shimmerDb * g);
    } else {
      this.shimmerGain = 1;
    }
  }

  private glottalSample(sample: number): { readonly source: number; readonly open: number } {
    let open = 0;
    for (let sub = 0; sub < 2; sub++) {
      this.phase += this.phaseStep;
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        this.beginPeriod(sample);
      }
      const value = lfDerivative(this.shape, this.phase) * this.shimmerGain;
      this.decimator.push(value);
      if (sub === 1) open = lfOpenPhaseWeight(this.shape, this.phase);
    }
    return { source: this.decimator.output(), open };
  }

  public fill(buffer: Float32Array, offset: number = 0, length: number = buffer.length - offset): number {
    const total = Math.max(0, Math.min(length, this.frames - this.cursor));
    const hop = this.hop;
    const gain = this.masterGain;
    for (let i = 0; i < total; i++) {
      const sample = this.cursor;
      if (sample % hop === 0) this.control(sample);
      const voicing = this.avGain;
      const aspiration = this.ahGain;
      const { source, open } = this.glottalSample(sample);
      const noise = this.aspirationLowpass.step(this.aspirationNoise.next());
      const modulation = voicing > 1e-4 ? 0.55 + 0.45 * open : 1;
      let excitation = SOURCE_GAIN * voicing * source + ASPIRATION_GAIN * aspiration * noise * modulation;
      if (this.nasalMix > 0.0005) {
        const nasal = this.nasalPole.step(this.nasalZero.step(excitation));
        excitation += this.nasalMix * (nasal - excitation);
      }
      let x = excitation;
      for (let band = 0; band < this.activeFormants; band++) x = this.cascade[band]?.step(x) ?? x;
      let frication = 0;
      if (this.afGain > 1e-5) {
        const white = this.fricationNoise.next();
        const highpassed = white - this.fricationHighpass.step(white);
        frication =
          FRICATION_GAIN *
          this.afGain *
          (this.fricGainA * this.fricationA.step(highpassed) + this.fricGainB * this.fricationB.step(highpassed));
      } else {
        this.fricationHighpass.step(0);
        this.fricationA.step(0);
        this.fricationB.step(0);
        this.fricationNoise.next();
      }
      const mixed = this.dcBlocker.step(x + frication) * gain;
      const out = softLimit(mixed, LIMITER_KNEE);
      if (Math.abs(mixed) > LIMITER_KNEE) this.limited += 1;
      const magnitude = Math.abs(out);
      if (magnitude > this.peak) this.peak = magnitude;
      this.sumSquares += out * out;
      buffer[offset + i] = out;
      this.cursor += 1;
    }
    return total;
  }

  public currentF0(): number {
    return this.periodF0;
  }
}

export interface BlockOptions {
  readonly blockFrames?: number;
  readonly signal?: AbortSignal;
}

export function* renderBlocks(
  plan: SynthesisPlan,
  options: BlockOptions = {},
): Generator<Float32Array, RenderStats, void> {
  const renderer = new PlanRenderer(plan);
  const blockFrames = Math.max(
    64,
    Math.min(1 << 20, Math.round(options.blockFrames ?? Math.max(1024, Math.round(plan.sampleRate / 20)))),
  );
  while (!renderer.finished) {
    checkAbort(options.signal);
    const block = new Float32Array(Math.min(blockFrames, renderer.frames - renderer.position));
    renderer.fill(block);
    yield block;
  }
  return renderer.stats();
}

export function renderPcm(
  plan: SynthesisPlan,
  options: BlockOptions = {},
): { readonly pcm: Float32Array; readonly stats: RenderStats } {
  const renderer = new PlanRenderer(plan);
  const pcm = new Float32Array(plan.frames);
  let offset = 0;
  const step = Math.max(1024, Math.round(plan.sampleRate / 4));
  while (!renderer.finished) {
    checkAbort(options.signal);
    offset += renderer.fill(pcm, offset, Math.min(step, plan.frames - offset));
  }
  return { pcm, stats: renderer.stats() };
}

export function segmentAt(plan: SynthesisPlan, sample: number): PlannedSegment | undefined {
  let low = 0;
  let high = plan.segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = plan.segments[mid];
    if (segment === undefined) break;
    if (sample < segment.start) high = mid - 1;
    else if (sample >= segment.end) low = mid + 1;
    else return segment;
  }
  return undefined;
}
