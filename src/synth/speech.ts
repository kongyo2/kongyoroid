import type { Diagnostic } from "../errors.ts";
import { invalid } from "../errors.ts";
import { MAX_F0_HZ, MIN_F0_HZ } from "../limits.ts";
import type { Phoneme } from "../text/mora.ts";
import { isUnvoicedVowel } from "../text/mora.ts";
import type { BoundaryKind } from "../text/notation.ts";
import { boundaryIsSentenceEnd, formatPhraseBody } from "../text/notation.ts";
import type { ReadingPlan } from "../text/reading.ts";
import { ENGINE_VERSION, PLAN_VERSION } from "../version.ts";
import type { PhoneDraft } from "./acoustics.ts";
import { compileSegments, phoneDraft } from "./acoustics.ts";
import { PHONEMES } from "./phonemes.ts";
import type { MoraMarker, PhraseMarker, PitchPoint, SynthesisPlan } from "./plan.ts";
import type { AccentCommand, BoundaryTone, FujisakiModel, PhraseCommand } from "./prosody.ts";
import { FUJISAKI_ALPHA, FUJISAKI_BETA, FUJISAKI_GAMMA, FujisakiEvaluator, applyPitchScale } from "./prosody.ts";
import type { VoiceProfile } from "./voice.ts";

export interface SpeechPlanInput {
  readonly reading: ReadingPlan;
  readonly voice: VoiceProfile;
  readonly sampleRate: number;
  readonly seed: number;
  readonly speed: number;
  readonly pitchSemitones: number;
  readonly pitchScale: number | undefined;
  readonly intonation: number;
  readonly volume: number;
  readonly prePause: number;
  readonly postPause: number;
  readonly pauseLength: number | undefined;
  readonly pauseScale: number;
  readonly upspeak: boolean;
  readonly breathiness: number;
  readonly jitter: number | undefined;
  readonly path?: string;
}

export const SPEECH_TIMING: {
  readonly mora: number;
  readonly consonantShare: number;
  readonly minVowel: number;
  readonly moraicNasal: number;
  readonly closure: number;
  readonly longVowel: number;
  readonly devoiced: number;
  readonly pausePhrase: number;
  readonly pauseComma: number;
  readonly pauseSentence: number;
  readonly pauseParagraph: number;
  readonly phraseFinalStretch: number;
  readonly sentenceFinalStretch: number;
  readonly questionStretch: number;
  readonly sentenceInitialStretch: number;
} = {
  mora: 0.108,
  consonantShare: 0.6,
  minVowel: 0.04,
  moraicNasal: 0.08,
  closure: 0.08,
  longVowel: 0.1,
  devoiced: 0.055,
  pausePhrase: 0,
  pauseComma: 0.2,
  pauseSentence: 0.38,
  pauseParagraph: 0.7,
  phraseFinalStretch: 1.12,
  sentenceFinalStretch: 1.3,
  questionStretch: 1.45,
  sentenceInitialStretch: 1.05,
};

interface Phone extends PhoneDraft {
  readonly isVowelOfMora: boolean;
  readonly moraStart: boolean;
}

export interface PauseTiming {
  readonly speed: number;
  readonly pauseLength: number | undefined;
  readonly pauseScale: number;
}

const ACCENT_LEAD_SECONDS = 0.08;

export function boundaryPauseSeconds(
  boundary: BoundaryKind,
  timing: PauseTiming,
  paragraphAfter: boolean = false,
): number {
  const speedFactor = 1 / timing.speed ** 0.7;
  let base: number;
  switch (boundary) {
    case "pause":
      base = timing.pauseLength ?? SPEECH_TIMING.pauseComma;
      break;
    case "sentence":
    case "question":
    case "exclamation":
      base =
        timing.pauseLength === undefined
          ? SPEECH_TIMING.pauseSentence
          : Math.max(timing.pauseLength, SPEECH_TIMING.pauseSentence);
      break;
    case "paragraph":
      base = SPEECH_TIMING.pauseParagraph;
      break;
    default:
      base = 0;
  }
  if (paragraphAfter && boundary !== "phrase" && boundary !== "end")
    base = Math.max(base, SPEECH_TIMING.pauseParagraph);
  return base * timing.pauseScale * speedFactor;
}

export function utteranceFinalPauseSeconds(boundary: BoundaryKind, timing: PauseTiming): number {
  return boundary === "pause" ? boundaryPauseSeconds(boundary, timing) : 0;
}

function sentenceExclamationFlags(reading: ReadingPlan): boolean[] {
  const flags: boolean[] = new Array<boolean>(reading.phrases.length).fill(false);
  let groupStart = 0;
  for (const [index, phrase] of reading.phrases.entries()) {
    if (!boundaryIsSentenceEnd(phrase.boundary) && index !== reading.phrases.length - 1) continue;
    let exclamatory = false;
    for (let k = groupStart; k <= index; k++) if (reading.phrases[k]?.exclamatory === true) exclamatory = true;
    for (let k = groupStart; k <= index; k++) flags[k] = exclamatory;
    groupStart = index + 1;
  }
  return flags;
}

export function planSpeech(input: SpeechPlanInput): SynthesisPlan {
  const path = input.path ?? "$.text";
  const { reading, voice, sampleRate } = input;
  const rate = input.speed * voice.rateScale;
  const phones: Phone[] = [];
  const warnings: Diagnostic[] = [...reading.warnings];
  const moraTimes: { start: number; end: number; phraseIndex: number; text: string; phonemes: Phoneme[] }[] = [];
  const phraseTimes: { start: number; end: number }[] = [];
  const moraOnsets: number[][] = [];
  const moraEnds: number[][] = [];
  const timing: PauseTiming = { speed: input.speed, pauseLength: input.pauseLength, pauseScale: input.pauseScale };
  const exclamatoryFlags = sentenceExclamationFlags(reading);
  const lastPhraseIndex = reading.phrases.length - 1;
  const paragraphAfter = (phraseIndex: number): boolean =>
    reading.sentences.some((sentence) => sentence.paragraphEnd && sentence.phraseEnd - 1 === phraseIndex);
  let clock = 0;
  const pushPhone = (phone: Phone): void => {
    phones.push(phone);
    clock += phone.seconds;
  };
  const rest = (seconds: number): void => {
    if (seconds <= 0) return;
    pushPhone({ ...phoneDraft("pau", seconds), isVowelOfMora: false, moraStart: false });
  };
  rest(input.prePause);
  let moraCounter = 0;
  let sentenceStart = true;
  for (const [phraseIndex, phrase] of reading.phrases.entries()) {
    const phraseStart = clock;
    const onsets: number[] = [];
    const ends: number[] = [];
    const count = phrase.moras.length;
    const sentenceEnd = boundaryIsSentenceEnd(phrase.boundary);
    const phraseEnd = phrase.boundary !== "phrase";
    for (const [moraIndex, mora] of phrase.moras.entries()) {
      const moraStartClock = clock;
      const last = moraIndex === count - 1;
      const first = moraIndex === 0;
      const isLong = mora.text === "ー";
      const devoiced = isUnvoicedVowel(mora.vowel);
      let stretch = 1;
      if (last && sentenceEnd)
        stretch *= phrase.boundary === "question" ? SPEECH_TIMING.questionStretch : SPEECH_TIMING.sentenceFinalStretch;
      else if (last && phraseEnd) stretch *= SPEECH_TIMING.phraseFinalStretch;
      if (first && sentenceStart) stretch *= SPEECH_TIMING.sentenceInitialStretch;
      if (phrase.accent === moraIndex + 1) stretch *= 1.04;
      const emphasis = exclamatoryFlags[phraseIndex] === true ? 1 : 0;
      const phonemes: Phoneme[] = [];
      let consonantSeconds = 0;
      if (mora.consonant !== null) {
        const spec = PHONEMES[mora.consonant];
        consonantSeconds = spec.duration / rate;
        phonemes.push(mora.consonant);
        pushPhone({
          ...phoneDraft(mora.consonant, consonantSeconds, {
            moraIndex: moraCounter,
            phraseIndex,
            boundaryBefore: first && (phraseIndex === 0 || sentenceStart || phones.at(-1)?.phoneme === "pau"),
            emphasis,
          }),
          isVowelOfMora: false,
          moraStart: true,
        });
      }
      let vowelSeconds: number;
      if (mora.vowel === "N") vowelSeconds = SPEECH_TIMING.moraicNasal;
      else if (mora.vowel === "cl") vowelSeconds = SPEECH_TIMING.closure;
      else if (isLong) vowelSeconds = SPEECH_TIMING.longVowel;
      else if (devoiced) vowelSeconds = SPEECH_TIMING.devoiced;
      else
        vowelSeconds = Math.max(
          SPEECH_TIMING.minVowel,
          SPEECH_TIMING.mora - SPEECH_TIMING.consonantShare * consonantSeconds * rate,
        );
      vowelSeconds = (vowelSeconds * stretch) / rate;
      const previous = phones.at(-1);
      const continuing = isLong && previous !== undefined && previous.phoneme === mora.vowel;
      phonemes.push(mora.vowel);
      pushPhone({
        ...phoneDraft(mora.vowel, vowelSeconds, {
          moraIndex: moraCounter,
          phraseIndex,
          articulation: continuing ? "continue" : "onset",
          boundaryBefore:
            mora.consonant === null && first && (phraseIndex === 0 || sentenceStart || previous?.phoneme === "pau"),
          boundaryAfter: last && phraseEnd,
          emphasis,
          gainDb: last && sentenceEnd ? -2 : 0,
          rdOffset: input.breathiness,
        }),
        isVowelOfMora: true,
        moraStart: mora.consonant === null,
      });
      onsets.push(clock - vowelSeconds);
      ends.push(clock);
      moraTimes.push({ start: moraStartClock, end: clock, phraseIndex, text: mora.text, phonemes });
      moraCounter += 1;
    }
    moraOnsets.push(onsets);
    moraEnds.push(ends);
    phraseTimes.push({ start: phraseStart, end: clock });
    rest(
      phraseIndex === lastPhraseIndex
        ? utteranceFinalPauseSeconds(phrase.boundary, timing)
        : boundaryPauseSeconds(phrase.boundary, timing, paragraphAfter(phraseIndex)),
    );
    sentenceStart = sentenceEnd;
  }
  rest(input.postPause);
  const baseHz = voice.baseF0 * 0.82 * 2 ** (input.pitchSemitones / 12);
  const intonation = input.intonation * voice.intonationScale;
  const phraseCommands: PhraseCommand[] = [];
  const accentCommands: AccentCommand[] = [];
  const tones: BoundaryTone[] = [];
  let newSentence = true;
  for (const [phraseIndex, phrase] of reading.phrases.entries()) {
    const times = phraseTimes[phraseIndex];
    const onsets = moraOnsets[phraseIndex] ?? [];
    const ends = moraEnds[phraseIndex] ?? [];
    if (times === undefined) continue;
    const exclaim = exclamatoryFlags[phraseIndex] === true ? 1.2 : 1;
    if (newSentence) {
      phraseCommands.push({ at: times.start - 0.12, amplitude: 0.28 * intonation * exclaim });
    } else {
      const previous = reading.phrases[phraseIndex - 1];
      if (previous !== undefined && previous.boundary === "pause") {
        phraseCommands.push({ at: times.start - 0.1, amplitude: 0.16 * intonation * exclaim });
      } else {
        phraseCommands.push({ at: times.start - 0.08, amplitude: 0.05 * intonation });
      }
    }
    const count = phrase.moras.length;
    const accent = Math.min(phrase.accent, count);
    const firstOnset = onsets[0] ?? times.start;
    const secondOnset = onsets[1] ?? firstOnset;
    if (count >= 1) {
      if (accent === 1) {
        accentCommands.push({
          start: firstOnset - ACCENT_LEAD_SECONDS,
          end: (ends[0] ?? times.end) - 0.03,
          amplitude: 0.44 * intonation * exclaim,
        });
      } else if (accent > 1) {
        accentCommands.push({
          start: secondOnset - ACCENT_LEAD_SECONDS,
          end: (ends[accent - 1] ?? times.end) - 0.03,
          amplitude: 0.4 * intonation * exclaim,
        });
      } else if (count >= 2) {
        accentCommands.push({
          start: secondOnset - ACCENT_LEAD_SECONDS,
          end: times.end - 0.02,
          amplitude: 0.32 * intonation * exclaim,
        });
      }
    }
    const sentenceEnd = boundaryIsSentenceEnd(phrase.boundary);
    if (sentenceEnd) {
      const lastOnset = onsets[count - 1] ?? times.start;
      if (phrase.boundary === "question" && input.upspeak) {
        tones.push({ start: lastOnset, end: times.end, amount: 0.38 * Math.max(0.4, intonation) });
      } else if (phrase.boundary !== "question") {
        tones.push({
          start: Math.max(times.start, times.end - 0.25),
          end: times.end,
          amount: -0.12 * Math.max(0.3, intonation),
        });
      }
    }
    newSentence = sentenceEnd;
  }
  const model: FujisakiModel = {
    baseHz,
    alpha: FUJISAKI_ALPHA,
    beta: FUJISAKI_BETA,
    gamma: FUJISAKI_GAMMA,
    phrases: phraseCommands,
    accents: accentCommands,
    tones,
  };
  const totalSeconds = clock;
  const step = 0.005;
  const pitch: PitchPoint[] = [];
  let f0Min = Infinity;
  let f0Max = 0;
  const evaluator = new FujisakiEvaluator(model);
  for (let t = 0; t <= totalSeconds + step; t += step) {
    const hz = applyPitchScale(evaluator.hzAt(t), input.pitchScale);
    pitch.push({ sample: Math.round(t * sampleRate), hz });
  }
  let phoneStart = 0;
  let pointIndex = 0;
  for (const phone of phones) {
    const start = phoneStart;
    const end = start + phone.seconds;
    phoneStart = end;
    if (!PHONEMES[phone.phoneme].voiced) continue;
    while (pointIndex < pitch.length && (pitch[pointIndex]?.sample ?? 0) / sampleRate < start) pointIndex += 1;
    for (let k = pointIndex; k < pitch.length; k++) {
      const point = pitch[k];
      if (point === undefined || point.sample / sampleRate > end) break;
      f0Min = Math.min(f0Min, point.hz);
      f0Max = Math.max(f0Max, point.hz);
    }
  }
  if (!Number.isFinite(f0Min)) {
    f0Min = baseHz;
    f0Max = baseHz;
  }
  if (f0Max > MAX_F0_HZ || f0Max > sampleRate * 0.2 || f0Min < MIN_F0_HZ) {
    invalid(
      input.pitchScale === undefined ? "$.pitchSemitones" : "$.pitch",
      `The speech contour reaches ${f0Max.toFixed(0)} Hz (minimum ${f0Min.toFixed(0)} Hz); the engine synthesizes ${MIN_F0_HZ}–${Math.min(MAX_F0_HZ, sampleRate * 0.2).toFixed(0)} Hz at ${sampleRate} Hz.`,
      {
        code: "PITCH_OUT_OF_RANGE",
        hint: "Lower pitchSemitones (or pitch), reduce intonation, or raise sampleRate.",
        repairOptions: [
          { action: "lower-pitch", description: "Reduce pitchSemitones or pitch.", path: "$.pitchSemitones" },
          { action: "raise-sample-rate", description: "Use a higher sampleRate such as 24000.", path: "$.sampleRate" },
        ],
      },
    );
  }
  if (f0Max > voice.f0Max || f0Min < voice.f0Min) {
    warnings.push({
      severity: "warning",
      code: "F0_OUTSIDE_VOICE_RANGE",
      message: `The contour spans ${f0Min.toFixed(0)}–${f0Max.toFixed(0)} Hz; voice ${voice.id} is tuned for ${voice.f0Min}–${voice.f0Max} Hz.`,
      help: "Choose another voice or reduce the pitch shift.",
      path,
    });
  }
  const compiled = compileSegments(phones, voice, sampleRate);
  const boundaries = compiled.boundaries;
  const sampleOf = (seconds: number): number => Math.round(seconds * sampleRate);
  const moras: MoraMarker[] = moraTimes.map((mora, index) => ({
    index,
    text: mora.text,
    start: Math.min(compiled.frames, sampleOf(mora.start)),
    end: Math.min(compiled.frames, sampleOf(mora.end)),
    phraseIndex: mora.phraseIndex,
    phonemes: mora.phonemes,
  }));
  const phrases: PhraseMarker[] = phraseTimes.map((times, index) => {
    const phrase = reading.phrases[index];
    return {
      index,
      text: phrase === undefined ? "" : phrase.moras.map((m) => m.text).join(""),
      kana: phrase === undefined ? "" : formatPhraseBody(phrase.moras, phrase.accent),
      accent: phrase?.accent ?? 0,
      start: Math.min(compiled.frames, sampleOf(times.start)),
      end: Math.min(compiled.frames, sampleOf(times.end)),
      boundary: phrase?.boundary ?? "end",
    };
  });
  void boundaries;
  return {
    planVersion: PLAN_VERSION,
    engineVersion: ENGINE_VERSION,
    kind: "speech",
    sampleRate,
    seed: input.seed,
    frames: compiled.frames,
    voice,
    volume: input.volume,
    jitter: input.jitter ?? voice.jitter,
    shimmerDb: voice.shimmerDb,
    flutter: voice.flutter,
    segments: compiled.segments,
    pitch,
    vibrato: [],
    moras,
    phrases,
    notes: [],
    reading,
    warnings,
    adjustments: [],
    f0Min,
    f0Max,
  };
}
