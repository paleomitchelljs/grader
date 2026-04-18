/** Stats panel — stub, filled in during task 16. */
export function mountStatsPanel(root: HTMLElement): void {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<h2>Stats</h2><p>Stats panel will be mounted here.</p>`;
  root.appendChild(panel);
}
