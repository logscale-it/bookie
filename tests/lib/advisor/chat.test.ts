import { expect, test } from "bun:test";
import { toMessages, userTurn, type Turn } from "$lib/advisor/prompt";
import { facts } from "./fixture";

const answer = (text: string): Turn => ({ role: "assistant", text, sent: text });

test("first question carries the facts, the calculator and the question", () => {
  const t = userTurn(facts, "  Kann ich einstellen?  ", "Rechner A", []);
  expect(t.text).toBe("Kann ich einstellen?");
  expect(t.sent).toContain("Zahlen aus der Buchhaltung (JSON):");
  expect(t.sent).toContain("Rechner A");
  expect(t.sent).toEndWith("Frage: Kann ich einstellen?");
});

test("a follow-up is sent as typed while the calculator is unchanged", () => {
  const first = userTurn(facts, "q1", "Rechner A", []);
  const thread = [first, answer("a1")];
  const t = userTurn(facts, "Und im Juni?", "Rechner A", thread);
  expect(t.sent).toBe("Und im Juni?");
});

test("a follow-up re-attaches the calculator once it changed, never the facts", () => {
  const first = userTurn(facts, "q1", "Rechner A", []);
  const t = userTurn(facts, "Und jetzt?", "Rechner B", [first, answer("a1")]);
  expect(t.sent).toContain("Rechner B");
  expect(t.sent).toEndWith("Frage: Und jetzt?");
  expect(t.sent).not.toContain("Zahlen aus der Buchhaltung");
});

test("toMessages sends the model-facing text in order", () => {
  const first = userTurn(facts, "q1", "c", []);
  const second = userTurn(facts, "q2", "c", [first, answer("a1")]);
  const msgs = toMessages([first, answer("a1"), second]);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(msgs[0].content).toBe(first.sent);
  expect(msgs[2].content).toBe("q2");
});
