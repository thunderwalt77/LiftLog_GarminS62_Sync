import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDate } from '@js-joda/core';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';
import { ProgramBlueprint, SessionBlueprint } from '@/models/blueprint-models';
import { makeWeightedBlueprint } from '@/models/session-models/__test__/helpers';
import { DatabaseMigrationService } from '@/services/database-migration-service';
import { GarminBridge, WatchSyncService } from '@/services/watch-sync/watch-sync-service';
import type { RootState } from '@/store';

let db: ExpoSQLiteDatabase;

beforeEach(async () => {
  db = drizzle(await openDatabaseAsync(':memory:'));
  await new DatabaseMigrationService(db, { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never, {
    importOldData: async () => {},
  }).migrate();
});

const program = new ProgramBlueprint(
  'Upper/Lower',
  [
    new SessionBlueprint(
      'Upper Body',
      [makeWeightedBlueprint({ name: 'Dumbbell Bench Press', alternatives: ['Machine Chest Press'] })],
      '',
    ),
  ],
  LocalDate.now(),
);
const state = {
  program: { activePlanId: 'plan-1', savedPrograms: { 'plan-1': program } },
  settings: { useImperialUnits: false },
} as unknown as RootState;

/** A watch that answers each programme end with `ok`, or stays silent when `ok` is undefined. */
function fakeWatch(
  opts: { ok?: boolean; sendStatus?: string; devices?: { id: string; name: string; status: string }[] } = {},
) {
  const sent: Record<string, unknown>[] = [];
  let listener: ((e: { deviceId: string; json: string }) => void) | undefined;
  const bridge: GarminBridge = {
    initialize: async () => 'READY',
    getDevices: async () => opts.devices ?? [{ id: '7', name: 'Approach S62', status: 'CONNECTED' }],
    send: async (deviceId, json) => {
      const message = JSON.parse(json) as Record<string, unknown>;
      sent.push(message);
      if (message.t === 'pe' && opts.ok !== undefined) {
        queueMicrotask(() =>
          listener?.({ deviceId, json: JSON.stringify({ t: 'pa', id: message.id, rev: message.rev, ok: opts.ok }) }),
        );
      }
      return opts.sendStatus ?? 'SUCCESS';
    },
    addListener: (_event, l) => {
      listener = l;
      return { remove: () => (listener = undefined) };
    },
  };
  return { bridge, sent };
}

describe('WatchSyncService.sendProgramme', () => {
  it('sends the active plan and succeeds when the watch confirms', async () => {
    const watch = fakeWatch({ ok: true });
    const result = await new WatchSyncService(
      db,
      () => state,
      () => watch.bridge,
    ).sendProgramme();

    expect(result).toEqual({ ok: true, watch: 'Approach S62' });
    expect(watch.sent.map((m) => m.t)).toEqual(['pb', 'pw', 'pe']);
    expect(watch.sent[0]).toMatchObject({ id: 'plan-1', name: 'Upper/Lower', n: 1 });
  });

  it('reports a rejected plan', async () => {
    const watch = fakeWatch({ ok: false });
    expect(
      await new WatchSyncService(
        db,
        () => state,
        () => watch.bridge,
      ).sendProgramme(),
    ).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('stops at the first message that fails to send', async () => {
    const watch = fakeWatch({ sendStatus: 'FAILURE_DEVICE_NOT_CONNECTED' });
    const result = await new WatchSyncService(
      db,
      () => state,
      () => watch.bridge,
    ).sendProgramme();

    expect(result).toEqual({ ok: false, reason: 'send-failed', detail: 'FAILURE_DEVICE_NOT_CONNECTED' });
    expect(watch.sent).toHaveLength(1);
  });

  it('needs a connected watch', async () => {
    const watch = fakeWatch({ devices: [{ id: '7', name: 'Approach S62', status: 'NOT_CONNECTED' }] });
    expect(
      await new WatchSyncService(
        db,
        () => state,
        () => watch.bridge,
      ).sendProgramme(),
    ).toEqual({
      ok: false,
      reason: 'no-watch',
    });
  });

  it('reports an error instead of throwing', async () => {
    const watch = fakeWatch({ ok: true });
    watch.bridge.send = () => Promise.reject(new Error('bridge exploded'));
    expect(
      await new WatchSyncService(
        db,
        () => state,
        () => watch.bridge,
      ).sendProgramme(),
    ).toEqual({
      ok: false,
      reason: 'error',
      detail: 'bridge exploded',
    });
  });

  it('is unsupported without the native bridge', async () => {
    const service = new WatchSyncService(
      db,
      () => state,
      () => undefined,
    );
    expect(service.isSupported).toBe(false);
    expect(await service.sendProgramme()).toEqual({ ok: false, reason: 'unsupported' });
  });
});
