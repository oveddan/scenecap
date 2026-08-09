import { describe, expect, it } from "vitest";

import {
  configureSourceRecordFilter,
  ensureSourceRecordCapability,
  SourceRecordConfigurationError,
  sourceRecordFilterName,
} from "../server/source-record.js";
import type { ObsConnectionOptions, ObsRequest, ObsSocket } from "../server/obs.js";

class FakeSocket implements ObsSocket {
  readonly requests: ObsRequest[] = [];

  constructor(readonly respond: (request: ObsRequest) => unknown | Promise<unknown>) {}

  async connect(options: ObsConnectionOptions): Promise<void> {
    void options;
  }
  async request(request: ObsRequest): Promise<unknown> {
    this.requests.push(request);
    return this.respond(request);
  }
  disconnect(): void {}
}

const options = { signal: new AbortController().signal, timeoutMs: 1_000 } as const;
const deadline = Date.now() + 1_000;
const source = { inputName: "Terminal", inputUuid: "terminal-uuid" };

describe("Source Record filter configuration", () => {
  it("uses an owned deterministic filter, inherited encoder defaults, safe overrides, and even scaling", async () => {
    const socket = new FakeSocket((request) => {
      if (request.type === "GetSourceFilterList") return { filters: [] };
      if (request.type === "CreateSourceFilter") return {};
      throw new Error(`Unexpected request ${request.type}`);
    });

    const configured = await configureSourceRecordFilter(socket, source, {
      encoderDimensions: { height: 1_081, width: 1_919 },
      filenameTemplate: "terminal-%CCYY-%MM-%DD",
      format: "mkv",
      outputDirectory: "/Users/example/Movies/scenecap",
    }, options, deadline);

    expect(configured).toEqual({
      encoderSafeDimensions: { adjusted: true, alignment: 2, height: 1_082, width: 1_920 },
      filterName: sourceRecordFilterName(source.inputUuid),
      format: "mkv",
      mode: "when_obs_records",
      outputDirectory: "/Users/example/Movies/scenecap",
    });
    expect(socket.requests).toEqual([
      { data: { sourceName: "Terminal" }, type: "GetSourceFilterList" },
      {
        data: {
          filterEnabled: true,
          filterKind: "source_record_filter",
          filterName: sourceRecordFilterName(source.inputUuid),
          filterSettings: {
            filename_formatting: "terminal-%CCYY-%MM-%DD",
            height: 1_082,
            path: "/Users/example/Movies/scenecap",
            rec_format: "mkv",
            record_mode: 3,
            scale: true,
            width: 1_920,
          },
          sourceName: "Terminal",
        },
        type: "CreateSourceFilter",
      },
    ]);
  });

  it("refuses a missing capability before source configuration begins", async () => {
    const socket = new FakeSocket(() => ({ sourceFilterKinds: ["crop_filter"] }));
    await expect(ensureSourceRecordCapability(socket, options, deadline)).rejects.toMatchObject({
      kind: "capability_unavailable",
      mutationAttempted: false,
    } satisfies Partial<SourceRecordConfigurationError>);
    expect(socket.requests).toEqual([{ type: "GetSourceFilterKindList" }]);
  });

  it("does not overwrite a colliding non-Source-Record filter", async () => {
    const socket = new FakeSocket((request) => request.type === "GetSourceFilterList"
      ? { filters: [{ filterKind: "crop_filter", filterName: sourceRecordFilterName(source.inputUuid) }] }
      : Promise.reject(new Error(`Unexpected request ${request.type}`)));
    await expect(configureSourceRecordFilter(socket, source, undefined, options, deadline)).rejects.toMatchObject({
      kind: "filter_collision",
      mutationAttempted: false,
    } satisfies Partial<SourceRecordConfigurationError>);
    expect(socket.requests).toEqual([{ data: { sourceName: "Terminal" }, type: "GetSourceFilterList" }]);
  });

  it("updates and re-enables a disabled scenecap-owned Source Record filter", async () => {
    const filterName = sourceRecordFilterName(source.inputUuid);
    const socket = new FakeSocket((request) => {
      if (request.type === "GetSourceFilterList") {
        return { filters: [{ filterEnabled: false, filterKind: "source_record_filter", filterName }] };
      }
      if (request.type === "SetSourceFilterSettings" || request.type === "SetSourceFilterEnabled") return {};
      throw new Error(`Unexpected request ${request.type}`);
    });

    await configureSourceRecordFilter(socket, source, undefined, options, deadline);

    expect(socket.requests).toEqual([
      { data: { sourceName: "Terminal" }, type: "GetSourceFilterList" },
      {
        data: { filterName, filterSettings: { record_mode: 3 }, overlay: true, sourceName: "Terminal" },
        type: "SetSourceFilterSettings",
      },
      {
        data: { filterEnabled: true, filterName, sourceName: "Terminal" },
        type: "SetSourceFilterEnabled",
      },
    ]);
  });

  it("does not send an enable mutation for an already enabled owned filter", async () => {
    const filterName = sourceRecordFilterName(source.inputUuid);
    const socket = new FakeSocket((request) => {
      if (request.type === "GetSourceFilterList") {
        return { filters: [{ filterEnabled: true, filterKind: "source_record_filter", filterName }] };
      }
      if (request.type === "SetSourceFilterSettings") return {};
      throw new Error(`Unexpected request ${request.type}`);
    });

    await configureSourceRecordFilter(socket, source, undefined, options, deadline);

    expect(socket.requests.map((request) => request.type)).toEqual([
      "GetSourceFilterList",
      "SetSourceFilterSettings",
    ]);
  });

  it.each([
    ["a definitive OBS rejection", Object.assign(new Error("invalid request"), { code: 500 }), "lookup_rejected"],
    ["an ambiguous lookup timeout", new Error("socket closed"), "lookup_ambiguous"],
  ] as const)("classifies %s before any filter mutation", async (_label, failure, kind) => {
    const socket = new FakeSocket((request) => {
      if (request.type === "GetSourceFilterList") throw failure;
      throw new Error(`Unexpected request ${request.type}`);
    });

    await expect(configureSourceRecordFilter(socket, source, undefined, options, deadline)).rejects.toMatchObject({
      kind,
      mutationAttempted: false,
    } satisfies Partial<SourceRecordConfigurationError>);
    expect(socket.requests).toEqual([{ data: { sourceName: "Terminal" }, type: "GetSourceFilterList" }]);
  });

  it("reports an ambiguous attempted mutation without claiming it was absent", async () => {
    const socket = new FakeSocket((request) => {
      if (request.type === "GetSourceFilterList") return { filters: [] };
      if (request.type === "CreateSourceFilter") throw new Error("socket closed");
      throw new Error(`Unexpected request ${request.type}`);
    });
    await expect(configureSourceRecordFilter(socket, source, undefined, options, deadline)).rejects.toMatchObject({
      kind: "mutation_ambiguous",
      mutationAttempted: true,
    } satisfies Partial<SourceRecordConfigurationError>);
  });
});
