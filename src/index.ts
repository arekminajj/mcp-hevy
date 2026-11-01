#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HevyClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) {
    console.error(
      "HEVY_API_KEY is not set. Get your key in the Hevy app (Pro): Settings → Developer, " +
        "or at https://hevy.com/settings?developer",
    );
    process.exit(1);
  }

  const client = new HevyClient({ apiKey, baseUrl: process.env.HEVY_BASE_URL });
  const server = createServer(client, {
    timeZone: process.env.HEVY_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultRangeDays: process.env.HEVY_DEFAULT_RANGE_DAYS ? Number(process.env.HEVY_DEFAULT_RANGE_DAYS) : undefined,
  });

  await server.connect(new StdioServerTransport());
  console.error("mcp-hevy server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
