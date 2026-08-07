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
  installDebugHandle({
    jumpTo: (index) => {
      store.update((s) => {
        s.progress.nextLevel = index;
        s.progress.highest = Math.max(s.progress.highest, index);
        s.resume = null;
      });
      app.playLevel(index);
    },
    seed: (patch) => {
      store.update((s) => {
        if (patch.level !== undefined) {
          s.progress.nextLevel = patch.level;
          s.progress.highest = Math.max(s.progress.highest, patch.level);
        }
        if (patch.coins !== undefined) s.wallet.coins = patch.coins;
        if (patch.medallions !== undefined) s.wallet.medallions = patch.medallions;
        if (patch.blueprints !== undefined) s.wallet.blueprints = patch.blueprints;
        if (patch.backdateIncomeHours !== undefined) {
          s.income.lastCollectAt = Date.now() - patch.backdateIncomeHours * 3_600_000;
        }
        if (patch.settings) Object.assign(s.settings, patch.settings);
      });
      app.applySettings(store.state.settings);
      app.refreshAll();
    },
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
