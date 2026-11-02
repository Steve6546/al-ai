import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_IMAGE_UPLOAD_BYTES,
  imageRejectionReason,
  normaliseImageDataUrl
} from "../src/contracts.js";

/**
 * What the image budget actually allows.
 *
 * The dashboard never re-encodes a picked image — `FileReader.readAsDataURL`
 * ships the file as it is — so an animated GIF reaches these validators intact,
 * and the byte budget and the base64 ceiling have to describe the same image.
 * They did not for a while: both were 500 000, and base64 is four characters per
 * three bytes, so anything between ~375 KB and 500 KB passed the download and
 * was refused on save.
 */

function dataUrlFor(bytes: number, mime = "image/gif"): string {
  return `data:${mime};base64,${Buffer.alloc(bytes).toString("base64")}`;
}

test("an animated GIF is a valid image for the bot's own identity", () => {
  const gif = dataUrlFor(1024);
  assert.equal(normaliseImageDataUrl(gif), gif, "the bytes are stored as sent");
  assert.equal(imageRejectionReason(gif), null, "no reason to refuse it");
});

test("SVG is refused, and that refusal is deliberate", () => {
  // Not a size question: an SVG is a document, and Discord's icon and banner
  // endpoints do not take one.
  const svg = "data:image/svg+xml;base64,PHN2Zy8+";
  assert.equal(normaliseImageDataUrl(svg), null);
  assert.equal(imageRejectionReason(svg), "NOT_AN_IMAGE");
});

test("an image at the full byte budget fits the base64 ceiling", () => {
  const largest = dataUrlFor(MAX_IMAGE_UPLOAD_BYTES);
  assert.ok(
    largest.length <= MAX_IMAGE_DATA_URL_LENGTH,
    `a ${MAX_IMAGE_UPLOAD_BYTES}-byte image encodes to ${largest.length} characters, over the ${MAX_IMAGE_DATA_URL_LENGTH} ceiling`
  );
  assert.equal(imageRejectionReason(largest), null, "the hint promises this size, so it must save");
});

test("an image clearly beyond the budget is refused as too large, not as not-an-image", () => {
  // Base64 grows three bytes at a time, so the string ceiling cannot cut the
  // budget on an exact byte — 500 000 and 500 001 encode identically. The byte
  // budget is enforced where the byte count is known (the download refuses
  // `too-large` while streaming); this ceiling is the last line for a
  // hand-crafted request, so it is asserted at a distance it can actually see.
  assert.equal(imageRejectionReason(dataUrlFor(MAX_IMAGE_UPLOAD_BYTES + 3_000)), "TOO_LARGE");
});
