import { describe, expect, it } from "vitest";
import { isGenerationFailure, isModelProblem } from "../src/study/ai.js";

describe("Groq error messages", () => {
  const parsing = "Parsing failed. The model generated output that could not be parsed. Please adjust your prompt. See 'failed_generation' for more details.";

  it("a model output that could not be parsed is a one-off, not a wrong model", () => {
    expect(isGenerationFailure(parsing)).toBe(true);
    expect(isModelProblem(400, parsing)).toBe(false);
  });

  it("a wrong or retired model is still recognised", () => {
    expect(isModelProblem(404, "anything")).toBe(true);
    expect(isModelProblem(400, "The model `llama-x` does not exist or you do not have access to it.")).toBe(true);
    expect(isModelProblem(400, "The model `mixtral-8x7b-32768` has been decommissioned and is no longer supported.")).toBe(true);
    expect(isGenerationFailure("The model `llama-x` does not exist")).toBe(false);
  });
});
