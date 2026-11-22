import { describe, expect, it } from "vitest";
import { renderText, usedVariables } from "../src/mail/render.js";

describe("template rendering", () => {
  it("fills variables, uses fallbacks, and chooses spintax the same way every time", () => {
    const t = "{Hi|Hello} {first_name|there},\n\n{signal_line}\n\nWould a call make sense for {company}?";
    const a = renderText(t, { first_name: "Sarah", signal_line: "I saw you are hiring.", company: "Pixel" }, "lead-1");
    expect(a.text).toMatch(/^(Hi|Hello) Sarah,\n\nI saw you are hiring\.\n\nWould a call make sense for Pixel\?$/);
    expect(a.missing).toEqual([]);
    expect(renderText(t, { first_name: "Sarah", signal_line: "x", company: "Pixel" }, "lead-1").text.split(" ")[0]).toBe(a.text.split(" ")[0]);
    const seen = new Set(Array.from({ length: 30 }, (_, i) => renderText(t, { signal_line: "x", company: "C" }, `lead-${i}`).text.split(" ")[0]));
    expect(seen).toEqual(new Set(["Hi", "Hello"]));
    expect(renderText(t, { signal_line: "x", company: "C" }, "s").text).toMatch(/^(Hi|Hello) there,/);
  });

  it("reports missing and unknown variables; options with an empty variable are skipped", () => {
    const r = renderText("Hello {first_name|there}, {signal_line} at {company}{ in {city}|}. {nonsense}", { company: "Acme" }, "s");
    expect(r.missing).toEqual(["signal_line"]);
    expect(r.unknown).toEqual(["nonsense"]);
    expect(r.text).toBe("Hello there, at Acme.");
    expect(["We are in Berlin.", "We are."]).toContain(renderText("We are{ in {city}|}.", { city: "Berlin" }, "s").text); // an empty option means "sometimes nothing"
    expect(renderText("{there|you} and {Hi|Hey}", {}, "s").text).toMatch(/^(there|you) and (Hi|Hey)$/);
    expect(renderText("Value: {branche}", { branche: "Retail" }, "s").text).toBe("Value: Retail"); // custom CSV column
    expect(usedVariables("{Hi|Hello} {first_name|there} {company} {company}")).toEqual(["first_name", "company"]);
  });

  it("keeps line breaks and tidies spaces", () => {
    expect(renderText("Line one {x|}  .\n\n\n\nLine two", {}, "s").text).toBe("Line one.\n\nLine two");
  });
});
