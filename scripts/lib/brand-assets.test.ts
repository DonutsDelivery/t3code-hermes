import { describe, expect, it } from "vite-plus/test";

import { BRAND_ASSET_PATHS } from "./brand-assets.ts";

describe("brand-assets", () => {
  it("uses the Hermes desktop icon across build channels", () => {
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toBe("assets/hermes/macos-1024.png");
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toBe("assets/hermes/macos-1024.png");
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toBe("assets/hermes/macos-1024.png");
  });
});
