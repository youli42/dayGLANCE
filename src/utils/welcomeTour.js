// Welcome tour (DesktopWelcomeModal / MobileWelcomeModal) dismissal (#2034).
//
// The tour is offered once, at boot, to a device whose task list is empty. Once
// the user closes it (any of its buttons), `welcomeDismissed` remembers that
// across restarts, so an empty list (a fresh profile that sync has not filled
// yet, or someone who only uses calendar subscriptions) does not bring it back
// on every launch. The key rides local backups via utils/deviceSettings.js.

export const WELCOME_DISMISSED_KEY = 'welcomeDismissed';

export function isWelcomeDismissed() {
  try {
    return localStorage.getItem(WELCOME_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markWelcomeDismissed() {
  try {
    localStorage.setItem(WELCOME_DISMISSED_KEY, 'true');
  } catch { /* storage unavailable: the tour may show again, nothing worse */ }
}

/** Whether the one-shot boot check should open the tour. */
export function shouldShowWelcomeAtBoot({ hasZeroRealTasks, dismissed }) {
  return !!hasZeroRealTasks && !dismissed;
}
