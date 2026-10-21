import { icons } from "lucide-react";
export { ScrollView, TextInput } from "react-native";

export function Icon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const Lucide = icons[name as keyof typeof icons];
  if (!Lucide) throw new Error(`Unknown Lucide icon ${name}`);
  return <Lucide size={size} color={color} />;
}

// Stand-in for Paseo's host toast: a visible banner at the bottom of the page, plus the console line.
function showToast(message: string, variant: "info" | "warning" | "error") {
  const toast = document.createElement("div");
  toast.setAttribute("role", "status");
  toast.dataset.testid = "toast";
  toast.textContent = message;
  const background = variant === "error" ? "#ef6a6a" : variant === "warning" ? "#e5a54b" : "#24272c";
  Object.assign(toast.style, {
    position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", padding: "10px 16px",
    borderRadius: "8px", background, color: "#e8e9eb", font: "14px system-ui", border: "1px solid #2e3238", zIndex: "10",
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
  (variant === "error" ? console.error : console.log)(message);
}

export function useToast() {
  return {
    show: (message: string, options?: { variant?: "warning" }) => showToast(message, options?.variant ?? "info"),
    error: (message: string) => showToast(message, "error"),
  };
}
