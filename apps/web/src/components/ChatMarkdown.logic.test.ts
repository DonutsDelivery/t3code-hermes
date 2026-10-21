import { describe, expect, it } from "vite-plus/test";

import { transformChatMarkdownUrl } from "./ChatMarkdown";

describe("Hermes markdown images", () => {
  it("allows inline raster images only for image sources", () => {
    const png = "data:image/png;base64,AQID";
    expect(transformChatMarkdownUrl(png, "src")).toBe(png);
    expect(transformChatMarkdownUrl(png, "href")).toBe("");
    expect(
      transformChatMarkdownUrl(
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+",
        "src",
      ),
    ).toBe("");
  });

  it("rewrites file URLs before the browser tries to load them", () => {
    expect(transformChatMarkdownUrl("file:///tmp/pairing%20qr.png", "src")).toBe(
      "/tmp/pairing%20qr.png",
    );
  });

  it("keeps in-app thread links", () => {
    const threadHref = "t3-thread://v1/env-1/thread-1";
    expect(transformChatMarkdownUrl(threadHref, "href")).toBe(threadHref);
  });
});
