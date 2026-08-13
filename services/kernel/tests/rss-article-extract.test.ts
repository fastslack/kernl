/**
 * Feeds that ship a link and nothing else.
 *
 * The Hugging Face blog feed publishes items with a title, a pubDate, a link
 * and a guid — no `<description>`, no `<content:encoded>`. The reader pane was
 * therefore blank for every one of them, and no amount of parser work could
 * fix that: the text was never in the feed. It has to come from the page.
 */

import { describe, it, expect } from "bun:test";
import { extractArticle } from "../assets/extensions/home/rss-reader/_module/article.js";

const PAGE = `
<!doctype html>
<html>
  <head>
    <title>GPU Management</title>
    <style>.x { color: red }</style>
    <script>window.analytics = 1;</script>
  </head>
  <body>
    <nav><a href="/home">Home</a><a href="/blog">Blog</a></nav>
    <header><h1>Site header that is not the article</h1></header>
    <article>
      <h1>GPU Management: Why Idle GPUs Are the New Grounded Aircraft</h1>
      <p class="lead" data-tracking="abc">An idle GPU is a cost centre with a fan. The economics look
      very much like commercial aviation, where an aircraft on the ground earns nothing and still
      depreciates on schedule.</p>
      <p>Utilisation is the whole game. A fleet at forty percent utilisation needs more than twice
      the capital of one at ninety, for the same delivered throughput, and the gap compounds.</p>
      <ul><li>Scheduling beats buying</li><li>Preemption beats reservation</li></ul>
      <p>Treat capacity as a schedule, not an inventory, and the numbers change shape entirely,
      which is the whole argument — see <a href="javascript:steal()">not a real link</a> for why.</p>
      <img src="/chart.png" alt="Utilisation curve" width="800">
    </article>
    <aside><p>Related posts you should also read right now immediately</p></aside>
    <footer><p>Copyright notice and a long pile of footer navigation text</p></footer>
  </body>
</html>`;

describe("extractArticle", () => {
  it("pulls the article body out of a full page", () => {
    const { html, length } = extractArticle(PAGE);
    expect(html).toContain("An idle GPU is a cost centre with a fan");
    expect(html).toContain("Utilisation is the whole game");
    expect(html).toContain("Scheduling beats buying");
    expect(length).toBeGreaterThan(200);
  });

  it("drops the furniture around it", () => {
    const { html } = extractArticle(PAGE);
    expect(html).not.toContain("window.analytics");
    expect(html).not.toContain("color: red");
    expect(html).not.toContain("Site header that is not the article");
    expect(html).not.toContain("Related posts");
    expect(html).not.toContain("Copyright notice");
  });

  it("keeps the tags a reader needs and strips the rest", () => {
    const { html } = extractArticle(PAGE);
    expect(html).toContain("<p>");
    expect(html).toContain("<li>");
    expect(html).toContain('<img src="/chart.png" alt="Utilisation curve">');
    // Tracking attributes and layout hints are not content.
    expect(html).not.toContain("data-tracking");
    expect(html).not.toContain('class="lead"');
    expect(html).not.toContain("width=");
  });

  it("refuses a javascript: href while keeping the link text", () => {
    const { html } = extractArticle(PAGE);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("not a real link");
  });

  it("falls back to the densest block when there is no <article>", () => {
    const noSemantic = `<html><body>
      <div><p>nav-ish</p></div>
      <div><p>${"The real body of the piece, repeated to carry weight. ".repeat(8)}</p></div>
    </body></html>`;
    const { html, length } = extractArticle(noSemantic);
    expect(html).toContain("The real body of the piece");
    expect(length).toBeGreaterThan(200);
  });

  it("does not spill an attribute containing '>' into the text", () => {
    // Observed on the real Hugging Face page: a Tailwind arbitrary variant
    // like class="[&>a]:hidden" split a tag in half and leaked `a]:hidden">`
    // into the reader as prose.
    const tricky = `<article><div class="[&>a]:hidden"><p>${"Body text that must survive. ".repeat(10)}</p></div></article>`;
    const { html } = extractArticle(tricky);
    expect(html).not.toContain("hidden");
    expect(html).not.toContain('">');
    expect(html).toContain("Body text that must survive");
  });

  it("keeps the prose when the markup is nested, and shows each image once", () => {
    // What Krebs on Security rendered as: the charts, twice, and not one
    // paragraph. Picking a container by regex stops at the first </div>, so a
    // nested layout yielded a fragment holding the figures and none of the text.
    const wordpress = `<html><body><article>
      <div class="entry"><div class="wrap">
        <figure><img src="/chart.png" alt="Proxy SDK prevalence"></figure>
        <p>${"LG will ban residential proxy SDKs from its smart TV app store. ".repeat(4)}</p>
        <p>${"The apps were fingerprinted across webOS and Tizen devices. ".repeat(4)}</p>
      </div></div>
    </article></body></html>`;
    const { html } = extractArticle(wordpress);
    expect(html).toContain("LG will ban residential proxy SDKs");
    expect(html).toContain("fingerprinted across webOS");
    expect(html.match(/<img/g)?.length).toBe(1);
  });

  it("resolves relative links and images against the article URL", () => {
    // Left relative, every asset resolves against the dashboard and 404s.
    const page = `<article><p>${"Body long enough to count as prose here. ".repeat(4)}</p>
      <img src="/img/chart.png" alt="c"></article>`;
    const { html } = extractArticle(page, "https://krebsonsecurity.com/2026/07/lg-proxies/");
    expect(html).toContain('src="https://krebsonsecurity.com/img/chart.png"');
  });

  it("drops the lead-in furniture that lives inside the article", () => {
    const page = `<article>
      <p><a href="/blog">Back to Articles</a></p>
      <h1>GPU Management</h1>
      <p>Upvote 68</p>
      <p>${"The actual opening paragraph of the piece, long enough to qualify. ".repeat(3)}</p>
    </article>`;
    const { html } = extractArticle(page);
    expect(html).not.toContain("Back to Articles");
    expect(html).not.toContain("Upvote 68");
    expect(html).toContain("The actual opening paragraph");
  });

  it("reports a short result rather than inventing one", () => {
    // The caller uses this to decide not to cache junk.
    const { length } = extractArticle("<html><body><p>Too short.</p></body></html>");
    expect(length).toBeLessThan(200);
  });
});
