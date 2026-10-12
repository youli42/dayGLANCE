import { useEffect, useRef } from 'react';
import { isNativeAndroid, isNativeApp } from '../native.js';

import { isTrayMode } from '../utils/trayMode.js';
import { isWelcomeDismissed, markWelcomeDismissed, shouldShowWelcomeAtBoot } from '../utils/welcomeTour.js';

export default function useAppInit({
  loadData, fetchAllDailyContent, setContentRotation,
  dailyContentEnabled,
  dataLoaded, hasZeroRealTasks,
  hasCheckedInitialWelcome,
  showWelcome, setShowWelcome,
}) {
  // Load data and fetch daily content on mount; rotate content every 15 minutes
  useEffect(() => {
    loadData();
    if (isTrayMode) return;
    if (dailyContentEnabled && !isNativeApp()) {
      fetchAllDailyContent();
    }

    // Rotate content every 15 minutes
    const rotationInterval = setInterval(() => {
      setContentRotation(prev => (prev + 1) % 4);
    }, 15 * 60 * 1000);

    return () => {
      clearInterval(rotationInterval);
    };
    // Mount-once: load data and start the rotation interval exactly once. Re-running
    // on dependency changes would reload data and reset the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember that the tour was closed, so it is not re-offered on every boot
  // while the task list is empty (#2034). Only a close of a tour that was
  // actually open counts: showWelcome starts false before the boot check.
  const welcomeWasShown = useRef(false);
  useEffect(() => {
    if (isTrayMode) return;
    if (showWelcome) {
      welcomeWasShown.current = true;
    } else if (welcomeWasShown.current) {
      welcomeWasShown.current = false;
      markWelcomeDismissed();
    }
  }, [showWelcome]);

  // Show welcome only on initial load with zero tasks (not when zeroing out
  // during session), and only until the user has closed it once.
  useEffect(() => {
    if (isTrayMode) return;
    if (dataLoaded && !hasCheckedInitialWelcome.current) {
      hasCheckedInitialWelcome.current = true;
      setShowWelcome(shouldShowWelcomeAtBoot({ hasZeroRealTasks, dismissed: isWelcomeDismissed() }));
    }
  }, [dataLoaded, hasZeroRealTasks, hasCheckedInitialWelcome, setShowWelcome]);
}
