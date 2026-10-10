import { LayerProvider } from '@astryxdesign/core/Layer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TheoremThemeProvider } from '../ui/index.ts';
import Studio from './Studio.tsx';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '../ui/built/theme.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TheoremThemeProvider>
        <LayerProvider>
          <Studio />
        </LayerProvider>
      </TheoremThemeProvider>
    </StrictMode>,
  );
}
