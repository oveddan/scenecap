import { describe, expect, it } from "vitest";

import { CaptureSessionStore } from "../server/capture-session.js";

describe("CaptureSessionStore", () => {
  it("preserves a scenecap-created source's original removal recovery when it is reconfigured", () => {
    const store = new CaptureSessionStore();
    const sourceRef = "scenecap-input-v1.Y3JlYXRlZC11dWlk";
    const created = {
      configurationState: "configured" as const,
      encoderSafeDimensions: { adjusted: false, alignment: 2 as const, height: 1_080, width: 1_920 },
      recovery: {
        input: "remove_created_input" as const,
        mutationOutcome: "confirmed" as const,
        sceneItem: "remove_added_scene_item" as const,
      },
      scene: { sceneName: "Record", sceneUuid: "scene-uuid" },
      source: {
        configuredTargetRef: "scenecap-target-v1.WyJ3aW5kb3ciLDQyXQ",
        inputKind: "screen_capture",
        inputName: "Terminal",
        sourceRef,
      },
      target: {
        availability: "available" as const,
        kind: "window" as const,
        label: "Terminal",
        targetRef: "scenecap-target-v1.WyJ3aW5kb3ciLDQyXQ",
        validity: "current_obs_session" as const,
      },
    };
    store.record(created, { configuredSourceRef: sourceRef });
    const updated = {
      ...created,
      encoderSafeDimensions: undefined,
      recovery: {
        input: "restore_previous_target" as const,
        mutationOutcome: "confirmed" as const,
        previousTargetRef: "scenecap-target-v1.WyJ3aW5kb3ciLDQxXQ",
        sceneItem: "preserve_existing_scene_item" as const,
      },
      target: { ...created.target, targetRef: "scenecap-target-v1.WyJ3aW5kb3ciLDQzXQ" },
    };
    store.record(updated, {
      configuredSourceRef: sourceRef,
      previousInputSettings: { type: 1, window: 42 },
    });

    expect(store.read()).toMatchObject({
      configuredSources: [{
        encoderSafeDimensions: { height: 1_080, width: 1_920 },
        recovery: {
          input: "remove_created_input",
          sceneItem: "remove_added_scene_item",
        },
      }],
      revision: 2,
    });
    expect(store.restoreSnapshot(sourceRef)).toEqual({ configuredSourceRef: sourceRef });
  });
});
