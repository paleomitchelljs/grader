import { mountApp } from './ui/app';
import './ui/styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Root #app element missing from index.html');
}
mountApp(root);
