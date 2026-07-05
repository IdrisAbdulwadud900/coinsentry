import { describe, expect, it } from "vitest";
import { formatCompactUsd, formatPercent, parseShorthandNumber } from "../src/util/numberParser.js";

describe("parseShorthandNumber", () => {
  it("parses plain integers", () => {
    expect(parseShorthandNumber("5000")).toBe(5000);
    expect(parseShorthandNumber("0")).toBe(0);
  });

  it("parses plain decimals", () => {
    expect(parseShorthandNumber("0.0045")).toBeCloseTo(0.0045);
    expect(parseShorthandNumber("1.5")).toBe(1.5);
  });

  it("parses k/m/b shorthand, case-insensitively", () => {
    expect(parseShorthandNumber("5k")).toBe(5000);
    expect(parseShorthandNumber("5K")).toBe(5000);
    expect(parseShorthandNumber("250k")).toBe(250_000);
    expect(parseShorthandNumber("1.2m")).toBe(1_200_000);
    expect(parseShorthandNumber("1.2M")).toBe(1_200_000);
    expect(parseShorthandNumber("2b")).toBe(2_000_000_000);
  });

  it("strips leading dollar signs and thousands separators", () => {
    expect(parseShorthandNumber("$5k")).toBe(5000);
    expect(parseShorthandNumber("10,000")).toBe(10_000);
    expect(parseShorthandNumber("$1,200,000")).toBe(1_200_000);
  });

  it("trims whitespace", () => {
    expect(parseShorthandNumber("  5k  ")).toBe(5000);
  });

  it("parses a leading plus sign", () => {
    expect(parseShorthandNumber("+22")).toBe(22);
    expect(parseShorthandNumber("+5k")).toBe(5000);
  });

  it("returns null for garbage input", () => {
    expect(parseShorthandNumber("")).toBeNull();
    expect(parseShorthandNumber("abc")).toBeNull();
    expect(parseShorthandNumber("5kk")).toBeNull();
    expect(parseShorthandNumber("k5")).toBeNull();
    expect(parseShorthandNumber("5 k")).toBeNull();
  });
});

describe("formatCompactUsd", () => {
  it("formats values across magnitudes", () => {
    expect(formatCompactUsd(5000)).toBe("$5.00K");
    expect(formatCompactUsd(1_200_000)).toBe("$1.20M");
    expect(formatCompactUsd(2_000_000_000)).toBe("$2.00B");
    expect(formatCompactUsd(42)).toBe("$42.00");
  });

  it("uses precision formatting for sub-dollar values", () => {
    expect(formatCompactUsd(0.0000451)).toBe("$0.0000451");
  });

  it("handles negative values", () => {
    expect(formatCompactUsd(-5000)).toBe("-$5.00K");
  });
});

describe("formatPercent", () => {
  it("adds a plus sign for positive values", () => {
    expect(formatPercent(4.567)).toBe("+4.6%");
  });

  it("does not add a plus sign for negative values", () => {
    expect(formatPercent(-4.567)).toBe("-4.6%");
  });

  it("respects digit precision", () => {
    expect(formatPercent(4.567, 2)).toBe("+4.57%");
  });
});
