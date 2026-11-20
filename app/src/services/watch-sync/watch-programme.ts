import {
  CardioExerciseBlueprint,
  ProgramBlueprint,
  ProgressionKey,
  WeightedExerciseBlueprint,
} from '@/models/blueprint-models';
import { RecordedExercise, RecordedWeightedExercise } from '@/models/session-models';
import { WeightUnit } from '@/models/weight';
import { nextRecordedExercise } from '@/services/session-service';

/**
 * The programme as the Garmin watch app stores it (`watch/source/Engine.mc` in Watch_GymAPP). Short keys
 * keep each Connect IQ message small. Weights are always kilograms; the watch has no unit setting.
 */
export interface WatchProgramme {
  id: string;
  name: string;
  rev: number;
  workouts: WatchWorkout[];
}

export interface WatchWorkout {
  name: string;
  exercises: WatchExercise[];
}

export interface WatchExercise extends WatchTarget {
  /** {@link WeightedExerciseBlueprint.movementKey}, the stable identity history is keyed by. */
  id: string;
  name: string;
  sets: number;
  reps: number;
  /** Rest between sets, seconds. */
  rest: number;
  alts: (WatchTarget & { id: string; name: string })[];
}

interface WatchTarget {
  /** The weight to start from: this exercise's own next weight, or the planned exercise's when it has no history. */
  kg: number;
  /** Its own last performance as [kg, reps], absent when it has never been done. */
  last?: [number, number];
}

export type WatchMessage =
  | { t: 'pb'; id: string; rev: number; name: string; n: number }
  | { t: 'pw'; i: number; w: WatchWorkout }
  | { t: 'pe'; id: string; rev: number };

type LatestByLineage = Record<ProgressionKey, RecordedExercise | undefined>;

/** Every lineage {@link buildWatchProgramme} reads, so the caller can fetch them in one query. */
export function watchProgressionKeys(program: ProgramBlueprint): ProgressionKey[] {
  return weightedExercises(program).flatMap((e) => [e, ...alternativeBlueprints(e)].map((x) => x.progressionKey()));
}

/**
 * Cardio exercises are left out: the watch logs sets of reps and weight only. An alternative is the planned
 * exercise under another name, so it keeps the plan's sets, reps and rest but its own lineage - its weights
 * never come from, nor flow back into, the exercise it stands in for.
 */
export function buildWatchProgramme(input: {
  id: string;
  rev: number;
  program: ProgramBlueprint;
  latest: LatestByLineage;
  unit: WeightUnit;
}): WatchProgramme {
  const { program, latest, unit } = input;
  return {
    id: input.id,
    name: program.name,
    rev: input.rev,
    workouts: program.sessions.map((session) => ({
      name: session.name,
      exercises: session.exercises
        .filter((e): e is WeightedExerciseBlueprint => !(e instanceof CardioExerciseBlueprint))
        .map((e) => {
          const planned = target(e, latest, unit, undefined);
          return {
            id: e.movementKey(),
            name: e.name,
            sets: e.plannedSets.length,
            reps: e.repsTargetForSet(0).min,
            rest: e.restBetweenSets.minRest.seconds(),
            ...planned,
            alts: alternativeBlueprints(e).map((alt) => ({
              id: alt.movementKey(),
              name: alt.name,
              ...target(alt, latest, unit, planned.kg),
            })),
          };
        }),
    })),
  };
}

/** One message per workout, framed by begin/end, so no single message nears Connect IQ's size limit. */
export function toWatchMessages(programme: WatchProgramme): WatchMessage[] {
  return [
    { t: 'pb', id: programme.id, rev: programme.rev, name: programme.name, n: programme.workouts.length },
    ...programme.workouts.map((w, i): WatchMessage => ({ t: 'pw', i, w })),
    { t: 'pe', id: programme.id, rev: programme.rev },
  ];
}

function weightedExercises(program: ProgramBlueprint): WeightedExerciseBlueprint[] {
  return program.sessions.flatMap((s) =>
    s.exercises.filter((e): e is WeightedExerciseBlueprint => e instanceof WeightedExerciseBlueprint),
  );
}

function alternativeBlueprints(e: WeightedExerciseBlueprint): WeightedExerciseBlueprint[] {
  return e.alternatives.map((name) => e.with({ name, alternatives: [] }));
}

function target(
  e: WeightedExerciseBlueprint,
  latest: LatestByLineage,
  unit: WeightUnit,
  fallbackKg: number | undefined,
): WatchTarget {
  const last = latest[e.progressionKey()];
  const lastWeighted = last instanceof RecordedWeightedExercise ? last : undefined;
  const lastSet = lastWeighted?.lastRecordedSet;
  if (!lastWeighted || !lastSet?.set) {
    return { kg: fallbackKg ?? 0 };
  }
  const next = nextRecordedExercise(e, lastWeighted, unit) as RecordedWeightedExercise;
  return {
    kg: toKg(next.potentialSets[0]?.weight.convertTo('kilograms').value.toNumber() ?? 0),
    last: [toKg(lastSet.weight.convertTo('kilograms').value.toNumber()), lastSet.set.repsCompleted],
  };
}

function toKg(value: number): number {
  return Math.round(value * 10) / 10;
}
