import { describe, expect, it } from "vitest";
import {
  estimateOneRepMax,
  exerciseProgress,
  personalRecords,
  searchTemplates,
  setRowsFromWorkouts,
  summarizeTraining,
  weekStart,
} from "../src/analysis.js";
import { templates, workouts } from "./fixtures.js";

const tplMap = new Map(templates.map((t) => [t.id, t]));

describe("helpers", () => {
  it("estimates 1RM with Epley", () => {
    expect(estimateOneRepMax(100, 1)).toBe(100);
    expect(estimateOneRepMax(100, 5)).toBeCloseTo(116.67, 1);
    expect(estimateOneRepMax(100, 20)).toBeNull();
    expect(estimateOneRepMax(0, 5)).toBeNull();
  });

  it("computes Monday week start", () => {
    expect(weekStart("2026-10-01")).toBe("2026-09-28"); // Thursday
    expect(weekStart("2026-09-28")).toBe("2026-09-28"); // Monday
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday
  });
});

describe("summarizeTraining", () => {
  const s = summarizeTraining(workouts, tplMap, { timeZone: "UTC" });

  it("totals exclude warm-ups", () => {
    expect(s.totals.workouts).toBe(4);
    expect(s.totals.working_sets).toBe(11);
    const bench = 800 + 880 + 825 + 850;
    const squat = 500 + 550 + 600;
    expect(s.totals.volume_kg).toBe(bench + squat);
    expect(s.totals.avg_duration_min).toBe(60);
  });

  it("counts muscle group sets with secondary weighting", () => {
    expect(s.muscle_group_sets.chest).toBe(8);
    expect(s.muscle_group_sets.triceps).toBe(4);
    expect(s.muscle_group_sets.quadriceps).toBe(3);
    expect(s.muscle_group_sets.glutes).toBe(1.5);
  });

  it("breaks down by week and tracks consistency", () => {
    expect(s.by_period.rows.map((r) => r.week_of)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(s.consistency.longest_consecutive_week_streak).toBe(4);
    expect(s.consistency.longest_gap_days).toBe(7);
    expect(s.top_exercises[0].title).toBe("Bench Press (Barbell)");
  });
});

describe("exerciseProgress", () => {
  const p = exerciseProgress(setRowsFromWorkouts(workouts, "BENCH"), { timeZone: "UTC" });

  it("orders sessions oldest first and flags PRs after the first", () => {
    expect(p.sessions).toBe(4);
    expect(p.history.map((h) => h.date)).toEqual(["2026-10-01", "2026-10-08", "2026-10-13", "2026-10-20"]);
    expect(p.history[0].new_prs).toEqual([]);
    expect(p.history[1].new_prs).toContain("reps");
    expect(p.history[3].new_prs).toEqual(expect.arrayContaining(["e1RM", "weight"]));
    expect(p.all_time_in_range.heaviest_weight_kg).toBe(85);
  });

  it("computes trend", () => {
    expect(p.trend?.first_e1rm_kg).toBeCloseTo(93.3, 1);
    expect(p.trend?.latest_e1rm_kg).toBeCloseTo(99.2, 1);
    expect(p.trend?.sessions_since_last_e1rm_pr).toBe(0);
  });
});

describe("personalRecords", () => {
  it("finds best sets per exercise", () => {
    const prs = personalRecords(workouts, { timeZone: "UTC" });
    const squat = prs.find((r) => r.exercise_template_id === "SQUAT")!;
    expect(squat.sessions).toBe(3);
    expect(squat.heaviest_set?.value).toBe(120);
    expect(squat.last_performed).toBe("2026-10-20");
  });
});

describe("searchTemplates", () => {
  it("ranks closer matches first and filters", () => {
    expect(searchTemplates(templates, "bench press")[0].id).toBe("BENCH");
    expect(searchTemplates(templates, "bench dumbbell")[0].id).toBe("DBBENCH");
    expect(searchTemplates(templates, undefined, { muscleGroup: "glutes" }).map((t) => t.id)).toEqual(["SQUAT"]);
    expect(searchTemplates(templates, "deadlift")).toEqual([]);
  });
});
