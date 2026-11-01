# mcp-hevy

An [MCP](https://modelcontextprotocol.io) server for the [Hevy](https://hevy.com) workout app API. It lets AI agents (Claude Desktop, Claude Code, Cursor, …) read your training log and **analyze** it: volume, frequency, muscle-group balance, strength progression, PRs, and bodyweight trends.

The server is read-only. It never changes anything in your Hevy account.

## Requirements

- Node.js 18+
- A **Hevy Pro** account and API key: in the Hevy app go to *Settings → Developer*, or visit <https://hevy.com/settings?developer>.

## Install

```bash
git clone https://github.com/arekminajj/mcp-hevy.git
cd mcp-hevy
npm install        # also builds to dist/
```

## Configure your MCP client

### Claude Code

```bash
claude mcp add hevy -e HEVY_API_KEY=your-key -- node /absolute/path/to/mcp-hevy/dist/index.js
```

### Claude Desktop / Cursor / other clients

```json
{
  "mcpServers": {
    "hevy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-hevy/dist/index.js"],
      "env": {
        "HEVY_API_KEY": "your-key",
        "HEVY_TIMEZONE": "Europe/Warsaw"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `HEVY_API_KEY` | yes | Your Hevy API key |
| `HEVY_TIMEZONE` | no | IANA time zone used to bucket workouts into days and weeks (defaults to the system zone) |
| `HEVY_DEFAULT_RANGE_DAYS` | no | Default look-back for analysis tools (default `90`) |
| `HEVY_BASE_URL` | no | Override the API base URL (default `https://api.hevyapp.com`) |

## Tools

### Analysis (start here)

| Tool | What it answers |
| --- | --- |
| `analyze_training_summary` | "How is my training going?" Workouts per week, hours, sets, reps, volume, **sets per muscle group**, top exercises, consistency (week streaks, longest gap, weekday distribution) and a per day/week/month breakdown. |
| `analyze_exercise_progress` | "Am I getting stronger at bench?" Per-session top weight, best set, **estimated 1RM**, volume and PR flags, plus the trend (change, % and rate per 4 weeks, sessions since the last PR). |
| `analyze_personal_records` | Best e1RM, heaviest set, most reps and best session volume for every exercise, plus the date each was last performed, so you can spot neglected lifts. |

### Raw data

| Tool | Description |
| --- | --- |
| `get_workouts` | All workouts in a date range, paginated for you. `format`: `headline`, `compact` (every set as short text) or `full` (raw API JSON). |
| `list_workouts` / `get_workout` | Paged workout list, or a single workout |
| `get_workout_count` | Total workouts logged |
| `get_workout_events` | Workouts updated or deleted since a timestamp |
| `get_exercise_history` | Every logged set of one exercise |
| `search_exercise_templates` | Search the exercise library by name, muscle group or equipment |
| `list_routines` / `get_routine` | Saved routines and their folders |
| `get_body_measurements` | Bodyweight and body measurements, with the weight trend |
| `get_user_info` | Account info |

Exercises can be given **by name**, with fuzzy matching (`"squat"`, `"bench dumbbell"`), or by `exercise_template_id`.

### Prompts

- `training_review`: a multi-week review of consistency, muscle balance and stalled lifts, with recommendations.
- `exercise_deep_dive`: a progression analysis for one exercise.

## Example questions for your agent

- "Summarize my last 12 weeks of training. Which muscle groups am I under-training?"
- "Has my squat e1RM improved since June? How fast?"
- "Which exercises haven't I done in over a month?"
- "Compare my training volume in September and October."
- "How has my bodyweight changed alongside my bench press?"

## How metrics are calculated

- **Working sets** are every set except `warmup`. Warm-ups are excluded from set counts and volume.
- **Volume** is the sum of weight × reps, in kg.
- **e1RM** uses the Epley formula `w × (1 + reps/30)` for sets of 1–15 reps.
- **Muscle-group sets**: each working set counts 1 toward the exercise's primary muscle and 0.5 toward each secondary muscle. Change this with `secondary_muscle_weight`.
- Weeks start on Monday.

## Development

```bash
npm run build      # compile to dist/
npm test           # unit tests and end-to-end MCP tests against a mocked Hevy API
npm run typecheck
npx @modelcontextprotocol/inspector node dist/index.js   # interactive debugging
```

Project layout:

- `src/client.ts`: Hevy REST client (auth, retries on 429 and 5xx, pagination, exercise-template cache)
- `src/analysis.ts`: pure analysis functions (summary, progression, PRs, search)
- `src/server.ts`: MCP tool and prompt definitions
- `src/index.ts`: stdio entry point
