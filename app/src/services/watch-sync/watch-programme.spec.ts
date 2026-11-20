import { describe, expect, it } from 'vitest';
import { LocalDate } from '@js-joda/core';
import {
  ProgramBlueprint,
  ProgressionKey,
  SessionBlueprint,
  WeightedExerciseBlueprint,
} from '@/models/blueprint-models';
import { RecordedExercise } from '@/models/session-models';
import { makeRecordedExercise, makeWeightedBlueprint } from '@/models/session-models/__test__/helpers';
import { Weight } from '@/models/weight';
import { buildWatchProgramme, toWatchMessages, watchProgressionKeys } from '@/services/watch-sync/watch-programme';

const bench = makeWeightedBlueprint({
  name: 'Dumbbell Bench Press',
  sets: 4,
  repsConfig: { type: 'fixed', reps: 8 },
  alternatives: ['Machine Chest Press', 'Cable Chest Press'],
});
const row = makeWeightedBlueprint({ name: 'Seated Cable Row', sets: 3, repsConfig: { type: 'fixed', reps: 10 } });
const program = new ProgramBlueprint(
  'Upper/Lower',
  [new SessionBlueprint('Upper Body', [bench, row], '')],
  LocalDate.now(),
);

function latestOf(...exercises: RecordedExercise[]): Record<ProgressionKey, RecordedExercise | undefined> {
  return Object.fromEntries(exercises.map((x) => [x.progressionKey(), x]));
}

describe('buildWatchProgramme', () => {
  it('gives an alternative its own history and next weight, never the planned exercise', () => {
    const machine = bench.with({ name: 'Machine Chest Press', alternatives: [] });
    const benchHistory = makeRecordedExercise(bench, [8, 8, 8, 8], new Weight(30, 'kilograms'));
    const machineHistory = makeRecordedExercise(machine, [8, 8, 8, 8], new Weight(45, 'kilograms'));

    const result = buildWatchProgramme({
      id: 'p1',
      rev: 3,
      program,
      latest: latestOf(benchHistory, machineHistory),
      unit: 'kilograms',
    });

    const exercise = result.workouts[0]!.exercises[0]!;
    expect(exercise).toMatchObject({ id: bench.movementKey(), name: 'Dumbbell Bench Press', sets: 4, reps: 8 });
    expect(exercise.kg).toBe(32.5);
    expect(exercise.last).toEqual([30, 8]);
    expect(exercise.alts[0]).toEqual({
      id: machine.movementKey(),
      name: 'Machine Chest Press',
      kg: 47.5,
      last: [45, 8],
    });
  });

  it('starts an alternative with no history from the planned weight, without claiming a last result', () => {
    const benchHistory = makeRecordedExercise(bench, [8, 8, 8, 8], new Weight(30, 'kilograms'));
    const result = buildWatchProgramme({
      id: 'p1',
      rev: 1,
      program,
      latest: latestOf(benchHistory),
      unit: 'kilograms',
    });

    const cable = result.workouts[0]!.exercises[0]!.alts[1]!;
    expect(cable.kg).toBe(32.5);
    expect(cable.last).toBeUndefined();
  });

  it('converts pounds to kilograms', () => {
    const benchHistory = makeRecordedExercise(bench, [8, 8, 8, 8], new Weight(100, 'pounds'));
    const result = buildWatchProgramme({ id: 'p1', rev: 1, program, latest: latestOf(benchHistory), unit: 'pounds' });

    expect(result.workouts[0]!.exercises[0]!.last).toEqual([45.4, 8]);
  });

  it('lists the lineages of planned exercises and their alternatives', () => {
    expect(watchProgressionKeys(program)).toHaveLength(4);
  });
});

describe('toWatchMessages', () => {
  it('frames one message per workout between begin and end', () => {
    const result = buildWatchProgramme({ id: 'p1', rev: 2, program, latest: {}, unit: 'kilograms' });
    const messages = toWatchMessages(result);

    expect(messages.map((m) => m.t)).toEqual(['pb', 'pw', 'pe']);
    expect(messages[0]).toEqual({ t: 'pb', id: 'p1', rev: 2, name: 'Upper/Lower', n: 1 });
  });
});

describe('WeightedExerciseBlueprint alternatives', () => {
  it('survives a JSON round trip and takes part in equality', () => {
    const copy = WeightedExerciseBlueprint.fromJSON(bench.toJSON());
    expect(copy.alternatives).toEqual(['Machine Chest Press', 'Cable Chest Press']);
    expect(copy.equals(bench)).toBe(true);
    expect(copy.with({ alternatives: ['Cable Chest Press'] }).equals(bench)).toBe(false);
  });

  it('leaves plans without alternatives exactly as they were', () => {
    const json = row.toJSON();
    expect('alternatives' in json).toBe(false);
    expect(WeightedExerciseBlueprint.fromJSON(json).alternatives).toEqual([]);
  });
});
