import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, packageInfo } from "./index.js";

describe("packageInfo", () => {
  it("reports the workspace package identity", () => {
    expect(packageInfo()).toEqual({ name: PACKAGE_NAME, version: "0.0.1-alpha.0" });
  });
});
