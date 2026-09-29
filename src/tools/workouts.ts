import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArchivedWorkout, WorkoutArchive } from "../archive.js";
import type { ExrClient, WorkoutListing } from "../exr.js";
import { convertSteps, describeWorkout, isCreatedHere, workoutFile, type Step } from "../workout.js";

// intervals.icu workout_doc steps. Their other fields (warmup, text, hr, ...) are accepted and ignored.
const target = z.object({
  value: z.number().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  units: z.string().optional(),
});
const stepFields = {
  duration: z.number().positive().optional().describe("Seconds, for timed workouts"),
  distance: z.number().positive().optional().describe("Meters, for distance-based workouts"),
  power: target.optional().describe('Power target: {value} or {start, end}, in units "%ftp" (the default) or "w"'),
  cadence: target.optional().describe("Stroke rate target in strokes per minute: {value} or {start, end}"),
  ramp: z.boolean().optional().describe("Power goes gradually from start to end"),
  freeride: z.boolean().optional().describe("Free row: no power target"),
};
const step = z.object({
  ...stepFields,
  reps: z.number().int().min(1).max(100).optional().describe("Repeat the nested steps this many times"),
  steps: z.array(z.object(stepFields)).optional().describe("The steps to repeat"),
});

const workoutId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Not an EXR workout ID");

const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });

const utcToday = () => new Date().toISOString().slice(0, 10);

export function registerWorkoutTools(server: McpServer, client: ExrClient, archive: WorkoutArchive, archiveDays: number) {
  server.registerTool(
    "create_workout",
    {
      title: "Create EXR workout",
      description:
        "Creates a custom rowing workout in the user's EXR account, from steps in the format of an " +
        "intervals.icu workout's workout_doc.steps (pass those unchanged). The title gets the date in front. " +
        "Returns the new workout's ID and its blocks. " +
        "EXR blocks each have one fixed power target in % of the rower's FTP in EXR, or none (a free row), " +
        "and optionally a stroke rate: ramps become steps of about a minute (or 250 m) and ranges use their " +
        "midpoint. A workout is all timed or all distance-based. " +
        "The user has to restart the EXR app to find it under Training Mode > My Workouts. " +
        "Set dry_run to preview the blocks without creating anything.",
      inputSchema: {
        title: z.string().trim().min(1).max(100).describe("Workout name, e.g. the planned workout's name in intervals.icu"),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
          .optional()
          .describe("Date put in front of the title (YYYY-MM-DD), normally the user's today. Defaults to today in UTC."),
        description: z.string().trim().max(500).default("").describe("Short description shown in EXR, e.g. the session's purpose"),
        steps: z.array(step).min(1).describe("The workout's steps, as in intervals.icu's workout_doc.steps"),
        ftp_watts: z.number().positive().optional().describe("The rower's FTP in watts; only needed for power targets in watts"),
        dry_run: z.boolean().default(false).describe("Only show the blocks the workout would get"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, date = utcToday(), description, steps, ftp_watts, dry_run }) => {
      const conversion = convertSteps(steps as Step[], { ftpWatts: ftp_watts });
      const file = workoutFile(title.startsWith(date) ? title : `${date} ${title}`, description, conversion);
      const summary = { ...describeWorkout(file.data), notes: conversion.notes };
      if (dry_run) return textResult({ dry_run: true, ...summary });
      const id = await client.uploadWorkout(file);
      return textResult({ id, ...summary, next: "Restart the EXR app to find it under Training Mode > My Workouts." });
    }
  );

  server.registerTool(
    "list_workouts",
    {
      title: "List EXR workouts",
      description: "Lists the custom workouts in the user's EXR account, newest first: ID, title, description and total length.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const workouts = await client.listWorkouts();
      return textResult(workouts.length > 0 ? { workouts } : { workouts, note: "The EXR account has no custom workouts." });
    }
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get EXR workout",
      description: "Shows one custom workout from the user's EXR account block by block: length, power target in % of FTP (or free row) and stroke rate.",
      inputSchema: { id: workoutId.describe("The workout's ID, from list_workouts") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => textResult({ id, ...describeWorkout((await client.downloadWorkout(id)).data) })
  );

  server.registerTool(
    "archive_workouts",
    {
      title: "Archive EXR workouts",
      description:
        "Removes workouts from the user's EXR account reversibly, e.g. superseded daily rows. " +
        "Before removing anything, the server saves a complete copy of each workout (title, description, " +
        "every block with its power target and stroke rate) to its archive; if saving a copy fails, " +
        `nothing is removed. Archived workouts can be put back with restore_workout for ${archiveDays} days, ` +
        "after which the server purges them automatically. " +
        "Only workouts created through this connector can be removed; others (such as ones made in EXR) " +
        "are left alone and reported.",
      inputSchema: { ids: z.array(workoutId).min(1).max(50).describe("IDs of the workouts to archive, from list_workouts") },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ ids }) => {
      const listing = new Map((await client.listWorkouts()).map((workout) => [workout.id, workout]));
      const found = [...new Set(ids)].filter((id) => listing.has(id));
      const copies: ArchivedWorkout[] = [];
      const notCreatedHere: WorkoutListing[] = [];
      for (const id of found) {
        const file = await client.downloadWorkout(id);
        if (isCreatedHere(file)) copies.push({ ...listing.get(id)!, archivedAt: new Date().toISOString(), file });
        else notCreatedHere.push(listing.get(id)!);
      }
      // Every copy is saved before anything is removed, so a failed save removes nothing
      await Promise.all(copies.map((copy) => archive.put(copy)));
      const { deleted } = copies.length > 0 ? await client.deleteWorkouts(copies.map((copy) => copy.id)) : { deleted: [] };

      const notFound = ids.filter((id) => !listing.has(id));
      return textResult({
        archived: deleted,
        ...(deleted.length > 0 ? { restorable_until: addDays(utcToday(), archiveDays) } : {}),
        ...(notCreatedHere.length > 0
          ? { not_created_here: notCreatedHere, note: "Workouts not created through this connector can only be removed on the EXR website." }
          : {}),
        ...(notFound.length > 0 ? { not_found: notFound } : {}),
      });
    }
  );

  server.registerTool(
    "list_archived_workouts",
    {
      title: "List archived EXR workouts",
      description:
        "Lists the workouts removed with archive_workouts that can still be restored, newest first, " +
        `with the date until which each can be restored (${archiveDays} days after archiving). ` +
        "A restored workout stays listed here until it's purged.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const workouts = (await archive.list()).map(({ id, title, description, length, archivedAt }) => ({
        id,
        title,
        description,
        length,
        archived_at: archivedAt,
        restorable_until: addDays(archivedAt.slice(0, 10), archiveDays),
      }));
      return textResult(workouts.length > 0 ? { archived: workouts } : { archived: workouts, note: "The archive is empty." });
    }
  );

  server.registerTool(
    "restore_workout",
    {
      title: "Restore EXR workout",
      description:
        "Puts an archived workout back into the user's EXR account, unchanged, as a new workout with a new ID. " +
        "The archive keeps its copy until it's purged.",
      inputSchema: { id: workoutId.describe("The archived workout's ID, from archive_workouts or list_archived_workouts") },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id }) => {
      const workout = await archive.get(id);
      if (!workout) throw new Error(`No archived workout ${id}. It may have been purged; list_archived_workouts shows what can be restored.`);
      const newId = await client.uploadWorkout(workout.file);
      return textResult({
        id: newId,
        restored_from: id,
        ...describeWorkout(workout.file.data),
        next: "Restart the EXR app to find it under Training Mode > My Workouts.",
      });
    }
  );
}

const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
