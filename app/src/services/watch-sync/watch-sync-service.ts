import { readExistingSessionIds, readLatestExercises, writeSession } from '@/db/sessions';
import type { RootState } from '@/store';
import { sessionsChanged } from '@/store/stored-sessions';
import { isWatchWorkout, watchWorkoutToSession } from '@/services/watch-sync/watch-import';
import {
  buildWatchProgramme,
  toWatchMessages,
  watchProgressionKeys,
  WatchMessage,
} from '@/services/watch-sync/watch-programme';
import { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { getGarminModule } from '~/modules/native-lib/src/LiftLogGarminModule';

/** The native Garmin bridge, narrowed to what sync needs so tests can stand in for it. */
export interface GarminBridge {
  initialize(): Promise<string>;
  getDevices(): Promise<{ id: string; name: string; status: string }[]>;
  send(deviceId: string, json: string): Promise<string>;
  listen(deviceId: string): Promise<string>;
  addListener(event: 'onMessage', listener: (e: { deviceId: string; json: string }) => void): { remove(): void };
}

export type WatchSyncResult =
  | { ok: true; watch: string }
  | {
      ok: false;
      reason: 'unsupported' | 'sdk' | 'no-watch' | 'send-failed' | 'no-reply' | 'rejected' | 'error';
      detail?: string;
    };

/** What the Garmin watch screen shows about workouts received from the watch. */
export interface WatchReceipt {
  imported: number;
  duplicates: number;
  failed: number;
  lastName?: string;
  lastAt?: number;
}

const replyTimeoutMs = 20_000;

export class WatchSyncService {
  private listening = false;
  private receipt: WatchReceipt = { imported: 0, duplicates: 0, failed: 0 };
  private receiptListeners = new Set<(receipt: WatchReceipt) => void>();

  constructor(
    private db: ExpoSQLiteDatabase,
    private getState: () => RootState,
    private dispatch: (action: ReturnType<typeof sessionsChanged>) => unknown,
    private getBridge: () => GarminBridge | undefined = getGarminModule,
  ) {}

  get lastReceipt() {
    return this.receipt;
  }

  onReceipt(listener: (receipt: WatchReceipt) => void) {
    this.receiptListeners.add(listener);
    return () => {
      this.receiptListeners.delete(listener);
    };
  }

  /**
   * Accepts finished workouts from the watch while LiftLog is open. Each one is saved before it is
   * acknowledged, so the watch only deletes a workout LiftLog has stored. Never throws.
   */
  async startListening(): Promise<void> {
    const bridge = this.getBridge();
    if (!bridge || this.listening) {
      return;
    }
    try {
      if ((await bridge.initialize()) !== 'READY') {
        return;
      }
      this.listening = true;
      bridge.addListener('onMessage', (event) => void this.onWatchMessage(bridge, event));
      for (const device of await bridge.getDevices()) {
        await bridge.listen(device.id);
      }
    } catch {
      this.listening = false;
    }
  }

  private async onWatchMessage(bridge: GarminBridge, event: { deviceId: string; json: string }) {
    const message = parse(event.json);
    if (message?.t !== 'wo' || !isWatchWorkout(message.w)) {
      return;
    }
    const workout = message.w;
    const outcome = this.importWorkout(workout);
    this.receipt = {
      imported: this.receipt.imported + (outcome === 'imported' ? 1 : 0),
      duplicates: this.receipt.duplicates + (outcome === 'duplicate' ? 1 : 0),
      failed: this.receipt.failed + (outcome === 'failed' ? 1 : 0),
      lastName: workout.name,
      lastAt: Date.now(),
    };
    this.receiptListeners.forEach((listener) => listener(this.receipt));
    try {
      await bridge.send(event.deviceId, JSON.stringify({ t: 'wa', uuid: workout.uuid, ok: outcome !== 'failed' }));
    } catch {
      // The watch keeps the workout and offers it again on the next sync.
    }
  }

  /** Saves a watch workout as a session; a workout already imported is acknowledged again, not duplicated. */
  importWorkout(workout: Parameters<typeof watchWorkoutToSession>[0]): 'imported' | 'duplicate' | 'failed' {
    try {
      if (readExistingSessionIds(this.db, [workout.uuid]).has(workout.uuid)) {
        return 'duplicate';
      }
      const state = this.getState();
      const program = state.program.savedPrograms[state.program.activePlanId];
      const session = watchWorkoutToSession(workout, program);
      this.db.transaction((tx) => writeSession(tx, session));
      this.dispatch(sessionsChanged());
      return 'imported';
    } catch {
      return 'failed';
    }
  }

  get isSupported() {
    return this.getBridge() !== undefined;
  }

  /** Sends the active plan. The LiftLog app must be open on the watch to receive it. Never throws. */
  async sendProgramme(): Promise<WatchSyncResult> {
    try {
      return await this.trySendProgramme();
    } catch (error) {
      return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async trySendProgramme(): Promise<WatchSyncResult> {
    const bridge = this.getBridge();
    if (!bridge) {
      return { ok: false, reason: 'unsupported' };
    }
    const sdk = await bridge.initialize();
    if (sdk !== 'READY') {
      return { ok: false, reason: 'sdk', detail: sdk };
    }
    const watch = (await bridge.getDevices()).find((d) => d.status === 'CONNECTED');
    if (!watch) {
      return { ok: false, reason: 'no-watch' };
    }

    const state = this.getState();
    const program = state.program.savedPrograms[state.program.activePlanId]!;
    const programme = buildWatchProgramme({
      id: state.program.activePlanId,
      rev: Math.floor(Date.now() / 1000),
      program,
      latest: readLatestExercises(this.db, watchProgressionKeys(program)),
      unit: state.settings.useImperialUnits ? 'pounds' : 'kilograms',
    });

    const reply = this.waitForReply(bridge, watch.id, programme.rev);
    try {
      for (const message of toWatchMessages(programme)) {
        const status = await bridge.send(watch.id, JSON.stringify(message satisfies WatchMessage));
        if (status !== 'SUCCESS') {
          return { ok: false, reason: 'send-failed', detail: status };
        }
      }
      const answer = await reply.promise;
      if (answer === undefined) {
        return { ok: false, reason: 'no-reply' };
      }
      return answer ? { ok: true, watch: watch.name } : { ok: false, reason: 'rejected' };
    } finally {
      reply.cancel();
    }
  }

  private waitForReply(bridge: GarminBridge, deviceId: string, rev: number) {
    let cancel = () => {};
    const promise = new Promise<boolean | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), replyTimeoutMs);
      const subscription = bridge.addListener('onMessage', (event) => {
        if (event.deviceId !== deviceId) {
          return;
        }
        const message = parse(event.json);
        if (message?.t === 'pa' && message.rev === rev) {
          resolve(message.ok === true);
        }
      });
      cancel = () => {
        clearTimeout(timer);
        subscription.remove();
      };
    });
    return { promise, cancel };
  }
}

function parse(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
