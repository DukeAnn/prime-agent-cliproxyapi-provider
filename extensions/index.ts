/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login`:
 * 1. Provider is registered as OAuth-only so `/login CLIProxyAPI` / `/login cliproxyapi`
 *    skip the API-key vs account selector and go straight to multi-field prompts
 *    (pi only supports multi-field prompts on the account/OAuth path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI` or `/login cliproxyapi`.
 * 3. Setup prompts for baseUrl + apiKey.
 * 4. Final login step validates credentials via /v1/models?client_version=pi
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 5. On success, models/credentials are saved and registered immediately.
 * 6. `/fast` globally controls catalog-driven priority service tier injection.
 *
 * Uses a patched openai-codex-responses implementation that does not require
 * extracting chatgpt_account_id from the API key (plain CPA keys work).
 *
 * Non-interactive setup still works via env vars or ~/.pi/agent/cliproxyapi.json.
 */

import type {
	Api,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	StreamFunction,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProactiveCompactionController } from "./auto-compact.ts";
import {
	applyFastPayloadHook,
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStreamSimple,
	extractPayloadToolNames,
	type HostNativeStreams,
	loadCliproxyCodexStreams,
	loadHostNativeStreams,
} from "./codex-stream.ts";
import { FastModeController } from "./fast.ts";
import { FastFooterController } from "./fast-footer.ts";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	DEFAULT_TRANSPORT_MODE,
	debugLog,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	isDebugEnabled,
	isModelReferencedAsDefault,
	isPrimeHost,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	loadConfiguredDefaultSettings,
	type MappedModels,
	type ModelRoute,
	type PiProviderModel,
	resolveAgentDir,
	resolveConnection,
	resolveEndpoints,
	resolveFastCommandName,
	resolveFastDefault,
	resolveIdentity,
	resolveMappedModels,
	resolveModelRoute,
	resolvePauseDefault,
	resolveProtocolBaseUrl,
	resolveTransportMode,
	saveConfigFile,
	type TransportMode,
} from "./lib.ts";
import type { PauseController } from "./pause.ts";
import { pauseController, waitForPauseToEnd } from "./pause.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";

class ConfigPersistenceError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to save ${CONFIG_FILE_NAME}: ${message}`, { cause });
		this.name = "ConfigPersistenceError";
	}
}

interface RefreshResult {
	modelCount: number;
	modelsUrl: string;
	staleCount?: number;
}

export const DEFAULT_AUTO_RECOVERY_DELAY_MS = 60_000;
export const MAX_AUTO_RECOVERY_DELAY_MS = 300_000;

export interface RecoverySnapshot {
	action: () => Promise<unknown>;
	attempt: number;
	delayMs: number;
}

class ModelRefreshCoordinator {
	private generation = 0;
	private activeController: AbortController | undefined;
	private recoveryTimer: NodeJS.Timeout | undefined;
	private recoveryAttempt = 0;
	private activeRecovery: RecoverySnapshot | undefined;
	private stopped = false;

	begin(): { generation: number; signal: AbortSignal } {
		this.clearRecoveryTimer();
		this.activeController?.abort();
		const controller = new AbortController();
		this.activeController = controller;
		this.generation += 1;
		return { generation: this.generation, signal: controller.signal };
	}

	isCurrent(generation: number): boolean {
		return !this.stopped && this.generation === generation;
	}

	scheduleRecovery(
		action: () => Promise<unknown>,
		baseDelayMs = DEFAULT_AUTO_RECOVERY_DELAY_MS,
		maxDelayMs = MAX_AUTO_RECOVERY_DELAY_MS,
	): void {
		if (this.stopped) return;
		this.clearRecoveryTimer();
		const delay = Math.min(baseDelayMs * 1.5 ** this.recoveryAttempt, maxDelayMs);
		this.recoveryAttempt += 1;
		this.activeRecovery = { action, attempt: this.recoveryAttempt, delayMs: delay };

		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			if (this.stopped) return;
			void action().catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("is stale after session replacement or reload")) {
					this.clearRecovery();
					return;
				}
				// Suppressed: logging this into the TUI corrupts the display.
				// The refresh path already reschedules the next attempt.
			});
		}, delay);
		this.recoveryTimer.unref?.();
	}

	snapshotRecovery(): RecoverySnapshot | undefined {
		if (!this.stopped && this.activeRecovery) {
			return { ...this.activeRecovery };
		}
		return undefined;
	}

	restoreRecovery(snapshot: RecoverySnapshot): void {
		if (this.stopped || !snapshot) return;
		this.clearRecoveryTimer();
		this.recoveryAttempt = snapshot.attempt;
		this.activeRecovery = snapshot;
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			if (this.stopped) return;
			void snapshot.action().catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("is stale after session replacement or reload")) {
					this.clearRecovery();
					return;
				}
				// Suppressed: logging this into the TUI corrupts the display.
				// The refresh path already reschedules the next attempt.
			});
		}, snapshot.delayMs);
		this.recoveryTimer.unref?.();
	}

	clearRecoveryTimer(): void {
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
	}

	clearRecovery(): void {
		this.clearRecoveryTimer();
		this.recoveryAttempt = 0;
		this.activeRecovery = undefined;
	}

	stop(): void {
		this.stopped = true;
		this.clearRecovery();
		this.activeController?.abort();
		this.activeController = undefined;
		this.generation += 1;
	}
}

/** Resolve protocol routing without failing a refresh on invalid settings. */
function resolveTransportModeSafe(agentDir: string): TransportMode {
	try {
		return resolveTransportMode(agentDir);
	} catch {
		return DEFAULT_TRANSPORT_MODE;
	}
}

function logWarn(message: string): void {
	console.warn(`[pi-cliproxyapi-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-cliproxyapi-provider] ${message}`);
}

export interface RoutedStreamOptions {
	providerId: string;
	transportMode: TransportMode;
	/** Used when a model carries no baseUrl of its own. */
	fallbackBaseUrl: string;
	codexStreamSimple: CliproxyCodexStreamSimple;
	/** Host pi-ai dispatcher; absent means native routes fall back to Codex. */
	nativeStreamSimple?: CliproxyCodexStreamSimple;
	/**
	 * Fast decision for natively routed requests, evaluated against the model of
	 * this request. Codex-routed requests keep their own Fast wrapper.
	 */
	shouldUseFast?: (model: Model<Api>) => boolean;
}

/** Add safe debug logging around a native request without touching the payload. */
function withRouteDiagnostics(route: ModelRoute, streamOptions?: SimpleStreamOptions): SimpleStreamOptions | undefined {
	if (!isDebugEnabled()) {
		return streamOptions;
	}
	const userOnPayload = streamOptions?.onPayload;
	const userOnResponse = streamOptions?.onResponse;
	return {
		...streamOptions,
		onPayload: async (payload, payloadModel) => {
			const outboundToolNames = extractPayloadToolNames(payload);
			debugLog("native outbound payload", {
				model: payloadModel.id,
				api: route.api,
				outboundTools: outboundToolNames.length,
				outboundToolNames: outboundToolNames.join(",") || undefined,
			});
			return userOnPayload?.(payload, payloadModel);
		},
		onResponse: async (response, responseModel) => {
			debugLog("native response", { model: responseModel.id, api: route.api, status: response.status });
			await userOnResponse?.(response, responseModel);
		},
	};
}

/**
 * Dispatch one request to the patched Codex transport or to a pi built-in adapter.
 *
 * Every registered model keeps the custom `cliproxyapi-codex-responses` api id so the
 * extension stream chain (Fast, pause, retry, proactive compaction) stays in place.
 * Native routes are served by cloning the model with the family-specific api id,
 * base URL and compat overrides, then calling the host dispatcher.
 */
export function createRoutedStreamSimple(options: RoutedStreamOptions): CliproxyCodexStreamSimple {
	const { providerId, transportMode, fallbackBaseUrl, codexStreamSimple, nativeStreamSimple, shouldUseFast } = options;
	let missingNativeWarned = false;

	return (model, context, streamOptions) => {
		if (model.provider !== providerId) {
			return codexStreamSimple(model, context, streamOptions);
		}

		let route: ModelRoute | undefined;
		try {
			route = resolveModelRoute(model.id, transportMode, model.baseUrl?.trim() ? model.baseUrl : fallbackBaseUrl);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn(`failed to resolve protocol route for ${model.id} (${message}); using the Codex transport.`);
			return codexStreamSimple(model, context, streamOptions);
		}

		if (!route.native) {
			// The base URL is never logged: a configured URL can carry userinfo or query tokens.
			debugLog("selected route", {
				model: model.id,
				family: route.family,
				api: CLIPROXYAPI_CODEX_API,
				transportMode,
			});
			return codexStreamSimple(model, context, streamOptions);
		}

		if (!nativeStreamSimple) {
			if (!missingNativeWarned) {
				missingNativeWarned = true;
				logWarn("host pi-ai stream dispatcher is unavailable; native routes fall back to the Codex transport.");
			}
			return codexStreamSimple(model, context, streamOptions);
		}

		// The base URL is never logged: a configured URL can carry userinfo or query tokens.
		debugLog("selected route", {
			model: model.id,
			family: route.family,
			api: route.api,
			transportMode,
		});

		const nativeModel = {
			...model,
			api: route.api as Api,
			baseUrl: route.baseUrl,
			...(route.compat ? { compat: route.compat as Model<Api>["compat"] } : {}),
		} as Model<Api>;

		// Fast is decided here, where the requested model and its route are both known.
		const baseOptions = withRouteDiagnostics(route, streamOptions);
		const nativeOptions = shouldUseFast?.(model)
			? {
					...baseOptions,
					onPayload: (payload: unknown, payloadModel: Model<Api>) =>
						applyFastPayloadHook(payload, payloadModel, baseOptions?.onPayload),
				}
			: baseOptions;

		return nativeStreamSimple(nativeModel, context, nativeOptions);
	};
}

/** True when this model id is served by a pi built-in adapter in the active mode. */
export function isNativeRoutedModel(model: Model<Api>, transportMode: TransportMode, fallbackBaseUrl: string): boolean {
	try {
		return resolveModelRoute(model.id, transportMode, model.baseUrl?.trim() ? model.baseUrl : fallbackBaseUrl).native;
	} catch {
		return false;
	}
}

const COMPAT_COORDINATOR_KEY = Symbol.for("pi-cliproxyapi-provider.compat-coordinator");
export const COMPAT_SOURCE_ID = "pi-cliproxyapi-provider-global";

interface CompatRegistrationEntry {
	instanceId: string;
	providerId: string;
	rawStream: CliproxyCodexStreamSimple;
	rawStreamSimple: CliproxyCodexStreamSimple;
	/** Protocol-routed variants used by the compat dispatcher. */
	routedStream: CliproxyCodexStreamSimple;
	routedStreamSimple: CliproxyCodexStreamSimple;
}

interface CompatCoordinator {
	stack: CompatRegistrationEntry[];
}

function getCompatCoordinator(): CompatCoordinator {
	const globalState = globalThis as unknown as { [COMPAT_COORDINATOR_KEY]?: CompatCoordinator };
	if (!globalState[COMPAT_COORDINATOR_KEY]) {
		globalState[COMPAT_COORDINATOR_KEY] = { stack: [] };
	}
	return globalState[COMPAT_COORDINATOR_KEY]!;
}

export function resetCompatCoordinator(): void {
	const coordinator = getCompatCoordinator();
	coordinator.stack = [];
}

function findActiveCompatEntry(
	stack: CompatRegistrationEntry[],
	providerId: string,
): CompatRegistrationEntry | undefined {
	for (let i = stack.length - 1; i >= 0; i--) {
		if (stack[i].providerId === providerId) {
			return stack[i];
		}
	}
	return undefined;
}

function hasLoginCredential(agentDir: string, providerId: string): boolean {
	try {
		return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
	} catch {
		return false;
	}
}

function buildOAuthCredentials(baseUrlInput: string, apiKey: string): OAuthCredentials {
	return {
		refresh: encodeRefreshMeta(baseUrlInput),
		access: apiKey,
		expires: Date.now() + CREDENTIAL_TTL_MS,
	};
}

function resolveDefaultBaseUrl(agentDir: string, providerId: string): string {
	let fileBaseUrl: string | undefined;
	try {
		fileBaseUrl = loadConfigFile(agentDir).baseUrl;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			logWarn(`failed to read ${CONFIG_FILE_NAME}: ${err.message}`);
		}
	}

	let authBaseUrl: string | undefined;
	try {
		authBaseUrl = loadAuthConnection(agentDir, providerId)?.baseUrl;
	} catch (error) {
		const err = error as Error;
		logWarn(`failed to read auth.json: ${err.message}`);
	}

	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, fileBaseUrl, authBaseUrl, DEFAULT_BASE_URL)!;
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.("Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).");

	const baseUrlRaw = await callbacks.onPrompt({
		message: `CLIProxyAPI base URL [${defaults.baseUrl}]:`,
		placeholder: defaults.baseUrl,
		allowEmpty: true,
	});
	const baseUrlInput = firstNonEmpty(baseUrlRaw, defaults.baseUrl)!;

	// Validate early so users get a clear error before typing the API key.
	resolveEndpoints(baseUrlInput);

	const apiKey = (
		await callbacks.onPrompt({
			message: "CLIProxyAPI API key:",
			placeholder: "sk-...",
			allowEmpty: false,
		})
	).trim();

	if (!apiKey) {
		throw new Error("API key cannot be empty.");
	}

	return { baseUrlInput, apiKey };
}

async function configureAndRegister(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	baseUrlInput: string;
	apiKey: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
	refreshCoordinator: ModelRefreshCoordinator;
	onFastModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
	onRefreshOutcome?: (loaded: MappedModels) => void;
}): Promise<RefreshResult> {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
		onRefreshOutcome,
	} = options;

	const refresh = refreshCoordinator.begin();
	const { loaded } = await resolveMappedModels(agentDir, baseUrlInput, apiKey, {
		forceRefresh: true,
		fastMode: fastMode.isEnabled(),
		signal: refresh.signal,
		shouldCommit: () => refreshCoordinator.isCurrent(refresh.generation),
		transportMode: resolveTransportModeSafe(agentDir),
	});
	if (!refreshCoordinator.isCurrent(refresh.generation)) {
		throw new Error("Model refresh was superseded by a newer request.");
	}

	try {
		saveConfigFile(agentDir, {
			baseUrl: baseUrlInput,
			apiKey,
			providerId,
			providerName,
		});
	} catch (error) {
		throw new ConfigPersistenceError(error);
	}

	// /login stores oauth credentials itself; keep the provider OAuth-only so
	// `/login <provider>` skips the API-key vs account selector.
	registerProvider(pi, {
		providerId,
		providerName,
		baseUrlInput,
		models: loaded.models,
		defaultBaseUrl: baseUrlInput || defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
		onRefreshOutcome,
	});
	fastMode.setSupportedModelIds(loaded.fastModelIds);

	onRefreshOutcome?.(loaded);
	const staleModels = loaded.models.filter((m) => m.stale);

	return {
		modelCount: loaded.models.length,
		modelsUrl: loaded.modelsUrl,
		staleCount: staleModels.length,
	};
}

function createOAuthHandlers(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
	refreshCoordinator: ModelRefreshCoordinator;
	onFastModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
	onRefreshOutcome?: (loaded: MappedModels) => void;
}) {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
		onRefreshOutcome,
	} = options;

	return {
		name: providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			let promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;

			// Final login step: validate by calling /v1/models.
			// HTTP 200 (even with an empty catalog) means success; otherwise re-prompt.
			while (true) {
				const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
					baseUrl: promptDefaultBaseUrl,
				});

				callbacks.onProgress?.("Validating credentials via models endpoint...");
				const previousRecovery = refreshCoordinator.snapshotRecovery();
				try {
					const result = await configureAndRegister({
						pi,
						agentDir,
						providerId,
						providerName,
						baseUrlInput,
						apiKey,
						defaultBaseUrl,
						streamSimple,
						fastMode,
						refreshCoordinator,
						onFastModeChange,
						onRefreshOutcome,
					});

					logInfo(`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
					return buildOAuthCredentials(baseUrlInput, apiKey);
				} catch (error) {
					if (previousRecovery) {
						refreshCoordinator.restoreRecovery(previousRecovery);
					}
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`login validation failed: ${message}`);
					if (error instanceof ConfigPersistenceError) {
						callbacks.onProgress?.(message);
						throw error;
					}
					callbacks.onProgress?.(`Login validation failed: ${message}\nPlease re-enter base URL and API key.`);
					// Keep last baseUrl as the next default so retyping is easier.
					promptDefaultBaseUrl = baseUrlInput || promptDefaultBaseUrl;
				}
			}
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			// API keys do not expire; keep the stored payload as-is.
			return {
				...credentials,
				expires: Date.now() + CREDENTIAL_TTL_MS,
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
			const meta = decodeRefreshMeta(credentials.refresh);
			if (!meta?.baseUrl) {
				return models;
			}
			try {
				// Recompute the endpoint that matches each model's own api id instead of
				// forcing every model onto /backend-api/.
				return models.map((model) =>
					model.provider === providerId
						? { ...model, baseUrl: resolveProtocolBaseUrl(model.api, meta.baseUrl) }
						: model,
				);
			} catch {
				return models;
			}
		},
	};
}

function registerProvider(
	pi: ExtensionAPI,
	options: {
		providerId: string;
		providerName: string;
		baseUrlInput: string;
		apiKey?: string;
		models?: PiProviderModel[];
		defaultBaseUrl: string;
		agentDir: string;
		streamSimple: CliproxyCodexStreamSimple;
		fastMode: FastModeController;
		refreshCoordinator?: ModelRefreshCoordinator;
		onFastModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
		onRefreshOutcome?: (loaded: MappedModels) => void;
	},
): void {
	const {
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		models,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
		onFastModeChange,
		onRefreshOutcome,
	} = options;
	const refreshCoordinator = options.refreshCoordinator ?? new ModelRefreshCoordinator();

	const endpoints = resolveEndpoints(baseUrlInput);
	const oauth = createOAuthHandlers({
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
		onRefreshOutcome,
	});

	// Replace any previous registration so an earlier ambient apiKey does not linger
	// via registerProvider merge semantics and reintroduce the auth-type selector.
	pi.unregisterProvider(providerId);

	pi.registerProvider(providerId, {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		// OAuth-only keeps `/login <provider>` on the multi-field account path.
		// Pass apiKey only for ambient request auth when no /login credential exists
		// (config file / env). Never pass both for /login flows.
		oauth,
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

export function registerPauseCommands(options: {
	pi: ExtensionAPI;
	agentDir: string;
	pauseMode: PauseController;
}): void {
	const { pi, agentDir, pauseMode } = options;

	const setPause = async (
		enabled: boolean,
		commandName: string,
		args: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		if (args.trim()) {
			ctx.ui.notify(`Usage: /${commandName}`, "error");
			return;
		}

		try {
			saveConfigFile(agentDir, { pause: enabled });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to save pause mode: ${message}`, "error");
			return;
		}

		pauseMode.setEnabled(enabled);
		ctx.ui.notify(enabled ? "Requests are paused." : "Requests are continued.", "info");
	};

	pi.registerCommand("pause", {
		description: "Pause provider requests until /continue is used.",
		handler: async (args, ctx) => setPause(true, "pause", args, ctx),
	});

	pi.registerCommand("continue", {
		description: "Continue provider requests paused by /pause.",
		handler: async (args, ctx) => setPause(false, "continue", args, ctx),
	});
}

export function registerPauseGuard(options: { pi: ExtensionAPI; agentDir: string; pauseMode: PauseController }): void {
	const { pi, agentDir, pauseMode } = options;
	pi.on("before_provider_request", async () => {
		await waitForPauseToEnd(agentDir, pauseMode);
	});
}

export function registerFastCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	fastMode: FastModeController;
	/** Defaults to /fast, or /cliproxyapi-fast on hosts that already own /fast. */
	commandName?: string;
	onStatusChange?: (ctx: ExtensionContext) => void;
	onModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
}): void {
	const { pi, agentDir, providerId, fastMode, onStatusChange, onModeChange } = options;
	const commandName = options.commandName ?? resolveFastCommandName();
	let modeChangeInProgress = false;

	pi.registerCommand(commandName, {
		description: "Toggle CLIProxyAPI Fast mode globally.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(`Usage: /${commandName}`, "error");
				return;
			}
			if (modeChangeInProgress) {
				ctx.ui.notify("Fast mode is already being refreshed. Try again when it finishes.", "warning");
				return;
			}

			modeChangeInProgress = true;
			try {
				const previousEnabled = fastMode.isEnabled();
				const enabled = !previousEnabled;
				try {
					saveConfigFile(agentDir, { fast: enabled });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save Fast mode: ${message}`, "error");
					return;
				}
				fastMode.setEnabled(enabled);
				try {
					await onModeChange?.(enabled, ctx);
				} catch (error) {
					// Restore all three views of the mode after a partial refresh:
					// in-memory request behavior, persisted preference, and model metadata.
					fastMode.setEnabled(previousEnabled);
					const rollbackErrors: string[] = [];
					try {
						saveConfigFile(agentDir, { fast: previousEnabled });
					} catch (rollbackError) {
						rollbackErrors.push(
							`config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					try {
						await onModeChange?.(previousEnabled, ctx);
					} catch (rollbackError) {
						rollbackErrors.push(
							`pricing rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					const message = error instanceof Error ? error.message : String(error);
					const rollbackSuffix = rollbackErrors.length > 0 ? ` (${rollbackErrors.join("; ")})` : "";
					ctx.ui.notify(`Failed to refresh model pricing: ${message}${rollbackSuffix}`, "warning");
					onStatusChange?.(ctx);
					return;
				}
				onStatusChange?.(ctx);

				const currentModel = ctx.model;
				if (!currentModel || currentModel.provider !== providerId || !fastMode.isModelSupported(currentModel.id)) {
					if (enabled) {
						ctx.ui.notify("Fast mode is enabled globally, but the current model does not support it.", "warning");
					} else {
						ctx.ui.notify("Fast mode is disabled globally.", "info");
					}
				}
			} finally {
				modeChangeInProgress = false;
			}
		},
	});
}

export function registerRefreshCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
	refreshCoordinator?: ModelRefreshCoordinator;
	onRefresh?: (connection: NonNullable<ReturnType<typeof resolveConnection>>) => Promise<RefreshResult | undefined>;
}): void {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onRefresh,
	} = options;

	pi.registerCommand("cliproxyapi-refresh", {
		description: "Force refresh CLIProxyAPI models from the remote catalog.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
				return;
			}

			const connection = resolveConnection(agentDir, providerId);
			if (!connection) {
				ctx.ui.notify(
					`CLIProxyAPI is not configured. Use /login ${providerName} or /login ${providerId}.`,
					"error",
				);
				return;
			}

			try {
				let result: RefreshResult | undefined;
				if (onRefresh) {
					result = await onRefresh(connection);
					if (!result) return;
				} else {
					const refresh = refreshCoordinator?.begin();
					const { loaded } = await resolveMappedModels(agentDir, connection.baseUrlInput, connection.apiKey, {
						forceRefresh: true,
						fastMode: fastMode.isEnabled(),
						signal: refresh?.signal,
						shouldCommit: refresh ? () => refreshCoordinator?.isCurrent(refresh.generation) ?? true : undefined,
						transportMode: resolveTransportModeSafe(agentDir),
					});
					if (refresh && !refreshCoordinator?.isCurrent(refresh.generation)) return;
					fastMode.setSupportedModelIds(loaded.fastModelIds);

					const hasStoredLogin = hasLoginCredential(agentDir, providerId);
					registerProvider(pi, {
						providerId,
						providerName,
						baseUrlInput: connection.baseUrlInput,
						apiKey: hasStoredLogin ? undefined : connection.apiKey,
						models: loaded.models,
						defaultBaseUrl,
						agentDir,
						streamSimple,
						fastMode,
						refreshCoordinator,
					});

					result = {
						modelCount: loaded.models.length,
						modelsUrl: loaded.modelsUrl,
						staleCount: loaded.models.filter((m) => m.stale).length,
					};
				}

				const staleSuffix =
					result.staleCount && result.staleCount > 0 ? ` (${result.staleCount} retained from cache)` : "";
				ctx.ui.notify(
					`Refreshed ${result.modelCount} CLIProxyAPI models${staleSuffix} from ${result.modelsUrl}.`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh CLIProxyAPI models: ${message}`, "error");
			}
		},
	});
}

export { CLIPROXYAPI_CODEX_API } from "./codex-stream.ts";
export { resolveEndpoints, toPiModel } from "./lib.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	// Resolve the host once: a non-empty PRIME_AGENT_CODING_AGENT_DIR wins, otherwise the
	// plugin-local agent directory decides (a default Prime run resolves ~/.prime/agent
	// without exporting the override env var).
	const fallbackAgentDir = getAgentDir();
	const agentDir = resolveAgentDir(() => fallbackAgentDir);
	const primeHost = isPrimeHost(agentDir);
	const identity = resolveIdentity(agentDir);
	const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);

	let transportMode: TransportMode = DEFAULT_TRANSPORT_MODE;
	try {
		transportMode = resolveTransportMode(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid transport mode configuration (${message}); using transportMode=${DEFAULT_TRANSPORT_MODE}`);
	}
	debugLog("resolved settings", {
		providerId: identity.providerId,
		transportMode,
		primeHost,
	});

	let pauseEnabled = false;
	try {
		pauseEnabled = resolvePauseDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid pause configuration (${message}); using pause=false`);
	}
	pauseController.setEnabled(pauseEnabled);
	registerPauseCommands({ pi, agentDir, pauseMode: pauseController });
	registerPauseGuard({ pi, agentDir, pauseMode: pauseController });

	const proactiveCompaction = new ProactiveCompactionController(agentDir, identity.providerId);
	proactiveCompaction.register(pi);

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid Fast configuration (${message}); using fast=false`);
	}
	const fastMode = new FastModeController(fastEnabled);
	const modelRefreshCoordinator = new ModelRefreshCoordinator();

	// The router uses this for native requests; the Codex wrapper uses the same
	// predicate only when Codex is actually called, including native-dispatch fallback.
	const shouldUseFastForRequest = (model: Model<Api>): boolean =>
		model.provider === identity.providerId && fastMode.isEffectiveFor(model.id);

	let streamSimple: CliproxyCodexStreamSimple = () => {
		throw new Error(
			`Codex protocol stream is unavailable for provider: ${identity.providerId} (api: ${CLIPROXYAPI_CODEX_API})`,
		);
	};
	try {
		const streams = await loadCliproxyCodexStreams([identity.providerId, "cliproxyapi"], {
			shouldUseFast: shouldUseFastForRequest,
		});
		proactiveCompaction.setCloseWebSocketSessions(streams.closeOpenAICodexWebSocketSessions);

		const hostNativeStreams: HostNativeStreams =
			transportMode === "codex" ? {} : await loadHostNativeStreams({ primeHost });
		if (transportMode !== "codex" && !hostNativeStreams.streamSimple) {
			logWarn(
				"host pi-ai stream dispatcher is unavailable; every model stays on the Codex transport " +
					"(set transportMode=codex to silence this).",
			);
		}
		debugLog("native dispatcher", {
			transportMode,
			source: hostNativeStreams.source,
			available: Boolean(hostNativeStreams.streamSimple),
		});

		const routedStreamSimple = createRoutedStreamSimple({
			providerId: identity.providerId,
			transportMode,
			fallbackBaseUrl: defaultBaseUrl,
			codexStreamSimple: streams.streamSimple,
			nativeStreamSimple: hostNativeStreams.streamSimple,
			shouldUseFast: shouldUseFastForRequest,
		});
		streamSimple = proactiveCompaction.wrapStreamSimple(routedStreamSimple);

		pi.on("session_shutdown", () => {
			try {
				streams.closeOpenAICodexWebSocketSessions();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`failed to close Codex WebSocket sessions on shutdown: ${message}`);
			}
		});

		// Prime Agent 0.9.5 does not expose the @earendil-works/pi-ai/compat subpath to
		// plugins, so the compat api registration is skipped there.
		if (primeHost) {
			debugLog("compat registration skipped", { reason: "prime-host" });
		} else {
			try {
				const { registerApiProvider, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");

				const coordinator = getCompatCoordinator();
				const instanceId = `${identity.providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

				const entry: CompatRegistrationEntry = {
					instanceId,
					providerId: identity.providerId,
					rawStream: streams.rawStream,
					rawStreamSimple: streams.rawStreamSimple,
					routedStream: createRoutedStreamSimple({
						providerId: identity.providerId,
						transportMode,
						fallbackBaseUrl: defaultBaseUrl,
						codexStreamSimple: streams.rawStream,
						nativeStreamSimple: hostNativeStreams.stream,
					}),
					routedStreamSimple: createRoutedStreamSimple({
						providerId: identity.providerId,
						transportMode,
						fallbackBaseUrl: defaultBaseUrl,
						codexStreamSimple: streams.rawStreamSimple,
						nativeStreamSimple: hostNativeStreams.streamSimple,
					}),
				};

				coordinator.stack.push(entry);

				const withExplicitFast = (options?: SimpleStreamOptions): SimpleStreamOptions | undefined => {
					const requested = options as { serviceTier?: string; fast?: boolean } | undefined;
					if (requested?.serviceTier !== "priority" && requested?.fast !== true) {
						return options;
					}
					return {
						...options,
						onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, options?.onPayload),
					};
				};

				const dispatchStream: CliproxyCodexStreamSimple = (model, context, options) => {
					const active = findActiveCompatEntry(coordinator.stack, model.provider);
					if (!active) {
						throw new Error(
							`No active provider stream handler registered for provider: ${model.provider} (api: ${CLIPROXYAPI_CODEX_API})`,
						);
					}
					return active.routedStream(model, context, withExplicitFast(options));
				};

				const dispatchStreamSimple: CliproxyCodexStreamSimple = (model, context, options) => {
					const active = findActiveCompatEntry(coordinator.stack, model.provider);
					if (!active) {
						throw new Error(
							`No active provider streamSimple handler registered for provider: ${model.provider} (api: ${CLIPROXYAPI_CODEX_API})`,
						);
					}
					return active.routedStreamSimple(model, context, withExplicitFast(options));
				};

				unregisterApiProviders(COMPAT_SOURCE_ID);
				registerApiProvider(
					{
						api: CLIPROXYAPI_CODEX_API,
						stream: dispatchStream as StreamFunction<typeof CLIPROXYAPI_CODEX_API>,
						streamSimple: dispatchStreamSimple as StreamFunction<
							typeof CLIPROXYAPI_CODEX_API,
							SimpleStreamOptions
						>,
					},
					COMPAT_SOURCE_ID,
				);

				pi.on("session_shutdown", () => {
					const index = coordinator.stack.findIndex((item) => item.instanceId === instanceId);
					if (index !== -1) {
						coordinator.stack.splice(index, 1);
					}
					if (coordinator.stack.length === 0) {
						unregisterApiProviders(COMPAT_SOURCE_ID);
					}
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`failed to register compat API provider: ${message}`);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load patched codex protocol: ${message}`);
	}

	const fastFooter = new FastFooterController(identity.providerId, fastMode, () =>
		proactiveCompaction.getCompactionSettings(),
	);
	let refreshModelsForFast: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	const onFastModeChange = async (_enabled: boolean, ctx: ExtensionContext): Promise<void> => {
		await refreshModelsForFast?.(ctx);
	};
	registerFastCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		fastMode,
		commandName: resolveFastCommandName({ primeHost }),
		onStatusChange: (ctx) => fastFooter.refresh(ctx),
		onModeChange: onFastModeChange,
	});
	fastFooter.register(pi);

	const scheduleActiveRecovery = (): void => {
		modelRefreshCoordinator.scheduleRecovery(async () => {
			const activeConn = resolveConnection(agentDir, identity.providerId);
			if (!activeConn) {
				modelRefreshCoordinator.clearRecovery();
				return;
			}
			await registerConfiguredProvider(activeConn, { forceRefresh: true });
		}, DEFAULT_AUTO_RECOVERY_DELAY_MS);
	};

	const handleRefreshOutcome = (loaded: MappedModels): void => {
		const staleModels = loaded.models.filter((m) => m.stale);
		latestStaleModelIds = staleModels.map((m) => m.id);

		if (staleModels.length > 0) {
			if (activeContext) {
				checkAndNotifyStaleModel(activeContext);
			}
			scheduleActiveRecovery();
		} else {
			notifiedStaleModelId = undefined;
			modelRefreshCoordinator.clearRecovery();
		}
	};

	// Always register oauth so the provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
		refreshCoordinator: modelRefreshCoordinator,
		onFastModeChange: onFastModeChange,
		onRefreshOutcome: handleRefreshOutcome,
	});
	registerTransientNetworkErrorRetry(pi, identity.providerId);

	let activeContext: ExtensionContext | undefined;
	let latestStaleModelIds: string[] = [];
	let notifiedStaleModelId: string | undefined;

	const checkAndNotifyStaleModel = (ctx: ExtensionContext): void => {
		try {
			const currentModel = ctx.model;
			const configured = loadConfiguredDefaultSettings(agentDir);
			const affectedStaleId = latestStaleModelIds.find(
				(staleId) =>
					(currentModel && currentModel.provider === identity.providerId && currentModel.id === staleId) ||
					isModelReferencedAsDefault(configured, staleId, identity.providerId),
			);

			if (affectedStaleId) {
				if (notifiedStaleModelId !== affectedStaleId) {
					notifiedStaleModelId = affectedStaleId;
					ctx.ui.notify(
						`Model '${affectedStaleId}' is temporarily unavailable from upstream (retaining cached entry).`,
						"warning",
					);
				}
			} else {
				notifiedStaleModelId = undefined;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("is stale after session replacement or reload")) {
				activeContext = undefined;
				return;
			}
			throw error;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		checkAndNotifyStaleModel(ctx);
	});
	pi.on("session_shutdown", () => {
		activeContext = undefined;
		latestStaleModelIds = [];
		notifiedStaleModelId = undefined;
		modelRefreshCoordinator.stop();
	});

	const connection = resolveConnection(agentDir, identity.providerId);
	const registerConfiguredProvider = async (
		currentConnection: { baseUrlInput: string; apiKey: string },
		options: { forceRefresh?: boolean } = {},
	): Promise<RefreshResult | undefined> => {
		const refresh = modelRefreshCoordinator.begin();
		try {
			const { loaded, fromCache } = await resolveMappedModels(
				agentDir,
				currentConnection.baseUrlInput,
				currentConnection.apiKey,
				{
					forceRefresh: options.forceRefresh,
					fastMode: fastMode.isEnabled(),
					signal: refresh.signal,
					shouldCommit: () => modelRefreshCoordinator.isCurrent(refresh.generation),
					transportMode,
				},
			);
			if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;

			fastMode.setSupportedModelIds(loaded.fastModelIds);

			// Prefer OAuth-only registration when /login already stored credentials so
			// `/login <provider>` jumps straight into the multi-field flow. Fall back to
			// ambient apiKey only for config-file / env setups without auth.json.
			const hasStoredLogin = hasLoginCredential(agentDir, identity.providerId);
			registerProvider(pi, {
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: currentConnection.baseUrlInput,
				apiKey: hasStoredLogin ? undefined : currentConnection.apiKey,
				models: loaded.models,
				defaultBaseUrl,
				agentDir,
				streamSimple,
				fastMode,
				refreshCoordinator: modelRefreshCoordinator,
				onFastModeChange,
				onRefreshOutcome: handleRefreshOutcome,
			});

			if (fromCache) {
				const cachedStaleModels = loaded.models.filter((m) => m.stale);
				if (cachedStaleModels.length > 0) {
					latestStaleModelIds = cachedStaleModels.map((m) => m.id);
					if (activeContext) {
						checkAndNotifyStaleModel(activeContext);
					}
				}
				if (!options.forceRefresh) {
					void registerConfiguredProvider(currentConnection, { forceRefresh: true }).catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						logWarn(`failed to refresh cached models (${message}); keeping the cached model list.`);
					});
				}
			} else {
				handleRefreshOutcome(loaded);
			}

			return {
				modelCount: loaded.models.length,
				modelsUrl: loaded.modelsUrl,
				staleCount: loaded.models.filter((m) => m.stale).length,
			};
		} catch (error) {
			if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("is stale after session replacement or reload")) {
				modelRefreshCoordinator.clearRecovery();
				return undefined;
			}
			if (options.forceRefresh) {
				scheduleActiveRecovery();
			}
			throw error;
		}
	};
	refreshModelsForFast = async (ctx: ExtensionContext): Promise<void> => {
		const currentConnection = resolveConnection(agentDir, identity.providerId);
		if (!currentConnection) return;

		const refreshed = await registerConfiguredProvider(currentConnection, { forceRefresh: true });
		if (!refreshed) return;
		const currentModel = ctx.model;
		if (!currentModel || currentModel.provider !== identity.providerId) return;

		const refreshedModel = ctx.modelRegistry.find(identity.providerId, currentModel.id);
		if (!refreshedModel) {
			throw new Error(`Refreshed model ${identity.providerId}/${currentModel.id} is unavailable`);
		}
		if (JSON.stringify(refreshedModel.cost) === JSON.stringify(currentModel.cost)) return;
		if (!(await pi.setModel(refreshedModel))) {
			throw new Error(`Unable to activate refreshed model ${identity.providerId}/${currentModel.id}`);
		}
	};
	registerRefreshCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator: modelRefreshCoordinator,
		onRefresh: (currentConnection) => registerConfiguredProvider(currentConnection, { forceRefresh: true }),
	});

	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		await registerConfiguredProvider(connection);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			logWarn(`models request unauthorized (${message}). Use /login ${identity.providerName} to reconfigure.`);
		} else {
			logWarn(
				`failed to load models (${message}). Use /login ${identity.providerName} or check ${CONFIG_FILE_NAME} / CLIPROXYAPI_* env vars.`,
			);
		}
	}
}
