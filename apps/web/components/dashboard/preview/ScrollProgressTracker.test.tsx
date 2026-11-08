// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ScrollProgressTracker from "@karakeep/shared-react/components/ScrollProgressTracker";

const position = vi.hoisted(() => ({
  value: { offset: 40, percent: 40, anchor: null },
}));
vi.mock("@karakeep/shared/utils/reading-progress-dom", () => ({
  findScrollableParent: () => document.documentElement,
  getReadingPosition: () => position.value,
  scrollToReadingPosition: vi.fn(),
  SCROLL_THROTTLE_MS: 100,
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("does not save inflated progress from a growing draft or replay it when tracking resumes", () => {
  vi.useFakeTimers();
  const save = vi.fn();
  const view = render(
    <ScrollProgressTracker onSavePosition={save}>
      <p>Original</p>
    </ScrollProgressTracker>,
  );
  fireEvent.scroll(window);
  view.rerender(
    <ScrollProgressTracker trackingEnabled={false} onSavePosition={save}>
      <p>Draft</p>
    </ScrollProgressTracker>,
  );
  position.value = { offset: 100, percent: 100, anchor: null };
  fireEvent.scroll(window);
  act(() => vi.advanceTimersByTime(6000));
  fireEvent(window, new Event("beforeunload"));
  expect(save).not.toHaveBeenCalled();
  view.rerender(
    <ScrollProgressTracker onSavePosition={save}>
      <p>Complete</p>
    </ScrollProgressTracker>,
  );
  fireEvent(window, new Event("beforeunload"));
  expect(save).not.toHaveBeenCalled();
  position.value = { offset: 80, percent: 50, anchor: null };
  fireEvent.scroll(window);
  act(() => vi.advanceTimersByTime(6000));
  expect(save).toHaveBeenCalledExactlyOnceWith(position.value);
});
