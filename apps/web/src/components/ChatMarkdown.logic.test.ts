import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canUseMarkdownFileShellActions,
  shouldUseMarkdownFileBrowserPrimaryAction,
  transformChatMarkdownUrl,
} from "./ChatMarkdown";

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions only for resolved local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  const html = { iconPath: "/tmp/report.html", canOpenInBrowser: true };

  it("uses the browser only when it is the sole action, except for PDFs", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: true,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});

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
