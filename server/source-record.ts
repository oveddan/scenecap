import { createHash } from "node:crypto";
import path from "node:path";

import { boundedObsRead, type ObsReadOptions, type ObsSocket } from "./obs.js";

export const SOURCE_RECORD_FILTER_KIND = "source_record_filter";
export const SOURCE_RECORD_RECORD_MODE = 3;
const ENCODER_DIMENSION_ALIGNMENT = 2;

export interface EncoderDimensions {
  height: number;
  width: number;
}

export interface EncoderSafeDimensions extends EncoderDimensions {
  adjusted: boolean;
  alignment: typeof ENCODER_DIMENSION_ALIGNMENT;
}

export type SourceRecordFormat = "fragmented_mov" | "fragmented_mp4" | "mkv";

/** Deliberately excludes encoder-specific knobs; defaults remain OBS-profile owned. */
export interface SourceRecordOptions {
  encoderDimensions?: EncoderDimensions;
  filenameTemplate?: string;
  format?: SourceRecordFormat;
  outputDirectory?: string;
}

export interface SourceRecordConfiguration {
  encoderSafeDimensions?: EncoderSafeDimensions;
  filterName: string;
  format?: SourceRecordFormat;
  mode: "when_obs_records";
  outputDirectory?: string;
}

export type SourceRecordConfigurationErrorKind =
  | "capability_unavailable"
  | "filter_collision"
  | "invalid_settings"
  | "mutation_ambiguous"
  | "mutation_rejected";

export class SourceRecordConfigurationError extends Error {
  constructor(
    readonly kind: SourceRecordConfigurationErrorKind,
    readonly mutationAttempted: boolean,
  ) {
    super("Source Record filter configuration failed.");
    this.name = "SourceRecordConfigurationError";
  }
}

interface SourceFilter {
  filterEnabled?: boolean;
  filterKind: string;
  filterName: string;
}

export async function ensureSourceRecordCapability(
  socket: ObsSocket,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<void> {
  const response = await boundedObsRead(
    socket,
    () => socket.request({ type: "GetSourceFilterKindList" }),
    options,
    deadline,
  );
  const kinds = isRecord(response) && Array.isArray(response.sourceFilterKinds)
    ? response.sourceFilterKinds.filter((value): value is string => typeof value === "string")
    : [];
  if (!kinds.includes(SOURCE_RECORD_FILTER_KIND)) {
    throw new SourceRecordConfigurationError("capability_unavailable", false);
  }
}

export async function configureSourceRecordFilter(
  socket: ObsSocket,
  source: { inputName: string; inputUuid: string },
  requested: SourceRecordOptions | undefined,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<SourceRecordConfiguration> {
  const normalized = normalizeOptions(requested);
  const filterName = sourceRecordFilterName(source.inputUuid);
  const response = await boundedObsRead(
    socket,
    () => socket.request({ data: { sourceName: source.inputName }, type: "GetSourceFilterList" }),
    options,
    deadline,
  );
  const existing = filters(response).find((filter) => filter.filterName === filterName);
  if (existing && existing.filterKind !== SOURCE_RECORD_FILTER_KIND) {
    throw new SourceRecordConfigurationError("filter_collision", false);
  }
  const filterSettings = settingsFor(normalized);
  try {
    if (existing) {
      await boundedObsRead(socket, () => socket.request({
        data: { filterName, filterSettings, overlay: true, sourceName: source.inputName },
        type: "SetSourceFilterSettings",
      }), options, deadline);
      // Updating settings does not change an existing filter's enabled state.
      // Re-enable only the deterministic filter we own, and only when OBS
      // explicitly reports it disabled. This avoids touching user filters.
      if (existing.filterEnabled === false) {
        await boundedObsRead(socket, () => socket.request({
          data: { filterEnabled: true, filterName, sourceName: source.inputName },
          type: "SetSourceFilterEnabled",
        }), options, deadline);
      }
    } else {
      await boundedObsRead(socket, () => socket.request({
        data: {
          filterEnabled: true,
          filterKind: SOURCE_RECORD_FILTER_KIND,
          filterName,
          filterSettings,
          sourceName: source.inputName,
        },
        type: "CreateSourceFilter",
      }), options, deadline);
    }
  } catch (error) {
    throw new SourceRecordConfigurationError(
      isDefinitiveObsRequestRejection(error) ? "mutation_rejected" : "mutation_ambiguous",
      true,
    );
  }
  return {
    ...(normalized.encoderDimensions ? { encoderSafeDimensions: alignEncoderDimensions(normalized.encoderDimensions) } : {}),
    filterName,
    ...(normalized.format ? { format: normalized.format } : {}),
    mode: "when_obs_records",
    ...(normalized.outputDirectory ? { outputDirectory: normalized.outputDirectory } : {}),
  };
}

export function sourceRecordFilterName(inputUuid: string): string {
  return `scenecap-source-record-v1-${createHash("sha256").update(inputUuid).digest("hex").slice(0, 16)}`;
}

function normalizeOptions(requested: SourceRecordOptions | undefined): SourceRecordOptions {
  if (!requested) return {};
  if (requested.outputDirectory !== undefined && !isSafeAbsolutePath(requested.outputDirectory)) {
    throw new SourceRecordConfigurationError("invalid_settings", false);
  }
  if (requested.filenameTemplate !== undefined && !isSafeTemplate(requested.filenameTemplate)) {
    throw new SourceRecordConfigurationError("invalid_settings", false);
  }
  if (requested.encoderDimensions) alignEncoderDimensions(requested.encoderDimensions);
  return requested;
}

function settingsFor(options: SourceRecordOptions): Record<string, boolean | number | string> {
  return {
    record_mode: SOURCE_RECORD_RECORD_MODE,
    ...(options.outputDirectory ? { path: options.outputDirectory } : {}),
    ...(options.filenameTemplate ? { filename_formatting: options.filenameTemplate } : {}),
    ...(options.format ? { rec_format: options.format } : {}),
    ...(options.encoderDimensions ? {
      height: alignEncoderDimensions(options.encoderDimensions).height,
      scale: true,
      width: alignEncoderDimensions(options.encoderDimensions).width,
    } : {}),
  };
}

function filters(response: unknown): SourceFilter[] {
  if (!isRecord(response) || !Array.isArray(response.filters)) return [];
  return response.filters.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.filterName !== "string" || typeof candidate.filterKind !== "string") return [];
    return [{
      ...(typeof candidate.filterEnabled === "boolean" ? { filterEnabled: candidate.filterEnabled } : {}),
      filterKind: candidate.filterKind,
      filterName: candidate.filterName,
    }];
  });
}

function isSafeAbsolutePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 && path.isAbsolute(value) && !hasControlCharacter(value);
}

function isSafeTemplate(value: string): boolean {
  return value.length > 0 && value.length <= 300 && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefinitiveObsRequestRejection(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 200 && code < 700;
}

function alignEncoderDimensions(dimensions: EncoderDimensions): EncoderSafeDimensions {
  if (!isPositiveDimension(dimensions.width) || !isPositiveDimension(dimensions.height)) {
    throw new SourceRecordConfigurationError("invalid_settings", false);
  }
  const width = Math.ceil(dimensions.width / ENCODER_DIMENSION_ALIGNMENT) * ENCODER_DIMENSION_ALIGNMENT;
  const height = Math.ceil(dimensions.height / ENCODER_DIMENSION_ALIGNMENT) * ENCODER_DIMENSION_ALIGNMENT;
  return { adjusted: width !== dimensions.width || height !== dimensions.height, alignment: ENCODER_DIMENSION_ALIGNMENT, height, width };
}

function isPositiveDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 16_384;
}
