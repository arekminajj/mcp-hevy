import type { ExerciseTemplate, Workout } from "../src/types.js";

export const templates: ExerciseTemplate[] = [
  {
    id: "BENCH",
    title: "Bench Press (Barbell)",
    type: "weight_reps",
    primary_muscle_group: "chest",
    secondary_muscle_groups: ["triceps", "shoulders"],
    equipment: "barbell",
    is_custom: false,
  },
  {
    id: "SQUAT",
    title: "Squat (Barbell)",
    type: "weight_reps",
    primary_muscle_group: "quadriceps",
    secondary_muscle_groups: ["glutes"],
    equipment: "barbell",
    is_custom: false,
  },
  {
    id: "DBBENCH",
    title: "Bench Press (Dumbbell)",
    type: "weight_reps",
    primary_muscle_group: "chest",
    secondary_muscle_groups: ["triceps"],
    equipment: "dumbbell",
    is_custom: false,
  },
];

const set = (weight_kg: number, reps: number, type = "normal", index = 0) => ({ index, type, weight_kg, reps });

export function makeWorkout(id: string, day: string, bench: Array<[number, number]>, squat: Array<[number, number]> = []): Workout {
  return {
    id,
    title: `Workout ${id}`,
    start_time: `${day}T10:00:00Z`,
    end_time: `${day}T11:00:00Z`,
    exercises: [
      {
        index: 0,
        title: "Bench Press (Barbell)",
        exercise_template_id: "BENCH",
        sets: [set(40, 10, "warmup"), ...bench.map(([w, r], i) => set(w, r, "normal", i + 1))],
      },
      ...(squat.length
        ? [
            {
              index: 1,
              title: "Squat (Barbell)",
              exercise_template_id: "SQUAT",
              sets: squat.map(([w, r], i) => set(w, r, "normal", i)),
            },
          ]
        : []),
    ],
  };
}

/** Newest first, like the Hevy API. */
export const workouts: Workout[] = [
  makeWorkout("w4", "2026-10-20", [[85, 5], [85, 5]], [[120, 5]]),
  makeWorkout("w3", "2026-10-13", [[82.5, 5], [82.5, 5]]),
  makeWorkout("w2", "2026-10-08", [[80, 5], [80, 6]], [[110, 5]]),
  makeWorkout("w1", "2026-10-01", [[80, 5], [80, 5]], [[100, 5]]),
];
