/** Review panel — stub, filled in during task 15. */
export function mountReviewPanel(root: HTMLElement): void {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<h2>Review &amp; Edit</h2><p>Review panel will be mounted here.</p>`;
  root.appendChild(panel);
}
