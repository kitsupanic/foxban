import { expect, test } from "@playwright/test";
import { hasYouTubeVideo } from "../src/lib/youtube";

test("a bare YouTube link on its own line is a video", () => {
  expect(hasYouTubeVideo("Intro\n\nhttps://youtu.be/dQw4w9WgXcQ")).toBe(true);
});

test("a bare YouTube link nested in a quote or a loose list item is a video, as the renderer embeds it", () => {
  expect(hasYouTubeVideo("> https://youtu.be/dQw4w9WgXcQ")).toBe(true);
  expect(hasYouTubeVideo("- https://youtu.be/dQw4w9WgXcQ\n\n- another item")).toBe(true);
  expect(hasYouTubeVideo("- intro\n\n  https://youtu.be/dQw4w9WgXcQ")).toBe(true);
  expect(hasYouTubeVideo("1. one\n   > https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
});

test("a bare YouTube link directly in a tight list item is not a video: the renderer unwraps its paragraph", () => {
  expect(hasYouTubeVideo("- https://youtu.be/dQw4w9WgXcQ")).toBe(false);
  expect(hasYouTubeVideo("1. https://youtu.be/dQw4w9WgXcQ\n2. two")).toBe(false);
  expect(hasYouTubeVideo("> - https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
});

test("a YouTube link inside prose, or a non-YouTube link, is not a video", () => {
  expect(hasYouTubeVideo("watch https://youtu.be/dQw4w9WgXcQ now")).toBe(false);
  expect(hasYouTubeVideo("> see https://youtu.be/dQw4w9WgXcQ")).toBe(false);
  expect(hasYouTubeVideo("> https://example.com/youtu.be/dQw4w9WgXcQ")).toBe(false);
});

test("the answer is the same on a repeated call (cached)", () => {
  const text = "> https://youtu.be/dQw4w9WgXcQ";
  expect(hasYouTubeVideo(text)).toBe(hasYouTubeVideo(text));
});
