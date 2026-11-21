import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDate } from '@js-joda/core';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';
import { ProgramBlueprint, SessionBlueprint } from '@/models/blueprint-models';
import { RecordedWeightedExercise } from '@/models/session-models';
import { makeWeightedBlueprint } from '@/models/session-models/__test__/helpers';
import { readSession } from '@/db/sessions';
import { DatabaseMigrationService } from '@/services/database-migration-service';
import { isWatchWorkout, watchWorkoutToSession, WatchWorkout } from '@/services/watch-sync/watch-import';
import { GarminBridge, WatchSyncService } from '@/services/watch-sync/watch-sync-service';
import type { RootState } from '@/store';

const bench = makeWeightedBlueprint({
  name: 'Dumbbell Bench Press',
  sets: 3,
  repsConfig: { type: 'fixed', reps: 8 },
  alternatives: ['Machine Chest Press'],
});
const row = makeWeightedBlueprint({ name: 'Seated Cable Row', sets: 3, repsConfig: { type: 'fixed', reps: 10 } });
const program = new ProgramBlueprint(
  'Upper/Lower',
  [new SessionBlueprint('Upper Body', [bench, row], '')],
  LocalDate.now(),
);

const start = 1_795_000_000;
const workout: WatchWorkout = {
  uuid: '5b4e7a10-0000-4000-8000-000000000001',
  name: 'Upper Body',
  start,
  end: start + 3000,
  ex: [
    {
      pid: bench.movementKey(),
      pname: 'Dumbbell Bench Press',
      aid: 'machine chest press|WeightedExerciseBlueprint',
      aname: 'Machine Chest Press',
      reason: 'No kit',
      ps: 3,
      reps: 8,
      sets: [
        [10, 45, start + 300],
        [10, 45, start + 420],
        [9, 45, start + 540],
      ],
    },
    {
      pid: row.movementKey(),
      pname: 'Seated Cable Row',
      aid: row.movementKey(),
      aname: 'Seated Cable Row',
      reason: null,
      ps: 3,
      reps: 10,
      sets: [[10, 50, start + 900]],
    },
  ],
};

describe('watchWorkoutToSession', () => {
  it('records the performed exercise under its own name, keeping the plan settings and noting the swap', () => {
    const session = watchWorkoutToSession(workout, program);

    expect(session.id).toBe(workout.uuid);
    const swapped = session.recordedExercises[0] as RecordedWeightedExercise;
    expect(swapped.blueprint.name).toBe('Machine Chest Press');
    expect(swapped.blueprint.progression).toEqual(bench.progression);
    expect(swapped.blueprint.alternatives).toEqual([]);
    expect(swapped.notes).toBe('Swapped from Dumbbell Bench Press (No kit) on watch');
    expect(swapped.potentialSets.map((s) => s.set?.repsCompleted)).toEqual([10, 10, 9]);
    expect(swapped.potentialSets[0]!.weight.value.toNumber()).toBe(45);
    expect(swapped.progressionKey()).not.toBe(bench.progressionKey());
  });

  it('keeps unlogged planned sets as not done', () => {
    const rowDone = watchWorkoutToSession(workout, program).recordedExercises[1] as RecordedWeightedExercise;

    expect(rowDone.blueprint.equals(row)).toBe(true);
    expect(rowDone.notes).toBeUndefined();
    expect(rowDone.potentialSets.map((s) => s.set?.repsCompleted)).toEqual([10, undefined, undefined]);
  });

  it('still imports when the plan no longer has the exercise', () => {
    const session = watchWorkoutToSession(workout, undefined);
    expect(session.recordedExercises[1]!.blueprint.name).toBe('Seated Cable Row');
    expect(session.blueprint.name).toBe('Upper Body');
  });

  it('recognises the watch shape and rejects anything else', () => {
    expect(isWatchWorkout(workout)).toBe(true);
    expect(isWatchWorkout({ ...workout, uuid: '' })).toBe(false);
    expect(isWatchWorkout({ ...workout, ex: [{ ...workout.ex[0], sets: [[1, 2]] }] })).toBe(false);
  });
});

describe('WatchSyncService receiving workouts', () => {
  let db: ExpoSQLiteDatabase;
  const state = {
    program: { activePlanId: 'plan-1', savedPrograms: { 'plan-1': program } },
    settings: { useImperialUnits: false },
  } as unknown as RootState;

  beforeEach(async () => {
    db = drizzle(await openDatabaseAsync(':memory:'));
    await new DatabaseMigrationService(db, { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never, {
      importOldData: async () => {},
    }).migrate();
  });

  it('saves a workout once and acknowledges every delivery', async () => {
    let deliver: ((e: { deviceId: string; json: string }) => void) | undefined;
    const replies: unknown[] = [];
    const bridge: GarminBridge = {
      initialize: async () => 'READY',
      getDevices: async () => [{ id: '7', name: 'Approach S62', status: 'CONNECTED' }],
      listen: async () => 'OK',
      send: async (_id, json) => {
        replies.push(JSON.parse(json));
        return 'SUCCESS';
      },
      addListener: (_e, l) => {
        deliver = l;
        return { remove: () => undefined };
      },
    };
    const dispatch = vi.fn();
    const service = new WatchSyncService(
      db,
      () => state,
      dispatch,
      () => bridge,
    );
    await service.startListening();

    for (let i = 0; i < 2; i++) {
      deliver!({ deviceId: '7', json: JSON.stringify({ t: 'wo', w: workout }) });
      await vi.waitFor(() => expect(replies).toHaveLength(i + 1));
    }

    expect(replies).toEqual([
      { t: 'wa', uuid: workout.uuid, ok: true },
      { t: 'wa', uuid: workout.uuid, ok: true },
    ]);
    expect(service.lastReceipt).toMatchObject({ imported: 1, duplicates: 1, failed: 0, lastName: 'Upper Body' });
    expect(readSession(db, workout.uuid)?.recordedExercises[0]!.blueprint.name).toBe('Machine Chest Press');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
