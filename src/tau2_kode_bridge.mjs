import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

function resolveModel(modelRaw) {
  const v = String(modelRaw || "").trim();
  if (!v) return { provider: "openai", model: "gpt-4o-mini" };
  const idx = v.indexOf("/");
  if (idx > 0) return { provider: v.slice(0, idx), model: v.slice(idx + 1) };
  return { provider: "openai", model: v };
}

function resolveProviderEnv(provider) {
  const p = provider.toLowerCase();
  if (p === "anthropic") {
    return {
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.KODE_AGENT_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.KODE_AGENT_BASE_URL,
    };
  }
  if (p === "gemini") {
    return {
      apiKey:
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.KODE_AGENT_API_KEY,
      baseUrl: process.env.GEMINI_BASE_URL || process.env.KODE_AGENT_BASE_URL,
    };
  }
  return {
    apiKey: process.env.OPENAI_API_KEY || process.env.KODE_AGENT_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.KODE_AGENT_BASE_URL,
  };
}

function getProviderUtilsModuleCandidates(source) {
  if (source === "@shareai-lab/kode-sdk") {
    return ["@shareai-lab/kode-sdk/dist/infra/providers/utils"];
  }
  if (source.endsWith("index.js")) {
    return [path.resolve(source, "../infra/providers/utils.js")];
  }
  return [path.join(source, "dist/infra/providers/utils.js")];
}

function normalizeOpenAIBaseUrlCompat(url) {
  let normalized = String(url || "").replace(/\/+$/, "");
  if (!/\/v\d+$/.test(normalized)) {
    normalized += "/v1";
  }
  return normalized;
}

function patchOpenAIBaseUrlNormalizerIfNeeded(source) {
  const candidates = getProviderUtilsModuleCandidates(source);
  for (const modPath of candidates) {
    try {
      const utils = require(modPath);
      if (!utils || typeof utils.normalizeOpenAIBaseUrl !== "function") continue;
      const probe = utils.normalizeOpenAIBaseUrl("https://open.bigmodel.cn/api/paas/v4");
      if (typeof probe === "string" && probe.endsWith("/v4/v1")) {
        utils.normalizeOpenAIBaseUrl = normalizeOpenAIBaseUrlCompat;
        process.stderr.write("[tau2-kode-bridge] patched SDK OpenAI base URL normalizer for non-v1 endpoints\n");
      }
      return;
    } catch {
      // try next candidate
    }
  }
}

function tryLoadKodeSdk() {
  const entries = [];
  if (process.env.KODE_SDK_PATH) entries.push(path.resolve(process.env.KODE_SDK_PATH));
  entries.push("@shareai-lab/kode-sdk");
  entries.push(path.resolve(process.cwd(), "../Kode-agent-sdk/dist/index.js"));
  const errs = [];
  for (const entry of entries) {
    try {
      const mod = require(entry);
      if (
        mod &&
        mod.Agent &&
        typeof mod.Agent.create === "function" &&
        mod.JSONStore &&
        mod.AgentTemplateRegistry &&
        mod.ToolRegistry &&
        mod.SandboxFactory
      ) {
        return { sdk: mod, source: entry };
      }
      errs.push(`${entry}: missing required exports`);
    } catch (e) {
      errs.push(`${entry}: ${String(e?.message || e)}`);
    }
  }
  throw new Error(`Failed to load KODE SDK:\n${errs.join("\n")}`);
}

function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "No tools available.";
  return tools
    .map((t) => {
      const fn = t?.function || {};
      return JSON.stringify(
        {
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        },
        null,
        2,
      );
    })
    .join("\n\n");
}

function renderMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      const role = String(m?.role || "unknown");
      const content = typeof m?.content === "string" ? m.content : "";
      const toolCalls = Array.isArray(m?.tool_calls) ? `\ntool_calls=${JSON.stringify(m.tool_calls)}` : "";
      const toolCallId = m?.tool_call_id ? `\ntool_call_id=${m.tool_call_id}` : "";
      return `[${role}]\n${content}${toolCalls}${toolCallId}`;
    })
    .join("\n\n");
}

function extractJsonCandidate(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}

function parseAction(raw) {
  const candidate = extractJsonCandidate(raw);
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") {
        const mode = String(obj.mode || obj.type || "").toLowerCase();
        if (mode === "tool_call" || mode === "tool") {
          return {
            mode: "tool_call",
            id: typeof obj.id === "string" ? obj.id : undefined,
            name: String(obj.name || ""),
            arguments: obj.arguments && typeof obj.arguments === "object" ? obj.arguments : {},
            raw_text: raw,
          };
        }
        return {
          mode: "message",
          content: typeof obj.content === "string" ? obj.content : String(obj.content || raw || ""),
          raw_text: raw,
        };
      }
    } catch {
      // fall through to plain text
    }
  }
  return { mode: "message", content: String(raw || ""), raw_text: raw };
}

function buildPrompt({ tools, messages }) {
  return [
    "You are a TAU2 customer service agent.",
    "Decide the next assistant action based on the conversation and tool specs.",
    "Output ONLY one JSON object with one of the following formats:",
    '{"mode":"message","content":"..."}',
    '{"mode":"tool_call","name":"tool_name","arguments":{"arg":"value"}}',
    "Do not output markdown.",
    "",
    "Available tools:",
    renderTools(tools),
    "",
    "Conversation:",
    renderMessages(messages),
  ].join("\n");
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || "{}");
  const modelRaw = payload.model;
  const llmArgs = payload.llm_args && typeof payload.llm_args === "object" ? payload.llm_args : {};
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  const loaded = tryLoadKodeSdk();
  const sdk = loaded.sdk;
  patchOpenAIBaseUrlNormalizerIfNeeded(loaded.source);
  const { provider, model } = resolveModel(modelRaw);
  const providerEnv = resolveProviderEnv(provider);
  if (!providerEnv.apiKey) {
    throw new Error(`Missing API key for provider=${provider}`);
  }

  const modelConfig = {
    provider,
    model,
    apiKey: providerEnv.apiKey,
    temperature: Number.isFinite(llmArgs.temperature) ? llmArgs.temperature : 0,
  };
  if (providerEnv.baseUrl) modelConfig.baseUrl = providerEnv.baseUrl;

  const storeDir =
    process.env.KODE_AGENT_STORE_DIR ||
    path.resolve(process.cwd(), "tests/tmp/kode-tau-bridge-store");
  fs.mkdirSync(storeDir, { recursive: true });

  const templateRegistry = new sdk.AgentTemplateRegistry();
  const toolRegistry = new sdk.ToolRegistry();
  const sandboxFactory = new sdk.SandboxFactory();
  const deps = {
    store: new sdk.JSONStore(storeDir),
    templateRegistry,
    sandboxFactory,
    toolRegistry,
  };

  const templateId = `tau2-kode-bridge-${Date.now()}`;
  templateRegistry.register({
    id: templateId,
    systemPrompt: "You are a reliable TAU2 agent.",
    tools: [],
    runtime: { metadata: { exposeThinking: false } },
  });

  const agent = await sdk.Agent.create(
    {
      templateId,
      modelConfig,
      sandbox: {
        kind: "local",
        workDir: process.env.KODE_AGENT_WORKDIR || process.cwd(),
        enforceBoundary: true,
        watchFiles: false,
      },
    },
    deps,
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let modelErrorMessage = "";
  const off =
    typeof agent.on === "function"
      ? agent.on("token_usage", (evt) => {
          const inTok = Number(evt?.inputTokens);
          const outTok = Number(evt?.outputTokens);
          if (Number.isFinite(inTok) && inTok > 0) inputTokens += inTok;
          if (Number.isFinite(outTok) && outTok > 0) outputTokens += outTok;
        })
      : () => undefined;
  const offError =
    typeof agent.on === "function"
      ? agent.on("error", (evt) => {
          const msg = String(evt?.message || "").trim();
          if (msg) modelErrorMessage = msg;
        })
      : () => undefined;

  const prompt = buildPrompt({ tools, messages });
  const result = await agent.complete(prompt);
  off();
  offError();

  if ((result?.status || "") === "paused") {
    const pending = Array.isArray(result?.permissionIds) ? result.permissionIds.join(",") : "";
    throw new Error(`agent paused waiting permissions${pending ? ` (${pending})` : ""}`);
  }

  let text = typeof result?.text === "string" ? result.text : "";
  if (!text.trim() && modelErrorMessage) {
    throw new Error(`agent returned empty response due to model error: ${modelErrorMessage}`);
  }
  if (!text.trim()) {
    text = '{"mode":"message","content":"I need more context to continue. Please restate your request."}';
  }
  const action = parseAction(text);
  action.usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };

  process.stdout.write(JSON.stringify(action));
}

main().catch((err) => {
  const msg = String(err?.message || err);
  process.stderr.write(`[tau2-kode-bridge] ${msg}\n`);
  process.exit(1);
});
