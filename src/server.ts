import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  compactWorkout,
  exerciseProgress,
  personalRecords,
  searchTemplates,
  setRowsFromHistory,
  setRowsFromWorkouts,
  summarizeTraining,
  workoutHeadline,
} from "./analysis.js";
import { HevyApiError, HevyClient, MAX_PAGE_SIZE } from "./client.js";
import type { ExerciseTemplate, Workout } from "./types.js";

export interface ServerOptions {
  timeZone?: string;
  /** Default look-back window for analysis tools, in days. */
  defaultRangeDays?: number;
}

const VERSION = "0.1.0";

// ---- helpers ----------------------------------------------------------------

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});

const fail = (err: unknown) => {
  let msg = err instanceof Error ? err.message : String(err);
  if (err instanceof HevyApiError && err.status === 401)
    msg += "\nCheck HEVY_API_KEY (Hevy Pro: Settings → Developer → API key).";
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
};

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return json(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses YYYY-MM-DD (start/end of day, UTC) or a full ISO timestamp. */
export function parseDate(value: string | undefined, edge: "start" | "end"): Date | undefined {
  if (!value) return undefined;
  const iso = DATE_RE.test(value) ? `${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value} (use YYYY-MM-DD or ISO 8601)`);
  return d;
}

const dateArg = (what: string) =>
  z.string().optional().describe(`${what} (YYYY-MM-DD or ISO 8601 timestamp)`);

const formatArg = z
  .enum(["headline", "compact", "full"])
  .optional()
  .describe(
    "headline = one line per workout; compact = every set as text (default); full = raw Hevy API JSON",
  );

function render(w: Workout, format: "headline" | "compact" | "full" | undefined, tz?: string) {
  if (format === "full") return w;
  if (format === "headline") return workoutHeadline(w, tz);
  return compactWorkout(w, tz);
}

const templateSummary = (t: ExerciseTemplate) => ({
  id: t.id,
  title: t.title,
  type: t.type,
  primary_muscle_group: t.primary_muscle_group,
  secondary_muscle_groups: t.secondary_muscle_groups,
  ...(t.equipment ? { equipment: t.equipment } : {}),
  ...(t.is_custom ? { is_custom: true } : {}),
});

// ---- server -----------------------------------------------------------------

export function createServer(client: HevyClient, opts: ServerOptions = {}): McpServer {
  const tz = opts.timeZone;
  const defaultDays = opts.defaultRangeDays ?? 90;

  const resolveRange = (start?: string, end?: string, fallbackDays = defaultDays) => {
    const endD = parseDate(end, "end") ?? new Date();
    const startD = parseDate(start, "start") ?? new Date(endD.getTime() - fallbackDays * 86_400_000);
    if (startD > endD) throw new Error("start_date must be before end_date");
    return { start: startD, end: endD };
  };

  const rangeInfo = (r: { start: Date; end: Date }) => ({
    start: r.start.toISOString(),
    end: r.end.toISOString(),
  });

  /** Resolves an exercise template from an id or a (fuzzy) name. */
  const resolveExercise = async (exercise: string) => {
    const templates = await client.getAllExerciseTemplates();
    const byId = templates.find((t) => t.id === exercise);
    if (byId) return { template: byId, alternatives: [] as ExerciseTemplate[] };
    const matches = searchTemplates(templates, exercise);
    if (!matches.length)
      throw new Error(
        `No exercise matching "${exercise}". Use search_exercise_templates to find the right name or id.`,
      );
    return { template: matches[0], alternatives: matches.slice(1, 6) };
  };

  const server = new McpServer(
    { name: "mcp-hevy", version: VERSION },
    {
      instructions:
        "Tools for reading and analyzing the user's Hevy workout log. " +
        "Prefer the analyze_* tools for questions about trends, volume, consistency and progress — they " +
        "aggregate many workouts server-side and return compact results. Use get_workouts for raw sessions " +
        "in a date range. Exercises can be referenced by name or exercise_template_id. Weights are in kg. " +
        "Warm-up sets are excluded from volume/set counts. Dates default to the last " +
        `${defaultDays} days when omitted.`,
    },
  );

  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  // ---- user & counts ------------------------------------------------------

  server.registerTool(
    "get_user_info",
    { title: "Get Hevy user", description: "Get the Hevy account (name, id, profile url).", annotations: ro },
    wrap(async () => client.getUserInfo()),
  );

  server.registerTool(
    "get_workout_count",
    { title: "Count workouts", description: "Total number of workouts logged on the account.", annotations: ro },
    wrap(async () => ({ workout_count: await client.getWorkoutCount() })),
  );

  // ---- workouts -----------------------------------------------------------

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts (paged)",
      description: "List workouts newest-first, one page at a time (max 10 per page).",
      inputSchema: {
        page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE.workouts).optional(),
        format: formatArg,
      },
      annotations: ro,
    },
    wrap(async ({ page, page_size, format }) => {
      const res = await client.listWorkouts(page ?? 1, page_size ?? MAX_PAGE_SIZE.workouts);
      return {
        page: res.page,
        page_count: res.page_count,
        workouts: res.workouts.map((w) => render(w, format, tz)),
      };
    }),
  );

  server.registerTool(
    "get_workouts",
    {
      title: "Get workouts in a date range",
      description:
        "Fetch all workouts between two dates (handles pagination). Use format=headline for an overview " +
        "of many workouts and compact/full to inspect every set.",
      inputSchema: {
        start_date: dateArg("Start of range, default 30 days before end_date"),
        end_date: dateArg("End of range, default now"),
        limit: z.number().int().min(1).max(500).optional().describe("Max workouts to return (default 100)"),
        format: formatArg,
      },
      annotations: ro,
    },
    wrap(async ({ start_date, end_date, limit, format }) => {
      const range = resolveRange(start_date, end_date, 30);
      const { workouts, truncated } = await client.getWorkoutsInRange(range.start, range.end, {
        maxWorkouts: limit ?? 100,
      });
      return {
        range: rangeInfo(range),
        count: workouts.length,
        truncated,
        workouts: workouts.map((w) => render(w, format, tz)),
      };
    }),
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get a workout",
      description: "Get a single workout with all exercises and sets.",
      inputSchema: { workout_id: z.string().min(1), format: formatArg },
      annotations: ro,
    },
    wrap(async ({ workout_id, format }) => render(await client.getWorkout(workout_id), format, tz)),
  );

  server.registerTool(
    "get_workout_events",
    {
      title: "Workout change feed",
      description: "Workouts updated or deleted since a given time (newest first, paged).",
      inputSchema: {
        since: z.string().describe("ISO 8601 timestamp, e.g. 2026-01-01T00:00:00Z"),
        page: z.number().int().min(1).optional(),
      },
      annotations: ro,
    },
    wrap(async ({ since, page }) => {
      const res = await client.listWorkoutEvents(since, page ?? 1);
      return {
        page: res.page,
        page_count: res.page_count,
        events: res.events.map((e) =>
          e.type === "updated" ? { type: e.type, workout: workoutHeadline(e.workout, tz) } : e,
        ),
      };
    }),
  );

  // ---- routines -----------------------------------------------------------

  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description: "List all saved workout routines (templates) with their folders and planned sets.",
      inputSchema: {
        include_sets: z.boolean().optional().describe("Include planned sets for each exercise (default false)"),
      },
      annotations: ro,
    },
    wrap(async ({ include_sets }) => {
      const [routines, folders] = await Promise.all([client.getAllRoutines(), client.getAllRoutineFolders()]);
      const folderName = new Map(folders.map((f) => [f.id, f.title]));
      return routines.map((r) => ({
        id: r.id,
        title: r.title,
        folder: r.folder_id != null ? (folderName.get(r.folder_id) ?? r.folder_id) : null,
        updated_at: r.updated_at,
        exercises: r.exercises.map((e) =>
          include_sets
            ? {
                title: e.title,
                exercise_template_id: e.exercise_template_id,
                rest_seconds: e.rest_seconds,
                sets: e.sets,
              }
            : `${e.title} (${e.sets.length} sets)`,
        ),
      }));
    }),
  );

  server.registerTool(
    "get_routine",
    {
      title: "Get a routine",
      description: "Get one routine with all planned exercises and sets.",
      inputSchema: { routine_id: z.string().min(1) },
      annotations: ro,
    },
    wrap(async ({ routine_id }) => client.getRoutine(routine_id)),
  );

  // ---- exercises ----------------------------------------------------------

  server.registerTool(
    "search_exercise_templates",
    {
      title: "Search exercises",
      description:
        "Search the exercise library (built-in and custom) by name, muscle group or equipment. " +
        "Returns exercise_template_ids used by other tools.",
      inputSchema: {
        query: z.string().optional().describe("Name or part of a name, e.g. 'bench press'"),
        muscle_group: z.string().optional().describe("e.g. chest, quadriceps, lats, biceps"),
        equipment: z.string().optional().describe("e.g. barbell, dumbbell, machine, none"),
        custom_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
      },
      annotations: ro,
    },
    wrap(async ({ query, muscle_group, equipment, custom_only, limit }) => {
      const results = searchTemplates(await client.getAllExerciseTemplates(), query, {
        muscleGroup: muscle_group,
        equipment,
        customOnly: custom_only,
      });
      return { total_matches: results.length, results: results.slice(0, limit ?? 25).map(templateSummary) };
    }),
  );

  server.registerTool(
    "get_exercise_history",
    {
      title: "Exercise set history",
      description: "Every logged set of one exercise over a date range, grouped by session.",
      inputSchema: {
        exercise: z.string().min(1).describe("Exercise name (fuzzy) or exercise_template_id"),
        start_date: dateArg("Start of range (default: all time)"),
        end_date: dateArg("End of range (default: now)"),
      },
      annotations: ro,
    },
    wrap(async ({ exercise, start_date, end_date }) => {
      const { template, alternatives } = await resolveExercise(exercise);
      const history = await client.getExerciseHistory(
        template.id,
        parseDate(start_date, "start")?.toISOString(),
        parseDate(end_date, "end")?.toISOString(),
      );
      const sessions = new Map<string, { date: string; workout_title: string; sets: string[] }>();
      for (const h of history) {
        const s = sessions.get(h.workout_id) ?? {
          date: h.workout_start_time,
          workout_title: h.workout_title,
          sets: [],
        };
        sessions.set(h.workout_id, s);
        s.sets.push(
          [
            h.weight_kg != null ? `${h.weight_kg}kg` : null,
            h.reps != null ? `x ${h.reps}` : null,
            h.distance_meters != null ? `${h.distance_meters}m` : null,
            h.duration_seconds != null ? `${h.duration_seconds}s` : null,
            h.rpe != null ? `@RPE ${h.rpe}` : null,
            h.set_type !== "normal" ? `[${h.set_type}]` : null,
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      return {
        exercise: templateSummary(template),
        ...(alternatives.length ? { other_matches: alternatives.map((t) => t.title) } : {}),
        sessions: [...sessions.entries()].map(([workout_id, s]) => ({ workout_id, ...s })),
      };
    }),
  );

  // ---- body measurements --------------------------------------------------

  server.registerTool(
    "get_body_measurements",
    {
      title: "Body measurements",
      description: "Logged body measurements (bodyweight, body fat, circumferences) with weight trend.",
      inputSchema: {
        start_date: dateArg("Start of range (default: all time)"),
        end_date: dateArg("End of range (default: now)"),
      },
      annotations: ro,
    },
    wrap(async ({ start_date, end_date }) => {
      const start = start_date ? start_date.slice(0, 10) : "0000-00-00";
      const end = end_date ? end_date.slice(0, 10) : "9999-99-99";
      const rows = (await client.getAllBodyMeasurements())
        .filter((m) => m.date >= start && m.date <= end)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)));
      const weights = rows.filter((r) => typeof r.weight_kg === "number") as Array<{ date: string; weight_kg: number }>;
      return {
        count: rows.length,
        weight_trend:
          weights.length >= 2
            ? {
                first: weights[0],
                latest: weights[weights.length - 1],
                change_kg: Math.round((weights[weights.length - 1].weight_kg - weights[0].weight_kg) * 10) / 10,
              }
            : null,
        measurements: rows,
      };
    }),
  );

  // ---- analysis -----------------------------------------------------------

  server.registerTool(
    "analyze_training_summary",
    {
      title: "Training summary",
      description:
        "Aggregate statistics over a date range: workout frequency, duration, sets, reps, volume, " +
        "sets per muscle group, most-trained exercises, consistency (streaks, gaps, weekdays) and a " +
        "per-week/month breakdown. Best starting point for 'how is my training going?'.",
      inputSchema: {
        start_date: dateArg(`Start of range (default ${defaultDays} days ago)`),
        end_date: dateArg("End of range (default now)"),
        period: z.enum(["day", "week", "month"]).optional().describe("Breakdown granularity (default week)"),
        secondary_muscle_weight: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("How much a set counts toward secondary muscles (default 0.5)"),
      },
      annotations: ro,
    },
    wrap(async ({ start_date, end_date, period, secondary_muscle_weight }) => {
      const range = resolveRange(start_date, end_date);
      const [{ workouts, truncated }, templates] = await Promise.all([
        client.getWorkoutsInRange(range.start, range.end, { maxWorkouts: 2000 }),
        client.getExerciseTemplateMap(),
      ]);
      return {
        requested_range: rangeInfo(range),
        ...(truncated ? { warning: "Workout limit reached; summary covers the most recent 2000 workouts." } : {}),
        ...summarizeTraining(workouts, templates, {
          period,
          timeZone: tz,
          secondaryMuscleWeight: secondary_muscle_weight,
        }),
      };
    }),
  );

  server.registerTool(
    "analyze_exercise_progress",
    {
      title: "Exercise progression",
      description:
        "Session-by-session progression for one exercise: top weight, best set, estimated 1RM, volume, " +
        "PR flags and overall trend (change and rate per 4 weeks). Use to answer 'am I getting stronger at X?'.",
      inputSchema: {
        exercise: z.string().min(1).describe("Exercise name (fuzzy) or exercise_template_id"),
        start_date: dateArg("Start of range (default: 365 days ago)"),
        end_date: dateArg("End of range (default now)"),
      },
      annotations: ro,
    },
    wrap(async ({ exercise, start_date, end_date }) => {
      const range = resolveRange(start_date, end_date, 365);
      const { template, alternatives } = await resolveExercise(exercise);
      let rows;
      let source = "exercise_history";
      try {
        rows = setRowsFromHistory(
          await client.getExerciseHistory(template.id, range.start.toISOString(), range.end.toISOString()),
        );
      } catch (err) {
        if (!(err instanceof HevyApiError) || err.status === 401) throw err;
        // Fall back to scanning workouts if the history endpoint is unavailable.
        source = "workouts";
        const { workouts } = await client.getWorkoutsInRange(range.start, range.end, { maxWorkouts: 2000 });
        rows = setRowsFromWorkouts(workouts, template.id);
      }
      return {
        exercise: templateSummary(template),
        ...(alternatives.length ? { other_matches: alternatives.map((t) => t.title) } : {}),
        requested_range: rangeInfo(range),
        source,
        ...exerciseProgress(rows, { timeZone: tz }),
      };
    }),
  );

  server.registerTool(
    "analyze_personal_records",
    {
      title: "Personal records",
      description:
        "Best e1RM, heaviest set, most reps and best session volume for every exercise performed in a range, " +
        "plus session count and last-performed date (useful to spot neglected exercises).",
      inputSchema: {
        start_date: dateArg("Start of range (default: all time)"),
        end_date: dateArg("End of range (default now)"),
        muscle_group: z.string().optional().describe("Only exercises whose primary muscle group matches"),
        limit: z.number().int().min(1).max(500).optional().describe("Max exercises (default 50, most frequent first)"),
      },
      annotations: ro,
    },
    wrap(async ({ start_date, end_date, muscle_group, limit }) => {
      const range = {
        start: parseDate(start_date, "start") ?? new Date(0),
        end: parseDate(end_date, "end") ?? new Date(),
      };
      const [{ workouts, truncated }, templates] = await Promise.all([
        client.getWorkoutsInRange(range.start, range.end, { maxWorkouts: 5000 }),
        client.getExerciseTemplateMap(),
      ]);
      let records = personalRecords(workouts, { timeZone: tz });
      if (muscle_group) {
        const mg = muscle_group.toLowerCase();
        records = records.filter((r) => templates.get(r.exercise_template_id)?.primary_muscle_group?.toLowerCase() === mg);
      }
      return {
        requested_range: rangeInfo(range),
        workouts_scanned: workouts.length,
        ...(truncated ? { warning: "Workout limit reached; only the most recent 5000 workouts were scanned." } : {}),
        exercises: records.slice(0, limit ?? 50).map((r) => ({
          ...r,
          primary_muscle_group: templates.get(r.exercise_template_id)?.primary_muscle_group,
        })),
      };
    }),
  );

  // ---- prompts --------------------------------------------------------------

  server.registerPrompt(
    "training_review",
    {
      title: "Training review",
      description: "Review recent training and suggest improvements.",
      argsSchema: { weeks: z.string().optional().describe("How many weeks to review (default 8)") },
    },
    ({ weeks }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Review my last ${weeks || "8"} weeks of training in Hevy. ` +
              "Call analyze_training_summary for that range, then analyze_exercise_progress for my 3-5 most " +
              "trained exercises. Report: consistency, weekly sets per muscle group (flag anything under ~10 or " +
              "imbalanced, e.g. push vs pull), which lifts are progressing or stalled, and 3 concrete, " +
              "prioritised recommendations.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "exercise_deep_dive",
    {
      title: "Exercise deep dive",
      description: "Analyze progression for a specific exercise.",
      argsSchema: { exercise: z.string().describe("Exercise name, e.g. 'Squat'") },
    },
    ({ exercise }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Analyze my progress on ${exercise} using analyze_exercise_progress over the last year. ` +
              "Describe the e1RM trend, recent PRs, whether I've plateaued, how rep ranges and volume have " +
              "changed, and suggest what to adjust next.",
          },
        },
      ],
    }),
  );

  return server;
}
