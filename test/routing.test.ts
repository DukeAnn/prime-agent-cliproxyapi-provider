import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import { createRoutedStreamSimple, isNativeRoutedModel } from "../extensions/index.ts";
import {
	ANTHROPIC_MESSAGES_API_ID,
	CLIPROXYAPI_CODEX_API_ID,
	detectModelFamily,
	GOOGLE_GENERATIVE_AI_API_ID,
	OPENAI_COMPLETIONS_API_ID,
	OPENAI_RESPONSES_API_ID,
	resolveModelRoute,
	resolveProtocolBaseUrl,
	resolveRootBaseUrl,
} from "../extensions/lib.ts";

const ROOT = "http://127.0.0.1:8317";

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: CLIPROXYAPI_CODEX_API_ID as Api,
		provider: "cliproxyapi",
		baseUrl: `${ROOT}/backend-api/`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	} as Model<Api>;
}

const emptyStream = {} as AssistantMessageEventStream;

/** Typed stream stub so mock call tuples keep their argument types. */
function streamSpy(_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
	return emptyStream;
}

describe("detectModelFamily", () => {
	it("detects explicit families and keeps route prefixes out of detection", () => {
		expect(detectModelFamily("gpt-5.6-sol")).toBe("gpt");
		expect(detectModelFamily("grok-4.6")).toBe("grok");
		expect(detectModelFamily("claude-fable-5-1")).toBe("claude");
		expect(detectModelFamily("relay-apikeyfun/claude-sonnet-5")).toBe("claude");
		expect(detectModelFamily("gemini-3.8-flash-high")).toBe("gemini");
		expect(detectModelFamily("gpt-oss-120b-medium")).toBe("gpt");
		expect(detectModelFamily("codex-auto-review")).toBe("unknown");
		expect(detectModelFamily("glm-4.6")).toBe("unknown");
	});
});

describe("resolveRootBaseUrl", () => {
	it("reduces every endpoint form to the same root", () => {
		expect(resolveRootBaseUrl(`${ROOT}/backend-api/`)).toBe(ROOT);
		expect(resolveRootBaseUrl(`${ROOT}/v1`)).toBe(ROOT);
		expect(resolveRootBaseUrl(`${ROOT}/v1beta`)).toBe(ROOT);
		expect(resolveRootBaseUrl(`${ROOT}/`)).toBe(ROOT);
		expect(resolveRootBaseUrl("127.0.0.1:8317")).toBe(ROOT);
		expect(resolveRootBaseUrl("http://host/proxy/backend-api/")).toBe("http://host/proxy");
		expect(resolveRootBaseUrl("https://cpa.example.com:8443/v1")).toBe("https://cpa.example.com:8443");
		expect(() => resolveRootBaseUrl("   ")).toThrow(/baseUrl is empty/);
	});

	it("rejects malformed and non-http(s) values instead of building a broken endpoint", () => {
		expect(() => resolveRootBaseUrl("ftp://127.0.0.1:8317/v1")).toThrow(/must use http or https/);
		expect(() => resolveRootBaseUrl("file:///etc/passwd")).toThrow(/must use http or https/);
		expect(() => resolveRootBaseUrl("ws://127.0.0.1:8317")).toThrow(/must use http or https/);
		expect(() => resolveRootBaseUrl("http://")).toThrow(/not a valid URL/);
		expect(() => resolveRootBaseUrl("http://host:port/v1")).toThrow(/not a valid URL/);
		expect(() => resolveRootBaseUrl(":::")).toThrow(/not a valid URL/);
	});

	it("propagates the validation failure through route resolution", () => {
		expect(() => resolveModelRoute("gpt-5.6-sol", "auto", "ftp://host")).toThrow(/must use http or https/);
		expect(() => resolveProtocolBaseUrl(ANTHROPIC_MESSAGES_API_ID, "ftp://host")).toThrow(/must use http or https/);
	});
});

describe("resolveModelRoute", () => {
	it("keeps every family on the Codex transport in codex mode", () => {
		for (const id of [
			"gpt-5.6-sol",
			"grok-4.6",
			"claude-sonnet-5",
			"relay-apikeyfun/claude-sonnet-5",
			"gemini-3.8-flash-high",
			"glm-4.6",
		]) {
			const route = resolveModelRoute(id, "codex", `${ROOT}/backend-api/`);
			expect(route.api).toBe(CLIPROXYAPI_CODEX_API_ID);
			expect(route.baseUrl).toBe(`${ROOT}/backend-api/`);
			expect(route.native).toBe(false);
		}
	});

	it("maps known families to native endpoints in native and auto modes", () => {
		for (const transportMode of ["native", "auto"] as const) {
			expect(resolveModelRoute("gpt-5.6-sol", transportMode, ROOT)).toMatchObject({
				api: OPENAI_RESPONSES_API_ID,
				baseUrl: `${ROOT}/v1`,
				native: true,
				family: "gpt",
			});
			expect(resolveModelRoute("grok-4.6", transportMode, ROOT)).toMatchObject({
				api: OPENAI_RESPONSES_API_ID,
				baseUrl: `${ROOT}/v1`,
				native: true,
				family: "grok",
			});
			expect(resolveModelRoute("claude-fable-5-1", transportMode, ROOT)).toMatchObject({
				api: ANTHROPIC_MESSAGES_API_ID,
				baseUrl: ROOT,
				native: true,
				family: "claude",
				compat: { supportsEagerToolInputStreaming: false },
			});
			expect(resolveModelRoute("relay-apikeyfun/claude-sonnet-5", transportMode, ROOT)).toMatchObject({
				api: ANTHROPIC_MESSAGES_API_ID,
				baseUrl: ROOT,
				native: true,
				family: "claude",
			});
			expect(resolveModelRoute("gemini-3.8-flash-high", transportMode, ROOT)).toMatchObject({
				api: GOOGLE_GENERATIVE_AI_API_ID,
				baseUrl: `${ROOT}/v1beta`,
				native: true,
				family: "gemini",
			});
		}
	});

	it("routes unknown model ids to openai-completions in native mode and to Codex in auto mode", () => {
		expect(resolveModelRoute("glm-4.6", "native", ROOT)).toMatchObject({
			api: OPENAI_COMPLETIONS_API_ID,
			baseUrl: `${ROOT}/v1`,
			native: true,
			family: "unknown",
		});
		expect(resolveModelRoute("glm-4.6", "auto", ROOT)).toMatchObject({
			api: CLIPROXYAPI_CODEX_API_ID,
			baseUrl: `${ROOT}/backend-api/`,
			native: false,
			family: "unknown",
		});
	});

	it("derives native endpoints from any stored base URL form", () => {
		expect(resolveModelRoute("claude-sonnet-5", "auto", `${ROOT}/backend-api/`).baseUrl).toBe(ROOT);
		expect(resolveModelRoute("gemini-3-flash", "auto", `${ROOT}/v1`).baseUrl).toBe(`${ROOT}/v1beta`);
	});
});

describe("resolveProtocolBaseUrl", () => {
	it("returns the endpoint that matches an already-selected api id", () => {
		expect(resolveProtocolBaseUrl(ANTHROPIC_MESSAGES_API_ID, ROOT)).toBe(ROOT);
		expect(resolveProtocolBaseUrl(GOOGLE_GENERATIVE_AI_API_ID, ROOT)).toBe(`${ROOT}/v1beta`);
		expect(resolveProtocolBaseUrl(OPENAI_RESPONSES_API_ID, ROOT)).toBe(`${ROOT}/v1`);
		expect(resolveProtocolBaseUrl(OPENAI_COMPLETIONS_API_ID, ROOT)).toBe(`${ROOT}/v1`);
		expect(resolveProtocolBaseUrl(CLIPROXYAPI_CODEX_API_ID, ROOT)).toBe(`${ROOT}/backend-api/`);
	});
});

describe("createRoutedStreamSimple", () => {
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

	function harness(transportMode: "auto" | "native" | "codex", withNative = true) {
		const codexStreamSimple = vi.fn(() => emptyStream);
		const nativeStreamSimple = vi.fn(() => emptyStream);
		const routed = createRoutedStreamSimple({
			providerId: "cliproxyapi",
			transportMode,
			fallbackBaseUrl: ROOT,
			codexStreamSimple,
			nativeStreamSimple: withNative ? nativeStreamSimple : undefined,
		});
		return { routed, codexStreamSimple, nativeStreamSimple };
	}

	it("sends Claude models to the anthropic-messages adapter with compat overrides", () => {
		const { routed, codexStreamSimple, nativeStreamSimple } = harness("auto");
		routed(model("relay-apikeyfun/claude-sonnet-5"), context, { apiKey: "k" });

		expect(codexStreamSimple).not.toHaveBeenCalled();
		const [nativeModel, nativeContext] = nativeStreamSimple.mock.calls[0] as unknown as [Model<Api>, Context];
		// The model id keeps its route prefix; only the transport changes.
		expect(nativeModel.id).toBe("relay-apikeyfun/claude-sonnet-5");
		expect(nativeModel.api).toBe(ANTHROPIC_MESSAGES_API_ID);
		expect(nativeModel.baseUrl).toBe(ROOT);
		expect(nativeModel.compat).toEqual({ supportsEagerToolInputStreaming: false });
		expect(nativeContext).toBe(context);
	});

	it("keeps unknown models on the Codex transport in auto mode", () => {
		const { routed, codexStreamSimple, nativeStreamSimple } = harness("auto");
		routed(model("glm-4.6"), context);

		expect(nativeStreamSimple).not.toHaveBeenCalled();
		const [codexModel] = codexStreamSimple.mock.calls[0] as unknown as [Model<Api>];
		expect(codexModel.api).toBe(CLIPROXYAPI_CODEX_API_ID);
		expect(codexModel.baseUrl).toBe(`${ROOT}/backend-api/`);
	});

	it("keeps every model on the Codex transport in codex mode", () => {
		const { routed, codexStreamSimple, nativeStreamSimple } = harness("codex");
		routed(model("gpt-5.6-sol"), context);
		routed(model("claude-sonnet-5"), context);

		expect(nativeStreamSimple).not.toHaveBeenCalled();
		expect(codexStreamSimple).toHaveBeenCalledTimes(2);
	});

	it("falls back to Codex when the host dispatcher is unavailable", () => {
		const { routed, codexStreamSimple } = harness("native", false);
		routed(model("gemini-3-flash"), context);
		expect(codexStreamSimple).toHaveBeenCalledTimes(1);
	});

	it("never rewrites models from another provider", () => {
		const { routed, codexStreamSimple, nativeStreamSimple } = harness("native");
		routed(model("claude-sonnet-5", { provider: "anthropic" }), context);
		expect(nativeStreamSimple).not.toHaveBeenCalled();
		expect(codexStreamSimple).toHaveBeenCalledTimes(1);
	});
});

describe("isNativeRoutedModel", () => {
	it("reports the routing decision for a model", () => {
		expect(isNativeRoutedModel(model("gpt-5.6-sol"), "auto", ROOT)).toBe(true);
		expect(isNativeRoutedModel(model("glm-4.6"), "auto", ROOT)).toBe(false);
		expect(isNativeRoutedModel(model("gpt-5.6-sol"), "codex", ROOT)).toBe(false);
		expect(isNativeRoutedModel(model("glm-4.6"), "native", ROOT)).toBe(true);
	});
});

describe("native Fast injection inside the router", () => {
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

	function fastHarness() {
		const codexStreamSimple = vi.fn(streamSpy);
		const nativeStreamSimple = vi.fn(streamSpy);
		const fastMode = new FastModeController(true);
		fastMode.setSupportedModelIds(["gpt-5.6-sol", "claude-sonnet-5"]);
		const routed = createRoutedStreamSimple({
			providerId: "cliproxyapi",
			transportMode: "auto",
			fallbackBaseUrl: ROOT,
			codexStreamSimple,
			nativeStreamSimple,
			shouldUseFast: (candidate: Model<Api>) =>
				candidate.provider === "cliproxyapi" && fastMode.isEffectiveFor(candidate.id),
		});
		const payloadOf = async (call: number, payload: unknown) => {
			const options = nativeStreamSimple.mock.calls[call]?.[2] as SimpleStreamOptions | undefined;
			return options?.onPayload?.(payload, model("gpt-5.6-sol"));
		};
		return { routed, codexStreamSimple, nativeStreamSimple, payloadOf };
	}

	it("injects service_tier priority for a supported native model", async () => {
		const { routed, payloadOf } = fastHarness();
		routed(model("gpt-5.6-sol"), context, { apiKey: "k" });
		await expect(payloadOf(0, { model: "gpt-5.6-sol" })).resolves.toEqual({
			model: "gpt-5.6-sol",
			service_tier: "priority",
		});
	});

	it("leaves a native model without Fast support unchanged", async () => {
		const { routed, nativeStreamSimple } = fastHarness();
		routed(model("gemini-3-flash"), context);
		const options = nativeStreamSimple.mock.calls[0]?.[2] as SimpleStreamOptions | undefined;
		// No Fast wrapper and no debug wrapper: the caller options pass through untouched.
		expect(options?.onPayload).toBeUndefined();
	});

	it("never rewrites a request from another provider", () => {
		const { routed, nativeStreamSimple, codexStreamSimple } = fastHarness();
		routed(model("gpt-5.6-sol", { provider: "openai" }), context);
		expect(nativeStreamSimple).not.toHaveBeenCalled();
		expect(codexStreamSimple).toHaveBeenCalledTimes(1);
	});

	it("keeps the caller payload hook in the chain and passes it the Fast payload", async () => {
		const { routed, nativeStreamSimple } = fastHarness();
		const userOnPayload = vi.fn(async () => undefined);
		routed(model("claude-sonnet-5"), context, { onPayload: userOnPayload } as SimpleStreamOptions);
		const options = nativeStreamSimple.mock.calls[0]?.[2] as SimpleStreamOptions | undefined;
		const result = await options?.onPayload?.({ model: "claude-sonnet-5" }, model("claude-sonnet-5"));

		expect(result).toEqual({ model: "claude-sonnet-5", service_tier: "priority" });
		expect(userOnPayload).toHaveBeenCalledWith(
			{ model: "claude-sonnet-5", service_tier: "priority" },
			expect.anything(),
		);
	});

	it("does not inject Fast when no shouldUseFast callback is provided (compat dispatch)", async () => {
		const nativeStreamSimple = vi.fn(streamSpy);
		const routed = createRoutedStreamSimple({
			providerId: "cliproxyapi",
			transportMode: "auto",
			fallbackBaseUrl: ROOT,
			codexStreamSimple: vi.fn(streamSpy),
			nativeStreamSimple,
		});
		const userOnPayload = vi.fn(async () => undefined);
		routed(model("gpt-5.6-sol"), context, { onPayload: userOnPayload } as SimpleStreamOptions);
		const options = nativeStreamSimple.mock.calls[0]?.[2] as SimpleStreamOptions | undefined;

		// The compat dispatcher injects Fast itself; the router must not add a second layer.
		expect(options?.onPayload).toBe(userOnPayload);
	});
});
