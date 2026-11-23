import type { PluginTheme } from "@getpaseo/plugin";
import { Markdown as HostMarkdown } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";

// The host's fenced-code renderer scrolls horizontally. Native Text wraps, and these web-only
// CSS properties preserve indentation while also wrapping long tokens in narrow cards.
const webWrap: TextStyle & { whiteSpace: "pre-wrap"; overflowWrap: "anywhere" } = {
  whiteSpace: "pre-wrap", overflowWrap: "anywhere",
};
const fontFamily = Platform.OS === "ios" ? "Menlo" : Platform.OS === "android"
  ? "monospace" : "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Keep the host's rich prose rendering, but let fenced code fit the card instead of scrolling. */
export function Markdown({ children, theme }: { children: string; theme: PluginTheme }) {
  if (!/^[ \t]*(?:`{3,}|~{3,})/m.test(children)) return <HostMarkdown>{children}</HostMarkdown>;
  const blocks: ReactNode[] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const source = lines.join("\n");
    if (fence) {
      blocks.push(
        <View key={blocks.length} style={{ minWidth: 0, backgroundColor: theme.colors.surface2, borderRadius: 6, padding: 10 }}>
          <Text selectable style={[
            { fontFamily, fontSize: 12, lineHeight: 18, color: theme.colors.foreground, flexShrink: 1 },
            Platform.OS === "web" && webWrap,
          ]}>{source}</Text>
        </View>,
      );
    } else if (source.trim()) blocks.push(<HostMarkdown key={blocks.length}>{source}</HostMarkdown>);
    lines = [];
  };
  for (const line of children.split("\n")) {
    if (fence) {
      const closing = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) {
        flush();
        fence = undefined;
      } else lines.push(line);
    } else {
      const opening = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
      // Backtick fences cannot have backticks in their language/info string.
      if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
        flush();
        fence = opening[1];
      } else lines.push(line);
    }
  }
  flush();
  return <View style={{ gap: 8, minWidth: 0 }}>{blocks}</View>;
}
