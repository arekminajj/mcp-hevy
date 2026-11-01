import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { HevyClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { templates, workouts } from "./fixtures.js";

/** Minimal fake of the Hevy API, enough to exercise pagination and routing. */
function fakeHevy() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    if (headers.get("api-key") !== "test-key") return new Response("unauthorized", { status: 401 });
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
    const paged = (key: string, items: unknown[]) => {
      const page_count = Math.max(1, Math.ceil(items.length / pageSize));
      if (page > page_count) return new Response("not found", { status: 404 });
      return Response.json({ page, page_count, [key]: items.slice((page - 1) * pageSize, page * pageSize) });
    };
    const p = url.pathname;
    if (p === "/v1/workouts") return paged("workouts", workouts);
    if (p === "/v1/workouts/count") return Response.json({ workout_count: workouts.length });
    if (p.startsWith("/v1/workouts/")) {
      const w = workouts.find((x) => x.id === p.split("/").pop());
      return w ? Response.json(w) : new Response("nope", { status: 404 });
    }
    if (p === "/v1/exercise_templates") return paged("exercise_templates", templates);
    if (p.startsWith("/v1/exercise_history/")) {
      const id = p.split("/").pop();
      const exercise_history = workouts.flatMap((w) =>
        w.exercises
          .filter((e) => e.exercise_template_id === id)
          .flatMap((e) =>
            e.sets.map((s) => ({
              workout_id: w.id,
              workout_title: w.title,
              workout_start_time: w.start_time,
              workout_end_time: w.end_time,
              exercise_template_id: id,
              weight_kg: s.weight_kg,
              reps: s.reps,
              set_type: s.type,
            })),
          ),
      );
      return Response.json({ exercise_history });
    }
    if (p === "/v1/user/info") return Response.json({ data: { id: "u1", name: "Tester", url: "https://hevy.com/user/tester" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("MCP server", () => {
  let client: Client;
  const hevy = fakeHevy();

  beforeAll(async () => {
    const api = new HevyClient({ apiKey: "test-key", fetchImpl: hevy.fetchImpl });
    const server = createServer(api, { timeZone: "UTC" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };

  it("lists tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "get_workouts",
        "analyze_training_summary",
        "analyze_exercise_progress",
        "analyze_personal_records",
        "search_exercise_templates",
      ]),
    );
  });

  it("gets workouts in a date range", async () => {
    const res = await call("get_workouts", { start_date: "2026-10-05", end_date: "2026-10-15", format: "headline" });
    expect(res.workouts.map((w: { id: string }) => w.id)).toEqual(["w3", "w2"]);
  });

  it("summarizes training", async () => {
    const res = await call("analyze_training_summary", { start_date: "2026-09-01", end_date: "2026-10-31" });
    expect(res.totals.workouts).toBe(4);
    expect(res.muscle_group_sets.chest).toBe(8);
  });

  it("analyzes exercise progress by fuzzy name", async () => {
    const res = await call("analyze_exercise_progress", {
      exercise: "squat",
      start_date: "2026-01-01",
      end_date: "2026-10-31",
    });
    expect(res.exercise.id).toBe("SQUAT");
    expect(res.source).toBe("exercise_history");
    expect(res.history.map((h: { top_weight_kg: number }) => h.top_weight_kg)).toEqual([100, 110, 120]);
  });

  it("returns a helpful error for unknown exercises", async () => {
    await expect(call("analyze_exercise_progress", { exercise: "zercher deadlift" })).rejects.toThrow(
      /search_exercise_templates/,
    );
  });

  it("reports auth errors", async () => {
    const api = new HevyClient({ apiKey: "bad", fetchImpl: hevy.fetchImpl, maxRetries: 0 });
    const server = createServer(api);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const res = await c.callTool({ name: "get_user_info", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/HEVY_API_KEY/);
  });
});
