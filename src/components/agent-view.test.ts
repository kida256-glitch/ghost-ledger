import { describe, expect, it } from "vitest";
import { SUGGESTED, toEntry } from "./agent-view";

describe("ai task 6: chat panel view model (A6)", () => {
  it("an answer becomes paragraphs, tool labels and ledger links", () => {
    const e = toEntry("Anything suspicious?", 200, {
      ok: true,
      answer: "2 things look suspicious:\n1. A loan ... (seq 453).\n2. Another (seq 453).",
      tools: [{ name: "flag_anomalies", summary: "2 anomalies" }],
      seqs: [453],
      offline: false,
    });
    expect(e).toEqual({
      kind: "answer",
      question: "Anything suspicious?",
      view: {
        paragraphs: ["2 things look suspicious:", "1. A loan ... (seq 453).", "2. Another (seq 453)."],
        tools: [{ label: "Ran the anomaly rules", summary: "2 anomalies" }],
        seqLinks: [{ seq: 453, href: "/dashboard/ledger?seq=453#seq-453" }],
        offline: false,
      },
    });
  });

  it("a 429 is a rate-limit state; other errors and garbage are error states", () => {
    expect(toEntry("q", 429, { ok: false, code: "RATE_LIMITED", message: "limit" })).toEqual({ kind: "error", question: "q", message: "limit", rateLimited: true });
    expect(toEntry("q", 503, { ok: false, code: "UNAVAILABLE", message: "down" })).toMatchObject({ kind: "error", rateLimited: false });
    expect(toEntry("q", 0, null)).toMatchObject({ kind: "error", message: "The assistant is unavailable right now. Please try again." });
    expect(toEntry("q", 200, "<html>")).toMatchObject({ kind: "error" });
  });

  it("the suggested chips are the three demo questions", () => {
    expect(SUGGESTED).toEqual(["Is the ledger intact?", "Anything suspicious?", "Who is overdue?"]);
  });
});
