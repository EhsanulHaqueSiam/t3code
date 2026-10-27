import { installSidebarTree } from "../lib/sidebarTree";
import { useAccessibilitySupport } from "./useAccessibilitySupport";

export function useSidebarTree() {
  const accessible = useAccessibilitySupport();
  const ref = (element: HTMLElement | null) => {
    if (element) return installSidebarTree(element);
  };
  return {
    ref,
    role: "tree",
    "aria-label": "Threads",
    "aria-description": accessible
      ? "Use arrow keys to browse, Right and Left to expand or collapse, and Enter to open. Tab reaches the focused thread's buttons. F2 renames it."
      : undefined,
  } as const;
}
