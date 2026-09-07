import { invalid } from "../errors.ts";
import { kanaToMoras, toKatakana } from "../text/mora.ts";
import type { OperationOptions } from "../types.ts";
import { integer, literal, string } from "../validate.ts";
import type { DictionaryWord, WordType } from "./api.ts";
import type { DictionaryWordInput, VoicevoxClient } from "./client.ts";

export const WORD_TYPES: readonly WordType[] = ["PROPER_NOUN", "COMMON_NOUN", "VERB", "ADJECTIVE", "SUFFIX"];

export interface DictionaryWordDraft {
  readonly surface: string;
  readonly pronunciation: string;
  readonly accentType: number;
  readonly wordType?: string;
  readonly priority?: number;
}

export function validateWord(draft: DictionaryWordDraft, path: string = "$"): DictionaryWordInput {
  const surface = string(draft.surface, `${path}.surface`, 1, 200).trim();
  if (surface.length === 0) invalid(`${path}.surface`, "The surface form must not be blank.");
  const pronunciation = toKatakana(string(draft.pronunciation, `${path}.pronunciation`, 1, 200)).replaceAll(
    /\s+/gu,
    "",
  );
  if (!/^[ァ-ヴー]+$/u.test(pronunciation)) {
    invalid(`${path}.pronunciation`, "The pronunciation must be katakana (ー allowed).", "Example: キンヨウビ");
  }
  const moraCount = kanaToMoras(pronunciation, `${path}.pronunciation`).length;
  const accentType = integer(draft.accentType, `${path}.accentType`, 0, moraCount);
  return {
    surface,
    pronunciation,
    accentType,
    ...(draft.wordType === undefined ? {} : { wordType: literal(draft.wordType, `${path}.wordType`, WORD_TYPES) }),
    ...(draft.priority === undefined ? {} : { priority: integer(draft.priority, `${path}.priority`, 0, 10) }),
  };
}

export class Dictionary {
  private readonly client: VoicevoxClient;

  public constructor(client: VoicevoxClient) {
    this.client = client;
  }

  public list(options: OperationOptions = {}): Promise<readonly DictionaryWord[]> {
    return this.client.dictionary(options);
  }

  public async add(draft: DictionaryWordDraft, options: OperationOptions = {}): Promise<string> {
    return this.client.addDictionaryWord(validateWord(draft), options);
  }

  public async update(uuid: string, draft: DictionaryWordDraft, options: OperationOptions = {}): Promise<void> {
    await this.client.updateDictionaryWord(string(uuid, "$.uuid", 1, 200), validateWord(draft), options);
  }

  public async remove(uuid: string, options: OperationOptions = {}): Promise<void> {
    await this.client.deleteDictionaryWord(string(uuid, "$.uuid", 1, 200), options);
  }
}
