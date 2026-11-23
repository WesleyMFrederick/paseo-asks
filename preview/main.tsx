import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { AgentAsks, AskCard, AsksView } from "../client/AsksView";
import { OpenPrContext } from "../client/inbox";
import { pillLabel } from "../shared/asks";
import { asks, emptyPill } from "./fixtures";
import { callKey } from "../shared/timeline";

const theme = {
  colors: {
    surface0: "#121316",
    surface1: "#1a1c20",
    surface2: "#24272c",
    border: "#2e3238",
    foreground: "#e8e9eb",
    foregroundMuted: "#8b9099",
    accent: "#7c8cff",
    accentForeground: "#0d0f1a",
    statusSuccess: "#4cc38a",
    statusWarning: "#e5a54b",
    statusDanger: "#ef6a6a",
  },
};

function Frame(props: {
  id: string;
  title: string;
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <View
      testID={props.id}
      style={{
        width: props.width,
        height: props.height,
        borderRadius: 12,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{props.title}</Text>
      </View>
      <View style={{ flex: 1 }}>{props.children}</View>
    </View>
  );
}

/** Older hosts cap the composer popover; Open wide closes it and opens the workspace panel. */
function WidePill() {
  const [wide, setWide] = React.useState(false);
  if (wide)
    return (
      <Frame id="panel-wide" title="Asks · shop-api (opened wide)" width={900} height={620}>
        <AsksView theme={theme} compact={false} workspaceId="api" openAgent={() => {}} />
      </Frame>
    );
  return (
    <View testID="popover" style={{ minWidth: 280, maxWidth: 420, maxHeight: 440, overflow: "scroll" as never, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
      <AgentAsks theme={theme} compact={false} workspaceId="api" agentId="main" onOpenWide={() => setWide(true)} />
    </View>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    {/* PR links open the Inbox, as on an FSH host with paseo-inbox installed. */}
    <OpenPrContext.Provider value={(pr) => console.log("open in Inbox", pr)}>
    <Frame id="main" title="Asks" width={1120} height={760}>
      <AsksView theme={theme} compact={false} openAgent={() => {}} />
    </Frame>
    <Frame id="panel" title="Asks · shop-api" width={620} height={620}>
      <AsksView theme={theme} compact={false} workspaceId="api" openAgent={() => {}} />
    </Frame>
    <Frame id="phone" title="Asks" width={390} height={720}>
      <AsksView theme={theme} compact openAgent={() => {}} />
    </Frame>
    <WidePill />
    <Frame id="phone-pill" title="Asks (phone pill sheet)" width={390} height={520}>
      <AgentAsks theme={theme} compact workspaceId="api" agentId="main" />
    </Frame>
    <Frame id="empty-pill" title={`Empty pill "${pillLabel(asks, emptyPill.agentId)}" · zero asks`} width={390} height={240}>
      <View style={{ padding: 16 }}>
        <AgentAsks theme={theme} compact workspaceId={emptyPill.workspaceId} agentId={emptyPill.agentId} />
      </View>
    </Frame>
    {/* A chief-of-staff chat that owns no asks: its pill lists asks relayed from other workspaces, newest relay open first. */}
    <Frame id="cos-phone-pill" title={`CoS pill "${pillLabel(asks, "cos")}" (phone sheet)`} width={390} height={640}>
      <AgentAsks theme={theme} compact workspaceId="cos-ws" agentId="cos" />
    </Frame>
    <Frame id="chat" title="Agent chat" width={620} height={700}>
      <View style={{ padding: 16, gap: 12, backgroundColor: theme.colors.surface0, flex: 1 }}>
        <AskCard
          theme={theme}
          compact={false}
          agentId="main"
          askId="A2"
          verb="update"
          call={callKey("update", { id: "A2", status: "in_progress" })}
          snapshot={{ status: "in_progress" }}
          changed={["status"]}
        />
        <Text style={{ color: theme.colors.foreground, lineHeight: 20 }}>
          The checkout rework writes the cart on every click, so where carts live has to be settled
          before the CartStore interface is fixed. Today they sit in a 4 KB session cookie and long
          carts get cut short. Redis is fast but loses carts on eviction; Postgres keeps them and
          lets us report on abandoned carts. I recommend Postgres.
        </Text>
        <AskCard
          theme={theme}
          compact={false}
          agentId="main"
          askId="A3"
          verb="create"
          call={callKey("create", { title: "Keep carts in Redis or Postgres?", kind: "decision" })}
          snapshot={asks.find((ask) => ask.workspaceId === "api" && ask.id === "A3")!}
          changed={[]}
        />
      </View>
    </Frame>
    <Frame id="closed-cards" title="Closed ask cards · done and dropped" width={390} height={720}>
      <View style={{ padding: 16, gap: 12, backgroundColor: theme.colors.surface0, flex: 1 }}>
        <Text style={{ color: theme.colors.foregroundMuted, lineHeight: 20 }}>
          Expand each card: its link remains, but answer buttons and the reply field are hidden.
        </Text>
        {asks.filter((ask) => ask.workspaceId === "api" && (ask.id === "A10" || ask.id === "A11")).map((ask) => (
          <AskCard
            key={ask.id}
            theme={theme}
            compact
            agentId="main"
            askId={ask.id}
            verb="create"
            call={callKey("create", { title: ask.title, kind: ask.kind })}
            snapshot={ask}
            changed={[]}
          />
        ))}
      </View>
    </Frame>
    </OpenPrContext.Provider>
  </QueryClientProvider>,
);
