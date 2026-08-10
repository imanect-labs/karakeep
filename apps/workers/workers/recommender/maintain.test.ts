import { describe, expect, test } from "vitest";

import { SEED_SOURCES } from "@karakeep/recommender";

import { selectMissingSeedSources } from "./maintain";

/**
 * シードの配り直し（FR-C-08b）。`enroll` は初回しか配らないので、一覧を
 * 増やしたぶんを既存ユーザーへ届けるのはここだけ。壊れても例外にならず
 * 「一部の人にだけ収集元が増えない」形で出るので、判定を直接押さえる。
 */
describe("selectMissingSeedSources", () => {
  test("gives nothing to a user who has no sources at all", () => {
    // 未登録の人にここから配ると、「画面から自分で始める」という有効化の
    // 設計を裏口から破ることになる。
    expect(selectMissingSeedSources([])).toHaveLength(0);
  });

  test("gives nothing to a user who already has every seed", () => {
    const all = SEED_SOURCES.map((s) => s.name);
    expect(selectMissingSeedSources(all)).toHaveLength(0);
  });

  test("gives only the seeds the user is missing", () => {
    const all = SEED_SOURCES.map((s) => s.name);
    const missing = selectMissingSeedSources(all.slice(0, 3));
    expect(missing).toHaveLength(SEED_SOURCES.length - 3);
    expect(missing.map((s) => s.name)).toEqual(all.slice(3));
  });

  test("ignores sources the user has that are not seeds", () => {
    // `discover` が作った個人の収集元。これがあるからといってシードを
    // 配らない理由にはならないし、消す対象にもしない。
    const missing = selectMissingSeedSources([
      SEED_SOURCES[0].name,
      "example.com からの自動発見",
    ]);
    expect(missing).toHaveLength(SEED_SOURCES.length - 1);
    expect(missing.map((s) => s.name)).not.toContain(SEED_SOURCES[0].name);
  });
});
