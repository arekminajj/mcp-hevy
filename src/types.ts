// Types for the Hevy public API (https://api.hevyapp.com/docs/).
// Fields are kept optional/nullable where the API may omit them.

export type SetType = "warmup" | "normal" | "failure" | "dropset" | string;

export interface WorkoutSet {
  index: number;
  type: SetType;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
}

export interface WorkoutExercise {
  index: number;
  title: string;
  notes?: string | null;
  exercise_template_id: string;
  superset_id?: number | null;
  sets: WorkoutSet[];
}

export interface Workout {
  id: string;
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string;
  updated_at?: string;
  created_at?: string;
  exercises: WorkoutExercise[];
}

export interface Paged {
  page: number;
  page_count: number;
}

export interface WorkoutsPage extends Paged {
  workouts: Workout[];
}

export type WorkoutEvent =
  | { type: "updated"; workout: Workout }
  | { type: "deleted"; id: string; deleted_at: string };

export interface WorkoutEventsPage extends Paged {
  events: WorkoutEvent[];
}

export interface ExerciseTemplate {
  id: string;
  title: string;
  type: string;
  primary_muscle_group: string;
  secondary_muscle_groups: string[];
  equipment?: string;
  is_custom: boolean;
}

export interface ExerciseTemplatesPage extends Paged {
  exercise_templates: ExerciseTemplate[];
}

export interface RoutineSet {
  index: number;
  type: SetType;
  weight_kg?: number | null;
  reps?: number | null;
  rep_range?: { start?: number | null; end?: number | null } | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  custom_metric?: number | null;
}

export interface RoutineExercise {
  index: number;
  title: string;
  rest_seconds?: number | null;
  notes?: string | null;
  exercise_template_id: string;
  superset_id?: number | null;
  sets: RoutineSet[];
}

export interface Routine {
  id: string;
  title: string;
  folder_id?: number | null;
  updated_at?: string;
  created_at?: string;
  exercises: RoutineExercise[];
}

export interface RoutinesPage extends Paged {
  routines: Routine[];
}

export interface RoutineFolder {
  id: number;
  index: number;
  title: string;
  updated_at?: string;
  created_at?: string;
}

export interface RoutineFoldersPage extends Paged {
  routine_folders: RoutineFolder[];
}

export interface ExerciseHistoryEntry {
  workout_id: string;
  workout_title: string;
  workout_start_time: string;
  workout_end_time: string;
  exercise_template_id: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
  set_type: SetType;
}

export interface BodyMeasurement {
  date: string;
  weight_kg?: number | null;
  lean_mass_kg?: number | null;
  fat_percent?: number | null;
  [key: string]: unknown;
}

export interface BodyMeasurementsPage extends Paged {
  body_measurements: BodyMeasurement[];
}

export interface UserInfo {
  id: string;
  name: string;
  url: string;
}
