// Entry for the single-file preview build. Installs the in-page router before
// the app boots so every fetch and the live socket hit the simulation.
import { installMock } from './lib/mock';

(window as unknown as { __DOCKET_PREVIEW__: boolean }).__DOCKET_PREVIEW__ = true;
installMock();
void import('./main');
