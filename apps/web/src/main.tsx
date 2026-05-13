import React from 'react';
import ReactDOM from 'react-dom/client';

// Local font assets via @fontsource-variable — never Google Fonts CDN.
// These imports load CSS that declares @font-face rules; Vite copies the
// WOFF2 files to dist/assets at build time.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/source-serif-4';

import './index.css';

import { App } from './app';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
