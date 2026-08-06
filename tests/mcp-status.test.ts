import { describe, expect, it } from "vitest";

import { ConfigError, loadServerConfig } from "../server/config.js";
import { curatedCaptureTargetFailureReason, curatedFailureReason } from "../server/mcp.js";
import { ObsStatusError } from "../server/obs.js";

describe("get_status failure reporting", () => {
  it("keeps the sidecar startup configuration independent from OBS credentials", () => {
    expect(loadServerConfig({ env: { SCENECAP_PORT: "3234" } })).toEqual({
      http: { host: "127.0.0.1", port: 3234 },
    });
  });

  it.each([
    [new ConfigError("password: should not be exposed"), "OBS configuration is unavailable."],
    [new ObsStatusError("timeout"), "OBS preflight timed out."],
    [new ObsStatusError("cancelled"), "OBS preflight was cancelled."],
    [new Error("authentication failed for a secret"), "OBS authentication failed."],
    [Object.assign(new Error("closed"), { code: 4009 }), "OBS authentication failed."],
    [new Error("connect ECONNREFUSED"), "OBS is unavailable or refused the connection."],
    [new Error("Not connected"), "OBS is unavailable or refused the connection."],
    [Object.assign(new Error(""), { code: 1006 }), "OBS is unavailable or refused the connection."],
    [new Error("invalid subprotocol"), "OBS WebSocket protocol is incompatible."],
    [Object.assign(new Error("closed"), { code: 4010 }), "OBS WebSocket protocol is incompatible."],
    [new Error("secret-other-error"), "OBS preflight failed for an unknown reason."],
  ])("returns a curated non-secret failure reason", (error, expected) => {
    const reason = curatedFailureReason(error);
    expect(reason).toBe(expected);
    expect(reason).not.toContain("secret");
  });

  it.each([
    [new ConfigError("password: should not be exposed"), "OBS configuration is unavailable."],
    [new ObsStatusError("timeout"), "OBS capture target discovery timed out."],
    [new ObsStatusError("cancelled"), "OBS capture target discovery was cancelled."],
    [new Error("authentication failed for a secret"), "OBS authentication failed."],
    [new Error("secret-other-error"), "OBS capture target discovery failed for an unknown reason."],
  ])("returns a curated capture-discovery failure reason", (error, expected) => {
    const reason = curatedCaptureTargetFailureReason(error);
    expect(reason).toBe(expected);
    expect(reason).not.toContain("secret");
  });
});
