import { useServices } from '@/components/app-shell/services-provider';
import { useAppSelector } from '@/store';
import { useEffect } from 'react';

/** Starts accepting workouts from the Garmin watch once stored data has loaded (Android only; a no-op elsewhere). */
export function GarminWatchGate() {
  const { watchSyncService } = useServices();
  const ready = useAppSelector((s) => s.settings.isHydrated && s.program.isHydrated);
  useEffect(() => {
    if (ready) {
      void watchSyncService.startListening();
    }
  }, [ready, watchSyncService]);
  return null;
}
