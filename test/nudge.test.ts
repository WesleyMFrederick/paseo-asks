import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import type { Ask } from "../shared/asks";
import { endsWithQuestion, NUDGE, REFRESH, shouldNudge } from "../server/nudge";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { pickCaller } from "../server/agents";
import { isAsksPermission } from "../server/permissions";
import { AskStore } from "../server/store";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const reply = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string) =>
  ({
    type: "tool_call",
    name,
    callId: name,
    status: "completed",
    error: null,
  }) as unknown as AgentTimelineItem;

describe("ask prompts", () => {
  it.each([NUDGE, REFRESH])("keeps deferred work in the work queue rather than manufacturing a human ask", (prompt) => {
    expect(prompt).toMatch(/human.*(?:answer|act|do)/i);
    expect(prompt).toMatch(/deferred or out-of-scope work.*work queue, not asks/i);
    expect(prompt).not.toContain("follow-up you recommended or deferred");
  });
});

describe("shouldNudge", () => {
  const none = () => false;
  const openA3 = (id: string) => id === "A3";

  it("nudges a turn that ends on a question with no ask", async () => {
    expect(
      await shouldNudge([
        user("try PR 11"),
        tool("Bash"),
        reply("Two ways forward.\n\nWhich one?"),
      ], none),
    ).toBe(true);
  });

  it("does not nudge when the turn used an asks tool", async () => {
    expect(
      await shouldNudge([user("go"), tool("mcp__asks__ask_create"), reply("Which one?")], none),
    ).toBe(false);
  });

  it("does not nudge when the reply points to an existing ask", async () => {
    expect(
      await shouldNudge([user("go"), reply("Still waiting on you, see A3. Which one?")], openA3),
    ).toBe(false);
  });

  it("nudges when the reply names only asks from elsewhere", async () => {
    expect(
      await shouldNudge(
        [user("go"), reply("If A30 is truly unused, A29 is worth questioning too. Reply send it?")],
        openA3,
      ),
    ).toBe(true);
  });

  it("does not nudge a reply that only reports", async () => {
    expect(await shouldNudge([user("go"), reply("Is it fixed? Yes.\n\nTests pass.")], none)).toBe(false);
  });

  it("looks only at the latest turn", async () => {
    expect(await shouldNudge([user("a"), reply("Which one?"), user("b"), reply("Done.")], none)).toBe(
      false,
    );
    expect(
      await shouldNudge([
        user("a"),
        tool("mcp__asks__ask_list"),
        reply("ok"),
        user("b"),
        reply("Which one?"),
      ], none),
    ).toBe(true);
  });

  it("never nudges the answer to a nudge", async () => {
    expect(await shouldNudge([user(NUDGE), reply("Which one?")], none)).toBe(false);
  });

  it("joins streamed reply chunks", async () => {
    expect(await shouldNudge([user("go"), reply("Which "), reply("one?")], none)).toBe(true);
  });

  it("keeps the old question-mark heuristic without creating classifier agents", async () => {
    expect(await shouldNudge([user("go"), reply("Decide on the migration, then re-review.")], none)).toBe(false);
    expect(await shouldNudge([user("go"), reply("Which one?")], none)).toBe(true);
  });
});

  describe("re-shown card an open ask already records", () => {
    const ask = (over: Partial<Ask>): Ask => ({
      id: "A9", workspaceId: "wks_1", ownerAgentId: "agent", kind: "decision", title: "Pick the nudge fix",
      actions: [], links: [], status: "open", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", ...over,
    });
    const card = [user("show it again"), reply("Pick the nudge fix\n\nOption one or two?")];
    const idCard = [user("show it again"), reply("Card file decision-toolu_01AbC.\n\nWhich option?")];

    it("does not nudge when the card's decision id is in an open ask's body", async () => {
      // Given an open decision ask whose body names the card file
      const open = ask({ title: "Unrelated heading", body: "card: decision-toolu_01AbC.md" });
      // When the reply re-shows that card, Then no nudge
      expect(await shouldNudge(idCard, () => false, [open])).toBe(false);
    });

    it("does not nudge when the reply carries an open ask's title", async () => {
      // Given an open ask titled like the card
      const open = ask({ title: "  pick the NUDGE   fix " });
      // When the reply re-shows the card, Then no nudge
      expect(await shouldNudge(card, () => false, [open])).toBe(false);
    });

    it("nudges when the matching ask is done or dropped", async () => {
      // Given closed asks that match by id and by title
      const closed = [ask({ status: "done", body: "decision-toolu_01AbC" }), ask({ status: "dropped" })];
      // When either card is re-shown, Then the nudge still fires
      expect(await shouldNudge(idCard, () => false, closed)).toBe(true);
      expect(await shouldNudge(card, () => false, closed)).toBe(true);
    });

    it("nudges a question when the only open ask is unrelated", async () => {
      // Given an open ask about something else
      const other = ask({ title: "Review the billing PR", body: "decision-toolu_other" });
      // When the reply asks a different question, Then the nudge fires
      expect(await shouldNudge(idCard, () => false, [other])).toBe(true);
      expect(await shouldNudge(card, () => false, [other])).toBe(true);
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
    const courier: Courier = {
      state: async () => state,
      send: async (_agent, text) => void sent.push(text),
    };
    const outbox = new Outbox(dir, courier);
    return {
      sent,
      outbox,
      service: new AsksService(new AskStore(dir), outbox, async () => "wks_1"),
    };
  };

  it("sends now to an idle agent", async () => {
    const { sent, service } = setup("idle");
    expect(await service.refresh("agent")).toEqual({ sent: true });
    expect(sent).toEqual([REFRESH]);
  });

  it.each(["running", "steerable"] as const)("waits for a %s agent and does not queue the same request twice", async (state) => {
    const { sent, outbox, service } = setup(state);
    expect(await service.refresh("agent")).toEqual({ sent: false });
    await service.refresh("agent");
    expect(sent).toEqual([]);
    expect(outbox.pending("agent")).toHaveLength(1);
  });
});

describe("isAsksPermission", () => {
  it("recognises Claude and Codex prompts for the asks tools only", () => {
    expect(isAsksPermission({ kind: "tool", name: "mcp__asks__ask_create" })).toBe(true);
    expect(
      isAsksPermission({
        kind: "tool",
        name: "CodexMcpElicitation",
        metadata: { serverName: "asks" },
      }),
    ).toBe(true);
    expect(
      isAsksPermission({
        kind: "tool",
        name: "CodexMcpElicitation",
        metadata: { serverName: "github" },
      }),
    ).toBe(false);
    expect(isAsksPermission({ kind: "tool", name: "Bash" })).toBe(false);
  });
});

describe("pickCaller", () => {
  const agent = (id: string, cwd: string, status = "idle", archivedAt: string | null = null) => ({
    id,
    cwd,
    status,
    archivedAt,
  });
  const home = homedir();

  it("picks the agent mid-turn in the bridge's directory", () => {
    const agents = [
      agent("a", `${home}/w/one`),
      agent("b", "~/w/one", "running"),
      agent("c", `${home}/w/two`, "running"),
    ];
    expect(pickCaller(agents, `${home}/w/one`)).toBe("b");
  });

  it("ignores agents whose bridge sends its own ID, so a Claude agent beside a Codex one is not ambiguous", () => {
    const claude = { ...agent("a", "/w", "running"), provider: "claude" };
    const codex = { ...agent("b", "/w", "running"), provider: "codex" };
    expect(pickCaller([claude, codex], "/w")).toBe("b");
    expect(pickCaller([claude], "/w")).toBe(null);
  });

  it("falls back to the only live agent there, and gives up when it cannot tell", () => {
    expect(pickCaller([agent("a", "/w"), agent("b", "/w", "running", "2026-01-01")], "/w")).toBe(
      "a",
    );
    expect(pickCaller([agent("a", "/w"), agent("b", "/w")], "/w")).toBe(null);
    expect(pickCaller([agent("a", "/w", "running"), agent("b", "/w", "running")], "/w")).toBe(null);
  });
});
