import { latestRelays, OPEN_STATUSES, showsIn } from "../../shared/asks";
import { asks, workspaces } from "../fixtures";

type Contract = { name: string };

export function useRpc(contract: Contract) {
  return async (input: any): Promise<any> => {
    if (contract.name === "asks.list") {
      // Derive the newest relay before filtering closed asks, as the server does.
      const scoped = input.workspaceId
        ? asks.filter((ask) => showsIn(ask, input.workspaceId))
        : asks;
      return {
        asks: input.includeClosed ? scoped : scoped.filter((ask) => OPEN_STATUSES.includes(ask.status)),
        latestRelays: latestRelays(scoped),
        ...(input.workspaceId ? {} : { workspaceNames: workspaces }),
      };
    }
    if (contract.name === "asks.discuss") return { agentId: "side-chat", created: true };
    if (contract.name === "asks.refresh") return { sent: true };
    const ask = asks.find((candidate) => candidate.workspaceId === input.workspaceId && candidate.id === input.id)!;
    if (contract.name === "asks.locate") return { agentId: ask.ownerAgentId };
    return { ask, delivery: "sent" as const };
  };
}

export function useAgent<T>(_agentId: string, selector: (agent: { workspaceId: string }) => T): T {
  return selector({ workspaceId: "api" });
}

export async function openExternalUrl(url: string) {
  console.log("openExternalUrl", url);
}

export function useSettings() {
  return { status: "ready" as const, values: { foldChatBodies: false } };
}
