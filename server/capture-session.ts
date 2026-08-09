import { randomUUID } from "node:crypto";

import type { EncoderSafeDimensions } from "./capture-config.js";
import type { CaptureSource, CaptureTarget } from "./capture-targets.js";
import type { SourceRecordConfiguration } from "./source-record.js";

export interface CaptureSessionScene {
  sceneName: string;
  sceneUuid: string;
}

/**
 * The externally readable recovery summary is intentionally descriptive, not
 * a settings dump.  OBS input settings can contain plugin-specific material;
 * raw snapshots remain private to the sidecar for a future restore tool.
 */
export interface CaptureSessionRecovery {
  input: "manual_confirmation_required" | "remove_created_input" | "restore_previous_target";
  /** Whether all configuration mutations were confirmed by OBS. */
  mutationOutcome: "confirmed" | "scene_attachment_rejected" | "source_record_filter_rejected" | "unknown";
  previousTargetRef?: string;
  sceneItem:
    | "manual_confirmation_required"
    | "remove_added_scene_item"
    | "preserve_existing_scene_item";
}

export interface ConfiguredCaptureSource {
  configurationState: "configured" | "partial_recovery_required";
  /** Normalized output intent for a later per-source recording configuration. */
  encoderSafeDimensions?: EncoderSafeDimensions;
  recovery: CaptureSessionRecovery;
  scene: CaptureSessionScene;
  source: CaptureSource;
  sourceRecord?: SourceRecordConfiguration;
  target: Pick<CaptureTarget, "availability" | "kind" | "label" | "targetRef" | "validity">;
}

/**
 * An ambiguous CreateInput response could not be tied safely to an OBS UUID.
 * Keep its unique name and intended scene visible for manual recovery rather
 * than making a second creation attempt or guessing ownership of the input.
 */
export interface UnresolvedCaptureCreation {
  inputKind: string;
  inputName: string;
  recovery: "manual_confirmation_required";
  scene: CaptureSessionScene;
  target: Pick<CaptureTarget, "kind" | "targetRef">;
}

export interface CaptureSession {
  configuredSources: ConfiguredCaptureSource[];
  revision: number;
  sessionId: string;
  unresolvedCreations: UnresolvedCaptureCreation[];
}

/** Private restoration data retained only by the singleton sidecar. */
export interface CaptureSessionRestoreSnapshot {
  configuredSourceRef: string;
  previousInputSettings?: Record<string, number | string>;
  sceneItemId?: number;
}

/**
 * One sidecar owns this store and injects it into every MCP session.  Writes
 * are serialized across clients and replacement snapshots are atomically
 * observable: callers see either the old session or the complete new one.
 */
export class CaptureSessionStore {
  #session: CaptureSession = { configuredSources: [], revision: 0, sessionId: randomUUID(), unresolvedCreations: [] };
  #restoreSnapshots = new Map<string, CaptureSessionRestoreSnapshot>();
  #tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  read(): CaptureSession {
    return structuredClone(this.#session);
  }

  record(configuration: ConfiguredCaptureSource, restoreSnapshot: CaptureSessionRestoreSnapshot): CaptureSession {
    const previous = this.#session.configuredSources.find(
      (candidate) => candidate.source.sourceRef === configuration.source.sourceRef,
    );
    const merged = previous ? mergeConfigurationRecovery(previous, configuration) : configuration;
    const configuredSources = previous
      ? this.#session.configuredSources.map((candidate) =>
        candidate.source.sourceRef === configuration.source.sourceRef ? merged : candidate,
      )
      : [...this.#session.configuredSources, merged];
    this.#session = {
      configuredSources,
      revision: this.#session.revision + 1,
      sessionId: this.#session.sessionId,
      unresolvedCreations: this.#session.unresolvedCreations.filter(
        (candidate) => candidate.inputName !== configuration.source.inputName,
      ),
    };
    // Preserve the original restoration point when a source is reconfigured
    // during one session; restore must return to pre-scenecap state, not an
    // intermediate target.
    if (!this.#restoreSnapshots.has(configuration.source.sourceRef)) {
      this.#restoreSnapshots.set(configuration.source.sourceRef, structuredClone(restoreSnapshot));
    }
    return this.read();
  }

  recordUnresolvedCreation(creation: UnresolvedCaptureCreation): CaptureSession {
    const unresolvedCreations = [
      ...this.#session.unresolvedCreations.filter((candidate) => candidate.inputName !== creation.inputName),
      structuredClone(creation),
    ];
    this.#session = {
      ...this.#session,
      revision: this.#session.revision + 1,
      unresolvedCreations,
    };
    return this.read();
  }

  /** For a future restore tool; never return this through MCP. */
  restoreSnapshot(sourceRef: string): CaptureSessionRestoreSnapshot | undefined {
    const snapshot = this.#restoreSnapshots.get(sourceRef);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
}

function mergeConfigurationRecovery(
  original: ConfiguredCaptureSource,
  replacement: ConfiguredCaptureSource,
): ConfiguredCaptureSource {
  const originalRecovery = original.recovery;
  const replacementRecovery = replacement.recovery;
  const input = originalRecovery.input === "remove_created_input"
    ? "remove_created_input"
    : originalRecovery.input === "manual_confirmation_required"
      ? "manual_confirmation_required"
      : replacementRecovery.input;
  const sceneItem = originalRecovery.sceneItem === "remove_added_scene_item"
    ? "remove_added_scene_item"
    : originalRecovery.sceneItem === "manual_confirmation_required"
      ? "manual_confirmation_required"
      : replacementRecovery.sceneItem;
  const mutationOutcome = moreSevereOutcome(originalRecovery.mutationOutcome, replacementRecovery.mutationOutcome);
  return {
    ...replacement,
    configurationState:
      original.configurationState === "partial_recovery_required" || replacement.configurationState === "partial_recovery_required"
        ? "partial_recovery_required"
        : "configured",
    encoderSafeDimensions: replacement.encoderSafeDimensions ?? original.encoderSafeDimensions,
    recovery: {
      input,
      mutationOutcome,
      ...(originalRecovery.previousTargetRef || replacementRecovery.previousTargetRef
        ? { previousTargetRef: originalRecovery.previousTargetRef ?? replacementRecovery.previousTargetRef }
        : {}),
      sceneItem,
    },
  };
}

function moreSevereOutcome(
  left: CaptureSessionRecovery["mutationOutcome"],
  right: CaptureSessionRecovery["mutationOutcome"],
): CaptureSessionRecovery["mutationOutcome"] {
  const severity = { confirmed: 0, scene_attachment_rejected: 1, source_record_filter_rejected: 1, unknown: 2 } as const;
  return severity[left] >= severity[right] ? left : right;
}
