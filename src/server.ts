import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkoutArchive } from "./archive.js";
import type { ExrClient } from "./exr.js";
import { registerWorkoutTools } from "./tools/workouts.js";

const instructions = (archiveDays: number) => `Custom workouts in the user's account for EXR, an indoor rowing app.
To put a planned intervals.icu rowing workout into EXR, pass that event's workout_doc.steps to create_workout unchanged, with the event's name as the title and a short description, and today's date in the user's time zone.
EXR power targets are % of the FTP set in EXR. The user sees new workouts after restarting the EXR app (Training Mode > My Workouts).
Removing workouts is reversible: archive_workouts keeps a complete copy of each, which restore_workout can put back for ${archiveDays} days.`;

export function createMcpServer(client: ExrClient, archive: WorkoutArchive, archiveDays: number): McpServer {
  const server = new McpServer({ name: "exr", version: "1.0.0" }, { instructions: instructions(archiveDays) });
  registerWorkoutTools(server, client, archive, archiveDays);
  return server;
}
