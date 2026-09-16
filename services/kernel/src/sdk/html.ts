/**
 * @kernl/extension-sdk/html — HTML sanitizing.
 *
 * Kept off the main entry on purpose: sanitize-html brings postcss and a DOM
 * serializer, ~420 KB. An extension that loads part of itself lazily makes bun
 * initialise the whole SDK barrel for that part, unused exports included, so
 * anything heavy on the main entry lands in every such bundle.
 */

export * from "./sanitize-html.js";
