import type {
  BodyMeasurement,
  BodyMeasurementsPage,
  ExerciseHistoryEntry,
  ExerciseTemplate,
  ExerciseTemplatesPage,
  Routine,
  RoutineFolder,
  RoutineFoldersPage,
  RoutinesPage,
  UserInfo,
  Workout,
  WorkoutEventsPage,
  WorkoutsPage,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.hevyapp.com";

/** Maximum page sizes accepted by the Hevy API per endpoint. */
export const MAX_PAGE_SIZE = {
  workouts: 10,
  events: 10,
  routines: 10,
  routineFolders: 10,
  bodyMeasurements: 10,
  exerciseTemplates: 100,
} as const;

export class HevyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Hevy API ${status} on ${path}: ${body.slice(0, 500)}`);
    this.name = "HevyApiError";
  }
}

export interface HevyClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** How long the exercise template cache stays fresh (ms). */
  templateCacheTtlMs?: number;
}

type Query = Record<string, string | number | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HevyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly templateCacheTtlMs: number;
  private templateCache?: { at: number; templates: Promise<ExerciseTemplate[]> };

  constructor(opts: HevyClientOptions) {
    if (!opts.apiKey) throw new Error("A Hevy API key is required (set HEVY_API_KEY).");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.templateCacheTtlMs = opts.templateCacheTtlMs ?? 60 * 60 * 1000;
  }

  async request<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        headers: { "api-key": this.apiKey, accept: "application/json" },
      });
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(delay, 10_000));
        continue;
      }
      throw new HevyApiError(res.status, path, await res.text().catch(() => ""));
    }
  }

  /**
   * Fetches a paged list page. The Hevy API returns 404 for pages past the end,
   * which we normalise into an empty page.
   */
  private async page<T extends { page_count: number }>(
    path: string,
    key: keyof T,
    query: Query,
  ): Promise<T> {
    try {
      return await this.request<T>(path, query);
    } catch (err) {
      if (err instanceof HevyApiError && err.status === 404 && Number(query.page ?? 1) > 1) {
        return { page: query.page, page_count: 0, [key]: [] } as unknown as T;
      }
      throw err;
    }
  }

  // ---- User ---------------------------------------------------------------

  async getUserInfo(): Promise<UserInfo> {
    const res = await this.request<{ data: UserInfo }>("/v1/user/info");
    return res.data;
  }

  // ---- Workouts -----------------------------------------------------------

  listWorkouts(page = 1, pageSize: number = MAX_PAGE_SIZE.workouts): Promise<WorkoutsPage> {
    return this.page<WorkoutsPage>("/v1/workouts", "workouts", { page, pageSize });
  }

  getWorkout(id: string): Promise<Workout> {
    return this.request<Workout>(`/v1/workouts/${encodeURIComponent(id)}`);
  }

  async getWorkoutCount(): Promise<number> {
    const res = await this.request<{ workout_count: number }>("/v1/workouts/count");
    return res.workout_count;
  }

  async listWorkoutEvents(since: string, page = 1, pageSize: number = MAX_PAGE_SIZE.events): Promise<WorkoutEventsPage> {
    const res = await this.page<WorkoutEventsPage>("/v1/workouts/events", "events", { since, page, pageSize });
    // When nothing changed since `since`, the API returns `{ page, page_count, workouts: [] }`
    // instead of an `events` array.
    return { ...res, events: res.events ?? [] };
  }

  /**
   * Returns all workouts whose start_time falls in [start, end].
   * Workouts are returned by the API newest-first, so paging stops once a page
   * reaches past `start`.
   */
  async getWorkoutsInRange(
    start?: Date,
    end?: Date,
    opts: { maxWorkouts?: number } = {},
  ): Promise<{ workouts: Workout[]; truncated: boolean }> {
    const maxWorkouts = opts.maxWorkouts ?? 1000;
    const out: Workout[] = [];
    const startMs = start?.getTime() ?? -Infinity;
    const endMs = end?.getTime() ?? Infinity;
    for (let page = 1; ; page++) {
      const res = await this.listWorkouts(page, MAX_PAGE_SIZE.workouts);
      if (!res.workouts.length) return { workouts: out, truncated: false };
      let reachedStart = false;
      for (const w of res.workouts) {
        const t = Date.parse(w.start_time);
        if (t > endMs) continue;
        if (t < startMs) {
          reachedStart = true;
          continue;
        }
        out.push(w);
        if (out.length >= maxWorkouts) return { workouts: out, truncated: true };
      }
      if (reachedStart || page >= res.page_count) return { workouts: out, truncated: false };
    }
  }

  // ---- Routines -----------------------------------------------------------

  listRoutines(page = 1, pageSize: number = MAX_PAGE_SIZE.routines): Promise<RoutinesPage> {
    return this.page<RoutinesPage>("/v1/routines", "routines", { page, pageSize });
  }

  async getRoutine(id: string): Promise<Routine> {
    const res = await this.request<{ routine: Routine } | Routine>(`/v1/routines/${encodeURIComponent(id)}`);
    return "routine" in res ? res.routine : res;
  }

  async getAllRoutines(): Promise<Routine[]> {
    return this.collect((p) => this.listRoutines(p), (r) => r.routines);
  }

  listRoutineFolders(page = 1, pageSize: number = MAX_PAGE_SIZE.routineFolders): Promise<RoutineFoldersPage> {
    return this.page<RoutineFoldersPage>("/v1/routine_folders", "routine_folders", { page, pageSize });
  }

  async getAllRoutineFolders(): Promise<RoutineFolder[]> {
    return this.collect((p) => this.listRoutineFolders(p), (r) => r.routine_folders);
  }

  // ---- Exercise templates -------------------------------------------------

  listExerciseTemplates(page = 1, pageSize: number = MAX_PAGE_SIZE.exerciseTemplates): Promise<ExerciseTemplatesPage> {
    return this.page<ExerciseTemplatesPage>("/v1/exercise_templates", "exercise_templates", { page, pageSize });
  }

  getExerciseTemplate(id: string): Promise<ExerciseTemplate> {
    return this.request<ExerciseTemplate>(`/v1/exercise_templates/${encodeURIComponent(id)}`);
  }

  /** All exercise templates (built-in + custom), cached in memory. */
  getAllExerciseTemplates(): Promise<ExerciseTemplate[]> {
    const now = Date.now();
    if (!this.templateCache || now - this.templateCache.at > this.templateCacheTtlMs) {
      const templates = this.collect(
        (p) => this.listExerciseTemplates(p),
        (r) => r.exercise_templates,
      );
      this.templateCache = { at: now, templates };
      templates.catch(() => (this.templateCache = undefined));
    }
    return this.templateCache.templates;
  }

  async getExerciseTemplateMap(): Promise<Map<string, ExerciseTemplate>> {
    return new Map((await this.getAllExerciseTemplates()).map((t) => [t.id, t]));
  }

  async getExerciseHistory(templateId: string, startDate?: string, endDate?: string): Promise<ExerciseHistoryEntry[]> {
    const res = await this.request<{ exercise_history: ExerciseHistoryEntry[] }>(
      `/v1/exercise_history/${encodeURIComponent(templateId)}`,
      { start_date: startDate, end_date: endDate },
    );
    return res.exercise_history ?? [];
  }

  // ---- Body measurements --------------------------------------------------

  listBodyMeasurements(page = 1, pageSize: number = MAX_PAGE_SIZE.bodyMeasurements): Promise<BodyMeasurementsPage> {
    return this.page<BodyMeasurementsPage>("/v1/body_measurements", "body_measurements", { page, pageSize });
  }

  async getAllBodyMeasurements(maxPages = 100): Promise<BodyMeasurement[]> {
    return this.collect((p) => this.listBodyMeasurements(p), (r) => r.body_measurements, maxPages);
  }

  // ---- helpers ------------------------------------------------------------

  private async collect<P extends { page_count: number }, I>(
    load: (page: number) => Promise<P>,
    items: (p: P) => I[] | undefined,
    maxPages = 200,
  ): Promise<I[]> {
    const out: I[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await load(page);
      const batch = items(res) ?? [];
      out.push(...batch);
      if (!batch.length || page >= res.page_count) break;
    }
    return out;
  }
}
