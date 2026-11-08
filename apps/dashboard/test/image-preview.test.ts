/**
 * What a share link's page contributes: the picture it declares, and the one it
 * actually shows.
 *
 * Pinterest is the case that produced these tests: a pin of a GIF declares a
 * still JPEG thumbnail in `og:image` and links the original `.gif` elsewhere in
 * the same document. Following only the tag turns an animation into a
 * photograph, which is exactly what the operator reported.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { previewImageFrom } from "../server/appearance.js";

const HASH = "96648da271d83135ea74cde49ecafd54";

test("a page that declares only a picture returns it", () => {
  const html = `<meta property="og:image" content="https://cdn.example.com/photo.jpg" />`;
  assert.equal(previewImageFrom(html), "https://cdn.example.com/photo.jpg");
});

test("twitter:image is used when og:image is absent", () => {
  const html = `<meta name="twitter:image" content="https://cdn.example.com/twitter.png" />`;
  assert.equal(previewImageFrom(html), "https://cdn.example.com/twitter.png");
});

test("a page with no preview tag returns nothing", () => {
  assert.equal(previewImageFrom("<html><body>nothing here</body></html>"), null);
});

test("the GIF of the same asset wins over the still thumbnail", () => {
  // The real shape of a Pinterest pin page: a sized JPEG in the tag, and the
  // original GIF — same file name — further down the document.
  const html = `
    <meta content="https://i.pinimg.com/736x/96/64/8d/${HASH}.jpg" property="og:image" />
    <meta content="500" property="og:image:width" />
    <div data-src="https://i.pinimg.com/originals/96/64/8d/${HASH}.gif"></div>
  `;
  assert.equal(previewImageFrom(html), `https://i.pinimg.com/originals/96/64/8d/${HASH}.gif`);
});

test("an unrelated GIF on the page is not attached to the declared picture", () => {
  const html = `
    <meta property="og:image" content="https://cdn.example.com/photo.jpg" />
    <img src="https://cdn.example.com/emoji-smile.gif" />
  `;
  assert.equal(previewImageFrom(html), "https://cdn.example.com/photo.jpg");
});

test("a short generic file name is never matched", () => {
  // "logo" is not an asset hash: matching on it would swap the picture for
  // whatever GIF the page happens to load.
  const html = `
    <meta property="og:image" content="https://cdn.example.com/logo.jpg" />
    <img src="https://other.example.com/logo.gif" />
  `;
  assert.equal(previewImageFrom(html), "https://cdn.example.com/logo.jpg");
});

test("a declared GIF is returned unchanged, query string included", () => {
  const html = `<meta property="og:image" content="https://cdn.example.com/${HASH}.gif?v=2" />`;
  assert.equal(previewImageFrom(html), `https://cdn.example.com/${HASH}.gif?v=2`);
});
