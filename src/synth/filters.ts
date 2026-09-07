export class Resonator {
  private a: number = 1;
  private b: number = 0;
  private c: number = 0;
  private y1: number = 0;
  private y2: number = 0;
  private frequency: number = 0;
  private bandwidth: number = 0;

  public tune(frequency: number, bandwidth: number, sampleRate: number): void {
    if (frequency === this.frequency && bandwidth === this.bandwidth) return;
    this.frequency = frequency;
    this.bandwidth = bandwidth;
    const limited = Math.min(frequency, sampleRate * 0.47);
    const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
    this.c = -r * r;
    this.b = 2 * r * Math.cos((2 * Math.PI * limited) / sampleRate);
    this.a = 1 - this.b - this.c;
  }

  public step(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  public reset(): void {
    this.y1 = 0;
    this.y2 = 0;
  }
}

export class AntiResonator {
  private a: number = 1;
  private b: number = 0;
  private c: number = 0;
  private x1: number = 0;
  private x2: number = 0;
  private frequency: number = 0;
  private bandwidth: number = 0;

  public tune(frequency: number, bandwidth: number, sampleRate: number): void {
    if (frequency === this.frequency && bandwidth === this.bandwidth) return;
    this.frequency = frequency;
    this.bandwidth = bandwidth;
    const limited = Math.min(frequency, sampleRate * 0.47);
    const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
    const c = -r * r;
    const b = 2 * r * Math.cos((2 * Math.PI * limited) / sampleRate);
    const a = 1 - b - c;
    this.a = 1 / a;
    this.b = -b / a;
    this.c = -c / a;
  }

  public step(x: number): number {
    const y = this.a * x + this.b * this.x1 + this.c * this.x2;
    this.x2 = this.x1;
    this.x1 = x;
    return y;
  }

  public reset(): void {
    this.x1 = 0;
    this.x2 = 0;
  }
}

export class OnePole {
  private coefficient: number = 0;
  private y1: number = 0;

  public setCutoff(hz: number, sampleRate: number): void {
    this.coefficient = Math.exp((-2 * Math.PI * hz) / sampleRate);
  }

  public setTimeConstant(seconds: number, sampleRate: number): void {
    this.coefficient = seconds <= 0 ? 0 : Math.exp(-1 / (seconds * sampleRate));
  }

  public step(x: number): number {
    this.y1 = x + this.coefficient * (this.y1 - x);
    return this.y1;
  }

  public get value(): number {
    return this.y1;
  }

  public reset(value: number = 0): void {
    this.y1 = value;
  }
}

export class DcBlocker {
  private readonly r: number;
  private x1: number = 0;
  private y1: number = 0;

  public constructor(cutoffHz: number, sampleRate: number) {
    this.r = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  public step(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

export class HighPass {
  private readonly r: number;
  private x1: number = 0;
  private y1: number = 0;

  public constructor(cutoffHz: number, sampleRate: number) {
    this.r = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  public step(x: number): number {
    const y = this.r * (this.y1 + x - this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

export function smoothingCoefficient(tauSeconds: number, hopSamples: number, sampleRate: number): number {
  if (tauSeconds <= 0) return 1;
  return 1 - Math.exp(-hopSamples / (tauSeconds * sampleRate));
}

export class HalfBandDecimator {
  private readonly taps: Float64Array;
  private readonly history: Float64Array;
  private position: number = 0;

  public constructor(taps: number = 31) {
    const coefficients = new Float64Array(taps);
    const center = (taps - 1) / 2;
    let sum = 0;
    for (let index = 0; index < taps; index++) {
      const n = index - center;
      const sinc = n === 0 ? 0.5 : Math.sin((Math.PI * n) / 2) / (Math.PI * n);
      const window =
        0.42 - 0.5 * Math.cos((2 * Math.PI * index) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * index) / (taps - 1));
      coefficients[index] = sinc * window;
      sum += sinc * window;
    }
    for (let index = 0; index < taps; index++) coefficients[index] = (coefficients[index] ?? 0) / sum;
    this.taps = coefficients;
    this.history = new Float64Array(taps);
  }

  public push(sample: number): void {
    this.history[this.position] = sample;
    this.position = (this.position + 1) % this.history.length;
  }

  public output(): number {
    const length = this.history.length;
    let acc = 0;
    let index = this.position;
    for (let k = 0; k < length; k++) {
      index = index === 0 ? length - 1 : index - 1;
      acc += (this.taps[k] ?? 0) * (this.history[index] ?? 0);
    }
    return acc;
  }
}

export function dbToGain(db: number): number {
  return db <= -120 ? 0 : 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0 ? -120 : 20 * Math.log10(gain);
}

export function softLimit(x: number, knee: number = 0.85): number {
  const magnitude = Math.abs(x);
  if (magnitude <= knee) return x;
  const excess = (magnitude - knee) / (1 - knee);
  const limited = knee + (1 - knee) * Math.tanh(excess);
  return x < 0 ? -limited : limited;
}
