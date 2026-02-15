import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type FormEvent,
} from "react";
import {
  Send,
  Loader2,
  Bot,
  User,
  Play,
  CheckCircle,
  XCircle,
  FileText,
  StopCircle,
  Trash2,
  MessageSquare,
  Plus,
  ChevronRight,
  ChevronDown,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import { useOllama } from "@/contexts/OllamaContext";
import {
  chatStream,
  extractAllCodeBlocks,
  extractFileOperations,
  extractPlanSteps,
} from "@/services/ollamaService";
import { toast } from "@/components/ui/use-toast";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  plan?: PlanData;
}

interface PlanData {
  raw: string;
  steps: Array<{ title: string; files: string[] }>;
  fileOps: { create: string[]; modify: string[]; delete: string[] };
  status?: "idle" | "running" | "done" | "error";
  stepStatus?: Array<"pending" | "running" | "done" | "error">;
}

/* ------------------------------------------------------------------ */
/* System Prompts                                                      */
/* ------------------------------------------------------------------ */
const PLAN_SYSTEM_PROMPT = `Voce e um arquiteto de software especializado em React + TypeScript + Tailwind CSS + Vite.
O usuario vai descrever uma alteracao e voce deve devolver um PLANO DE EXECUCAO estruturado.

Formato obrigatorio do plano:
### Arquivos a criar
- caminho/completo/do/arquivo.tsx
### Arquivos a modificar
- caminho/completo/do/arquivo.tsx
### Arquivos a excluir
- caminho/completo/do/arquivo.tsx
### Passos
1. Descricao do passo - envolvendo \`caminho/completo/do/arquivo.tsx\`
2. ...

REGRAS:
- SEMPRE use caminhos relativos reais (ex: src/components/MeuComponente.tsx)
- NUNCA use nomes descritivos como nomes de arquivo
- Liste TODOS os arquivos afetados nas secoes corretas
- Os passos devem referenciar os arquivos com backticks
- Retorne APENAS o plano, sem codigo`;

const EXEC_SYSTEM_PROMPT = `Voce e um assistente profissional especializado em React+TypeScript+Tailwind+Vite.
Antes de gerar codigo, analise TODOS os arquivos do projeto fornecidos no contexto.

REGRAS OBRIGATORIAS DE NOMEACAO:
- CADA bloco de codigo DEVE comecar com um comentario na PRIMEIRA linha contendo o CAMINHO EXATO do arquivo.
- Use EXATAMENTE os caminhos listados no plano. NAO invente nomes novos.
- Exemplo: // src/components/NavLink.tsx
- Para HTML: <!-- src/index.html -->
- Para CSS: // src/index.css
- Se o passo diz "modificar src/components/NavLink.tsx", o bloco DEVE comecar com: // src/components/NavLink.tsx
- NUNCA use nomes descritivos ou titulos de passos como nome de arquivo.

REGRAS DE CODIGO:
- Retorne blocos de codigo completos, um por arquivo
- Use tsx para blocos React/TypeScript, css para CSS, ts para TypeScript puro
- Cada arquivo deve ser COMPLETO e funcional (nao use "// ... resto do codigo")
- Use apenas classes Tailwind e componentes funcionais React
- Verifique os imports de cada arquivo
- Se modificar um componente usado por outros, gere TODOS os afetados
- Gere cada arquivo COMPLETAMENTE, sem abreviacoes`;

/* ------------------------------------------------------------------ */
/* Helper: resolve filename from a code block to the correct plan path */
/* ------------------------------------------------------------------ */
function resolveBlockFileName(
  block: { filename?: string; code: string; lang: string },
  stepFiles: string[],
  planCreateFiles: string[],
  planModifyFiles: string[],
  resolvedSoFar: Set<string>,
  routeFileFn: (fname: string) => string,
): string {
  // 1. Block has a path with directory separator => use directly
  if (block.filename && (block.filename.includes("/") || block.filename.includes("\\"))) {
    return block.filename.replace(/^[\\/]+/, "");
  }

  // 2. Block has a simple name (e.g. "NavLink.tsx") => match against plan files
  if (block.filename) {
    const baseName = block.filename.split("/").pop() || block.filename;
    const allPlanFiles = [...planCreateFiles, ...planModifyFiles, ...stepFiles];
    const match = allPlanFiles.find((f) => f.endsWith("/" + baseName) || f === baseName);
    if (match) return match;
    return routeFileFn(baseName);
  }

  // 3. No filename: try matching by content
  const allCandidates = stepFiles.length > 0
    ? [...stepFiles]
    : [...planCreateFiles, ...planModifyFiles];

  // Try by default export name
  const exportMatch = block.code.match(/export\s+default\s+function\s+(\w+)/);
  const exportName = exportMatch?.[1];
  if (exportName) {
    const found = allCandidates.find((f) => {
      const fBase = f.split("/").pop()?.replace(/\.\w+$/, "") || "";
      return fBase.toLowerCase() === exportName.toLowerCase();
    });
    if (found && !resolvedSoFar.has(found)) return found;
  }

  // Try by named export
  const namedExport = block.code.match(/export\s+(?:const|function)\s+(\w+)/);
  const namedName = namedExport?.[1];
  if (namedName) {
    const found = allCandidates.find((f) => {
      const fBase = f.split("/").pop()?.replace(/\.\w+$/, "") || "";
      return fBase.toLowerCase() === namedName.toLowerCase();
    });
    if (found && !resolvedSoFar.has(found)) return found;
  }

  // 4. Fallback: first unresolved file from candidates
  for (const f of allCandidates) {
    if (!resolvedSoFar.has(f)) return f;
  }

  // 5. Last resort
  return routeFileFn("GeneratedComponent.tsx");
}

/* ------------------------------------------------------------------ */
/* Route file to the proper directory based on extension/type          */
/* ------------------------------------------------------------------ */
function routeFile(filename: string): string {
  // Already has a path
  if (filename.includes("/") || filename.includes("\\")) {
    return filename.replace(/^[\\/]+/, "");
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".css")) return `src/${filename}`;
  if (lower === "index.html") return filename;
  if (lower.endsWith(".html")) return filename;
  if (lower.endsWith(".json")) return filename;
  if (lower.endsWith(".md")) return filename;
  // TSX/JSX/TS => components
  if (/\.(tsx|jsx|ts)$/.test(lower)) return `src/components/${filename}`;
  return `src/${filename}`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */
export function ChatPanel() {
  const {
    config,
    isConnected,
    virtualFiles,
    addVirtualFile,
    deleteVirtualFile,
    projectTemplate,
    saveChatSession,
    loadChatSession,
    loadChatSessions,
    chatSessions,
    currentChatId,
    setCurrentChatId,
    pendingErrorFix,
    setPendingErrorFix,
    projectName,
  } = useOllama();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [executingPlan, setExecutingPlan] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamText]);

  // Load chat sessions on mount
  useEffect(() => {
    loadChatSessions();
  }, [loadChatSessions]);

  // Auto-load current chat
  useEffect(() => {
    if (currentChatId && messages.length === 0) {
      loadChatSession(currentChatId).then((msgs) => {
        if (msgs) setMessages(msgs);
      });
    }
  }, [currentChatId]);

  // Auto-fix errors
  useEffect(() => {
    if (pendingErrorFix && !isLoading && !executingPlan) {
      const msg = pendingErrorFix;
      setPendingErrorFix(null);
      setInput(`Corrija este erro do console:\n${msg}`);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      }, 100);
    }
  }, [pendingErrorFix, isLoading, executingPlan]);

  // Save chat on message changes
  const autoSave = useCallback(
    async (msgs: ChatMessage[]) => {
      if (msgs.length === 0) return;
      const chatId = currentChatId || `chat-${Date.now()}`;
      if (!currentChatId) setCurrentChatId(chatId);
      const firstUserMsg = msgs.find((m) => m.role === "user");
      const title = firstUserMsg
        ? firstUserMsg.content.slice(0, 50)
        : "Nova conversa";
      await saveChatSession(chatId, title, msgs);
    },
    [currentChatId, saveChatSession, setCurrentChatId],
  );

  /* ---------------------------------------------------------------- */
  /* Build context string from virtual files                          */
  /* ---------------------------------------------------------------- */
  const projectContext = useMemo(() => {
    const relevantFiles = virtualFiles.filter(
      (f) =>
        /\.(tsx|ts|jsx|js|css|html|json)$/i.test(f.path) &&
        !f.path.includes("node_modules"),
    );
    if (relevantFiles.length === 0) return "";
    const parts = relevantFiles.map(
      (f) => `### ${f.path}\n\`\`\`\n${f.code}\n\`\`\``,
    );
    return (
      "\n\n--- ARQUIVOS DO PROJETO ---\n" +
      parts.join("\n\n") +
      "\n--- FIM DOS ARQUIVOS ---\n"
    );
  }, [virtualFiles]);

  /* ---------------------------------------------------------------- */
  /* Handle send message                                              */
  /* ---------------------------------------------------------------- */
  const handleSend = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    if (!isConnected) {
      toast({
        title: "Ollama desconectado",
        description: "Conecte ao Ollama antes de enviar mensagens.",
        variant: "destructive",
      });
      return;
    }

    const userMsg: ChatMessage = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setIsLoading(true);
    setStreamText("");

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const systemPrompt = `${PLAN_SYSTEM_PROMPT}\n\n${projectTemplate}\n${projectContext}`;
      const apiMessages = [
        { role: "system" as const, content: systemPrompt },
        ...next.map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        })),
      ];

      let full = "";
      await chatStream({
        config,
        messages: apiMessages,
        signal: abort.signal,
        onToken: (token) => {
          full += token;
          setStreamText(full);
        },
      });

      // Parse plan from response
      const fileOps = extractFileOperations(full);
      const steps = extractPlanSteps(full);
      const hasPlan =
        steps.length > 0 ||
        fileOps.create.length > 0 ||
        fileOps.modify.length > 0 ||
        fileOps.delete.length > 0;

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: full,
        plan: hasPlan
          ? {
              raw: full,
              steps,
              fileOps,
              status: "idle",
              stepStatus: steps.map(() => "pending" as const),
            }
          : undefined,
      };

      const updated = [...next, assistantMsg];
      setMessages(updated);
      setStreamText("");
      await autoSave(updated);
    } catch (err: any) {
      if (err.name === "AbortError") {
        const abortMsg: ChatMessage = {
          role: "assistant",
          content: streamText + "\n\n*(Geração cancelada)*",
        };
        const updated = [...next, abortMsg];
        setMessages(updated);
      } else {
        toast({
          title: "Erro",
          description: err.message,
          variant: "destructive",
        });
      }
    } finally {
      setIsLoading(false);
      setStreamText("");
      abortRef.current = null;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Stop generation                                                  */
  /* ---------------------------------------------------------------- */
  const handleStop = () => {
    abortRef.current?.abort();
  };

  /* ---------------------------------------------------------------- */
  /* Execute plan - the core fix                                      */
  /* ---------------------------------------------------------------- */
  const handleExecutePlan = async (msgIndex: number) => {
    const msg = messages[msgIndex];
    if (!msg?.plan || executingPlan) return;

    const plan = msg.plan;
    setExecutingPlan(true);

    // Update plan status
    const updatePlan = (patch: Partial<PlanData>) => {
      setMessages((prev) => {
        const copy = [...prev];
        const m = { ...copy[msgIndex] };
        m.plan = { ...m.plan!, ...patch };
        copy[msgIndex] = m;
        return copy;
      });
    };

    updatePlan({ status: "running" });

    const allCreated: string[] = [];
    const allModified: string[] = [];
    const allDeleted: string[] = [];
    const allErrors: string[] = [];

    try {
      // ---- Execute each step ----
      for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];

        // Update step status
        updatePlan({
          stepStatus: plan.steps.map((_, i) =>
            i < si ? "done" : i === si ? "running" : "pending",
          ),
        });

        // Skip deletion-only steps (handled at the end)
        const isDeletionStep =
          step.title.toLowerCase().includes("excluir") ||
          step.title.toLowerCase().includes("remover") ||
          step.title.toLowerCase().includes("delete");
        if (isDeletionStep && plan.fileOps.delete.length > 0) {
          continue;
        }

        // Build the execution prompt with file context
        const stepFilesContent: string[] = [];
        const filesToInclude = step.files.length > 0 ? step.files : [...plan.fileOps.create, ...plan.fileOps.modify];

        for (const fp of filesToInclude) {
          const existing = virtualFiles.find((f) => f.path === fp);
          if (existing) {
            stepFilesContent.push(
              `--- CONTEUDO ATUAL DE ${fp} ---\n\`\`\`\n${existing.code}\n\`\`\``,
            );
          }
        }

        const fileListContext = [
          plan.fileOps.create.length > 0
            ? `Arquivos a CRIAR: ${plan.fileOps.create.join(", ")}`
            : "",
          plan.fileOps.modify.length > 0
            ? `Arquivos a MODIFICAR: ${plan.fileOps.modify.join(", ")}`
            : "",
          plan.fileOps.delete.length > 0
            ? `Arquivos a EXCLUIR: ${plan.fileOps.delete.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        const execPrompt = [
          `Execute o passo ${si + 1}: ${step.title}`,
          "",
          `Arquivos envolvidos neste passo: ${step.files.join(", ") || "ver lista abaixo"}`,
          "",
          fileListContext,
          "",
          stepFilesContent.length > 0
            ? "Conteudo atual dos arquivos relevantes:\n" +
              stepFilesContent.join("\n\n")
            : "",
          "",
          `IMPORTANTE: Cada bloco de codigo DEVE ter na PRIMEIRA LINHA um comentario com o caminho EXATO do arquivo.`,
          `Exemplo: // src/components/MeuComponente.tsx`,
          `Use EXATAMENTE os caminhos listados acima. NAO invente nomes.`,
          "",
          `Gere o codigo completo de TODOS os arquivos necessarios para este passo.`,
        ].join("\n");

        const systemPrompt = `${EXEC_SYSTEM_PROMPT}\n\n${projectTemplate}\n${projectContext}`;

        let stepResponse = "";
        try {
          const abort = new AbortController();
          abortRef.current = abort;

          await chatStream({
            config,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: execPrompt },
            ],
            signal: abort.signal,
            onToken: (token) => {
              stepResponse += token;
              setStreamText(
                `Executando passo ${si + 1}/${plan.steps.length}: ${step.title}\n\n${stepResponse}`,
              );
            },
          });
        } catch (err: any) {
          if (err.name === "AbortError") {
            allErrors.push(`Passo ${si + 1} cancelado`);
            updatePlan({
              stepStatus: plan.steps.map((_, i) =>
                i < si ? "done" : i === si ? "error" : "pending",
              ),
            });
            break;
          }
          throw err;
        }

        // ---- Process code blocks from the response ----
        const blocks = extractAllCodeBlocks(stepResponse);
        const resolvedInThisStep = new Set<string>();

        for (const block of blocks) {
          const resolvedPath = resolveBlockFileName(
            block,
            step.files,
            plan.fileOps.create,
            plan.fileOps.modify,
            resolvedInThisStep,
            routeFile,
          );

          resolvedInThisStep.add(resolvedPath);

          // Check if this is a modification or creation
          const exists = virtualFiles.some((f) => f.path === resolvedPath);
          addVirtualFile(resolvedPath, block.code, true);

          if (exists) {
            if (!allModified.includes(resolvedPath)) allModified.push(resolvedPath);
          } else {
            if (!allCreated.includes(resolvedPath)) allCreated.push(resolvedPath);
          }
        }
      }

      // ---- Handle deletions AFTER all steps ----
      if (plan.fileOps.delete.length > 0) {
        for (const filePath of plan.fileOps.delete) {
          const exists = virtualFiles.some((f) => f.path === filePath);
          if (exists) {
            deleteVirtualFile(filePath);
            allDeleted.push(filePath);
          }
          // Also try to delete from remote server
          try {
            const pName = projectName || "";
            if (pName) {
              await fetch("http://localhost:3001/delete-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  projectName: pName,
                  filePath,
                }),
              }).catch(() => {});
            }
          } catch {
            // Ignore remote delete errors
          }
        }
      }

      // ---- Update final status ----
      updatePlan({
        status: allErrors.length > 0 ? "error" : "done",
        stepStatus: plan.steps.map((_, i) => {
          const isDel =
            plan.steps[i].title.toLowerCase().includes("excluir") ||
            plan.steps[i].title.toLowerCase().includes("remover");
          if (isDel && plan.fileOps.delete.length > 0) return "done";
          return allErrors.length > 0 && i === plan.steps.length - 1
            ? "error"
            : "done";
        }),
      });

      // ---- Summary message ----
      const summaryParts: string[] = [];
      if (allCreated.length > 0)
        summaryParts.push(
          `Criados (${allCreated.length}): ${allCreated.join(", ")}`,
        );
      if (allModified.length > 0)
        summaryParts.push(
          `Modificados (${allModified.length}): ${allModified.join(", ")}`,
        );
      if (allDeleted.length > 0)
        summaryParts.push(
          `Excluidos (${allDeleted.length}): ${allDeleted.join(", ")}`,
        );
      if (allErrors.length > 0)
        summaryParts.push(`Erros: ${allErrors.join("; ")}`);

      const summaryMsg: ChatMessage = {
        role: "assistant",
        content:
          allErrors.length > 0
            ? `Plano executado com erros.\n${summaryParts.join("\n")}`
            : `Plano executado com sucesso!\n${summaryParts.join("\n")}`,
      };
      const updated = [...messages, summaryMsg];
      setMessages(updated);
      await autoSave(updated);

      toast({
        title:
          allErrors.length > 0
            ? "Plano executado com erros"
            : "Plano executado com sucesso",
        description: `${allCreated.length} criados, ${allModified.length} modificados, ${allDeleted.length} excluidos`,
        variant: allErrors.length > 0 ? "destructive" : "default",
      });
    } catch (err: any) {
      updatePlan({ status: "error" });
      toast({
        title: "Erro na execucao",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setExecutingPlan(false);
      setStreamText("");
      abortRef.current = null;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Quick actions: single message (no plan)                           */
  /* ---------------------------------------------------------------- */
  const handleQuickGenerate = async (prompt: string) => {
    if (isLoading || executingPlan) return;

    const userMsg: ChatMessage = { role: "user", content: prompt };
    const next = [...messages, userMsg];
    setMessages(next);
    setIsLoading(true);
    setStreamText("");

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const systemPrompt = `${EXEC_SYSTEM_PROMPT}\n\n${projectTemplate}\n${projectContext}`;

      let full = "";
      await chatStream({
        config,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        signal: abort.signal,
        onToken: (token) => {
          full += token;
          setStreamText(full);
        },
      });

      // Extract and apply code blocks directly
      const blocks = extractAllCodeBlocks(full);
      const appliedFiles: string[] = [];

      for (const block of blocks) {
        const path = block.filename
          ? block.filename.includes("/")
            ? block.filename
            : routeFile(block.filename)
          : routeFile("GeneratedComponent.tsx");
        addVirtualFile(path, block.code, true);
        appliedFiles.push(path);
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content:
          full +
          (appliedFiles.length > 0
            ? `\n\n*Arquivos aplicados: ${appliedFiles.join(", ")}*`
            : ""),
      };
      const updated = [...next, assistantMsg];
      setMessages(updated);
      setStreamText("");
      await autoSave(updated);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        toast({
          title: "Erro",
          description: err.message,
          variant: "destructive",
        });
      }
    } finally {
      setIsLoading(false);
      setStreamText("");
      abortRef.current = null;
    }
  };

  /* ---------------------------------------------------------------- */
  /* New chat                                                          */
  /* ---------------------------------------------------------------- */
  const handleNewChat = () => {
    setMessages([]);
    setCurrentChatId(null);
    setExpandedPlan(null);
    localStorage.removeItem("current-chat-id");
  };

  /* ---------------------------------------------------------------- */
  /* Load a saved chat                                                */
  /* ---------------------------------------------------------------- */
  const handleLoadChat = async (chatId: string) => {
    const msgs = await loadChatSession(chatId);
    if (msgs) {
      setMessages(msgs);
      setShowSessions(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Render plan UI                                                   */
  /* ---------------------------------------------------------------- */
  const renderPlan = (plan: PlanData, msgIdx: number) => {
    const isExpanded = expandedPlan === msgIdx;
    return (
      <div className="mt-3 rounded-lg border border-border bg-secondary/30 overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setExpandedPlan(isExpanded ? null : msgIdx)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-primary" />
            <span>
              Plano: {plan.steps.length} passos,{" "}
              {plan.fileOps.create.length + plan.fileOps.modify.length} arquivos
            </span>
            {plan.fileOps.delete.length > 0 && (
              <span className="text-destructive">
                ({plan.fileOps.delete.length} a excluir)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {plan.status === "done" && (
              <CheckCircle className="h-3.5 w-3.5 text-green-500" />
            )}
            {plan.status === "error" && (
              <XCircle className="h-3.5 w-3.5 text-destructive" />
            )}
            {plan.status === "running" && (
              <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />
            )}
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </div>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div className="px-3 pb-3 space-y-2">
            {/* File operations summary */}
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              {plan.fileOps.create.length > 0 && (
                <div className="bg-green-500/10 text-green-600 rounded px-2 py-1">
                  <div className="font-semibold">Criar</div>
                  {plan.fileOps.create.map((f) => (
                    <div key={f} className="truncate" title={f}>
                      {f}
                    </div>
                  ))}
                </div>
              )}
              {plan.fileOps.modify.length > 0 && (
                <div className="bg-yellow-500/10 text-yellow-600 rounded px-2 py-1">
                  <div className="font-semibold">Modificar</div>
                  {plan.fileOps.modify.map((f) => (
                    <div key={f} className="truncate" title={f}>
                      {f}
                    </div>
                  ))}
                </div>
              )}
              {plan.fileOps.delete.length > 0 && (
                <div className="bg-red-500/10 text-red-600 rounded px-2 py-1">
                  <div className="font-semibold">Excluir</div>
                  {plan.fileOps.delete.map((f) => (
                    <div key={f} className="truncate" title={f}>
                      {f}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Steps */}
            <div className="space-y-1">
              {plan.steps.map((step, si) => (
                <div
                  key={si}
                  className="flex items-start gap-2 text-xs py-1 px-2 rounded"
                >
                  <div className="mt-0.5 shrink-0">
                    {plan.stepStatus?.[si] === "done" && (
                      <CheckCircle className="h-3 w-3 text-green-500" />
                    )}
                    {plan.stepStatus?.[si] === "running" && (
                      <Loader2 className="h-3 w-3 text-primary animate-spin" />
                    )}
                    {plan.stepStatus?.[si] === "error" && (
                      <XCircle className="h-3 w-3 text-destructive" />
                    )}
                    {plan.stepStatus?.[si] === "pending" && (
                      <div className="h-3 w-3 rounded-full border border-muted-foreground/30" />
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground mr-1">
                      {si + 1}.
                    </span>
                    {step.title}
                    {step.files.length > 0 && (
                      <span className="text-muted-foreground ml-1">
                        ({step.files.join(", ")})
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Execute button */}
            {(!plan.status || plan.status === "idle" || plan.status === "error") && (
              <button
                onClick={() => handleExecutePlan(msgIdx)}
                disabled={executingPlan || !isConnected}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {plan.status === "error" ? (
                  <RotateCcw className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {plan.status === "error"
                  ? "Re-executar Plano"
                  : "Executar Plano"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/50 shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Chat IA</span>
          {executingPlan && (
            <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full animate-pulse">
              Executando plano...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSessions(!showSessions)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Historico"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleNewChat}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Nova conversa"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              setMessages([]);
              setStreamText("");
            }}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Limpar"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Sessions dropdown */}
      {showSessions && chatSessions.length > 0 && (
        <div className="border-b border-border bg-card/80 max-h-48 overflow-auto">
          {chatSessions.map((s) => (
            <button
              key={s.id}
              onClick={() => handleLoadChat(s.id)}
              className={`w-full text-left px-4 py-2 text-xs hover:bg-secondary/50 transition-colors ${
                s.id === currentChatId
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground"
              }`}
            >
              <div className="font-medium truncate">{s.title}</div>
              <div className="text-[10px] opacity-60">
                {new Date(s.updatedAt).toLocaleString("pt-BR")}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !streamText && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <Bot className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">
              Descreva o que deseja construir e receba um plano de execucao.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              O plano ira criar, modificar e excluir arquivos conforme necessario.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}
          >
            {msg.role === "assistant" && (
              <div className="shrink-0 mt-1">
                <Bot className="h-5 w-5 text-primary" />
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/50 text-foreground"
              }`}
            >
              <div className="whitespace-pre-wrap break-words">
                {msg.content}
              </div>
              {msg.plan && renderPlan(msg.plan, i)}
            </div>
            {msg.role === "user" && (
              <div className="shrink-0 mt-1">
                <User className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
          </div>
        ))}

        {/* Streaming text */}
        {streamText && (
          <div className="flex gap-2">
            <Bot className="h-5 w-5 text-primary shrink-0 mt-1" />
            <div className="max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed bg-secondary/50 text-foreground">
              <div className="whitespace-pre-wrap break-words">
                {streamText}
              </div>
              <Loader2 className="h-3 w-3 text-primary animate-spin mt-1" />
            </div>
          </div>
        )}

        {isLoading && !streamText && (
          <div className="flex gap-2">
            <Bot className="h-5 w-5 text-primary shrink-0 mt-1" />
            <div className="rounded-xl px-3 py-2 bg-secondary/50">
              <Loader2 className="h-4 w-4 text-primary animate-spin" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border bg-card/50 p-3">
        <form onSubmit={handleSend} className="flex gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={
                isConnected
                  ? "Descreva o que deseja construir..."
                  : "Conecte ao Ollama para comecar"
              }
              disabled={!isConnected || executingPlan}
              rows={2}
              className="w-full resize-none rounded-lg bg-secondary/50 border border-border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50 disabled:opacity-50"
            />
          </div>
          <div className="flex flex-col gap-1">
            {isLoading || executingPlan ? (
              <button
                type="button"
                onClick={handleStop}
                className="h-full px-3 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                title="Parar"
              >
                <StopCircle className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || !isConnected}
                className="h-full px-3 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                title="Enviar"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>

        {/* Connection status */}
        {!isConnected && (
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-destructive">
            <AlertTriangle className="h-3 w-3" />
            <span>Ollama desconectado. Verifique a conexao nas configuracoes.</span>
          </div>
        )}
      </div>
    </div>
  );
}
