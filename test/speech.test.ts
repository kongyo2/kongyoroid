import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRequest } from "../src/request.ts";
import { compileRequest } from "../src/synth/engine.ts";
import { isVowelPhoneme } from "../src/synth/phonemes.ts";
import { P_AF, P_F2 } from "../src/synth/plan.ts";
import type { SynthesisPlan } from "../src/synth/plan.ts";

const RATE = 24000;

async function plan(request: Record<string, unknown>): Promise<SynthesisPlan> {
  return (await compileRequest(parseRequest({ kind: "speech", text: "x", ...request }), RATE)).plan;
}

function f0At(planned: SynthesisPlan, sample: number): number {
  let best = planned.pitch[0];
  for (const point of planned.pitch) {
    if (point.sample <= sample) best = point;
    else break;
  }
  return best?.hz ?? 0;
}

function vowelMiddleF0(planned: SynthesisPlan, moraIndex: number): number {
  const vowel = planned.segments.find((segment) => segment.moraIndex === moraIndex && isVowelPhoneme(segment.phoneme));
  assert.ok(vowel !== undefined, `mora ${moraIndex} has a vowel`);
  return f0At(planned, Math.round((vowel.start + vowel.end) / 2));
}

function voicedSeconds(planned: SynthesisPlan): number {
  let frames = 0;
  for (const segment of planned.segments) if (segment.phoneme !== "pau") frames += segment.end - segment.start;
  return frames / planned.sampleRate;
}

test("mora and phrase markers tile the utterance in order", async () => {
  const planned = await plan({ kana: "コンニチワ'、セカ'イ？" });
  assert.equal(planned.moras.length, 8);
  for (const [index, mora] of planned.moras.entries()) {
    assert.ok(mora.end > mora.start, mora.text);
    const previous = planned.moras[index - 1];
    if (previous !== undefined) assert.ok(mora.start >= previous.end);
  }
  assert.equal(planned.phrases.length, 2);
  assert.equal(planned.phrases[0]?.boundary, "pause");
  assert.equal(planned.phrases[1]?.boundary, "question");
  assert.equal(planned.segments.at(-1)?.phoneme, "pau");
  assert.equal(planned.reading?.kana, "コンニチワ'、セカ'イ？");
});

test("accent nuclei and question rises shape the F0 contour", async () => {
  const initial = await plan({ kana: "ハ'シガ" });
  const final = await plan({ kana: "ハシ'ガ" });
  const heiban = await plan({ kana: "ハシガ" });
  const middle = vowelMiddleF0;
  assert.ok(middle(initial, 0) > middle(initial, 2) * 1.12, `頭高: ${middle(initial, 0)} vs ${middle(initial, 2)}`);
  assert.ok(middle(final, 1) > middle(final, 0) * 1.12, `尾高: ${middle(final, 1)} vs ${middle(final, 0)}`);
  assert.ok(middle(final, 1) > middle(final, 2) * 1.08, `尾高 fall: ${middle(final, 1)} vs ${middle(final, 2)}`);
  assert.ok(middle(heiban, 2) > middle(heiban, 0) * 1.08, `平板: ${middle(heiban, 2)} vs ${middle(heiban, 0)}`);
  assert.ok(
    middle(heiban, 2) >= middle(heiban, 1) * 0.97,
    `平板 stays high: ${middle(heiban, 2)} vs ${middle(heiban, 1)}`,
  );
  const question = await plan({ kana: "ハシ？" });
  const statement = await plan({ kana: "ハシ。" });
  const last = (planned: SynthesisPlan): number => {
    const mora = planned.moras.at(-1);
    return mora === undefined ? 0 : f0At(planned, mora.end - 1);
  };
  assert.ok(last(question) > last(statement) * 1.2, `question ${last(question)} vs statement ${last(statement)}`);
  const flat = await plan({ kana: "ハシ？", upspeak: false });
  assert.ok(last(flat) < last(question) * 0.9);
});

test("pitch, intonation, and exclamation controls act on the contour as documented", async () => {
  const base = await plan({ kana: "コンニチワ'/セカ'イ。" });
  const up = await plan({ kana: "コンニチワ'/セカ'イ。", pitchSemitones: 12 });
  assert.ok(Math.abs(up.f0Max / base.f0Max - 2) < 0.03, `${up.f0Max} vs ${base.f0Max}`);
  const monotone = await plan({ kana: "コンニチワ'/セカ'イ。", intonation: 0 });
  assert.ok(monotone.f0Max / monotone.f0Min < 1.15, `${monotone.f0Min}-${monotone.f0Max}`);
  const wide = await plan({ kana: "コンニチワ'/セカ'イ。", intonation: 2 });
  assert.ok(wide.f0Max / wide.f0Min > base.f0Max / base.f0Min);
  const excited = await plan({ kana: "コンニチワ'/セカ'イ！" });
  assert.ok(excited.f0Max > base.f0Max);
  const female = await plan({ kana: "コンニチワ'/セカ'イ。", voice: "female" });
  assert.ok(female.f0Min > base.f0Min);
  const compat = await plan({ kana: "コンニチワ'/セカ'イ。", pitch: 0.05 });
  assert.ok(compat.f0Max > base.f0Max);
});

test("pauses follow pauseScale, pauseLength, sentence and paragraph boundaries", async () => {
  const seconds = async (extra: Record<string, unknown>): Promise<number> =>
    (await plan({ prePause: 0, postPause: 0, ...extra })).frames / RATE;
  const comma = await seconds({ kana: "ア'、イ'" });
  const scaled = await seconds({ kana: "ア'、イ'", pauseScale: 3 });
  assert.ok(Math.abs(scaled - comma - 0.4) < 0.02, `${scaled} - ${comma}`);
  const fixed = await seconds({ kana: "ア'、イ'", pauseLength: 0.5 });
  const fixedScaled = await seconds({ kana: "ア'、イ'", pauseLength: 0.5, pauseScale: 2 });
  assert.ok(Math.abs(fixedScaled - fixed - 0.5) < 0.02, `${fixedScaled} - ${fixed}`);
  const sentence = await seconds({ text: "あ。い" });
  const paragraph = await seconds({ text: "あ。\n\nい" });
  assert.ok(paragraph > sentence + 0.25, `${paragraph} vs ${sentence}`);
  const fast = await plan({ kana: "アイウエオ'、カキクケコ'。", speed: 2 });
  const normal = await plan({ kana: "アイウエオ'、カキクケコ'。" });
  assert.ok(Math.abs(voicedSeconds(fast) / voicedSeconds(normal) - 0.5) < 0.06);
});

test("phonological context rules change the acoustic plan", async () => {
  const devoiced = await plan({ kana: "デス" });
  assert.ok(devoiced.segments.some((segment) => segment.phoneme === "U"));
  const geminateFricative = await plan({ kana: "アッサ" });
  const closure = geminateFricative.segments.find((segment) => segment.phoneme === "cl");
  assert.ok(closure !== undefined);
  assert.ok((closure.keyframes[1]?.values[P_AF] ?? -120) > -40, "っ before s carries frication");
  const geminateStop = await plan({ kana: "アッカ" });
  const stopClosure = geminateStop.segments.find((segment) => segment.phoneme === "cl");
  assert.ok((stopClosure?.keyframes[0]?.values[P_AF] ?? 0) <= -100, "っ before k is silent");
  const bilabial = await plan({ kana: "アンマ" });
  const velar = await plan({ kana: "アンカ" });
  const nasalF2 = (planned: SynthesisPlan): number =>
    planned.segments.find((segment) => segment.phoneme === "N")?.keyframes[1]?.values[P_F2] ?? 0;
  assert.ok(nasalF2(velar) > nasalF2(bilabial) * 1.3, `ん assimilates: ${nasalF2(bilabial)} vs ${nasalF2(velar)}`);
  const long = await plan({ kana: "オーサカ" });
  assert.equal(long.segments.filter((segment) => segment.phoneme === "o")[1]?.articulation, "continue");
});
