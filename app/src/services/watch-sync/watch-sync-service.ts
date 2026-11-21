import { readLatestExercises } from '@/db/sessions';
import type { RootState } from '@/store';
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
  addListener(event: 'onMessage', listener: (e: { deviceId: string; json: string }) => void): { remove(): void };
}

export type WatchSyncResult =
  | { ok: true; watch: string }
  | {
      ok: false;
      reason: 'unsupported' | 'sdk' | 'no-watch' | 'send-failed' | 'no-reply' | 'rejected' | 'error';
      detail?: string;
    };

const replyTimeoutMs = 20_000;

export class WatchSyncService {
  constructor(
    private db: ExpoSQLiteDatabase,
    private getState: () => RootState,
    private getBridge: () => GarminBridge | undefined = getGarminModule,
  ) {}

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
