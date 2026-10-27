/** Alternating atomic live regions allow repeated user actions to be announced, as in VS Code aria.ts. */
export function announceSidebarVisibility(open: boolean) {
  let container = document.getElementById("workspace-visibility-alerts");
  const created = !container;
  if (!container) {
    container = document.createElement("div");
    container.id = "workspace-visibility-alerts";
    container.className = "sr-only";
    for (let index = 0; index < 2; index++) {
      const alert = document.createElement("div");
      alert.setAttribute("aria-live", "polite");
      alert.setAttribute("aria-atomic", "true");
      container.append(alert);
    }
    document.body.append(container);
  }
  const [first, second] = Array.from(container.children);
  const write = () => {
    const next = first!.textContent ? second! : first!;
    first!.textContent = "";
    second!.textContent = "";
    next.textContent = `Sidebar ${open ? "shown" : "hidden"}`;
  };
  // Screen readers ignore text written in the same task that inserts its live region.
  if (created) setTimeout(write, 100);
  else write();
}
