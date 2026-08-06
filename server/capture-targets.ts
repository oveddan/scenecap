import type { ObsConfig } from "./config.js";
import {
  boundedObsRead,
  createObsSocket,
  disconnectObsQuietly,
  normalizeObsReadOptions,
  type CapturePropertyName,
  type ObsReadOptions,
  type ObsSocket,
  type ObsSocketFactory,
} from "./obs.js";

const MAX_CAPTURE_INPUTS = 16;
const MAX_TARGETS_PER_KIND = 250;
export const DEFAULT_CAPTURE_TARGET_DISCOVERY_TIMEOUT_MS = 20_000;

export type CaptureTargetKind = "application" | "camera" | "display" | "window";

export interface CaptureSource {
  configuredTargetRef?: string;
  inputKind: string;
  inputName: string;
  sourceRef: string;
}

export interface CaptureTarget {
  availability: "available" | "configured_only";
  kind: CaptureTargetKind;
  label: string;
  targetRef: string;
  validity: "current_obs_session" | "persistent";
}

export interface CaptureTargetLimitation {
  code: "dynamic_list_unavailable" | "input_limit_reached" | "requires_existing_input";
  kind?: CaptureTargetKind | "screen_capture";
  message: string;
}

export interface CaptureTargetDiscovery {
  limitations: CaptureTargetLimitation[];
  sources: CaptureSource[];
  targets: CaptureTarget[];
  truncatedKinds: CaptureTargetKind[];
}

interface ObsInput {
  inputKind: string;
  inputName: string;
  inputUuid: string;
}

interface InputSnapshot extends ObsInput {
  settings: Record<string, unknown>;
}

interface PropertyProbe {
  kind: CaptureTargetKind;
  propertyName: CapturePropertyName;
}

const WINDOW_PROBE: PropertyProbe = { kind: "window", propertyName: "window" };

const CAMERA_INPUT_KINDS = new Set(["av_capture_input_v2", "macos-avcapture"]);

export async function readCaptureTargets(
  config: ObsConfig,
  createSocket: ObsSocketFactory = createObsSocket,
  optionsOrSignal: ObsReadOptions | AbortSignal = {},
): Promise<CaptureTargetDiscovery> {
  const options = normalizeObsReadOptions(
    isAbortSignal(optionsOrSignal)
      ? { signal: optionsOrSignal, timeoutMs: DEFAULT_CAPTURE_TARGET_DISCOVERY_TIMEOUT_MS }
      : { timeoutMs: DEFAULT_CAPTURE_TARGET_DISCOVERY_TIMEOUT_MS, ...optionsOrSignal },
  );
  const deadline = Date.now() + options.timeoutMs;
  const socket = createSocket();
  try {
    await boundedObsRead(
      socket,
      () => socket.connect({
        address: `ws://${config.host}:${config.port}`,
        eventSubscriptions: 0,
        password: config.password,
      }),
      options,
      deadline,
    );

    const inputResponse = await boundedObsRead(
      socket,
      () => socket.request({ type: "GetInputList" }),
      options,
      deadline,
    );
    const allCaptureInputs = parseInputs(inputResponse).filter(isSupportedCaptureInput);
    const inputs = allCaptureInputs.slice(0, MAX_CAPTURE_INPUTS);
    const snapshots = await readSnapshots(socket, inputs, options, deadline);

    const limitations: CaptureTargetLimitation[] = [];
    if (allCaptureInputs.length > inputs.length) {
      limitations.push({
        code: "input_limit_reached",
        message: `Only the first ${MAX_CAPTURE_INPUTS} supported OBS capture inputs were inspected.`,
      });
    }

    const screenInputs = snapshots.filter((input) => input.inputKind === "screen_capture");
    const cameraInputs = snapshots.filter((input) => CAMERA_INPUT_KINDS.has(input.inputKind));
    if (screenInputs.length === 0) {
      limitations.push({
        code: "requires_existing_input",
        kind: "screen_capture",
        message: "Add one macOS Screen Capture input in OBS before discovering displays, windows, or applications.",
      });
    } else {
      limitations.push(
        {
          code: "dynamic_list_unavailable",
          kind: "display",
          message: "Available displays cannot be queried safely through this OBS WebSocket build; configured display sources are still reported.",
        },
        {
          code: "dynamic_list_unavailable",
          kind: "application",
          message: "Available applications cannot be queried safely through this OBS WebSocket build; configured application sources are still reported.",
        },
      );
    }
    if (cameraInputs.length === 0) {
      limitations.push({
        code: "requires_existing_input",
        kind: "camera",
        message: "Add one Video Capture Device input in OBS before discovering cameras.",
      });
    } else {
      limitations.push({
        code: "dynamic_list_unavailable",
        kind: "camera",
        message: "Available cameras cannot yet be queried safely through this OBS WebSocket build; configured camera sources are still reported.",
      });
    }

    const targets: CaptureTarget[] = [];
    if (screenInputs.length > 0) {
      const probeInput = preferredScreenProbe(screenInputs);
      targets.push(...await readPropertyTargets(
        socket,
        probeInput,
        WINDOW_PROBE,
        options,
        deadline,
      ));
    }
    targets.push(...snapshots.flatMap(toConfiguredCaptureTarget));

    const { boundedTargets, truncatedKinds } = boundAndDedupeTargets(targets);
    return {
      limitations,
      sources: snapshots.map(toCaptureSource),
      targets: boundedTargets,
      truncatedKinds,
    };
  } finally {
    disconnectObsQuietly(socket);
  }
}

async function readSnapshots(
  socket: ObsSocket,
  inputs: ObsInput[],
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<InputSnapshot[]> {
  const snapshots: InputSnapshot[] = [];
  for (const input of inputs) {
    const response = await boundedObsRead(
      socket,
      () => socket.request({ data: { inputName: input.inputName }, type: "GetInputSettings" }),
      options,
      deadline,
    );
    snapshots.push({ ...input, settings: objectField(response, "inputSettings") });
  }
  return snapshots;
}

async function readPropertyTargets(
  socket: ObsSocket,
  input: InputSnapshot,
  probe: PropertyProbe,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<CaptureTarget[]> {
  const response = await boundedObsRead(
    socket,
    () => socket.request({
      data: { inputName: input.inputName, propertyName: probe.propertyName },
      type: "GetInputPropertiesListPropertyItems",
    }),
    options,
    deadline,
  );
  return arrayField(response, "propertyItems").flatMap((item) => {
    if (!isRecord(item) || item.itemEnabled === false) return [];
    const label = cleanLabel(item.itemName);
    const value = targetValue(item.itemValue);
    if (!label || value === undefined || value === "" || value === 0) return [];
    return [{
      availability: "available",
      kind: probe.kind,
      label,
      targetRef: encodeCaptureTargetRef(probe.kind, value),
      validity: probe.kind === "window" ? "current_obs_session" : "persistent",
    } satisfies CaptureTarget];
  });
}

function parseInputs(response: unknown): ObsInput[] {
  return arrayField(response, "inputs").flatMap((input) => {
    if (!isRecord(input)) return [];
    const { inputKind, inputName, inputUuid } = input;
    if (typeof inputKind !== "string" || typeof inputName !== "string" || typeof inputUuid !== "string") {
      return [];
    }
    return [{ inputKind, inputName, inputUuid }];
  });
}

function isSupportedCaptureInput(input: ObsInput): boolean {
  return input.inputKind === "screen_capture" || CAMERA_INPUT_KINDS.has(input.inputKind);
}

function preferredScreenProbe(inputs: InputSnapshot[]): InputSnapshot {
  return [...inputs].sort((left, right) => {
    const leftBroad = left.settings.show_hidden_windows === true || left.settings.show_empty_names === true;
    const rightBroad = right.settings.show_hidden_windows === true || right.settings.show_empty_names === true;
    return Number(rightBroad) - Number(leftBroad) || left.inputName.localeCompare(right.inputName);
  })[0] as InputSnapshot;
}

function toCaptureSource(input: InputSnapshot): CaptureSource {
  const configured = configuredTarget(input);
  return {
    ...(configured ? { configuredTargetRef: encodeCaptureTargetRef(configured.kind, configured.value) } : {}),
    inputKind: input.inputKind,
    inputName: input.inputName,
    sourceRef: encodeInputRef(input.inputUuid),
  };
}

function toConfiguredCaptureTarget(input: InputSnapshot): CaptureTarget[] {
  const configured = configuredTarget(input);
  if (!configured) return [];
  const deviceName = input.settings.device_name;
  const label = configured.kind === "camera" && typeof deviceName === "string" && deviceName.trim()
    ? deviceName.trim().slice(0, 300)
    : `${input.inputName} (configured ${configured.kind})`;
  return [{
    availability: "configured_only",
    kind: configured.kind,
    label,
    targetRef: encodeCaptureTargetRef(configured.kind, configured.value),
    validity: configured.kind === "window" ? "current_obs_session" : "persistent",
  }];
}

function configuredTarget(
  input: InputSnapshot,
): { kind: CaptureTargetKind; value: number | string } | undefined {
  if (input.inputKind === "screen_capture") {
    const captureType = input.settings.type;
    const selection = captureType === 0
      ? { kind: "display" as const, value: targetValue(input.settings.display_uuid) }
      : captureType === 1
        ? { kind: "window" as const, value: targetValue(input.settings.window) }
        : captureType === 2
          ? { kind: "application" as const, value: targetValue(input.settings.application) }
          : undefined;
    return selection?.value === undefined || selection.value === "" || selection.value === 0
      ? undefined
      : { kind: selection.kind, value: selection.value };
  }
  if (CAMERA_INPUT_KINDS.has(input.inputKind)) {
    const value = targetValue(input.settings.device);
    return value === undefined || value === "" || value === 0 ? undefined : { kind: "camera", value };
  }
  return undefined;
}

function boundAndDedupeTargets(targets: CaptureTarget[]): {
  boundedTargets: CaptureTarget[];
  truncatedKinds: CaptureTargetKind[];
} {
  const seen = new Set<string>();
  const counts = new Map<CaptureTargetKind, number>();
  const truncatedKinds = new Set<CaptureTargetKind>();
  const boundedTargets: CaptureTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.targetRef)) continue;
    seen.add(target.targetRef);
    const count = counts.get(target.kind) ?? 0;
    if (count >= MAX_TARGETS_PER_KIND) {
      truncatedKinds.add(target.kind);
      continue;
    }
    counts.set(target.kind, count + 1);
    boundedTargets.push(target);
  }
  return { boundedTargets, truncatedKinds: [...truncatedKinds] };
}

export function encodeCaptureTargetRef(kind: CaptureTargetKind, value: number | string): string {
  return `scenecap-target-v1.${Buffer.from(JSON.stringify([kind, value])).toString("base64url")}`;
}

function encodeInputRef(inputUuid: string): string {
  return `scenecap-input-v1.${Buffer.from(inputUuid).toString("base64url")}`;
}

function targetValue(value: unknown): number | string | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const field = value[key];
  return isRecord(field) ? field : {};
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: ObsReadOptions | AbortSignal): value is AbortSignal {
  return "aborted" in value && "addEventListener" in value;
}
