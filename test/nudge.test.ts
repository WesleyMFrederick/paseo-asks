import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import type { Ask } from "../shared/asks";
import { endsWithQuestion, NUDGE, REFRESH, shouldNudge } from "../server/nudge";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const reply = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string) => ({ type: "tool_call", name, callId: name, status: "completed", error: null }) as unknown as AgentTimelineItem;

describe("shouldNudge", () => {
  it("nudges a turn that ends on a question with no ask", () => {
    expect(shouldNudge([user("try PR 11"), tool("Bash"), reply("Two ways forward.\n\nWhich one?")])).toBe(true);
  });

  it("does not nudge when the turn used an asks tool", () => {
    expect(shouldNudge([user("go"), tool("mcp__asks__ask_create"), reply("Which one?")])).toBe(false);
  });

  it("does not nudge when the reply points to an existing ask", () => {
    expect(shouldNudge([user("go"), reply("Still waiting on you, see A3. Which one?")])).toBe(false);
  });

  it("does not nudge a reply that only reports", () => {
    expect(shouldNudge([user("go"), reply("Is it fixed? Yes.\n\nTests pass.")])).toBe(false);
  });

  it("looks only at the latest turn", () => {
    expect(shouldNudge([user("a"), reply("Which one?"), user("b"), reply("Done.")])).toBe(false);
    expect(shouldNudge([user("a"), tool("mcp__asks__ask_list"), reply("ok"), user("b"), reply("Which one?")])).toBe(true);
  });

  it("never nudges the answer to a nudge", () => {
    expect(shouldNudge([user(NUDGE), reply("Which one?")])).toBe(false);
  });

  it("joins streamed reply chunks", () => {
    expect(shouldNudge([user("go"), reply("Which "), reply("one?")])).toBe(true);
  });

  describe("re-shown card an open ask already records", () => {
    const ask = (over: Partial<Ask>): Ask => ({
      id: "A9", workspaceId: "wks_1", ownerAgentId: "agent", kind: "decision", title: "Pick the nudge fix",
      actions: [], links: [], status: "open", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", ...over,
    });
    const card = [user("show it again"), reply("Pick the nudge fix\n\nOption one or two?")];
    const idCard = [user("show it again"), reply("Card file decision-toolu_01AbC.\n\nWhich option?")];

    it("does not nudge when the card's decision id is in an open ask's body", () => {
      // Given an open decision ask whose body names the card file
      const open = ask({ title: "Unrelated heading", body: "card: decision-toolu_01AbC.md" });
      // When the reply re-shows that card, Then no nudge
      expect(shouldNudge(idCard, [open])).toBe(false);
    });

    it("does not nudge when the reply carries an open ask's title", () => {
      // Given an open ask titled like the card
      const open = ask({ title: "  pick the NUDGE   fix " });
      // When the reply re-shows the card, Then no nudge
      expect(shouldNudge(card, [open])).toBe(false);
    });

    it("nudges when the matching ask is done or dropped", () => {
      // Given closed asks that match by id and by title
      const closed = [ask({ status: "done", body: "decision-toolu_01AbC" }), ask({ status: "dropped" })];
      // When either card is re-shown, Then the nudge still fires
      expect(shouldNudge(idCard, closed)).toBe(true);
      expect(shouldNudge(card, closed)).toBe(true);
    });

    it("nudges a question when the only open ask is unrelated", () => {
      // Given an open ask about something else
      const other = ask({ title: "Review the billing PR", body: "decision-toolu_other" });
      // When the reply asks a different question, Then the nudge fires
      expect(shouldNudge(idCard, [other])).toBe(true);
      expect(shouldNudge(card, [other])).toBe(true);
    });
  });
});

describe("endsWithQuestion", () => {
  it("ignores question marks in code and links", () => {
    expect(endsWithQuestion("Run `a?.b` here.")).toBe(false);
    expect(endsWithQuestion("See https://x.dev/p?q=1")).toBe(false);
    expect(endsWithQuestion("```\nwhy?\n```")).toBe(false);
  });
});

describe("refresh", () => {
  const setup = (state: AgentState) => {
    const dir = mkdtempSync(join(tmpdir(), "asks-"));
    const sent: string[] = [];
    const courier: Courier = { state: async () => state, send: async (_agent, text) => void sent.push(text) };
    const outbox = new Outbox(dir, courier);
    return { sent, outbox, service: new AsksService(new AskStore(dir), outbox, async () => "wks_1") };
  };

  it("sends now to an idle agent", async () => {
    const { sent, service } = setup("idle");
    expect(await service.refresh("agent")).toEqual({ sent: true });
    expect(sent).toEqual([REFRESH]);
  });

  it("waits for a running agent and does not queue the same request twice", async () => {
    const { sent, outbox, service } = setup("running");
    expect(await service.refresh("agent")).toEqual({ sent: false });
    await service.refresh("agent");
    expect(sent).toEqual([]);
    expect(outbox.pending("agent")).toHaveLength(1);
  });
});
