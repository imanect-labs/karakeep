import { describe, expect, test } from "vitest";

import { paginate } from "./pagination";

const items = Array.from({ length: 30 }, (_, i) => i + 1);

describe("paginate", () => {
  test("splits 30 items into 3 pages of 10", () => {
    expect(paginate(items, 10, 0)).toMatchObject({
      pageCount: 3,
      currentPage: 0,
      pageStart: 0,
    });
    expect(paginate(items, 10, 0).items).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(paginate(items, 10, 2).items).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    expect(paginate(items, 10, 2).pageStart).toBe(20);
  });

  test("gives a short last page", () => {
    const page = paginate(items.slice(0, 25), 10, 2);
    expect(page.pageCount).toBe(3);
    expect(page.items).toHaveLength(5);
  });

  test("clamps a page past the end to the last page", () => {
    // 読んでいる最中に rank が再実行されて件数が減ったときに起きる。
    // そのままだと空のページに取り残されて壊れて見える。
    const page = paginate(items.slice(0, 12), 10, 2);
    expect(page.currentPage).toBe(1);
    expect(page.items).toEqual([11, 12]);
  });

  test("clamps a negative page to the first", () => {
    expect(paginate(items, 10, -1).currentPage).toBe(0);
  });

  test("returns one empty page for an empty list", () => {
    expect(paginate([], 10, 0)).toEqual({
      pageCount: 1,
      currentPage: 0,
      pageStart: 0,
      items: [],
    });
  });

  test("does not paginate when everything fits", () => {
    expect(paginate(items.slice(0, 10), 10, 0).pageCount).toBe(1);
  });
});
