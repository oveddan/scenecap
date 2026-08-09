import { randomUUID } from "node:crypto";

import type { CaptureSource, CaptureTarget } from "./capture-targets.js";

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
  input: "remove_created_input" | "restore_previous_target";
  /** Whether all configuration mutations were confirmed by OBS. */
  mutationOutcome: "confirmed" | "scene_attachment_rejected" | "unknown";
  previousTargetRef?: string;
  sceneItem:
    | "manual_confirmation_required"
    | "remove_added_scene_item"
    | "preserve_existing_scene_item";
}

export interface ConfiguredCaptureSource {
  configurationState: "configured" | "partial_recovery_required";
  recovery: CaptureSessionRecovery;
  scene: CaptureSessionScene;
  source: CaptureSource;
  target: Pick<CaptureTarget, "availability" | "kind" | "label" | "targetRef" | "validity">;
}

export interface CaptureSession {
  configuredSources: ConfiguredCaptureSource[];
  revision: number;
  sessionId: string;
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
  #session: CaptureSession = { configuredSources: [], revision: 0, sessionId: randomUUID() };
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
    const configuredSources = previous
      ? this.#session.configuredSources.map((candidate) =>
        candidate.source.sourceRef === configuration.source.sourceRef ? configuration : candidate,
      )
      : [...this.#session.configuredSources, configuration];
    this.#session = {
      configuredSources,
      revision: this.#session.revision + 1,
      sessionId: this.#session.sessionId,
    };
    // Preserve the original restoration point when a source is reconfigured
    // during one session; restore must return to pre-scenecap state, not an
    // intermediate target.
    if (!this.#restoreSnapshots.has(configuration.source.sourceRef)) {
      this.#restoreSnapshots.set(configuration.source.sourceRef, structuredClone(restoreSnapshot));
    }
    return this.read();
  }

  /** For a future restore tool; never return this through MCP. */
  restoreSnapshot(sourceRef: string): CaptureSessionRestoreSnapshot | undefined {
    const snapshot = this.#restoreSnapshots.get(sourceRef);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
}
