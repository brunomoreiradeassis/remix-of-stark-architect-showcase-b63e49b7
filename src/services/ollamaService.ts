export type OllamaConfig = {
  baseUrl: string;
  selectedModel: string;
  temperature: number;
  maxTokens: number;
};

export async function listModels(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error("Falha ao listar modelos");
  return res.json();
}

/**
 * Retry helper: tenta a função até `retries` vezes com delay entre tentativas.
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (i < retries) {
        console.warn(`[Ollama] Tentativa ${i + 1} falhou, retentando em ${delayMs}ms...`, lastErr.message);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr!;
}

export async function chatStream(params: {
  config: OllamaConfig;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}) {
  const body = {
    model: params.config.selectedModel,
    messages: params.messages,
    stream: true,
    keep_alive: "15m",
    options: {
      temperature: params.config.temperature,
      num_predict: params.config.maxTokens,
      num_ctx: 16384,
    },
  };

  const doFetch = async () => {
    const res = await fetch(`${params.config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Falha ao conectar ao chat do Ollama (HTTP ${res.status}): ${errText || "sem detalhes"}`);
    }
    if (!res.body) throw new Error("Resposta sem body stream");
    return res;
  };

  const res = await withRetry(doFetch, 2, 2000);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep last potentially incomplete line in buffer
    buffer = lines.pop() || "";
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const json = JSON.parse(l);
        const token = json.message?.content ?? json.response ?? "";
        if (token) {
          params.onToken(token);
          full += token;
        }
      } catch (e) {
        const _ = e;
      }
    }
  }
  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer);
      const token = json.message?.content ?? json.response ?? "";
      if (token) {
        params.onToken(token);
        full += token;
      }
    } catch { /* ignore */ }
  }
  return full;
}

export async function generateStream(params: {
  config: OllamaConfig;
  prompt: string;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}) {
  const body = {
    model: params.config.selectedModel,
    prompt: params.prompt,
    stream: true,
    keep_alive: "15m",
    options: {
      temperature: params.config.temperature,
      num_predict: params.config.maxTokens,
      num_ctx: 16384,
    },
  };

  const doFetch = async () => {
    const res = await fetch(`${params.config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Falha ao conectar à geração do Ollama (HTTP ${res.status}): ${errText || "sem detalhes"}`);
    }
    if (!res.body) throw new Error("Resposta sem body stream");
    return res;
  };

  const res = await withRetry(doFetch, 2, 2000);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const json = JSON.parse(l);
        const token = json.response ?? "";
        if (token) {
          params.onToken(token);
          full += token;
        }
      } catch (e) {
        const _ = e;
      }
    }
  }
  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer);
      const token = json.response ?? "";
      if (token) {
        params.onToken(token);
        full += token;
      }
    } catch { /* ignore */ }
  }
  return full;
}

export function extractTsxBlocks(text: string) {
  const blocks: { filename?: string; code: string }[] = [];
  const fence = "```";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(fence, i);
    if (start === -1) break;
    const langEnd = text.indexOf("\n", start + fence.length);
    if (langEnd === -1) break;
    const lang = text.substring(start + fence.length, langEnd).trim();
    const end = text.indexOf(fence, langEnd + 1);
    if (end === -1) break;
    const code = text.substring(langEnd + 1, end);
    if (lang.startsWith("tsx") || lang.startsWith("typescript") || lang.startsWith("jsx")) {
      const lines = code.split("\n");
      let filename: string | undefined;
      const first = lines[0] || "";
      const m = first.match(/\/\/\s*(.+\.(tsx|jsx))/i);
      if (m) {
        filename = m[1].trim();
      }
      blocks.push({ filename, code });
    }
    i = end + fence.length;
  }
  return blocks;
}

export function makeChatCacheKey(config: OllamaConfig, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
  const payload = {
    model: config.selectedModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    messages,
  };
  return "chat:" + JSON.stringify(payload);
}

export function makeGenerateCacheKey(config: OllamaConfig, prompt: string) {
  const payload = {
    model: config.selectedModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    prompt,
  };
  return "generate:" + JSON.stringify(payload);
}

export function getCacheItem(key: string) {
  try {
    const raw = localStorage.getItem("ollama-cache");
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return map[key] ?? null;
  } catch {
    return null;
  }
}

export function setCacheItem(key: string, value: string) {
  try {
    const raw = localStorage.getItem("ollama-cache");
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[key] = value;
    localStorage.setItem("ollama-cache", JSON.stringify(map));
  } catch (e) {
    void e;
  }
}

export function pickModel(task: "generate" | "chat" | "explain" | "fix" | "refactor", available: string[], fallback: string) {
  try {
    const raw = localStorage.getItem("ollama-task-models");
    if (raw) {
      const map = JSON.parse(raw) as Record<string, string>;
      const desired = map[task];
      if (desired && available.includes(desired)) {
        return desired;
      }
    }
  } catch (e) {
    void e;
  }
  if (available.includes(fallback)) return fallback;
  return available[0] ?? fallback;
}

/**
 * Extrai blocos de código de qualquer linguagem (tsx, ts, jsx, css, json, html, etc.)
 */
export function extractAllCodeBlocks(text: string) {
  const blocks: { filename?: string; code: string; lang: string }[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const lang = match[1] || "txt";
    const code = match[2];
    if (!code.trim()) continue;
    const lines = code.split("\n");
    let filename: string | undefined;
    const first = lines[0] || "";
    const mLine = first.trim();
    const m1 = mLine.match(/\/\/\s*(.+\.\w+)/i);
    const m2 = mLine.match(/<!--\s*(.+\.\w+)\s*-->/i);
    const m3 = mLine.match(/\/\*\s*(.+\.\w+)\s*\*\//i);
    filename = (m1?.[1] || m2?.[1] || m3?.[1] || "").trim() || undefined;
    blocks.push({ filename, code, lang });
  }
  return blocks;
}

/**
 * Parseia a resposta do plano e extrai operações de arquivo (criar, modificar, excluir).
 */
export function extractFileOperations(planText: string): {
  create: string[];
  modify: string[];
  delete: string[];
} {
  const result = { create: [] as string[], modify: [] as string[], delete: [] as string[] };
  const lines = planText.split("\n");

  let currentSection: "create" | "modify" | "delete" | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase().trim();

    if (lower.includes("arquivos a criar") || lower.includes("criar:") || lower.includes("novos arquivos") || lower.includes("files to create")) {
      currentSection = "create";
      continue;
    }
    if (lower.includes("arquivos a modificar") || lower.includes("modificar:") || lower.includes("arquivos modificados") || lower.includes("files to modify")) {
      currentSection = "modify";
      continue;
    }
    if (lower.includes("arquivos a excluir") || lower.includes("excluir:") || lower.includes("arquivos removidos") || lower.includes("files to delete")) {
      currentSection = "delete";
      continue;
    }

    if (currentSection) {
      const fileMatch = line.match(/[-*]\s*`?([^\s`]+\.\w+)`?/);
      if (fileMatch) {
        result[currentSection].push(fileMatch[1]);
      }
    }
  }

  return result;
}

/**
 * Extrai os passos do plano para gerar tasks.
 */
export function extractPlanSteps(planText: string): Array<{ title: string; files: string[] }> {
  const steps: Array<{ title: string; files: string[] }> = [];
  const lines = planText.split("\n");

  let inSteps = false;

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (lower.includes("passos:") || lower.includes("steps:") || lower.includes("passo a passo")) {
      inSteps = true;
      continue;
    }

    if (inSteps) {
      // Match numbered steps
      const stepMatch = line.match(/^\s*\d+\.\s+(.+)/);
      if (stepMatch) {
        const title = stepMatch[1].trim();
        // Extract file references from step
        const fileRefs: string[] = [];
        const fileMatches = title.matchAll(/`([^`]+\.\w+)`/g);
        for (const m of fileMatches) {
          fileRefs.push(m[1]);
        }
        steps.push({ title: title.replace(/`[^`]+`/g, "").trim() || title, files: fileRefs });
      } else if (line.match(/^###?\s/) && steps.length > 0) {
        // New section header means end of steps
        break;
      }
    }
  }

  // If no steps found, create generic tasks from file operations
  if (steps.length === 0) {
    const ops = extractFileOperations(planText);
    if (ops.create.length > 0) {
      steps.push({ title: "Criar novos arquivos", files: ops.create });
    }
    if (ops.modify.length > 0) {
      steps.push({ title: "Modificar arquivos existentes", files: ops.modify });
    }
    if (ops.delete.length > 0) {
      steps.push({ title: "Excluir arquivos", files: ops.delete });
    }
  }

  return steps;
}
