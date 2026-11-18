import { latestRelays } from "../../shared/asks";
import { asks, workspaces } from "../fixtures";

type Contract = { name: string };

export function useRpc(contract: Contract) {
  return async (input: any): Promise<any> => {
    if (contract.name === "asks.list") {
      // As the server does: the latest relay per reader comes from the listed asks, closed ones included.
      if (input.workspaceId) {
        const scoped = asks.filter((ask) => ask.workspaceId === input.workspaceId);
        return { asks: scoped, latestRelays: latestRelays(scoped) };
      }
      return { asks, latestRelays: latestRelays(asks), workspaceNames: workspaces };
    }
    if (contract.name === "asks.discuss") return { agentId: "side-chat", created: true };
    const ask = asks.find((candidate) => candidate.workspaceId === input.workspaceId && candidate.id === input.id)!;
    return { ask, delivery: "sent" as const };
  };
}

export async function openExternalUrl(url: string) {
  console.log("openExternalUrl", url);
}
