// @vitest-environment jsdom
import "@klinecharts/pro";
import { CHART_DRAWING_CAPABILITIES } from "@rakazo/core";
import { getOverlayClass, getSupportedIndicators, getSupportedOverlays } from "klinecharts";
import { expect, it } from "vitest";

it.each(CHART_DRAWING_CAPABILITIES)(
  "the pinned adapter actually implements %s with %s anchors",
  (name, anchors) => {
    expect(getSupportedOverlays()).toContain(name);
    const Constructor = getOverlayClass(name);
    expect(Constructor).not.toBeNull();
    if (!Constructor) throw new Error("Unavailable overlay");
    expect(new Constructor().totalStep - 1).toBe(anchors);
  },
);
it("discovers native indicators without automatically adding a strategy", () => {
  expect(getSupportedIndicators()).toContain("MA");
});
