import { createHash, randomUUID } from "node:crypto";

// EXR's custom workout file, as the web account's upload accepts it and its download returns it.
// A workout is a list of blocks, all timed or all distance-based, each with one fixed power
// target in % of the rower's FTP, or none (a free-row block, for rest), and an optional stroke
// rate. Workouts are converted from intervals.icu's workout_doc steps.

export const UNIT_TYPES = { distance: 0, time: 1 } as const;
export type Unit = keyof typeof UNIT_TYPES;
const FREE_ROW = -1;

export type ExrBlock = {
  // Seconds or meters, by the workout's unitType
  length: number;
  // Fraction of FTP (0.65 is 65%), or -1 for a free row
  FTPTarget: number;
  // 0 for none
  strokesPerMin: number;
};

export type ExrWorkoutFile = {
  metaData: { fileVersionNumber: number; guid: string };
  data: {
    category: string;
    title: string;
    unitType: number;
    description: string;
    schedule: ExrBlock[];
    events: unknown[];
  };
  editorData: { eventLinks: unknown[] };
  checksum: string;
  // EXR replaces it with the workout's ID in the account
  uuid: string;
  _id: number;
};

// A step of an intervals.icu workout_doc: a single step, or a repeat of nested steps
export type Target = { value?: number; start?: number; end?: number; units?: string };
export type Step = {
  duration?: number;
  distance?: number;
  power?: Target;
  cadence?: Target;
  ramp?: boolean;
  freeride?: boolean;
  reps?: number;
  steps?: Step[];
};

export type Conversion = { unit: Unit; blocks: ExrBlock[]; notes: string[] };

// Ramps become steps of about this length (seconds or meters), at most MAX_RAMP_STEPS of them
const RAMP_STEP: Record<Unit, number> = { time: 60, distance: 250 };
const MAX_RAMP_STEPS = 10;

export function convertSteps(steps: Step[], { ftpWatts }: { ftpWatts?: number } = {}): Conversion {
  const leaves = flatten(steps);
  if (leaves.length === 0) throw new Error("The workout has no steps");
  const units = leaves.map((step, index) => {
    if (step.duration && step.duration > 0) return "time";
    if (step.distance && step.distance > 0) return "distance";
    throw new Error(`Step ${index + 1} has no duration or distance`);
  });
  const unit = units[0];
  if (units.some((u) => u !== unit)) {
    throw new Error("EXR workouts are either all timed or all distance-based, and this one mixes both. Convert the steps to one kind first.");
  }

  const notes = new Set<string>();
  const percentOfFtp = (value: number, targetUnits = "%ftp") => {
    if (targetUnits === "%ftp") return value;
    if (targetUnits === "w") {
      if (!ftpWatts) throw new Error("Power targets in watts need ftp_watts, or convert them to %FTP");
      return (value / ftpWatts) * 100;
    }
    throw new Error(`Power targets in ${targetUnits} aren't supported; convert them to %FTP`);
  };

  const blocks = leaves.flatMap((step): ExrBlock[] => {
    const length = Math.max(1, Math.round(unit === "time" ? step.duration! : step.distance!));
    const strokesPerMin = Math.round(middle(step.cadence) ?? 0);
    const block = (percent: number | undefined, blockLength = length): ExrBlock => ({
      length: blockLength,
      FTPTarget: percent === undefined ? FREE_ROW : Math.round(percent * 100) / 10000,
      strokesPerMin,
    });

    if (step.freeride) return [block(undefined)];
    const power = step.power ?? {};
    const percent = middle(power);
    if (percent === undefined) {
      notes.add("Steps without a power target (e.g. heart rate or pace targets) became free-row blocks.");
      return [block(undefined)];
    }
    if (power.value !== undefined || power.start === undefined || power.end === undefined || power.start === power.end) {
      return [block(percentOfFtp(percent, power.units))];
    }
    if (!step.ramp) {
      notes.add("Power ranges use their midpoint.");
      return [block(percentOfFtp(percent, power.units))];
    }

    // A ramp: a staircase of equal steps, each at the ramp's power halfway through it
    notes.add(`Ramps became steps of about ${unit === "time" ? "a minute" : `${RAMP_STEP.distance} m`} each.`);
    const count = Math.min(MAX_RAMP_STEPS, Math.max(1, Math.round(length / RAMP_STEP[unit])));
    const [start, end] = [percentOfFtp(power.start, power.units), percentOfFtp(power.end, power.units)];
    return Array.from({ length: count }, (_, i) =>
      block(start + ((end - start) * (i + 0.5)) / count, Math.round((length * (i + 1)) / count) - Math.round((length * i) / count))
    );
  });

  return { unit, blocks, notes: [...notes] };
}

export function workoutFile(title: string, description: string, { unit, blocks }: Conversion): ExrWorkoutFile {
  const data = { category: "Custom Workouts", title, unitType: UNIT_TYPES[unit], description, schedule: blocks, events: [] };
  return {
    metaData: { fileVersionNumber: 2, guid: randomUUID() },
    data,
    editorData: { eventLinks: [] },
    // EXR's own checksum algorithm is unknown. Its website only requires a non-empty value.
    checksum: createHash("md5").update(JSON.stringify(data)).digest("hex"),
    uuid: randomUUID(),
    _id: 1,
  };
}

// A readable summary of a workout, with one line per block
export function describeWorkout({ title, description, unitType, schedule }: ExrWorkoutFile["data"]) {
  const unit: Unit = unitType === UNIT_TYPES.distance ? "distance" : "time";
  const total = schedule.reduce((sum, block) => sum + block.length, 0);
  return {
    title,
    description,
    unit,
    total: formatLength(total, unit),
    blocks: schedule.map((block) => {
      const target = block.FTPTarget < 0 ? "free row" : `${Math.round(block.FTPTarget * 1000) / 10}% FTP`;
      return `${formatLength(block.length, unit)} ${target}${block.strokesPerMin > 0 ? `, ${block.strokesPerMin} spm` : ""}`;
    }),
  };
}

function flatten(steps: Step[]): Step[] {
  return steps.flatMap((step) => {
    if (!step.steps?.length) return [step];
    const inner = flatten(step.steps);
    return Array.from({ length: step.reps ?? 1 }, () => inner).flat();
  });
}

// A target's single value, or the midpoint of its range
function middle(target: Target | undefined): number | undefined {
  if (target?.value !== undefined) return target.value;
  if (target?.start !== undefined && target.end !== undefined) return (target.start + target.end) / 2;
  return target?.start ?? target?.end;
}

function formatLength(length: number, unit: Unit): string {
  if (unit === "distance") return `${length} m`;
  const [h, m, s] = [Math.floor(length / 3600), Math.floor((length % 3600) / 60), length % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
