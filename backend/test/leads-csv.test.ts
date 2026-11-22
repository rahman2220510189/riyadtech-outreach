import { describe, expect, it } from "vitest";
import { csvCell, csvLine, detectDelimiter, parseCsv, suggestMapping, variableName } from "../src/leads/csv.js";
import { countryCode } from "../src/leads/lists.js";
import { parseSuppressionList, suppressionTarget } from "../src/leads/suppression.js";

describe("CSV import helpers", () => {
  it("detects the delimiter (comma, semicolon, tab) outside quotes", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("E-Mail;Vorname;Firma\nx;y;z")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"x, y";z;w')).toBe(";");
  });

  it("reads quotes, BOM, empty lines, ragged rows and duplicate headers", () => {
    const csv = parseCsv('﻿Email;Company;Email\n"a@x.com";"Acme; Ltd";dup\n\nb@y.com;Beta\n');
    expect(csv.delimiter).toBe(";");
    expect(csv.headers).toEqual(["Email", "Company", "Email (2)"]);
    expect(csv.rows).toEqual([["a@x.com", "Acme; Ltd", "dup"], ["b@y.com", "Beta"]]);
    expect(() => parseCsv("   ")).toThrow(/empty/);
  });

  it("suggests the mapping from header names (several languages) or from content", () => {
    expect(suggestMapping(["E-Mail", "Vorname", "Firma", "Webseite", "Land", "Stadt", "Branche"], [])).toEqual({
      email: "E-Mail",
      first_name: "Vorname",
      company: "Firma",
      website: "Webseite",
      country: "Land",
      city: "Stadt",
    });
    expect(suggestMapping(["Contact", "Notes"], [["jo@acme.com", "x"], ["", "y"]])).toEqual({ email: "Contact" });
  });

  it("makes template variable names and safe CSV cells", () => {
    expect(variableName("Industry Type")).toBe("industry_type");
    expect(variableName("Größe (MA)")).toBe("grosse_ma");
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+49 30 123")).toBe("'+49 30 123");
    expect(csvCell('He said "hi", ok')).toBe('"He said ""hi"", ok"');
    expect(csvCell(null)).toBe("");
    expect(csvLine([1, true, "a;b"])).toBe('1,true,"a;b"');
  });

  it("turns country names into codes", () => {
    expect(countryCode("Germany")).toBe("DE");
    expect(countryCode("deutschland")).toBe("DE");
    expect(countryCode("uk")).toBe("GB");
    expect(countryCode("ie")).toBe("IE");
    expect(countryCode("Atlantis")).toBeNull();
  });
});

describe("suppression input", () => {
  it("knows addresses and domains", () => {
    expect(suppressionTarget("Info@Acme.com")).toEqual({ kind: "email", value: "info@acme.com" });
    expect(suppressionTarget("https://www.acme.com/contact")).toEqual({ kind: "domain", value: "acme.com" });
    expect(suppressionTarget("@acme.co.uk")).toEqual({ kind: "domain", value: "acme.co.uk" });
    expect(suppressionTarget("not valid")).toBeNull();
  });

  it("reads a pasted list or a one-column file, skipping headers and repeats", () => {
    const r = parseSuppressionList("email\nA@x.com\na@x.com, b.com;  junk\n@c.org");
    expect(r.targets).toEqual([
      { kind: "email", value: "a@x.com" },
      { kind: "domain", value: "b.com" },
      { kind: "domain", value: "c.org" },
    ]);
    expect(r.invalid).toEqual(["junk"]);
  });
});
