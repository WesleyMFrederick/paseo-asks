# Asks for Paseo

Asks is a [Paseo](https://paseo.sh) plugin. It lifts what your agents need from you out of their chats and into one list. When an agent needs a PR reviewed, a decision made, a follow-up approved or a manual step done, it records an **ask**. Each ask carries the buttons that answer it, and pressing one sends the answer back to the agent that raised it.

| Workspace panel, a decision with a markdown brief | Every workspace, on a phone, a PR ask expanded |
|---|---|
| ![Asks panel in a workspace](docs/panel.png) | ![Asks across workspaces on a phone](docs/phone.png) |

<sub>The screenshots render the plugin's own React Native components with sample data, using react-native-web (`preview/`). Inside Paseo they sit in its panel and screen chrome.</sub>

## What you can do with an ask

- **Pick an option.** A decision's options are buttons, and the agent's recommendation is starred. The agent gets `[asks] A3 resolved: b: squash-only`.
- **Hand work back.** A PR or follow-up offers actions such as "Merge (squash)". Pressing one sends the agent that exact instruction and shows the ask as *in progress* until the agent closes it.
- **Reply, mark done, or drop.** A note can go along with any of these.
- **Discuss.** Opens a side chat about this one ask. It's a child of the main agent, starts read-only (plan mode), and already knows the ask and the main agent's latest reply. Talk it through there. When you settle it, the side chat closes the ask, and the main agent gets the outcome as one message: `[asks] A3 resolved in a side chat: … Summary: …`. Only the main agent ever changes the checkout.
- **Open chat.** Jumps to the agent that raised the ask.

PR asks show live status from `gh`: open, merged or closed, checks, review decision and conflicts. An agent that subscribed to a PR ask is told when it merges, closes, its checks pass or fail, or its review decision changes.

## Where asks show up

- an **Asks** panel in each workspace (also in ⌘K: "Open asks for this workspace");
- an **Asks** screen in the sidebar, covering every workspace, with a count of what's waiting;
- an **Asks · n** (or **No asks**) pill in every agent's composer. It counts the same asks its popover lists, so in-progress ones show as **Asks · 1 in progress**, never as **No asks**. Pressing it shows that agent's asks in the same collapsed list as the sidebar (tap one to open it), with a **Refresh asks** button that tells the agent to bring them up to date: create asks it skipped, and update or resolve stale ones. Paseo caps plugin popovers at 420 wide, so on wide layouts an **Open wide** button opens the Asks panel beside the chat. Phones get Paseo's bottom sheet instead.
  The pill also counts and lists asks *relayed* to the agent: asks other agents own, from any workspace, that its replies pointed at (a Chief of Staff's "→ Open … answer its decision card"). The asks of the newest relay open expanded with their buttons, and a row from another workspace names that workspace above its title. Answers still go to the agent that owns the ask.
  Each relay request has its own persisted batch identity and shared recency stamp, with a separate pointer index; only its newest batch starts expanded, even when two replies arrive in the same millisecond. The open-only list includes latest-relay metadata from closed asks: completing the newest batch leaves older rows collapsed. Older entries without batch identities remain readable and expand individually only when newest. Automatically in-progress asks keep their unsent action buttons; a human send still hides send actions and a second send press is refused, even when both presses arrive at once: the plugin checks and marks the send under the store lock before it queues anything. Relays validate every target under the workspace locks and reject the entire request if any ask is missing, closed, dropped, or orphaned. Concurrent readers retain independent stamps without changing the ask's updated time.

## How it works

```
agent ──stdio MCP──▶ bridge.mjs ──HTTP 127.0.0.1──▶ plugin server ──▶ ~/.paseo/plugin-data/asks/
  ▲                    (inherits PASEO_AGENT_ID,                  │  workspaces/<id>.json, outbox.json
  │                     so every call knows its caller)           │
  └──── "[asks] …" message, held until the agent's turn ends ─────┘
```

- Every agent created after the plugin is installed gets an `asks` MCP server with `ask_create`, `ask_update`, `ask_resolve` and `ask_list`. Its instructions tell the agent when to use them, so no `CLAUDE.md` edit is needed.
- Agents sometimes ask in chat and skip `ask_create`. When a turn ends on a question, uses no asks tool and names no ask id, the plugin sends one `[asks]` reminder. A reply that re-shows a decision card an open ask already records (the reply names a `decision-…` id found in that ask, or quotes that ask's title) is not reminded. Its answer is never reminded again, and side chats are never reminded.
- Answers are written to an on-disk outbox first. They're sent only when the agent is between turns, because a prompt sent mid-turn interrupts it, and several answers are batched into one message. A plugin restart loses nothing.
- If the agent that raised an ask is archived, the ask is marked *orphaned*: you can still close it, and nobody is notified.
- Every Drop, Done, Reply or option press confirms who heard: the agent was told now, will be told when its current turn ends, or (orphaned) nobody. Acting on an ask that is already done or dropped fails with "A2 is already dropped; nothing was changed or sent", so a second press never re-sends. Each press, applied or refused, is one line in `act-log.jsonl` in the data folder.
- Ask ids count per workspace: "A2" in one workspace and "A2" in another are different asks with different owners.

## Status follows the owner

An ask is `in_progress` while the agent that raised it runs a turn, and `open` while that agent is idle. The plugin sets this itself from the agent's turn events (and re-checks every 20 s to catch missed events and plugin reloads), so agents never flip `open`/`in_progress` by hand. A new ask starts `in_progress`, because its owner is mid-turn when it creates it.

The `autoStatus` flag on an ask marks an `in_progress` the plugin set, which it may set back to `open`. A human **send** action, or the owner explicitly choosing `in_progress` for work that spans turns, clears the flag, and the ask stays `in_progress` until someone changes it. Automatic flips compare the status and flag again inside the store lock, so an owner-state lookup that began before a human send cannot overwrite it.

Every automatic flip is one JSON line in `status-flip-log.jsonl` in the data folder (`~/.paseo/plugin-data/asks/`): `{ at, cause, workspaceId, askId, ownerAgentId, from, to }`, where `cause` is `turn_started`, `turn_ended`, `owner_call` or `reconcile`.

## Install

Paseo 0.12 or newer, with plugins enabled on the daemon. `gh`, if installed in `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`, adds live PR status.

```bash
git clone git@github.com:fullstackhouse/paseo-asks.git
cd paseo-asks && npm install
paseo plugin install "$PWD"
paseo plugin ls            # paseo-asks should be "running"
```

Agents that already exist don't get the tools. Start a new agent.

## From a terminal

The plugin writes the port and token of its local listener to `~/.paseo/plugin-data/asks/server.json`, so scripts can do what the UI does:

```bash
S=~/.paseo/plugin-data/asks/server.json
P=$(jq -r .port $S); T=$(jq -r .token $S)
curl -s -H "authorization: Bearer $T" -X POST localhost:$P/act \
  -d '{"workspaceId":"wks_…","id":"A3","verb":"action","actionId":"a2"}'
curl -s -H "authorization: Bearer $T" -X POST localhost:$P/discuss -d '{"workspaceId":"wks_…","id":"A3"}'
# Relay asks to the agent whose reply pointed at them (the harness does this at turn end), in pointer order:
curl -s -H "authorization: Bearer $T" -X POST localhost:$P/relay \
  -d '{"readerAgentId":"agent-…","asks":[{"workspaceId":"wks_…","id":"A3"}]}'
```

## Develop

```bash
npm run typecheck      # client and server tsconfigs
npm test               # vitest: store, outbox, tools, side chats, PR watching
paseo plugin reload paseo-asks && paseo plugin logs paseo-asks
cd preview && npm install && npm run dev   # the UI with sample data, at localhost:5199
```


## Design decisions

- **Agents report asks themselves.** Nothing reads transcripts to find them: only the agent knows what it is waiting on.
- **Four fixed action kinds** (`send`, `resolve`, `open`, plus the built-in Discuss). Agents supply labels and prompts, never arbitrary behaviour.
- **One writer per checkout.** Work goes back to the main agent; side chats are read-only and end with an outcome on the ask.
- **Push, held until the turn ends.** Answers reach the agent as prompts, from a disk outbox, never mid-turn.
- **External events only if subscribed,** so polling `gh` never wakes an agent for nothing.

## Limits

- Lists refresh by polling (every 4 s, and every 8 s for pill counts). Paseo has no plugin channel for pushing updates to the app.
- Side chats need a provider with a read-only mode. Claude has `plan`; with any other provider, Discuss reports an error.
- It's unverified whether agents created before a daemon restart keep the tools after it.
