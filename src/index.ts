export { Kongyoroid, readingFromPlan } from "./kongyoroid.ts";
export type {
  CacheOptions,
  CompileResult,
  Diagnosis,
  DoctorOptions,
  FrontendDiagnosis,
  InspectOptions,
  InspectResult,
  KongyoroidOptions,
  PlanResult,
  Reading,
  ReadingMora,
  ReadingOptions,
  ReadingPhrase,
  RenderPlanOptions,
  SingInput,
  SpeakInput,
  ValidationResult,
  VoiceDescriptor,
  VoiceKind,
  VoicesOptions,
  VoicesResult,
  VoicevoxDiagnosis,
  VoicevoxOptions,
} from "./kongyoroid.ts";
export { ERROR_CODES, EXIT_CODES, KongyoroidError, asKongyoroidError, exitCodeOf, formatDiagnostic } from "./errors.ts";
export type {
  Diagnostic,
  DiagnosticSeverity,
  ErrorCode,
  ErrorData,
  RepairAction,
  RepairOption,
  SourceSpan,
} from "./errors.ts";
export {
  parseEngine,
  parseJson,
  parseRequest,
  parseSongRequest,
  parseSpeechRequest,
  parseStyleRef,
  requestHash,
  songRequest,
  speechRequest,
} from "./request.ts";
export {
  BATCH_JOB_SCHEMA,
  CAPABILITIES,
  DICTIONARY_ENTRY_SCHEMA,
  DICTIONARY_SCHEMA,
  MML_SCORE_SCHEMA,
  NOTE_SCHEMA,
  REQUEST_SCHEMA,
  SCORE_TEXT_SCHEMA,
} from "./schema.ts";
export type { JsonSchema } from "./schema.ts";
export { DEFAULT_SAMPLE_RATE, LIMITS, MAX_F0_HZ, MIN_F0_HZ, SAMPLE_RATE_RANGE } from "./limits.ts";
export { ENGINE_VERSION, FRONTEND_VERSION, PACKAGE_NAME, PLAN_VERSION, SCHEMA_VERSION, VERSION } from "./version.ts";
export type {
  AudioInfo,
  EngineId,
  EngineSelector,
  OperationOptions,
  RenderRequest,
  RenderResult,
  RenderStyles,
  RenderTimings,
  ResolvedRequest,
  ResolvedSong,
  ResolvedSpeech,
  SongRequest,
  SongVibratoRequest,
  SpeechRequest,
  SplitMode,
  StyleRef,
  StyleSelection,
  StyleType,
  VoiceStyle,
} from "./types.ts";
export {
  MORA_TABLE,
  countMoras,
  isKanaOnly,
  isLongVowelMark,
  kanaToMoras,
  kanaToUnits,
  lookupMora,
  toHiragana,
  toKatakana,
  vowelToKana,
} from "./text/mora.ts";
export type { Consonant, KanaUnit, MoraPhonemes, MoraUnit, Phoneme, UnvoicedVowel, Vowel } from "./text/mora.ts";
export { formatKanaNotation, parseKanaNotation, parsePhraseBody } from "./text/notation.ts";
export type { AccentPhrase, BoundaryKind, NotationMora } from "./text/notation.ts";
export { normalizeForReading } from "./text/normalize.ts";
export type { NormalizedText, Substitution } from "./text/normalize.ts";
export { splitSentences } from "./text/sentences.ts";
export type { SentencePiece } from "./text/sentences.ts";
export {
  applyDevoicingRules,
  frontendState,
  loadFrontend,
  readJapanese,
  readKanaHeuristically,
  readKanaNotation,
} from "./text/frontend.ts";
export type { ReadOptions, TextFrontend } from "./text/frontend.ts";
export type { AccentSource, DictionaryHit, FrontendKind, ReadingPlan, SentenceReading } from "./text/reading.ts";
export {
  LocalDictionary,
  dictionaryFromJson,
  parseDictionaryEntries,
  parseDictionaryEntry,
} from "./text/dictionary.ts";
export type { DictionaryEntry, DictionaryEntryInput, DictionaryMatch } from "./text/dictionary.ts";
export { BUILTIN_LEXICON, lookupLexicon } from "./text/lexicon.ts";
export { splitText } from "./text/split.ts";
export { A4_HZ, midiToHz, midiToNoteName, noteToMidi } from "./song/pitch.ts";
export {
  DEFAULT_FRAME_RATE,
  MAX_BEATS,
  MAX_LYRIC_MORAS,
  MAX_NOTES,
  MIN_BEATS,
  alignLyrics,
  engineScoreFrames,
  notesToEngineScore,
  parseMmlScore,
  parseNoteInput,
  parseNotes,
  parseScoreText,
  resolveNotes,
  scoreSeconds,
} from "./song/score.ts";
export type {
  Continuation,
  EngineNote,
  EngineScore,
  LyricAlignment,
  MmlScore,
  Note,
  NoteArticulation,
  NoteInput,
  NoteVibrato,
  ParsedNotes,
  ScoreText,
} from "./song/score.ts";
export { parseMml } from "./song/mml.ts";
export type { MmlNote, MmlResult } from "./song/mml.ts";
export {
  concatWav,
  decodeWav,
  encodePcm16,
  encodeWav,
  inspectWav,
  pcm16Samples,
  silenceWav,
  wavHeader,
} from "./wav.ts";
export type { WavLayout } from "./wav.ts";
export {
  compileRequest,
  compileSongPlan,
  compileSpeechPlan,
  planHash,
  readForRequest,
  summarizePlan,
} from "./synth/engine.ts";
export type { CompileOptions, CompiledPlan, PlanDetail, PlanSummary } from "./synth/engine.ts";
export { planSpeech, SPEECH_TIMING } from "./synth/speech.ts";
export type { SpeechPlanInput } from "./synth/speech.ts";
export { planSong, SONG_LEVEL_OFFSET_DB } from "./synth/song.ts";
export type { SongPlanInput, SongVibratoSettings } from "./synth/song.ts";
export { PlanRenderer, renderBlocks, renderPcm, segmentAt } from "./synth/renderer.ts";
export type { BlockOptions, RenderStats } from "./synth/renderer.ts";
export { encodePlanAsync, encodePlanSync, renderInto, renderPcmStream, streamingWavHeader } from "./synth/stream.ts";
export type { AudioSink, PcmBlock, StreamOptions } from "./synth/stream.ts";
export { synthesizeTextStream, takeSentences } from "./synth/textstream.ts";
export type { TextStreamEvent, TextStreamOptions } from "./synth/textstream.ts";
export type {
  Adjustment,
  Articulation,
  Keyframe,
  MoraMarker,
  NoteMarker,
  PhraseMarker,
  PitchPoint,
  PlannedSegment,
  SynthesisPlan,
  VibratoRegion,
} from "./synth/plan.ts";
export { PARAM_NAMES, interpolatePitchLog, keyframeToObject } from "./synth/plan.ts";
export { compileSegments, phoneDraft } from "./synth/acoustics.ts";
export type { PhoneDraft } from "./synth/acoustics.ts";
export { PHONEMES, isVoicedSustain, isVowelPhoneme } from "./synth/phonemes.ts";
export type { PhonemeKind, PhonemeSpec } from "./synth/phonemes.ts";
export { BUILTIN_VOICES, DEFAULT_VOICE_ID, describeVoice, resolveVoice, voiceProfileHash } from "./synth/voice.ts";
export type { SingingDefaults, VoiceProfile } from "./synth/voice.ts";
export { lfDerivative, lfShapeFor, solveLfShape } from "./synth/glottal.ts";
export type { LfShape } from "./synth/glottal.ts";
export { FujisakiEvaluator, evaluateFujisakiHz, evaluateFujisakiLog } from "./synth/prosody.ts";
export type { FujisakiModel } from "./synth/prosody.ts";
export { bandEnergyRatio, centsBetween, estimatePitch, signalStats, spectralCentroid } from "./synth/analysis.ts";
export type { PitchEstimate, SignalStats } from "./synth/analysis.ts";
export { DiskCache, LayeredCache, MemoryCache, cacheKey } from "./cache.ts";
export type { CacheStats, DiskCacheOptions, RenderCache } from "./cache.ts";
export { Semaphore, mapConcurrent } from "./concurrency.ts";
export { playWav, playerCandidates } from "./player.ts";
export type { PlayerCommand } from "./player.ts";
export { ensureReadableFile, readChunks, readLines, readText, writeAudio, writeAudioIdempotent } from "./io.ts";
export type { WriteAudioResult } from "./io.ts";
export { DEFAULT_ENDPOINT, VoicevoxClient } from "./voicevox/client.ts";
export type { DictionaryWordInput, VoicevoxClientOptions } from "./voicevox/client.ts";
export { StyleCatalog, describeStyle } from "./voicevox/styles.ts";
export type { StylePurpose } from "./voicevox/styles.ts";
export { Dictionary, WORD_TYPES, validateWord } from "./voicevox/dictionary.ts";
export type { DictionaryWordDraft } from "./voicevox/dictionary.ts";
export {
  accentPhrasesToKana,
  applySpeechSettings,
  querySeconds,
  semitonesToPitchScale,
  synthesizeSpeech,
} from "./voicevox/speech.ts";
export type { SpeechOptions, SpeechSynthesis } from "./voicevox/speech.ts";
export { applyVibrato, synthesizeSong } from "./voicevox/song.ts";
export type { SongSynthesis } from "./voicevox/song.ts";
export type {
  AudioQuery,
  DictionaryWord,
  EngineAccentPhrase,
  EngineManifest,
  EngineMora,
  FrameAudioQuery,
  FramePhoneme,
  SupportedDevices,
  WordType,
} from "./voicevox/api.ts";
