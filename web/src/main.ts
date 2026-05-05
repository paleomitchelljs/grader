import { mountApp } from './ui/app';
import './ui/styles.css';

declare const __GRADER_VERSION__: string;
console.info(
  `%c[grader] build ${__GRADER_VERSION__}`,
  'background:#00509d;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
);

const root = document.getElementById('app');
if (!root) {
  throw new Error('Root #app element missing from index.html');
}
mountApp(root);
