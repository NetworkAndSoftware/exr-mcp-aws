import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { WorkoutListing } from "./exr.js";
import type { ExrWorkoutFile } from "./workout.js";

// Copies of workouts removed from EXR, so a removal can be undone: one S3 object per workout,
// under archive/<the person's EXR email>/<workout ID>.json. The server can write and read them
// but not delete them. The bucket's lifecycle rule purges them after ARCHIVE_DAYS (template.yaml).

// id is the workout's ID in EXR when it was archived
export type ArchivedWorkout = WorkoutListing & { archivedAt: string; file: ExrWorkoutFile };

// One person's archive
export interface WorkoutArchive {
  put(workout: ArchivedWorkout): Promise<void>;
  get(id: string): Promise<ArchivedWorkout | undefined>;
  // Newest first
  list(): Promise<ArchivedWorkout[]>;
}

const s3 = new S3Client({});

export class S3Archive implements WorkoutArchive {
  private prefix: string;

  constructor(
    private bucket: string,
    owner: string
  ) {
    this.prefix = `archive/${encodeURIComponent(owner)}/`;
  }

  async put(workout: ArchivedWorkout): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}${workout.id}.json`,
        Body: JSON.stringify(workout),
        ContentType: "application/json",
      })
    );
  }

  async get(id: string): Promise<ArchivedWorkout | undefined> {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${id}.json` }));
      return JSON.parse(await object.Body!.transformToString()) as ArchivedWorkout;
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  async list(): Promise<ArchivedWorkout[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token }));
      keys.push(...(page.Contents ?? []).map((object) => object.Key!));
      token = page.NextContinuationToken;
    } while (token);
    const workouts = await Promise.all(keys.map((key) => this.get(key.slice(this.prefix.length, -".json".length))));
    return workouts
      .filter((workout): workout is ArchivedWorkout => workout !== undefined)
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }
}
