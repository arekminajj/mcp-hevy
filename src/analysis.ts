import type { ExerciseHistoryEntry, ExerciseTemplate, Workout, WorkoutSet } from "./types.js";

// ---------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------

export const round = (n: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Sets that count as "working" (everything except warm-ups). */
export const isWorkingSet = (s: { type?: string; set_type?: string }): boolean =>
  (s.type ?? s.set_type) !== "warmup";

/**
 * Estimated one-rep max using the Epley formula. Returns null when the set has
 * no load/reps or too many reps for the estimate to be meaningful.
 */
export function estimateOneRepMax(weightKg?: number | null, reps?: number | null): number | null {
  if (!weightKg || !reps || weightKg <= 0 || reps <= 0) return null;
  if (reps === 1) return weightKg;
  if (reps > 15) return null;
  return weightKg * (1 + reps / 30);
}

export const setVolume = (s: { weight_kg?: number | null; reps?: number | null }): number =>
  (s.weight_kg ?? 0) * (s.reps ?? 0);

/** YYYY-MM-DD for an ISO timestamp in the given IANA time zone. */
export function localDate(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const dateFromYmd = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Monday (YYYY-MM-DD) of the week containing the given local date. */
export function weekStart(localYmd: string): string {
  const d = dateFromYmd(localYmd);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return ymd(d);
}

export type Period = "day" | "week" | "month";

export function periodKey(localYmd: string, period: Period): string {
  if (period === "day") return localYmd;
  if (period === "month") return localYmd.slice(0, 7);
  return weekStart(localYmd);
}

export const durationMinutes = (w: Pick<Workout, "start_time" | "end_time">): number =>
  Math.max(0, (Date.parse(w.end_time) - Date.parse(w.start_time)) / 60000);

// ---------------------------------------------------------------------------
// Compact representations (keep LLM context small)
// ---------------------------------------------------------------------------

export function formatSet(s: WorkoutSet): string {
  const parts: string[] = [];
  if (s.weight_kg != null && s.reps != null) parts.push(`${round(s.weight_kg, 2)}kg x ${s.reps}`);
  else if (s.reps != null) parts.push(`${s.reps} reps`);
  else if (s.weight_kg != null) parts.push(`${round(s.weight_kg, 2)}kg`);
  if (s.distance_meters != null) parts.push(`${s.distance_meters}m`);
  if (s.duration_seconds != null) parts.push(`${s.duration_seconds}s`);
  if (s.custom_metric != null) parts.push(`custom ${s.custom_metric}`);
  if (s.rpe != null) parts.push(`@RPE ${s.rpe}`);
  let out = parts.join(" ") || "(empty)";
  if (s.type && s.type !== "normal") out += ` [${s.type}]`;
  return out;
}

export function compactWorkout(w: Workout, timeZone?: string) {
  let volume = 0;
  let sets = 0;
  for (const e of w.exercises ?? [])
    for (const s of e.sets ?? [])
      if (isWorkingSet(s)) {
        sets++;
        volume += setVolume(s);
      }
  return {
    id: w.id,
    title: w.title,
    date: localDate(w.start_time, timeZone),
    start_time: w.start_time,
    duration_min: round(durationMinutes(w), 0),
    working_sets: sets,
    volume_kg: round(volume, 0),
    ...(w.description ? { description: w.description } : {}),
    exercises: (w.exercises ?? []).map((e) => ({
      title: e.title,
      exercise_template_id: e.exercise_template_id,
      ...(e.superset_id != null ? { superset_id: e.superset_id } : {}),
      ...(e.notes ? { notes: e.notes } : {}),
      sets: (e.sets ?? []).map(formatSet),
    })),
  };
}

export function workoutHeadline(w: Workout, timeZone?: string) {
  const c = compactWorkout(w, timeZone);
  return {
    id: c.id,
    title: c.title,
    date: c.date,
    duration_min: c.duration_min,
    working_sets: c.working_sets,
    volume_kg: c.volume_kg,
    exercises: c.exercises.map((e) => e.title),
  };
}

// ---------------------------------------------------------------------------
// Training summary
// ---------------------------------------------------------------------------

export interface SummaryOptions {
  period?: Period;
  timeZone?: string;
  /** Count secondary muscle groups as this fraction of a set (default 0.5). */
  secondaryMuscleWeight?: number;
  topExercises?: number;
}

export function muscleSetContributions(
  template: ExerciseTemplate | undefined,
  secondaryWeight: number,
): Array<[string, number]> {
  if (!template) return [["unknown", 1]];
  const out: Array<[string, number]> = [[template.primary_muscle_group || "unknown", 1]];
  if (secondaryWeight > 0)
    for (const m of template.secondary_muscle_groups ?? []) out.push([m, secondaryWeight]);
  return out;
}

const addTo = (m: Record<string, number>, k: string, v: number) => (m[k] = (m[k] ?? 0) + v);

const roundValues = (m: Record<string, number>, digits = 1) =>
  Object.fromEntries(
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, round(v, digits)]),
  );

export function summarizeTraining(
  workouts: Workout[],
  templates: Map<string, ExerciseTemplate>,
  opts: SummaryOptions = {},
) {
  const period = opts.period ?? "week";
  const tz = opts.timeZone;
  const secondary = opts.secondaryMuscleWeight ?? 0.5;
  const sorted = [...workouts].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));

  let totalMinutes = 0;
  let totalVolume = 0;
  let totalSets = 0;
  let totalReps = 0;
  const byWeekday: Record<string, number> = {};
  const muscleSets: Record<string, number> = {};
  const exercises = new Map<
    string,
    { title: string; sessions: number; sets: number; volume_kg: number; best_e1rm_kg: number }
  >();
  const periods = new Map<
    string,
    { workouts: number; minutes: number; working_sets: number; volume_kg: number; muscle_sets: Record<string, number> }
  >();
  const trainingDays = new Set<string>();

  for (const w of sorted) {
    const day = localDate(w.start_time, tz);
    trainingDays.add(day);
    const key = periodKey(day, period);
    const p =
      periods.get(key) ?? { workouts: 0, minutes: 0, working_sets: 0, volume_kg: 0, muscle_sets: {} };
    periods.set(key, p);
    const mins = durationMinutes(w);
    p.workouts++;
    p.minutes += mins;
    totalMinutes += mins;
    addTo(byWeekday, WEEKDAYS[dateFromYmd(day).getUTCDay()], 1);

    for (const e of w.exercises ?? []) {
      const tpl = templates.get(e.exercise_template_id);
      const ex =
        exercises.get(e.exercise_template_id) ??
        { title: e.title, sessions: 0, sets: 0, volume_kg: 0, best_e1rm_kg: 0 };
      exercises.set(e.exercise_template_id, ex);
      ex.sessions++;
      for (const s of e.sets ?? []) {
        if (!isWorkingSet(s)) continue;
        const v = setVolume(s);
        totalSets++;
        totalReps += s.reps ?? 0;
        totalVolume += v;
        p.working_sets++;
        p.volume_kg += v;
        ex.sets++;
        ex.volume_kg += v;
        const e1 = estimateOneRepMax(s.weight_kg, s.reps);
        if (e1 && e1 > ex.best_e1rm_kg) ex.best_e1rm_kg = e1;
        for (const [m, c] of muscleSetContributions(tpl, secondary)) {
          addTo(muscleSets, m, c);
          addTo(p.muscle_sets, m, c);
        }
      }
    }
  }

  // Consistency: gaps between training days and weekly streaks.
  const days = [...trainingDays].sort();
  let longestGap = 0;
  for (let i = 1; i < days.length; i++) {
    const gap = (dateFromYmd(days[i]).getTime() - dateFromYmd(days[i - 1]).getTime()) / 86_400_000;
    longestGap = Math.max(longestGap, gap);
  }
  const weeks = [...new Set(days.map(weekStart))].sort();
  let longestWeekStreak = weeks.length ? 1 : 0;
  let run = longestWeekStreak;
  for (let i = 1; i < weeks.length; i++) {
    const diff = (dateFromYmd(weeks[i]).getTime() - dateFromYmd(weeks[i - 1]).getTime()) / 86_400_000;
    run = diff === 7 ? run + 1 : 1;
    longestWeekStreak = Math.max(longestWeekStreak, run);
  }

  const n = sorted.length;
  const spanDays =
    n > 0 ? (dateFromYmd(days[days.length - 1]).getTime() - dateFromYmd(days[0]).getTime()) / 86_400_000 + 1 : 0;

  const top = opts.topExercises ?? 15;
  return {
    range: n ? { first_workout: days[0], last_workout: days[days.length - 1] } : null,
    totals: {
      workouts: n,
      training_days: days.length,
      total_hours: round(totalMinutes / 60, 1),
      avg_duration_min: n ? round(totalMinutes / n, 0) : 0,
      working_sets: totalSets,
      reps: totalReps,
      volume_kg: round(totalVolume, 0),
      avg_workouts_per_week: spanDays ? round((n / spanDays) * 7, 2) : 0,
    },
    consistency: {
      longest_gap_days: longestGap,
      longest_consecutive_week_streak: longestWeekStreak,
      workouts_by_weekday: byWeekday,
    },
    muscle_group_sets: roundValues(muscleSets),
    top_exercises: [...exercises.entries()]
      .sort((a, b) => b[1].sets - a[1].sets)
      .slice(0, top)
      .map(([id, e]) => ({
        exercise_template_id: id,
        title: e.title,
        sessions: e.sessions,
        working_sets: e.sets,
        volume_kg: round(e.volume_kg, 0),
        best_e1rm_kg: e.best_e1rm_kg ? round(e.best_e1rm_kg, 1) : null,
      })),
    by_period: {
      period,
      rows: [...periods.entries()].map(([key, p]) => ({
        [period === "week" ? "week_of" : period]: key,
        workouts: p.workouts,
        hours: round(p.minutes / 60, 1),
        working_sets: p.working_sets,
        volume_kg: round(p.volume_kg, 0),
        muscle_sets: roundValues(p.muscle_sets),
      })),
    },
    notes: [
      "Warm-up sets are excluded from sets/volume.",
      `Muscle group sets: primary = 1, each secondary = ${secondary}.`,
      "e1RM uses the Epley formula (sets of 1-15 reps).",
    ],
  };
}

// ---------------------------------------------------------------------------
// Exercise progression
// ---------------------------------------------------------------------------

/** Normalised set row, buildable from workouts or from the exercise_history endpoint. */
export interface SetRow {
  workout_id: string;
  workout_title: string;
  start_time: string;
  set_type: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
}

export function setRowsFromHistory(history: ExerciseHistoryEntry[]): SetRow[] {
  return history.map((h) => ({
    workout_id: h.workout_id,
    workout_title: h.workout_title,
    start_time: h.workout_start_time,
    set_type: h.set_type,
    weight_kg: h.weight_kg,
    reps: h.reps,
    distance_meters: h.distance_meters,
    duration_seconds: h.duration_seconds,
    rpe: h.rpe,
  }));
}

export function setRowsFromWorkouts(workouts: Workout[], templateId: string): SetRow[] {
  const rows: SetRow[] = [];
  for (const w of workouts)
    for (const e of w.exercises ?? [])
      if (e.exercise_template_id === templateId)
        for (const s of e.sets ?? [])
          rows.push({
            workout_id: w.id,
            workout_title: w.title,
            start_time: w.start_time,
            set_type: s.type,
            weight_kg: s.weight_kg,
            reps: s.reps,
            distance_meters: s.distance_meters,
            duration_seconds: s.duration_seconds,
            rpe: s.rpe,
          });
  return rows;
}

export function exerciseProgress(rows: SetRow[], opts: { timeZone?: string } = {}) {
  const sessions = new Map<string, SetRow[]>();
  for (const r of rows) {
    if (!isWorkingSet(r)) continue;
    const list = sessions.get(r.workout_id) ?? [];
    list.push(r);
    sessions.set(r.workout_id, list);
  }

  let bestE1rm = 0;
  let bestWeight = 0;
  let bestVolume = 0;
  let bestReps = 0;
  const out = [...sessions.values()]
    .sort((a, b) => Date.parse(a[0].start_time) - Date.parse(b[0].start_time))
    .map((sets) => {
      let topWeight = 0;
      let maxReps = 0;
      let volume = 0;
      let reps = 0;
      let e1 = 0;
      let bestSet: SetRow | undefined;
      let distance = 0;
      let duration = 0;
      const rpes: number[] = [];
      for (const s of sets) {
        const w = s.weight_kg ?? 0;
        topWeight = Math.max(topWeight, w);
        maxReps = Math.max(maxReps, s.reps ?? 0);
        volume += setVolume(s);
        reps += s.reps ?? 0;
        distance += s.distance_meters ?? 0;
        duration += s.duration_seconds ?? 0;
        if (s.rpe != null) rpes.push(s.rpe);
        const est = estimateOneRepMax(s.weight_kg, s.reps) ?? 0;
        if (est > e1) {
          e1 = est;
          bestSet = s;
        }
      }
      const prs: string[] = [];
      if (e1 > bestE1rm && e1 > 0) (prs.push("e1RM"), (bestE1rm = e1));
      if (topWeight > bestWeight && topWeight > 0) (prs.push("weight"), (bestWeight = topWeight));
      if (volume > bestVolume && volume > 0) (prs.push("volume"), (bestVolume = volume));
      if (maxReps > bestReps && maxReps > 0) (prs.push("reps"), (bestReps = maxReps));
      const first = sets[0];
      return {
        date: localDate(first.start_time, opts.timeZone),
        workout_id: first.workout_id,
        workout_title: first.workout_title,
        working_sets: sets.length,
        reps,
        top_weight_kg: round(topWeight, 2),
        best_set: bestSet ? `${round(bestSet.weight_kg ?? 0, 2)}kg x ${bestSet.reps}` : null,
        e1rm_kg: e1 ? round(e1, 1) : null,
        volume_kg: round(volume, 0),
        ...(distance ? { distance_m: distance } : {}),
        ...(duration ? { duration_s: duration } : {}),
        ...(rpes.length ? { avg_rpe: round(rpes.reduce((a, b) => a + b, 0) / rpes.length, 1) } : {}),
        // The first session trivially sets every "PR", so only flag later ones.
        new_prs: prs,
      };
    });
  if (out.length) out[0].new_prs = [];

  const withE1 = out.filter((s) => s.e1rm_kg != null);
  let trend = null;
  if (withE1.length >= 2) {
    const firstE = withE1[0];
    const lastE = withE1[withE1.length - 1];
    const days = (dateFromYmd(lastE.date).getTime() - dateFromYmd(firstE.date).getTime()) / 86_400_000;
    const change = (lastE.e1rm_kg ?? 0) - (firstE.e1rm_kg ?? 0);
    trend = {
      first_e1rm_kg: firstE.e1rm_kg,
      latest_e1rm_kg: lastE.e1rm_kg,
      change_kg: round(change, 1),
      change_pct: firstE.e1rm_kg ? round((change / firstE.e1rm_kg) * 100, 1) : null,
      per_4_weeks_kg: days > 0 ? round((change / days) * 28, 2) : null,
      sessions_since_last_e1rm_pr: (() => {
        const idx = [...out].reverse().findIndex((s) => s.new_prs.includes("e1RM"));
        return idx === -1 ? out.length - 1 : idx;
      })(),
    };
  }

  return {
    sessions: out.length,
    all_time_in_range: {
      best_e1rm_kg: bestE1rm ? round(bestE1rm, 1) : null,
      heaviest_weight_kg: bestWeight || null,
      most_reps_in_a_set: bestReps || null,
      best_session_volume_kg: bestVolume ? round(bestVolume, 0) : null,
    },
    trend,
    history: out,
  };
}

// ---------------------------------------------------------------------------
// Personal records across all exercises
// ---------------------------------------------------------------------------

export function personalRecords(workouts: Workout[], opts: { timeZone?: string } = {}) {
  type Rec = { value: number; date: string; detail?: string };
  const best = new Map<
    string,
    { title: string; e1rm?: Rec; weight?: Rec; reps?: Rec; volume?: Rec; sessions: number; last: string }
  >();
  const better = (cur: Rec | undefined, v: number) => v > 0 && (!cur || v > cur.value);

  for (const w of workouts) {
    const date = localDate(w.start_time, opts.timeZone);
    for (const e of w.exercises ?? []) {
      const r = best.get(e.exercise_template_id) ?? { title: e.title, sessions: 0, last: date };
      best.set(e.exercise_template_id, r);
      r.sessions++;
      if (date > r.last) r.last = date;
      let vol = 0;
      for (const s of e.sets ?? []) {
        if (!isWorkingSet(s)) continue;
        vol += setVolume(s);
        const label = `${round(s.weight_kg ?? 0, 2)}kg x ${s.reps ?? 0}`;
        const e1 = estimateOneRepMax(s.weight_kg, s.reps) ?? 0;
        if (better(r.e1rm, e1)) r.e1rm = { value: round(e1, 1), date, detail: label };
        if (better(r.weight, s.weight_kg ?? 0)) r.weight = { value: s.weight_kg ?? 0, date, detail: label };
        if (better(r.reps, s.reps ?? 0)) r.reps = { value: s.reps ?? 0, date, detail: label };
      }
      if (better(r.volume, vol)) r.volume = { value: round(vol, 0), date };
    }
  }

  return [...best.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .map(([id, r]) => ({
      exercise_template_id: id,
      title: r.title,
      sessions: r.sessions,
      last_performed: r.last,
      ...(r.e1rm ? { best_e1rm: r.e1rm } : {}),
      ...(r.weight ? { heaviest_set: r.weight } : {}),
      ...(r.reps ? { most_reps: r.reps } : {}),
      ...(r.volume ? { best_session_volume_kg: r.volume } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Exercise template search
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function searchTemplates(
  templates: ExerciseTemplate[],
  query?: string,
  filters: { muscleGroup?: string; equipment?: string; customOnly?: boolean } = {},
): ExerciseTemplate[] {
  const q = query ? norm(query) : "";
  const words = q.split(" ").filter(Boolean);
  const mg = filters.muscleGroup ? norm(filters.muscleGroup) : undefined;
  const eq = filters.equipment ? norm(filters.equipment) : undefined;
  return templates
    .filter((t) => !filters.customOnly || t.is_custom)
    .filter(
      (t) =>
        !mg ||
        norm(t.primary_muscle_group ?? "") === mg ||
        (t.secondary_muscle_groups ?? []).some((m) => norm(m) === mg),
    )
    .filter((t) => !eq || norm(t.equipment ?? "") === eq)
    .map((t) => {
      const title = norm(t.title);
      let score = 0;
      if (!words.length) score = 1;
      else if (title === q) score = 100;
      else if (title.startsWith(q)) score = 50;
      else if (title.includes(q)) score = 30;
      else if (words.every((w) => title.includes(w))) score = 10;
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.title.length - b.t.title.length)
    .map((x) => x.t);
}
