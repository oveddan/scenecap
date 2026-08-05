import { describe, expect, it } from "vitest";

import { ConfigError, loadServerConfig } from "../server/config.js";
import { curatedFailureReason } from "../server/mcp.js";
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
    [Object.assign(new Error("closed"), { code: 4005 }), "OBS authentication failed."],
    [new Error("connect ECONNREFUSED"), "OBS is unavailable or refused the connection."],
    [new Error("invalid subprotocol"), "OBS WebSocket protocol is incompatible."],
    [Object.assign(new Error("closed"), { code: 4009 }), "OBS WebSocket protocol is incompatible."],
    [new Error("secret-other-error"), "OBS preflight failed for an unknown reason."],
  ])("returns a curated non-secret failure reason", (error, expected) => {
    const reason = curatedFailureReason(error);
    expect(reason).toBe(expected);
    expect(reason).not.toContain("secret");
  });
});
