export interface PhraseCommand {
  readonly at: number;
  readonly amplitude: number;
}

export interface AccentCommand {
  readonly start: number;
  readonly end: number;
  readonly amplitude: number;
}

export interface BoundaryTone {
  readonly start: number;
  readonly end: number;
  readonly amount: number;
}

export interface FujisakiModel {
  readonly baseHz: number;
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
  readonly phrases: readonly PhraseCommand[];
  readonly accents: readonly AccentCommand[];
  readonly tones: readonly BoundaryTone[];
}

export const FUJISAKI_ALPHA: number = 3;
export const FUJISAKI_BETA: number = 20;
export const FUJISAKI_GAMMA: number = 0.9;

function phraseResponse(alpha: number, t: number): number {
  if (t <= 0) return 0;
  return alpha * alpha * t * Math.exp(-alpha * t);
}

function accentStep(beta: number, gamma: number, t: number): number {
  if (t <= 0) return 0;
  return Math.min(gamma, 1 - (1 + beta * t) * Math.exp(-beta * t));
}

export function evaluateFujisakiLog(model: FujisakiModel, t: number): number {
  let value = 0;
  for (const phrase of model.phrases) {
    const dt = t - phrase.at;
    if (dt <= 0 || dt > 4) continue;
    value += phrase.amplitude * phraseResponse(model.alpha, dt);
  }
  for (const accent of model.accents) {
    if (t - accent.start <= 0 || t - accent.end > 1) continue;
    value +=
      accent.amplitude *
      (accentStep(model.beta, model.gamma, t - accent.start) - accentStep(model.beta, model.gamma, t - accent.end));
  }
  for (const tone of model.tones) {
    if (t <= tone.start) continue;
    const span = tone.end - tone.start;
    const progress = span <= 0 ? 1 : Math.min(1, (t - tone.start) / span);
    value += tone.amount * progress * (t <= tone.end + 0.05 ? 1 : Math.max(0, 1 - (t - tone.end - 0.05) / 0.15));
  }
  return value;
}

export function evaluateFujisakiHz(model: FujisakiModel, t: number): number {
  return model.baseHz * Math.exp(evaluateFujisakiLog(model, t));
}

const PHRASE_WINDOW_SECONDS = 4;
const ACCENT_TAIL_SECONDS = 1;
const TONE_TAIL_SECONDS = 0.2;

function firstIndexAbove<T>(items: readonly T[], timeOf: (item: T) => number, threshold: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const item = items[mid];
    if (item !== undefined && timeOf(item) <= threshold) low = mid + 1;
    else high = mid;
  }
  return low;
}

export class FujisakiEvaluator {
  private readonly model: FujisakiModel;
  private readonly maxAccentSeconds: number;
  private readonly maxToneSeconds: number;

  public constructor(model: FujisakiModel) {
    this.model = {
      ...model,
      phrases: [...model.phrases].sort((a, b) => a.at - b.at),
      accents: [...model.accents].sort((a, b) => a.start - b.start),
      tones: [...model.tones].sort((a, b) => a.start - b.start),
    };
    let accentSpan = 0;
    for (const accent of this.model.accents) accentSpan = Math.max(accentSpan, accent.end - accent.start);
    let toneSpan = 0;
    for (const tone of this.model.tones) toneSpan = Math.max(toneSpan, tone.end - tone.start);
    this.maxAccentSeconds = accentSpan;
    this.maxToneSeconds = toneSpan;
  }

  public logAt(t: number): number {
    const model = this.model;
    let value = 0;
    const phrases = model.phrases;
    for (let i = firstIndexAbove(phrases, (p) => p.at, t - PHRASE_WINDOW_SECONDS); i < phrases.length; i++) {
      const phrase = phrases[i];
      if (phrase === undefined || phrase.at >= t) break;
      value += phrase.amplitude * phraseResponse(model.alpha, t - phrase.at);
    }
    const accents = model.accents;
    const accentFrom = firstIndexAbove(accents, (a) => a.start, t - this.maxAccentSeconds - ACCENT_TAIL_SECONDS);
    for (let i = accentFrom; i < accents.length; i++) {
      const accent = accents[i];
      if (accent === undefined || accent.start >= t) break;
      if (t - accent.end > ACCENT_TAIL_SECONDS) continue;
      value +=
        accent.amplitude *
        (accentStep(model.beta, model.gamma, t - accent.start) - accentStep(model.beta, model.gamma, t - accent.end));
    }
    const tones = model.tones;
    const toneFrom = firstIndexAbove(tones, (tone) => tone.start, t - this.maxToneSeconds - TONE_TAIL_SECONDS);
    for (let i = toneFrom; i < tones.length; i++) {
      const tone = tones[i];
      if (tone === undefined || tone.start >= t) break;
      const span = tone.end - tone.start;
      const progress = span <= 0 ? 1 : Math.min(1, (t - tone.start) / span);
      value += tone.amount * progress * (t <= tone.end + 0.05 ? 1 : Math.max(0, 1 - (t - tone.end - 0.05) / 0.15));
    }
    return value;
  }

  public hzAt(t: number): number {
    return this.model.baseHz * Math.exp(this.logAt(t));
  }
}

export function applyPitchScale(hz: number, pitchScale: number | undefined): number {
  if (pitchScale === undefined || pitchScale === 0) return hz;
  return Math.exp(Math.log(hz) * 2 ** pitchScale);
}
