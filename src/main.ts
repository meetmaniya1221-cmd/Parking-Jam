/** Entry point. Boot to a touchable lot as fast as the browser allows. */

import './style.css';
import { App } from './app';
import { AudioEngine } from './audio/audio';
import { installDebugHandle } from './debug';
import { GameStore } from './meta/store';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app host missing');

  const store = new GameStore();
  const audio = new AudioEngine(store.state.settings);
  const app = new App(root, store, audio);
  installDebugHandle((index) => {
    store.update((s) => {
      s.progress.nextLevel = index;
      s.progress.highest = Math.max(s.progress.highest, index);
      s.resume = null;
    });
    app.playLevel(index);
  });

  // Browsers only allow audio after a gesture; the first touch anywhere unlocks it.
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, { once: false, passive: true });
  window.addEventListener('keydown', unlock, { once: false, passive: true });

  document.addEventListener('visibilitychange', () => app.onVisibilityChange(document.hidden));
  window.addEventListener('pagehide', () => {
    store.update((s) => void (s.lastSeenAt = Date.now()));
    store.flush();
  });

  // An OS interrupt must never cost progress (GDD §14).
  window.addEventListener('blur', () => store.flush());

  app.start();
  document.body.classList.add('booted');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
