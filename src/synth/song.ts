import type { Diagnostic } from "../errors.ts";
import { invalid } from "../errors.ts";
import { MAX_F0_HZ, MIN_F0_HZ } from "../limits.ts";
import { midiToHz } from "../song/pitch.ts";
import type { Note, NoteVibrato } from "../song/score.ts";
import type { Phoneme, Vowel } from "../text/mora.ts";
import { ENGINE_VERSION, PLAN_VERSION } from "../version.ts";
import type { PhoneDraft } from "./acoustics.ts";
import { compileSegments, phoneDraft } from "./acoustics.ts";
import { PHONEMES } from "./phonemes.ts";
import type {
  Adjustment,
  Articulation,
  MoraMarker,
  NoteMarker,
  PitchPoint,
  SynthesisPlan,
  VibratoRegion,
} from "./plan.ts";
import type { VoiceProfile } from "./voice.ts";

export interface SongVibratoSettings {
  readonly depthCents: number;
  readonly rateHz: number;
  readonly delaySeconds: number;
  readonly fadeSeconds: number;
}

export interface SongPlanInput {
  readonly notes: readonly Note[];
  readonly tempo: number;
  readonly voice: VoiceProfile;
  readonly sampleRate: number;
  readonly seed: number;
  readonly volume: number;
  readonly leadIn: number;
  readonly leadOut: number;
  readonly vibrato: SongVibratoSettings;
  readonly portamentoSeconds: number;
  readonly scoopCents: number;
  readonly scoopSeconds: number;
  readonly breathiness: number;
  readonly jitter: number | undefined;
  readonly allowConsonantCompression: boolean;
  readonly path?: string;
}

const MIN_VOWEL_SECONDS = 0.03;
const MAX_BORROW_FRACTION = 0.4;
const MAX_CONSONANT_COMPRESSION = 0.45;
export const SONG_LEVEL_OFFSET_DB: number = -4;

interface Placed {
  readonly note: Note;
  readonly start: number;
  readonly end: number;
  readonly vowelStart: number;
  readonly sustainId: number | null;
  readonly articulation: Articulation;
}

function consonantSeconds(phoneme: Phoneme): number {
  return PHONEMES[phoneme].duration;
}

export function planSong(input: SongPlanInput): SynthesisPlan {
  const path = input.path ?? "$.notes";
  const { notes, voice, sampleRate } = input;
  const secondsPerBeat = 60 / input.tempo;
  const warnings: Diagnostic[] = [];
  const adjustments: Adjustment[] = [];
  const phones: PhoneDraft[] = [];
  const placed: Placed[] = [];
  const moraMarkers: MoraMarker[] = [];
  const noteStart: number[] = [];
  let clock = notes[0]?.key === null ? 0 : input.leadIn;
  for (const note of notes) {
    noteStart.push(clock);
    clock += note.beats * secondsPerBeat;
  }
  const totalSeconds = clock + (notes.at(-1)?.key === null ? 0 : input.leadOut);
  const push = (phone: PhoneDraft): void => {
    phones.push(phone);
  };
  let cursor = 0;
  let sustainCounter = 0;
  let currentSustain: number | null = null;
  let lastVoicedVowel: Vowel | null = null;
  let previousPitched: Placed | null = null;
  let moraCounter = 0;
  const leadConsonant = (index: number): { readonly seconds: number; readonly phonemes: readonly Phoneme[] } => {
    const note = notes[index];
    if (note === undefined || note.key === null || note.continuation !== "none") return { seconds: 0, phonemes: [] };
    const first = note.moras[0];
    if (first === undefined || first.consonant === null) return { seconds: 0, phonemes: [] };
    return { seconds: consonantSeconds(first.consonant), phonemes: [first.consonant] };
  };
  for (const [index, note] of notes.entries()) {
    const start = noteStart[index] ?? 0;
    const end = start + note.beats * secondsPerBeat;
    const nextLead = leadConsonant(index + 1);
    const nextNote = notes[index + 1];
    if (note.key === null) {
      const borrow = Math.min(nextLead.seconds, Math.max(0, end - cursor - 0.01));
      const restEnd = end - borrow;
      if (restEnd > cursor) push(phoneDraft("pau", restEnd - cursor, { noteId: note.id }));
      cursor = Math.max(cursor, restEnd);
      currentSustain = null;
      lastVoicedVowel = null;
      previousPitched = null;
      continue;
    }
    const velocityGain = note.gainDb + SONG_LEVEL_OFFSET_DB;
    const rdOffset = input.breathiness - Math.max(-0.5, Math.min(0.5, (note.velocity - 100) / 100));
    const isContinuation = note.continuation !== "none";
    const ownLead = leadConsonant(index);
    const borrowedForNext = Math.min(nextLead.seconds, (end - start) * MAX_BORROW_FRACTION);
    let vowelEnd =
      nextNote !== undefined && nextNote.key !== null && !isContinuationNote(nextNote) ? end - borrowedForNext : end;
    if (nextNote !== undefined && nextNote.key === null) vowelEnd = end;
    if (isContinuation) {
      const previous = placed.at(-1);
      const articulation: Articulation = "continue";
      const vowel: Vowel = note.moras[0]?.vowel ?? lastVoicedVowel ?? "a";
      const seconds = vowelEnd - cursor;
      if (seconds <= 0)
        invalid(`${path}[${index}].beats`, `Note ${note.id} has no time left after consonant borrowing.`, {
          code: "NOTE_TOO_SHORT",
        });
      push(
        phoneDraft(vowel, seconds, {
          noteId: note.id,
          moraIndex: moraCounter,
          sustainId: currentSustain,
          articulation,
          gainDb: velocityGain,
          rdOffset,
          sustain: nextNote !== undefined && nextNote.key !== null && isContinuationNote(nextNote),
          boundaryAfter: nextNote === undefined || nextNote.key === null,
        }),
      );
      moraMarkers.push({
        index: moraCounter,
        text: note.moraTexts[0] ?? "ー",
        start: cursor,
        end: vowelEnd,
        phraseIndex: 0,
        phonemes: [vowel],
      });
      moraCounter += 1;
      placed.push({ note, start: cursor, end: vowelEnd, vowelStart: cursor, sustainId: currentSustain, articulation });
      cursor = vowelEnd;
      lastVoicedVowel = vowel;
      previousPitched = placed.at(-1) ?? previous ?? null;
      continue;
    }
    const moraCount = note.moras.length;
    let consonantTotal = 0;
    for (const [moraIndex, mora] of note.moras.entries()) {
      if (mora.consonant !== null && moraIndex > 0) consonantTotal += consonantSeconds(mora.consonant);
    }
    const firstConsonant = ownLead.seconds;
    const leadAvailable = Math.max(0, start - cursor);
    const noteTime = vowelEnd - Math.max(start, cursor);
    const maxInNote = noteTime - MIN_VOWEL_SECONDS * moraCount - consonantTotal;
    let firstConsonantSeconds = firstConsonant;
    let consonantFromOwn = 0;
    if (maxInNote < -1e-9) {
      invalid(
        `${path}[${index}].beats`,
        `Note ${note.id} (${note.lyric}) leaves only ${Math.round(Math.max(0, noteTime - consonantTotal) * 1000)} ms for ${moraCount} vowel(s); at least ${Math.round(MIN_VOWEL_SECONDS * moraCount * 1000)} ms are needed.`,
        {
          code: "NOTE_TOO_SHORT",
          hint: "Give the note more beats, lower the tempo, or use fewer moras in the lyric.",
          detail: {
            availableMs: Math.round(Math.max(0, noteTime - consonantTotal) * 1000),
            requiredMs: Math.round(MIN_VOWEL_SECONDS * moraCount * 1000),
            noteId: note.id,
          },
          repairOptions: [
            {
              action: "increase-duration",
              description: "Give the note more beats or lower the tempo.",
              path: `${path}[${index}].beats`,
            },
            {
              action: "use-vowel-continuation",
              description: "Move some moras to neighbouring notes or hold the previous vowel.",
              path: `${path}[${index}].lyric`,
            },
          ],
        },
      );
    }
    if (firstConsonant > 0) {
      const inNote = firstConsonant - leadAvailable > 1e-6 ? firstConsonant - leadAvailable : 0;
      if (inNote <= maxInNote + 1e-9) {
        consonantFromOwn = inNote;
        if (inNote > 0) {
          adjustments.push({
            code: "CONSONANT_TAKEN_FROM_NOTE",
            message: `Note ${note.id}: ${Math.round(inNote * 1000)} ms of its consonant fall inside the note because nothing precedes it.`,
            noteId: note.id,
            path: `${path}[${index}]`,
            before: firstConsonant,
            after: firstConsonant,
          });
        }
      } else if (input.allowConsonantCompression) {
        consonantFromOwn = Math.max(0, maxInNote);
        firstConsonantSeconds = leadAvailable + consonantFromOwn;
        adjustments.push({
          code: "CONSONANT_COMPRESSED",
          message: `Note ${note.id}: consonant shortened from ${Math.round(firstConsonant * 1000)} ms to ${Math.round(firstConsonantSeconds * 1000)} ms.`,
          noteId: note.id,
          path: `${path}[${index}]`,
          before: firstConsonant,
          after: firstConsonantSeconds,
        });
        if (firstConsonantSeconds < firstConsonant * MAX_CONSONANT_COMPRESSION) {
          warnings.push({
            severity: "warning",
            code: "CONSONANT_HEAVILY_COMPRESSED",
            message: `Note ${note.id}: the consonant kept only ${Math.round((firstConsonantSeconds / firstConsonant) * 100)}% of its length; it may be hard to hear.`,
            help: "Lengthen the note or the preceding rest.",
            path: `${path}[${index}]`,
          });
        }
      } else {
        invalid(
          `${path}[${index}].beats`,
          `Note ${note.id} (${note.lyric}) is too short for its consonant: ${Math.round((leadAvailable + Math.max(0, maxInNote)) * 1000)} ms available, ${Math.round(firstConsonant * 1000)} ms needed.`,
          {
            code: "NOTE_TOO_SHORT",
            hint: "Give the note more beats, lower the tempo, allow consonant compression, or hold the previous vowel instead.",
            detail: {
              availableMs: Math.round((leadAvailable + Math.max(0, maxInNote)) * 1000),
              requiredMs: Math.round(firstConsonant * 1000),
              noteId: note.id,
            },
            repairOptions: [
              {
                action: "increase-duration",
                description: "Give the note more beats or lower the tempo.",
                path: `${path}[${index}].beats`,
              },
              {
                action: "allow-consonant-compression",
                description: "Set consonantCompression to true to shorten consonants automatically.",
                path: "$.consonantCompression",
              },
              {
                action: "use-vowel-continuation",
                description: "Replace the lyric with a tie or melisma of the previous vowel.",
                path: `${path}[${index}]`,
              },
            ],
          },
        );
      }
    }
    const previousBoundary = previousPitched === null;
    const consonantStart = Math.max(cursor, start - Math.max(0, firstConsonantSeconds - consonantFromOwn));
    if (consonantStart > cursor) push(phoneDraft("pau", consonantStart - cursor, { noteId: note.id }));
    cursor = consonantStart;
    const vowelBudget = vowelEnd - cursor - firstConsonantSeconds - consonantTotal;
    if (vowelBudget < MIN_VOWEL_SECONDS * moraCount - 1e-9) {
      invalid(
        `${path}[${index}].beats`,
        `Note ${note.id} (${note.lyric}) leaves only ${Math.round(Math.max(0, vowelBudget) * 1000)} ms for ${moraCount} vowel(s).`,
        {
          code: "NOTE_TOO_SHORT",
          hint: "Give the note more beats, lower the tempo, or use fewer moras in the lyric.",
          detail: {
            availableMs: Math.round(Math.max(0, vowelBudget) * 1000),
            requiredMs: Math.round(MIN_VOWEL_SECONDS * moraCount * 1000),
            noteId: note.id,
          },
          repairOptions: [
            {
              action: "increase-duration",
              description: "Give the note more beats or lower the tempo.",
              path: `${path}[${index}].beats`,
            },
            {
              action: "use-vowel-continuation",
              description: "Move some moras to neighbouring notes.",
              path: `${path}[${index}].lyric`,
            },
          ],
        },
      );
    }
    const perMora = vowelBudget / moraCount;
    const noteVowelStartHolder = { value: 0 };
    const sameVowelRepeat =
      previousPitched !== null &&
      ownLead.seconds === 0 &&
      lastVoicedVowel === note.moras[0]?.vowel &&
      previousPitched.end >= cursor - 1e-9;
    for (const [moraIndex, mora] of note.moras.entries()) {
      const moraStart = cursor;
      const consonant = mora.consonant;
      if (consonant !== null) {
        const seconds = moraIndex === 0 ? firstConsonantSeconds : consonantSeconds(consonant);
        push(
          phoneDraft(consonant, seconds, {
            noteId: note.id,
            moraIndex: moraCounter,
            gainDb: velocityGain,
            rdOffset,
            boundaryBefore: moraIndex === 0 && previousBoundary,
          }),
        );
        cursor += seconds;
      }
      const vowelSeconds = perMora;
      let articulation: Articulation = "onset";
      if (moraIndex === 0 && consonant === null && sameVowelRepeat) {
        articulation = note.articulation === "legato" ? "continue" : "rearticulate";
      }
      if (articulation !== "continue") {
        sustainCounter += 1;
        currentSustain = sustainCounter;
      }
      const isLastMora = moraIndex === moraCount - 1;
      const nextIsContinuation = nextNote !== undefined && nextNote.key !== null && isContinuationNote(nextNote);
      push(
        phoneDraft(mora.vowel, vowelSeconds, {
          noteId: note.id,
          moraIndex: moraCounter,
          sustainId: mora.vowel === "N" || mora.vowel === "cl" ? null : currentSustain,
          articulation,
          gainDb: velocityGain,
          rdOffset,
          boundaryBefore: moraIndex === 0 && consonant === null && previousBoundary,
          boundaryAfter: isLastMora && (nextNote === undefined || nextNote.key === null),
          sustain: isLastMora && nextIsContinuation,
        }),
      );
      if (moraIndex === 0) noteVowelStartHolder.value = cursor;
      cursor += vowelSeconds;
      moraMarkers.push({
        index: moraCounter,
        text: note.moraTexts[moraIndex] ?? "",
        start: moraStart,
        end: cursor,
        phraseIndex: 0,
        phonemes: consonant === null ? [mora.vowel] : [consonant, mora.vowel],
      });
      moraCounter += 1;
      lastVoicedVowel = mora.vowel === "N" || mora.vowel === "cl" ? null : mora.vowel;
    }
    const record: Placed = {
      note,
      start: consonantStart,
      end: cursor,
      vowelStart: noteVowelStartHolder.value,
      sustainId: currentSustain,
      articulation: sameVowelRepeat && note.articulation !== "legato" ? "rearticulate" : "onset",
    };
    placed.push(record);
    previousPitched = record;
  }
  if (totalSeconds > cursor) push(phoneDraft("pau", totalSeconds - cursor));
  const pitch: PitchPoint[] = [];
  const addPoint = (seconds: number, hz: number): void => {
    const sample = Math.round(seconds * sampleRate);
    const last = pitch.at(-1);
    pitch.push({ sample: last === undefined ? Math.max(0, sample) : Math.max(sample, last.sample), hz });
  };
  let previousHz: number | null = null;
  let previousEnd = 0;
  for (const [index, entry] of placed.entries()) {
    const hz = midiToHz(entry.note.key ?? 69);
    const portamento = entry.note.portamentoSeconds ?? input.portamentoSeconds;
    const previous = placed[index - 1];
    const legato = previous !== undefined && previousHz !== null && previous.end >= entry.start - 1e-6;
    if (previousHz === null || !legato) {
      if (previousHz !== null) addPoint(previousEnd, previousHz);
      if (input.scoopCents > 0 && input.scoopSeconds > 0) {
        addPoint(entry.start, hz * 2 ** (-input.scoopCents / 1200));
        addPoint(entry.vowelStart, hz * 2 ** (-input.scoopCents / 1200));
        addPoint(entry.vowelStart + input.scoopSeconds, hz);
      } else {
        addPoint(entry.start, hz);
      }
    } else {
      const window = Math.min(portamento, Math.max(0, entry.vowelStart - previous.vowelStart - 0.01));
      const transitionEnd = entry.vowelStart;
      const transitionStart = transitionEnd - window;
      addPoint(transitionStart, previousHz);
      addPoint(transitionEnd, hz);
    }
    previousHz = hz;
    previousEnd = entry.end;
  }
  if (previousHz !== null) addPoint(previousEnd, previousHz);
  if (pitch.length === 0) pitch.push({ sample: 0, hz: voice.baseF0 });
  const vibrato: VibratoRegion[] = [];
  const sustains = new Map<number, { start: number; end: number; settings: SongVibratoSettings }>();
  for (const entry of placed) {
    if (entry.sustainId === null) continue;
    const override = entry.note.vibrato;
    const settings = mergeVibrato(input.vibrato, override);
    const existing = sustains.get(entry.sustainId);
    if (existing === undefined) sustains.set(entry.sustainId, { start: entry.vowelStart, end: entry.end, settings });
    else existing.end = entry.end;
  }
  for (const sustain of [...sustains.values()].sort((a, b) => a.start - b.start)) {
    if (sustain.settings.depthCents <= 0) continue;
    vibrato.push({
      start: Math.round(sustain.start * sampleRate),
      end: Math.round(sustain.end * sampleRate),
      delaySeconds: sustain.settings.delaySeconds,
      fadeSeconds: sustain.settings.fadeSeconds,
      depthCents: sustain.settings.depthCents,
      rateHz: sustain.settings.rateHz,
    });
  }
  let f0Min = Infinity;
  let f0Max = 0;
  for (const point of pitch) {
    f0Min = Math.min(f0Min, point.hz);
    f0Max = Math.max(f0Max, point.hz);
  }
  const vibratoMax = f0Max * 2 ** (input.vibrato.depthCents / 1200);
  if (vibratoMax > MAX_F0_HZ || vibratoMax > sampleRate * 0.2 || f0Min < MIN_F0_HZ) {
    invalid(
      path,
      `The score spans ${f0Min.toFixed(1)}–${vibratoMax.toFixed(1)} Hz; the engine synthesizes ${MIN_F0_HZ}–${Math.min(MAX_F0_HZ, sampleRate * 0.2).toFixed(0)} Hz at ${sampleRate} Hz.`,
      {
        code: "PITCH_OUT_OF_RANGE",
        hint: "Transpose the score down, remove extreme keys, or raise sampleRate.",
        repairOptions: [
          { action: "lower-pitch", description: "Lower transpose or the highest keys.", path: "$.transpose" },
          { action: "raise-sample-rate", description: "Use sampleRate 24000 or higher.", path: "$.sampleRate" },
        ],
      },
    );
  }
  if (f0Max > voice.f0Max || f0Min < voice.f0Min) {
    warnings.push({
      severity: "warning",
      code: "F0_OUTSIDE_VOICE_RANGE",
      message: `The score spans ${f0Min.toFixed(0)}–${f0Max.toFixed(0)} Hz; voice ${voice.id} is tuned for ${voice.f0Min}–${voice.f0Max} Hz.`,
      help: "Transpose the score or choose a voice with a matching range.",
      path,
    });
  }
  const compiled = compileSegments(phones, voice, sampleRate);
  const sampleOf = (seconds: number): number => Math.min(compiled.frames, Math.round(seconds * sampleRate));
  const noteMarkers: NoteMarker[] = notes.map((note, index) => {
    const entry = placed.find((p) => p.note.id === note.id);
    const start = noteStart[index] ?? 0;
    return {
      id: note.id,
      index,
      key: note.key,
      hz: note.key === null ? null : midiToHz(note.key),
      lyric: note.key === null ? "" : note.continuation === "none" ? note.lyric : "ー",
      start: sampleOf(entry?.start ?? start),
      end: sampleOf(entry?.end ?? start + note.beats * secondsPerBeat),
      vowelStart: entry === undefined ? null : sampleOf(entry.vowelStart),
      sustainId: entry?.sustainId ?? null,
      continuation: note.continuation,
      articulation: entry?.articulation ?? "onset",
    };
  });
  return {
    planVersion: PLAN_VERSION,
    engineVersion: ENGINE_VERSION,
    kind: "song",
    sampleRate,
    seed: input.seed,
    frames: compiled.frames,
    voice,
    volume: input.volume,
    jitter: input.jitter ?? voice.singing.jitter,
    shimmerDb: voice.singing.shimmerDb,
    flutter: 0.08,
    segments: compiled.segments,
    pitch,
    vibrato,
    moras: moraMarkers.map((marker) => ({ ...marker, start: sampleOf(marker.start), end: sampleOf(marker.end) })),
    phrases: [],
    notes: noteMarkers,
    reading: null,
    warnings,
    adjustments,
    f0Min,
    f0Max,
  };
}

function isContinuationNote(note: Note): boolean {
  return note.continuation !== "none";
}

function mergeVibrato(base: SongVibratoSettings, override: NoteVibrato | false | undefined): SongVibratoSettings {
  if (override === false) return { ...base, depthCents: 0 };
  if (override === undefined) return base;
  return {
    depthCents: override.depthCents ?? base.depthCents,
    rateHz: override.rateHz ?? base.rateHz,
    delaySeconds: override.delayMs === undefined ? base.delaySeconds : override.delayMs / 1000,
    fadeSeconds: override.fadeMs === undefined ? base.fadeSeconds : override.fadeMs / 1000,
  };
}
