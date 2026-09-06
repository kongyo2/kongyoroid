import { invalid } from "../errors.ts";
import type { OperationOptions, StyleRef, StyleSelection, StyleType, VoiceStyle } from "../types.ts";
import type { VoicevoxClient } from "./client.ts";

export type StylePurpose = "speaker" | "singer" | "teacher";

const ACCEPTED: Readonly<Record<StylePurpose, readonly StyleType[]>> = {
  speaker: ["talk", "streaming_talk"],
  singer: ["frame_decode", "sing"],
  teacher: ["singing_teacher", "sing"],
};

const PURPOSE_HINT: Readonly<Record<StylePurpose, string>> = {
  speaker: "Speech needs a style of type talk. Run the voices command to list them.",
  singer: "Singing needs a style of type frame_decode or sing. Run voices --kind song to list them.",
  teacher: "A teacher needs a style of type singing_teacher or sing. Run voices --kind song to list them.",
};

function normalize(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase();
}

export function toSelection(style: VoiceStyle): StyleSelection {
  return { id: style.id, name: style.name, character: style.character, type: style.type };
}

export function describeStyle(style: VoiceStyle): string {
  return `${style.id}: ${style.character}/${style.name} (${style.type})`;
}

export class StyleCatalog {
  private readonly client: VoicevoxClient;
  private cache: Promise<readonly VoiceStyle[]> | undefined;

  public constructor(client: VoicevoxClient) {
    this.client = client;
  }

  public refresh(): void {
    this.cache = undefined;
  }

  public all(options: OperationOptions = {}): Promise<readonly VoiceStyle[]> {
    this.cache ??= Promise.all([this.client.speakers(options), this.client.singers(options)])
      .then(([speakers, singers]) => {
        const seen = new Set<number>();
        const merged: VoiceStyle[] = [];
        for (const style of [...speakers, ...singers]) {
          if (seen.has(style.id)) continue;
          seen.add(style.id);
          merged.push(style);
        }
        return merged;
      })
      .catch((error: unknown) => {
        this.cache = undefined;
        throw error;
      });
    return this.cache;
  }

  public async byPurpose(purpose: StylePurpose, options: OperationOptions = {}): Promise<readonly VoiceStyle[]> {
    const accepted = ACCEPTED[purpose];
    return (await this.all(options)).filter((style) => accepted.includes(style.type));
  }

  public async resolve(
    ref: StyleRef | undefined,
    purpose: StylePurpose,
    options: OperationOptions = {},
  ): Promise<StyleSelection> {
    const path = `$.${purpose}`;
    const all = await this.all(options);
    const accepted = ACCEPTED[purpose];
    const candidates = all.filter((style) => accepted.includes(style.type));
    if (ref === undefined) {
      const first = candidates[0];
      if (first === undefined) {
        invalid(path, `The engine offers no style usable as ${purpose}.`, PURPOSE_HINT[purpose]);
      }
      return toSelection(first);
    }
    if (typeof ref === "number") {
      const exact = all.find((style) => style.id === ref);
      if (exact === undefined) {
        invalid(path, `No style has id ${ref}.`, PURPOSE_HINT[purpose]);
      }
      if (!accepted.includes(exact.type)) {
        invalid(
          path,
          `Style ${describeStyle(exact)} cannot be used as ${purpose}.`,
          `${PURPOSE_HINT[purpose]} Usable: ${candidates.slice(0, 8).map(describeStyle).join(", ")}.`,
        );
      }
      return toSelection(exact);
    }
    const query = normalize(ref);
    const [characterPart, stylePart] = query.split(/[/／]/u, 2);
    const character = characterPart ?? query;
    const byCharacter = candidates.filter((style) => normalize(style.character) === character);
    if (byCharacter.length > 0) {
      const firstOfCharacter = byCharacter[0];
      if (firstOfCharacter !== undefined && (stylePart === undefined || stylePart.length === 0)) {
        return toSelection(firstOfCharacter);
      }
      const exact = byCharacter.find((style) => normalize(style.name) === stylePart);
      if (exact !== undefined) return toSelection(exact);
      invalid(
        path,
        `${ref}: character found but no ${purpose} style named ${JSON.stringify(stylePart)}.`,
        `Styles for this character: ${byCharacter.map((s) => `${s.name} (${s.id})`).join(", ")}.`,
      );
    }
    const byStyleName = candidates.find((style) => normalize(style.name) === query);
    if (byStyleName !== undefined) return toSelection(byStyleName);
    const partial = candidates.filter(
      (style) =>
        normalize(style.character).includes(character) || normalize(`${style.character}/${style.name}`).includes(query),
    );
    const characters = new Set(partial.map((style) => style.character));
    const firstPartial = partial[0];
    if (firstPartial !== undefined && characters.size === 1 && (stylePart === undefined || stylePart.length === 0)) {
      return toSelection(firstPartial);
    }
    return invalid(
      path,
      `No ${purpose} style matches ${JSON.stringify(ref)}.`,
      partial.length > 0
        ? `Did you mean: ${partial.slice(0, 8).map(describeStyle).join(", ")}?`
        : `${PURPOSE_HINT[purpose]} Available: ${candidates.slice(0, 8).map(describeStyle).join(", ")}.`,
    );
  }
}
