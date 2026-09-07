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

export function applyPitchScale(hz: number, pitchScale: number | undefined): number {
  if (pitchScale === undefined || pitchScale === 0) return hz;
  return Math.exp(Math.log(hz) * 2 ** pitchScale);
}
