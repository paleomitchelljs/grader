/**
 * Top-level app shell: FERPA banner, tab navigation, and panel mounting.
 * Individual panels are mounted lazily when their tab is activated.
 */

import { store } from '../state';
import { mountUploadPanel } from './upload-panel';
import { mountReviewPanel } from './review-panel';
import { mountStatsPanel } from './stats-panel';

type TabId = 'upload' | 'review' | 'stats';

export function mountApp(root: HTMLElement) {
  root.innerHTML = '';
  root.appendChild(renderPrivacyBanner());
  root.appendChild(renderHeader());

  const main = document.createElement('main');
  main.className = 'app-main';
  root.appendChild(main);

  let activeTab: TabId = 'upload';

  const renderActive = () => {
    main.innerHTML = '';
    if (activeTab === 'upload') mountUploadPanel(main);
    else if (activeTab === 'review') mountReviewPanel(main);
    else if (activeTab === 'stats') mountStatsPanel(main);
    updateTabButtons();
  };

  const nav = root.querySelector('nav') as HTMLElement;
  const tabs = nav.querySelectorAll('button[data-tab]');
  const updateTabButtons = () => {
    tabs.forEach(btn => {
      const t = (btn as HTMLButtonElement).dataset.tab as TabId;
      btn.classList.toggle('active', t === activeTab);
      // Review and stats only become enabled once there's data.
      const needsData = t === 'review' || t === 'stats';
      (btn as HTMLButtonElement).disabled = needsData && store.state.pages.length === 0;
    });
  };

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const t = (btn as HTMLButtonElement).dataset.tab as TabId;
      if ((btn as HTMLButtonElement).disabled) return;
      activeTab = t;
      renderActive();
    });
  });

  store.subscribe(() => {
    // If user just processed a batch, auto-advance to Review.
    if (activeTab === 'upload' && store.state.pages.length > 0 && store.state.justProcessed) {
      activeTab = 'review';
      store.clearJustProcessed();
      renderActive();
    } else {
      updateTabButtons();
    }
  });

  renderActive();
}

function renderPrivacyBanner(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'banner-privacy';
  el.innerHTML = `<strong>All processing is local.</strong> Your PDFs, answer keys, and student rosters never leave this browser tab. Closing the tab erases everything.`;
  return el;
}

function renderHeader(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = `
    <h1>grader</h1>
    <nav>
      <button data-tab="upload" class="active">Upload</button>
      <button data-tab="review" disabled>Review &amp; Edit</button>
      <button data-tab="stats" disabled>Stats</button>
    </nav>
  `;
  return header;
}
