/** Upload panel — stub, filled in during task 14. */
export function mountUploadPanel(root: HTMLElement): void {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<h2>Upload</h2><p>Upload panel will be mounted here.</p>`;
  root.appendChild(panel);
}
