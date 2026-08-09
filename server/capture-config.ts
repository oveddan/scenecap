import type { ObsConfig } from "./config.js";
import type {
  CaptureSessionRecovery,
  CaptureSessionRestoreSnapshot,
  CaptureSessionScene,
  ConfiguredCaptureSource,
  UnresolvedCaptureCreation,
} from "./capture-session.js";
import {
  decodeCaptureTargetRef,
  decodeInputRef,
  isCompatibleCaptureInputKind,
  isSupportedCaptureInputKind,
  readCaptureTargets,
  type CaptureSource,
  type CaptureTarget,
  type CaptureTargetKind,
  type DecodedCaptureTargetRef,
  type SupportedCaptureInputKind,
} from "./capture-targets.js";
import {
  boundedObsRead,
  createObsSocket,
  disconnectObsQuietly,
  isAbortSignal,
  normalizeObsReadOptions,
  type ObsReadOptions,
  type ObsSocket,
  type ObsSocketFactory,
} from "./obs.js";

export const DEFAULT_CAPTURE_CONFIGURATION_TIMEOUT_MS = 20_000;
export const CAPTURE_CONFIGURATION_RECOVERY_TIMEOUT_MS = 5_000;
export const ENCODER_DIMENSION_ALIGNMENT = 2;

export interface EncoderDimensions {
  height: number;
  width: number;
}

export interface NewCaptureSource {
  inputKind?: SupportedCaptureInputKind;
  inputName: string;
}

export interface ConfigureCaptureTargetRequest {
  /** A targetRef returned by the current capture-target discovery result. */
  targetRef: string;
  /** An opaque sourceRef returned by discovery, for an in-place update. */
  sourceRef?: string;
  /** Required instead of sourceRef when creating a durable OBS input. */
  newSource?: NewCaptureSource;
  /** Existing OBS scene name; defaults to the current Program scene. */
  sceneName?: string;
  /**
   * Optional intended output dimensions.  They are rounded up to even pixels
   * and retained in the session contract for Source Record configuration.
   * #9 does not alter an OBS scene transform or camera preset: those could
   * crop, distort, or select an unsupported device mode.  #10 consumes this
   * normalized intent when it configures the per-source recording encoder.
   */
  encoderDimensions?: EncoderDimensions;
}

export interface EncoderSafeDimensions extends EncoderDimensions {
  adjusted: boolean;
  alignment: typeof ENCODER_DIMENSION_ALIGNMENT;
}

export interface CaptureTargetConfiguration {
  configuredSource: ConfiguredCaptureSource;
  encoderSafeDimensions?: EncoderSafeDimensions;
  restoreSnapshot: CaptureSessionRestoreSnapshot;
}

export type CaptureConfigurationErrorKind =
  | "incompatible_source"
  | "invalid_reference"
  | "invalid_request"
  | "source_unavailable"
  | "stale_reference";

export class CaptureConfigurationError extends Error {
  constructor(readonly kind: CaptureConfigurationErrorKind, message: string) {
    super(message);
    this.name = "CaptureConfigurationError";
  }
}

/**
 * A mutating OBS request had already succeeded, or its outcome is ambiguous,
 * before the configuration sequence failed.  Callers must retain this
 * sidecar-owned recovery point instead of pretending no state changed.
 */
export class CaptureConfigurationPartialError extends CaptureConfigurationError {
  constructor(
    readonly configuration: Omit<CaptureTargetConfiguration, "encoderSafeDimensions">,
    readonly outcome: "scene_attachment_rejected" | "unknown",
  ) {
    super("source_unavailable", "OBS capture configuration is only partially applied.");
    this.name = "CaptureConfigurationPartialError";
  }
}

/** OBS may have created an input, but a fresh lookup could not identify it safely. */
export class CaptureConfigurationAmbiguousCreationError extends CaptureConfigurationError {
  constructor(readonly creation: UnresolvedCaptureCreation) {
    super("source_unavailable", "OBS input creation may have succeeded but could not be verified.");
    this.name = "CaptureConfigurationAmbiguousCreationError";
  }
}

interface ObsInput {
  inputKind: string;
  inputName: string;
  inputUuid: string;
}

interface SceneItem {
  sceneItemId?: number;
  sourceName?: string;
  sourceUuid?: string;
}

/**
 * Persist one discovered target in OBS.  The function deliberately accepts no
 * generic settings object and makes only allowlisted input/scene mutations.
 * Store ownership and serialization live at the MCP boundary so every client
 * shares one CaptureSessionStore.
 */
export async function configureCaptureTarget(
  config: ObsConfig,
  request: ConfigureCaptureTargetRequest,
  createSocket: ObsSocketFactory = createObsSocket,
  optionsOrSignal: ObsReadOptions | AbortSignal = {},
): Promise<CaptureTargetConfiguration> {
  validateRequest(request);
  const timeoutMs = isAbortSignal(optionsOrSignal)
    ? DEFAULT_CAPTURE_CONFIGURATION_TIMEOUT_MS
    : optionsOrSignal.timeoutMs ?? DEFAULT_CAPTURE_CONFIGURATION_TIMEOUT_MS;
  const options = normalizeObsReadOptions(
    isAbortSignal(optionsOrSignal)
      ? { signal: optionsOrSignal, timeoutMs }
      : { ...optionsOrSignal, timeoutMs },
  );
  const deadline = Date.now() + options.timeoutMs;
  const discovery = await readCaptureTargets(config, createSocket, {
    signal: options.signal,
    timeoutMs: remainingTimeout(deadline),
  });
  const target = discovery.targets.find((candidate) => candidate.targetRef === request.targetRef);
  if (!target) {
    throw new CaptureConfigurationError("stale_reference", "The capture target is no longer available in OBS.");
  }

  const socket = createSocket();
  try {
    await connect(socket, config, options, deadline);
    const scene = await resolveScene(socket, request.sceneName, options, deadline);
    const operation = request.sourceRef
      ? await updateExistingInput(socket, request.sourceRef, target, scene, options, deadline)
      : await createNewInput(
        config,
        socket,
        request.newSource as NewCaptureSource,
        target,
        scene,
        createSocket,
        options,
        deadline,
      );
    const { restoreSnapshot, ...configuredSource } = operation;
    const encoderSafeDimensions = request.encoderDimensions ? alignEncoderDimensions(request.encoderDimensions) : undefined;
    return {
      configuredSource: {
        ...configuredSource,
        ...(encoderSafeDimensions ? { encoderSafeDimensions } : {}),
      },
      ...(encoderSafeDimensions ? { encoderSafeDimensions } : {}),
      restoreSnapshot,
    };
  } finally {
    void Promise.resolve(socket.disconnect()).catch(() => undefined);
  }
}

export function alignEncoderDimensions(dimensions: EncoderDimensions): EncoderSafeDimensions {
  if (!isPositiveDimension(dimensions.width) || !isPositiveDimension(dimensions.height)) {
    throw new CaptureConfigurationError(
      "invalid_request",
      "Encoder dimensions must be integers from 1 through 16384.",
    );
  }
  const width = alignDimension(dimensions.width);
  const height = alignDimension(dimensions.height);
  return {
    adjusted: width !== dimensions.width || height !== dimensions.height,
    alignment: ENCODER_DIMENSION_ALIGNMENT,
    height,
    width,
  };
}

async function updateExistingInput(
  socket: ObsSocket,
  sourceRef: string,
  target: CaptureTarget,
  scene: CaptureSessionScene,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<ConfiguredCaptureSource & { restoreSnapshot: CaptureSessionRestoreSnapshot }> {
  const inputUuid = decodeInputRef(sourceRef);
  if (!inputUuid) {
    throw new CaptureConfigurationError("invalid_reference", "The capture source reference is invalid.");
  }
  const inputs = parseInputs(await boundedObsRead(
    socket,
    () => socket.request({ type: "GetInputList" }),
    options,
    deadline,
  ));
  const input = inputs.find((candidate) => candidate.inputUuid === inputUuid);
  if (!input) {
    throw new CaptureConfigurationError("source_unavailable", "The capture source is no longer available in OBS.");
  }
  if (!isSupportedCaptureInputKind(input.inputKind)) {
    throw new CaptureConfigurationError("incompatible_source", "The selected OBS source is not a supported capture input.");
  }
  if (!isCompatibleCaptureInputKind(target.kind, input.inputKind)) {
    throw new CaptureConfigurationError("incompatible_source", "The selected source kind cannot capture that target kind.");
  }
  const previousSettings = objectField(await boundedObsRead(
    socket,
    () => socket.request({ data: { inputName: input.inputName }, type: "GetInputSettings" }),
    options,
    deadline,
  ), "inputSettings");
  const previousTarget = targetFromSettings(input.inputKind, previousSettings);
  const source = captureSource(input, requestSourceRef(input.inputUuid), target.targetRef);
  try {
    await boundedObsRead(
      socket,
      () => socket.request({
        data: { inputName: input.inputName, inputSettings: targetSettings(target), overlay: true },
        type: "SetInputSettings",
      }),
      options,
      deadline,
    );
  } catch (error) {
    if (!isDefinitiveObsRequestRejection(error)) {
      throw partialConfiguration(source, target, scene, previousTarget, "unknown", "preserve_existing_scene_item");
    }
    throw error;
  }
  let sceneItem: { added: boolean; sceneItemId?: number };
  try {
    sceneItem = await ensureSceneItem(socket, input, scene, options, deadline);
  } catch (error) {
    throw partialConfiguration(
      source,
      target,
      scene,
      previousTarget,
      isDefinitiveObsRequestRejection(error) ? "scene_attachment_rejected" : "unknown",
      "manual_confirmation_required",
    );
  }
  const recovery = recoveryForExistingInput(previousTarget, sceneItem.added);
  return {
    configurationState: "configured",
    recovery,
    restoreSnapshot: {
      configuredSourceRef: source.sourceRef,
      previousInputSettings: previousTarget ? targetSettings(previousTarget) : undefined,
      ...(sceneItem.sceneItemId === undefined ? {} : { sceneItemId: sceneItem.sceneItemId }),
    },
    scene,
    source,
    target: publicTarget(target),
  };
}

async function createNewInput(
  config: ObsConfig,
  socket: ObsSocket,
  newSource: NewCaptureSource,
  target: CaptureTarget,
  scene: CaptureSessionScene,
  createSocket: ObsSocketFactory,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<ConfiguredCaptureSource & { restoreSnapshot: CaptureSessionRestoreSnapshot }> {
  const inputKind = newSource.inputKind ?? defaultInputKind(target.kind);
  if (!isCompatibleCaptureInputKind(target.kind, inputKind)) {
    throw new CaptureConfigurationError("incompatible_source", "The requested input kind cannot capture that target kind.");
  }
  const existingInputs = parseInputs(await boundedObsRead(
    socket,
    () => socket.request({ type: "GetInputList" }),
    options,
    deadline,
  ));
  if (existingInputs.some((input) => input.inputName === newSource.inputName)) {
    throw new CaptureConfigurationError("invalid_request", "An OBS input already uses that name; select it by sourceRef instead.");
  }
  let response: unknown;
  try {
    response = await boundedObsRead(
      socket,
      () => socket.request({
        data: {
          inputKind,
          inputName: newSource.inputName,
          inputSettings: targetSettings(target),
          sceneItemEnabled: true,
          sceneName: scene.sceneName,
        },
        type: "CreateInput",
      }),
      options,
      deadline,
    );
  } catch (error) {
    if (isDefinitiveObsRequestRejection(error)) throw error;
    return recoverAmbiguousCreatedInput(config, socket, newSource, inputKind, target, scene, createSocket);
  }
  const inputUuid = objectString(response, "inputUuid");
  if (!inputUuid) {
    return recoverAmbiguousCreatedInput(config, socket, newSource, inputKind, target, scene, createSocket);
  }
  const source = captureSource({ inputKind, inputName: newSource.inputName, inputUuid }, requestSourceRef(inputUuid), target.targetRef);
  const sceneItemId = objectInteger(response, "sceneItemId");
  return {
    configurationState: "configured",
    recovery: { input: "remove_created_input", mutationOutcome: "confirmed", sceneItem: "remove_added_scene_item" },
    restoreSnapshot: {
      configuredSourceRef: source.sourceRef,
      ...(sceneItemId === undefined ? {} : { sceneItemId }),
    },
    scene,
    source,
    target: publicTarget(target),
  };
}

async function recoverAmbiguousCreatedInput(
  config: ObsConfig,
  primarySocket: ObsSocket,
  newSource: NewCaptureSource,
  inputKind: SupportedCaptureInputKind,
  target: CaptureTarget,
  scene: CaptureSessionScene,
  createSocket: ObsSocketFactory,
): Promise<never> {
  // A response timeout/cancellation does not say whether OBS applied the
  // mutation. Close the original connection and use a new one so a stale
  // request queue cannot be mistaken for an absence proof.
  disconnectObsQuietly(primarySocket);
  const recoverySocket = createSocket();
  const recoveryOptions = normalizeObsReadOptions({ timeoutMs: CAPTURE_CONFIGURATION_RECOVERY_TIMEOUT_MS });
  const recoveryDeadline = Date.now() + recoveryOptions.timeoutMs;
  try {
    await connect(recoverySocket, config, recoveryOptions, recoveryDeadline);
    const inputs = parseInputs(await boundedObsRead(
      recoverySocket,
      () => recoverySocket.request({ type: "GetInputList" }),
      recoveryOptions,
      recoveryDeadline,
    ));
    const input = inputs.find((candidate) => candidate.inputName === newSource.inputName);
    if (!input) {
      // A fresh, successful list is an absence proof: no durable input is
      // left to track, so fail normally rather than issuing a duplicate.
      throw new CaptureConfigurationError("source_unavailable", "OBS did not confirm the configured source identity.");
    }
    if (input.inputKind === inputKind) {
      const source = captureSource(input, requestSourceRef(input.inputUuid), target.targetRef);
      throw new CaptureConfigurationPartialError({
        configuredSource: {
          configurationState: "partial_recovery_required",
          recovery: {
            input: "manual_confirmation_required",
            mutationOutcome: "unknown",
            sceneItem: "manual_confirmation_required",
          },
          scene,
          source,
          target: publicTarget(target),
        },
        restoreSnapshot: { configuredSourceRef: source.sourceRef },
      }, "unknown");
    }
    throw new CaptureConfigurationAmbiguousCreationError(unresolvedCreation(newSource, inputKind, target, scene));
  } catch (error) {
    if (
      error instanceof CaptureConfigurationError
      || error instanceof CaptureConfigurationPartialError
      || error instanceof CaptureConfigurationAmbiguousCreationError
    ) throw error;
    throw new CaptureConfigurationAmbiguousCreationError(unresolvedCreation(newSource, inputKind, target, scene));
  } finally {
    disconnectObsQuietly(recoverySocket);
  }
}

function unresolvedCreation(
  newSource: NewCaptureSource,
  inputKind: SupportedCaptureInputKind,
  target: CaptureTarget,
  scene: CaptureSessionScene,
): UnresolvedCaptureCreation {
  return {
    inputKind,
    inputName: newSource.inputName,
    recovery: "manual_confirmation_required",
    scene,
    target: { kind: target.kind, targetRef: target.targetRef },
  };
}

async function resolveScene(
  socket: ObsSocket,
  requestedSceneName: string | undefined,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<CaptureSessionScene> {
  if (!requestedSceneName) {
    const response = await boundedObsRead(socket, () => socket.request({ type: "GetCurrentProgramScene" }), options, deadline);
    const sceneName = objectString(response, "currentProgramSceneName");
    const sceneUuid = objectString(response, "currentProgramSceneUuid");
    if (!sceneName || !sceneUuid) {
      throw new CaptureConfigurationError("source_unavailable", "OBS did not report an active Program scene.");
    }
    return { sceneName, sceneUuid };
  }
  const response = await boundedObsRead(socket, () => socket.request({ type: "GetSceneList" }), options, deadline);
  const scene = arrayField(response, "scenes").find((candidate) => objectString(candidate, "sceneName") === requestedSceneName);
  const sceneUuid = scene ? objectString(scene, "sceneUuid") : undefined;
  if (!sceneUuid) {
    throw new CaptureConfigurationError("source_unavailable", "The requested OBS scene is no longer available.");
  }
  return { sceneName: requestedSceneName, sceneUuid };
}

async function ensureSceneItem(
  socket: ObsSocket,
  input: ObsInput,
  scene: CaptureSessionScene,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<{ added: boolean; sceneItemId?: number }> {
  const response = await boundedObsRead(
    socket,
    () => socket.request({ data: { sceneName: scene.sceneName }, type: "GetSceneItemList" }),
    options,
    deadline,
  );
  const existing = arrayField(response, "sceneItems").find((candidate) => {
    const item = candidate as SceneItem;
    return item.sourceUuid === input.inputUuid || item.sourceName === input.inputName;
  });
  if (existing) return { added: false, sceneItemId: objectInteger(existing, "sceneItemId") };
  const created = await boundedObsRead(
    socket,
    () => socket.request({ data: { sceneName: scene.sceneName, sourceName: input.inputName }, type: "CreateSceneItem" }),
    options,
    deadline,
  );
  return { added: true, sceneItemId: objectInteger(created, "sceneItemId") };
}

function validateRequest(request: ConfigureCaptureTargetRequest): void {
  if (!decodeCaptureTargetRef(request.targetRef)) {
    throw new CaptureConfigurationError("invalid_reference", "The capture target reference is invalid.");
  }
  if (Boolean(request.sourceRef) === Boolean(request.newSource)) {
    throw new CaptureConfigurationError("invalid_request", "Provide exactly one existing sourceRef or one new source definition.");
  }
  if (request.sourceRef && !decodeInputRef(request.sourceRef)) {
    throw new CaptureConfigurationError("invalid_reference", "The capture source reference is invalid.");
  }
  if (request.newSource) {
    if (!isSafeObsName(request.newSource.inputName)) {
      throw new CaptureConfigurationError("invalid_request", "The new OBS input name is invalid.");
    }
    if (request.newSource.inputKind && !isSupportedCaptureInputKind(request.newSource.inputKind)) {
      throw new CaptureConfigurationError("invalid_request", "The requested OBS input kind is invalid.");
    }
  }
  if (request.sceneName !== undefined && !isSafeObsName(request.sceneName)) {
    throw new CaptureConfigurationError("invalid_request", "The target OBS scene name is invalid.");
  }
  if (request.encoderDimensions) alignEncoderDimensions(request.encoderDimensions);
}

function targetSettings(target: Pick<CaptureTarget, "kind" | "targetRef"> | DecodedCaptureTargetRef): Record<string, number | string> {
  const decoded = "targetRef" in target ? decodeCaptureTargetRef(target.targetRef) : target;
  if (!decoded) throw new CaptureConfigurationError("invalid_reference", "The capture target reference is invalid.");
  switch (decoded.kind) {
    case "display": return { display_uuid: decoded.value, type: 0 };
    case "window": return { type: 1, window: decoded.value };
    case "application": return { application: decoded.value, type: 2 };
    case "camera": return { device: decoded.value };
  }
}

function targetFromSettings(
  inputKind: SupportedCaptureInputKind,
  settings: Record<string, unknown>,
): DecodedCaptureTargetRef | undefined {
  if (inputKind === "screen_capture") {
    const type = settings.type === undefined ? 0 : settings.type;
    if (type === 0 && typeof settings.display_uuid === "string" && settings.display_uuid) {
      return { kind: "display", value: settings.display_uuid };
    }
    if (type === 1 && isWindowId(settings.window)) return { kind: "window", value: settings.window };
    if (type === 2 && typeof settings.application === "string" && settings.application) {
      return { kind: "application", value: settings.application };
    }
    return undefined;
  }
  return typeof settings.device === "string" && settings.device
    ? { kind: "camera", value: settings.device }
    : undefined;
}

function recoveryForExistingInput(
  previousTarget: DecodedCaptureTargetRef | undefined,
  sceneItemAdded: boolean,
): CaptureSessionRecovery {
  return {
    input: "restore_previous_target",
    mutationOutcome: "confirmed",
    ...(previousTarget ? { previousTargetRef: encodeTarget(previousTarget) } : {}),
    sceneItem: sceneItemAdded ? "remove_added_scene_item" : "preserve_existing_scene_item",
  };
}

function partialConfiguration(
  source: CaptureSource,
  target: CaptureTarget,
  scene: CaptureSessionScene,
  previousTarget: DecodedCaptureTargetRef | undefined,
  outcome: "scene_attachment_rejected" | "unknown",
  sceneItem: CaptureSessionRecovery["sceneItem"],
): CaptureConfigurationPartialError {
  const recovery: CaptureSessionRecovery = {
    input: "restore_previous_target",
    mutationOutcome: outcome,
    ...(previousTarget ? { previousTargetRef: encodeTarget(previousTarget) } : {}),
    sceneItem,
  };
  return new CaptureConfigurationPartialError({
    configuredSource: { configurationState: "partial_recovery_required", recovery, scene, source, target: publicTarget(target) },
    restoreSnapshot: {
      configuredSourceRef: source.sourceRef,
      previousInputSettings: previousTarget ? targetSettings(previousTarget) : undefined,
    },
  }, outcome);
}

function defaultInputKind(targetKind: CaptureTargetKind): SupportedCaptureInputKind {
  return targetKind === "camera" ? "av_capture_input_v2" : "screen_capture";
}

function captureSource(input: ObsInput, sourceRef: string, targetRef: string): CaptureSource {
  return { configuredTargetRef: targetRef, inputKind: input.inputKind, inputName: input.inputName, sourceRef };
}

function publicTarget(target: CaptureTarget): ConfiguredCaptureSource["target"] {
  const { availability, kind, label, targetRef, validity } = target;
  return { availability, kind, label, targetRef, validity };
}

function requestSourceRef(inputUuid: string): string {
  // Importing the encoder alongside the decoder makes the opaque protocol
  // explicit without letting a caller supply a raw UUID.
  return `scenecap-input-v1.${Buffer.from(inputUuid).toString("base64url")}`;
}

function encodeTarget(target: DecodedCaptureTargetRef): string {
  return `scenecap-target-v1.${Buffer.from(JSON.stringify([target.kind, target.value])).toString("base64url")}`;
}

function parseInputs(response: unknown): ObsInput[] {
  return arrayField(response, "inputs").flatMap((candidate) => {
    const inputKind = objectString(candidate, "inputKind");
    const inputName = objectString(candidate, "inputName");
    const inputUuid = objectString(candidate, "inputUuid");
    return inputKind && inputName && inputUuid ? [{ inputKind, inputName, inputUuid }] : [];
  });
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value[key])) return {};
  return value[key];
}

function arrayField(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function objectString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key] ? value[key] : undefined;
}

function objectInteger(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" && Number.isSafeInteger(value[key]) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeObsName(value: string): boolean {
  return value.length > 0 && value.length <= 300 && ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isPositiveDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 16_384;
}

function alignDimension(value: number): number {
  return Math.ceil(value / ENCODER_DIMENSION_ALIGNMENT) * ENCODER_DIMENSION_ALIGNMENT;
}

function isWindowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function isDefinitiveObsRequestRejection(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  // A bounded obs-websocket response code proves that OBS rejected this
  // mutation. Cancellation, timeout, or a lost socket do not prove that.
  return typeof code === "number" && Number.isInteger(code) && code >= 200 && code < 700;
}

function remainingTimeout(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function connect(
  socket: ObsSocket,
  config: ObsConfig,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<void> {
  await boundedObsRead(socket, () => socket.connect({
    address: `ws://${config.host}:${config.port}`,
    eventSubscriptions: 0,
    password: config.password,
  }), options, deadline);
}
