import { Instant, LocalDate, OffsetDateTime, ZoneId } from '@js-joda/core';
import { ProgramBlueprint, SessionBlueprint, WeightedExerciseBlueprint } from '@/models/blueprint-models';
import { PotentialSet, RecordedSet, RecordedWeightedExercise, Session } from '@/models/session-models';
import { Weight } from '@/models/weight';

/** A finished workout as the watch sends it (`watch/source/Sync.mc` in Watch_GymAPP). Times are epoch seconds. */
export interface WatchWorkout {
  uuid: string;
  name: string;
  start: number;
  end: number | null;
  ex: WatchWorkoutExercise[];
}

export interface WatchWorkoutExercise {
  /** Planned exercise: its {@link WeightedExerciseBlueprint.movementKey} and name. */
  pid: string;
  pname: string;
  /** Performed exercise; differs from the planned one when swapped on the watch. */
  aid: string;
  aname: string;
  reason: string | null;
  /** Planned sets and reps. */
  ps: number;
  reps: number;
  /** Logged sets as [reps, kg, epoch seconds]. */
  sets: [number, number, number][];
}

export function isWatchWorkout(value: unknown): value is WatchWorkout {
  const w = value as Partial<WatchWorkout> | undefined;
  return (
    typeof w === 'object' &&
    w !== null &&
    typeof w.uuid === 'string' &&
    w.uuid.length > 0 &&
    typeof w.name === 'string' &&
    typeof w.start === 'number' &&
    Array.isArray(w.ex) &&
    w.ex.every(
      (e) =>
        typeof e?.pname === 'string' &&
        typeof e.aname === 'string' &&
        typeof e.ps === 'number' &&
        Array.isArray(e.sets) &&
        e.sets.every((s) => Array.isArray(s) && s.length === 3 && s.every((n) => typeof n === 'number')),
    )
  );
}

/**
 * Turns a watch workout into a LiftLog session with the same id, so importing it twice is a no-op.
 *
 * Each exercise is recorded under the exercise actually performed. Its blueprint comes from the plan when the
 * planned exercise is still there - so rest, rep scheme and progression rules match what the plan would have
 * used - renamed to the alternative when one was swapped in, which keeps the alternative on its own lineage.
 */
export function watchWorkoutToSession(workout: WatchWorkout, program: ProgramBlueprint | undefined): Session {
  const zone = ZoneId.systemDefault();
  const at = (epochSeconds: number) => OffsetDateTime.ofInstant(Instant.ofEpochSecond(epochSeconds), zone);
  const planned = program?.sessions.find((s) => s.name === workout.name);

  const exercises = workout.ex.map((e) => {
    const fromPlan = planned?.exercises.find(
      (x): x is WeightedExerciseBlueprint => x instanceof WeightedExerciseBlueprint && x.movementKey() === e.pid,
    );
    const plannedBlueprint =
      fromPlan ??
      WeightedExerciseBlueprint.of({ name: e.pname, sets: e.ps, repsConfig: { type: 'fixed', reps: e.reps } });
    const swapped = e.aid !== e.pid;
    const blueprint = swapped ? plannedBlueprint.with({ name: e.aname, alternatives: [] }) : plannedBlueprint;

    const count = Math.max(e.ps, e.sets.length);
    const lastKg = e.sets.at(-1)?.[1] ?? 0;
    const potentialSets = Array.from({ length: count }, (_, i) => {
      const logged = e.sets[i];
      return PotentialSet.of({
        set: logged ? RecordedSet.of({ repsCompleted: logged[0], completionDateTime: at(logged[2]) }) : undefined,
        weight: new Weight(logged ? logged[1] : lastKg, 'kilograms'),
        target: blueprint.repsTargetForSet(i),
      });
    });
    const notes = swapped ? `Swapped from ${e.pname}${e.reason ? ` (${e.reason})` : ''} on watch` : undefined;
    return new RecordedWeightedExercise(blueprint, potentialSets, notes);
  });

  return new Session(
    workout.uuid,
    new SessionBlueprint(
      workout.name,
      exercises.map((x) => x.blueprint),
      planned?.notes ?? '',
    ),
    exercises,
    LocalDate.ofInstant(Instant.ofEpochSecond(workout.start), zone),
    undefined,
    undefined,
    at(
      workout.end ?? workout.ex.flatMap((e) => e.sets.map((s) => s[2])).reduce((a, b) => Math.max(a, b), workout.start),
    ),
  );
}
