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
  ShieldCheck,
  GitBranch,
  Zap,
  Eye,
  Info,
} from "lucide-react";
import { useOllama } from "@/contexts/OllamaContext";
import {
  chatStream,
  extractAllCodeBlocks,
  extractFileOperations,
  extractPlanSteps,
} from "@/services/ollamaService";
import { toast } from "@/components/ui/use-toast";
import {
  scanProject,
  analyzeImpact,
  generateDiffSummary,
  type ProjectMetadata,
} from "@/services/projectScanner";
import {
  buildPlanningPrompt,
  buildExecutionPrompt,
  getSystemLimitations,
  getActiveSkills,
} from "@/services/skillsRegistry";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  plan?: PlanData;
  validation?: ValidationResult;
}

interface PlanData {
  raw: string;
  steps: Array<{ title: string; files: string[] }>;
  fileOps: { create: string[]; modify: string[]; delete: string[] };
  status?: "idle" | "approved" | "running" | "done" | "error" | "rejected";
  stepStatus?: Array<"pending" | "running" | "done" | "error">;
  impactAnalysis?: {
    cascadeFiles: string[];
    warnings: string[];
  };
  diffSummaries?: string[];
}

interface ValidationResult {
  passed: boolean;
  checks: Array<{
    name: string;
    status: "ok" | "warn" | "error";
    message: string;
  }>;
}

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
  if (block.filename && (block.filename.includes("/") || block.filename.includes("\\"))) {
    return block.filename.replace(/^[\\/]+/, "");
  }

  if (block.filename) {
    const baseName = block.filename.split("/").pop() || block.filename;
    const allPlanFiles = [...planCreateFiles, ...planModifyFiles, ...stepFiles];
    const match = allPlanFiles.find((f) => f.endsWith("/" + baseName) || f === baseName);
    if (match) return match;
    return routeFileFn(baseName);
  }

  const allCandidates = stepFiles.length > 0
    ? [...stepFiles]
    : [...planCreateFiles, ...planModifyFiles];

  const exportMatch = block.code.match(/export\s+default\s+function\s+(\w+)/);
  const exportName = exportMatch?.[1];
  if (exportName) {
    const found = allCandidates.find((f) => {
      const fBase = f.split("/").pop()?.replace(/\.\w+$/, "") || "";
      return fBase.toLowerCase() === exportName.toLowerCase();
    });
    if (found && !resolvedSoFar.has(found)) return found;
  }

  const namedExport = block.code.match(/export\s+(?:const|function)\s+(\w+)/);
  const namedName = namedExport?.[1];
  if (namedName) {
    const found = allCandidates.find((f) => {
      const fBase = f.split("/").pop()?.replace(/\.\w+$/, "") || "";
      return fBase.toLowerCase() === namedName.toLowerCase();
    });
    if (found && !resolvedSoFar.has(found)) return found;
  }

  for (const f of allCandidates) {
    if (!resolvedSoFar.has(f)) return f;
  }

  return routeFileFn("GeneratedComponent.tsx");
}

/* ------------------------------------------------------------------ */
/* Route file to the proper directory based on extension/type          */
/* ------------------------------------------------------------------ */
function routeFile(filename: string): string {
  if (filename.includes("/") || filename.includes("\\")) {
    return filename.replace(/^[\\/]+/, "");
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".css")) return `src/${filename}`;
  if (lower === "index.html") return filename;
  if (lower.endsWith(".html")) return filename;
  if (lower.endsWith(".json")) return filename;
  if (lower.endsWith(".md")) return filename;
  if (/\.(tsx|jsx|ts)$/.test(lower)) return `src/components/${filename}`;
  return `src/${filename}`;
}

/* ------------------------------------------------------------------ */
/* Post-processing: validate generated code blocks                    */
/* ------------------------------------------------------------------ */
function validateCodeBlocks(
  blocks: Array<{ filename?: string; code: string; lang: string }>,
  plan: PlanData,
): ValidationResult {
  const checks: ValidationResult["checks"] = [];

  // Check 1: All planned files have corresponding blocks
  const allPlanFiles = [...plan.fileOps.create, ...plan.fileOps.modify];
  const blockFileNames = blocks
    .map((b) => b.filename)
    .filter(Boolean) as string[];
  const missingFiles = allPlanFiles.filter(
    (pf) =>
      !blockFileNames.some(
        (bf) => bf === pf || bf.endsWith("/" + pf.split("/").pop()),
      ),
  );
  if (missingFiles.length > 0) {
    checks.push({
      name: "Arquivos do plano",
      status: "warn",
      message: `Arquivos planejados nao gerados: ${missingFiles.join(", ")}`,
    });
  } else {
    checks.push({
      name: "Arquivos do plano",
      status: "ok",
      message: `Todos os ${allPlanFiles.length} arquivos planejados foram gerados`,
    });
  }

  // Check 2: No truncated code
  for (const block of blocks) {
    const hasEllipsis =
      block.code.includes("// ... resto") ||
      block.code.includes("// ...rest") ||
      block.code.includes("/* ... */") ||
      block.code.includes("// ... existing");
    if (hasEllipsis) {
      checks.push({
        name: "Codigo truncado",
        status: "error",
        message: `${block.filename || "Bloco"} contem codigo abreviado/truncado`,
      });
    }
  }

  // Check 3: Each block has filepath comment
  for (const block of blocks) {
    if (!block.filename) {
      const firstLine = block.code.split("\n")[0] || "";
      const hasComment =
        firstLine.startsWith("//") || firstLine.startsWith("<!--");
      if (!hasComment) {
        checks.push({
          name: "Caminho de arquivo",
          status: "warn",
          message: "Um bloco nao possui comentario com caminho do arquivo",
        });
      }
    }
  }

  // Check 4: Import consistency
  for (const block of blocks) {
    if (!block.code.includes("import") && /\.(tsx|jsx)$/.test(block.filename || "")) {
      // A React component without imports is suspicious
      const hasJSX = /<\w/.test(block.code);
      if (hasJSX) {
        checks.push({
          name: "Imports",
          status: "warn",
          message: `${block.filename || "Bloco"} parece usar JSX mas nao importa React`,
        });
      }
    }
  }

  if (checks.filter((c) => c.status === "error").length === 0 &&
      checks.filter((c) => c.status === "warn").length === 0) {
    checks.push({
      name: "Validacao geral",
      status: "ok",
      message: "Todos os blocos passaram na validacao",
    });
  }

  return {
    passed: checks.every((c) => c.status !== "error"),
    checks,
  };
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
  const [showImpact, setShowImpact] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Camada 2 & 4: Cached project metadata (re-scanned on file changes)
  const projectMeta = useMemo<ProjectMetadata>(() => {
    return scanProject(virtualFiles);
  }, [virtualFiles]);

  // Camada 3: Active skills for this project
  const activeSkills = useMemo(() => {
    return getActiveSkills(projectMeta);
  }, [projectMeta]);

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
  /* Camada 4: Build enriched context string from project metadata    */
  /* ---------------------------------------------------------------- */
  const projectContext = useMemo(() => {
    const relevantFiles = virtualFiles.filter(
      (f) =>
        /\.(tsx|ts|jsx|js|css|html|json)$/i.test(f.path) &&
        !f.path.includes("node_modules") &&
        !f.path.includes(".builderai/"),
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
  /* Camada 1 + 4 + 5: Handle send message (enriched pipeline)       */
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
      // Camada 4: Build multi-layer contextualized system prompt
      const planningInstructions = buildPlanningPrompt(projectMeta);
      const limitations = getSystemLimitations();
      const skillsSummary = activeSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n");

      const systemPrompt = [
        `Voce e um arquiteto de software inteligente. Analise TUDO antes de planejar.`,
        "",
        "=== DIAGNOSTICO DO PROJETO ===",
        projectMeta.summary,
        "",
        "=== SKILLS ATIVAS ===",
        skillsSummary,
        "",
        "=== INSTRUCOES DE PLANEJAMENTO ===",
        planningInstructions,
        "",
        "=== LIMITACOES ===",
        limitations,
        "",
        "=== TEMPLATE DO PROJETO ===",
        projectTemplate,
        "",
        projectContext,
      ].join("\n");

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

      // Camada 5: Impact analysis before approval
      let impactAnalysis: PlanData["impactAnalysis"] = undefined;
      if (hasPlan) {
        const impact = analyzeImpact(
          projectMeta,
          [...fileOps.create, ...fileOps.modify],
          fileOps.delete,
        );
        if (impact.cascadeFiles.length > 0 || impact.warnings.length > 0) {
          impactAnalysis = impact;
        }
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: full,
        plan: hasPlan
          ? {
              raw: full,
              steps,
              fileOps,
              status: "idle", // Camada 6: Starts as idle, needs approval
              stepStatus: steps.map(() => "pending" as const),
              impactAnalysis,
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
          content: streamText + "\n\n*(Geracao cancelada)*",
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
  /* Camada 6: Approve plan                                           */
  /* ---------------------------------------------------------------- */
  const handleApprovePlan = (msgIndex: number) => {
    setMessages((prev) => {
      const copy = [...prev];
      const m = { ...copy[msgIndex] };
      m.plan = { ...m.plan!, status: "approved" };
      copy[msgIndex] = m;
      return copy;
    });
    // Immediately start execution after approval
    setTimeout(() => handleExecutePlan(msgIndex), 100);
  };

  /* ---------------------------------------------------------------- */
  /* Camada 6: Reject plan                                            */
  /* ---------------------------------------------------------------- */
  const handleRejectPlan = (msgIndex: number) => {
    setMessages((prev) => {
      const copy = [...prev];
      const m = { ...copy[msgIndex] };
      m.plan = { ...m.plan!, status: "rejected" };
      copy[msgIndex] = m;
      return copy;
    });
    toast({
      title: "Plano rejeitado",
      description: "Descreva as alteracoes que deseja no plano.",
    });
  };

  /* ---------------------------------------------------------------- */
  /* Camada 7: Execute plan (intelligent execution)                   */
  /* ---------------------------------------------------------------- */
  const handleExecutePlan = async (msgIndex: number) => {
    const msg = messages[msgIndex];
    if (!msg?.plan || executingPlan) return;

    const plan = msg.plan;
    setExecutingPlan(true);

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
    const allDiffs: string[] = [];

    try {
      // Camada 7: Build execution prompt with full skills context
      const executionInstructions = buildExecutionPrompt(projectMeta);

      for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];

        updatePlan({
          stepStatus: plan.steps.map((_, i) =>
            i < si ? "done" : i === si ? "running" : "pending",
          ),
        });

        const isDeletionStep =
          step.title.toLowerCase().includes("excluir") ||
          step.title.toLowerCase().includes("remover") ||
          step.title.toLowerCase().includes("delete");
        if (isDeletionStep && plan.fileOps.delete.length > 0) {
          continue;
        }

        // Build execution context with file contents
        const stepFilesContent: string[] = [];
        const filesToInclude =
          step.files.length > 0
            ? step.files
            : [...plan.fileOps.create, ...plan.fileOps.modify];

        for (const fp of filesToInclude) {
          const existing = virtualFiles.find((f) => f.path === fp);
          if (existing) {
            stepFilesContent.push(
              `--- CONTEUDO ATUAL DE ${fp} ---\n\`\`\`\n${existing.code}\n\`\`\``,
            );
          }
        }

        // Camada 7: Include cascade files in context
        const cascadeFiles = plan.impactAnalysis?.cascadeFiles || [];
        for (const cf of cascadeFiles) {
          const existing = virtualFiles.find((f) => f.path === cf);
          if (existing && !stepFilesContent.some((s) => s.includes(cf))) {
            stepFilesContent.push(
              `--- ARQUIVO DEPENDENTE (pode precisar de atualizacao) ${cf} ---\n\`\`\`\n${existing.code}\n\`\`\``,
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
          cascadeFiles.length > 0
            ? `Arquivos em CASCATA (verificar imports): ${cascadeFiles.join(", ")}`
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

        const systemPrompt = `${executionInstructions}\n\n${projectTemplate}\n${projectContext}`;

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

        // Camada 8: Process and validate code blocks
        const blocks = extractAllCodeBlocks(stepResponse);
        const resolvedInThisStep = new Set<string>();

        // Post-process validation
        const validation = validateCodeBlocks(blocks, plan);
        if (!validation.passed) {
          const errorChecks = validation.checks
            .filter((c) => c.status === "error")
            .map((c) => c.message);
          allErrors.push(
            `Passo ${si + 1} validacao: ${errorChecks.join("; ")}`,
          );
        }

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

          // Generate diff summary before applying
          const existingFile = virtualFiles.find(
            (f) => f.path === resolvedPath,
          );
          if (existingFile) {
            const diff = generateDiffSummary(
              existingFile.code,
              block.code,
              resolvedPath,
            );
            allDiffs.push(diff);
          }

          const exists = virtualFiles.some((f) => f.path === resolvedPath);
          addVirtualFile(resolvedPath, block.code, true);

          if (exists) {
            if (!allModified.includes(resolvedPath))
              allModified.push(resolvedPath);
          } else {
            if (!allCreated.includes(resolvedPath))
              allCreated.push(resolvedPath);
          }
        }
      }

      // Handle deletions
      if (plan.fileOps.delete.length > 0) {
        for (const filePath of plan.fileOps.delete) {
          const exists = virtualFiles.some((f) => f.path === filePath);
          if (exists) {
            deleteVirtualFile(filePath);
            allDeleted.push(filePath);
          }
          try {
            const pName = projectName || "";
            if (pName) {
              await fetch("http://localhost:3001/delete-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectName: pName, filePath }),
              }).catch(() => {});
            }
          } catch {
            // Ignore remote delete errors
          }
        }
      }

      // Update final status with diffs
      updatePlan({
        status: allErrors.length > 0 ? "error" : "done",
        diffSummaries: allDiffs,
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

      // Camada 9: Summary with validation and diff info
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
      if (allDiffs.length > 0)
        summaryParts.push(`\nResumo de alteracoes:\n${allDiffs.join("\n")}`);
      if (allErrors.length > 0)
        summaryParts.push(`\nErros: ${allErrors.join("; ")}`);

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
      const executionInstructions = buildExecutionPrompt(projectMeta);
      const systemPrompt = `${executionInstructions}\n\n${projectTemplate}\n${projectContext}`;

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
    setShowImpact(null);
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
  /* Render plan UI with approval system (Camada 6)                   */
  /* ---------------------------------------------------------------- */
  const renderPlan = (plan: PlanData, msgIdx: number) => {
    const isExpanded = expandedPlan === msgIdx;
    const isImpactExpanded = showImpact === msgIdx;
    const hasImpact = plan.impactAnalysis && (
      plan.impactAnalysis.cascadeFiles.length > 0 ||
      plan.impactAnalysis.warnings.length > 0
    );

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
            {plan.status === "approved" && (
              <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
            )}
            {plan.status === "rejected" && (
              <XCircle className="h-3.5 w-3.5 text-yellow-500" />
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

            {/* Impact analysis (Camada 5) */}
            {hasImpact && (
              <div className="space-y-1">
                <button
                  onClick={() => setShowImpact(isImpactExpanded ? null : msgIdx)}
                  className="flex items-center gap-1.5 text-[10px] font-medium text-amber-600 hover:text-amber-500 transition-colors"
                >
                  <GitBranch className="h-3 w-3" />
                  <span>Analise de Impacto</span>
                  {isImpactExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
                {isImpactExpanded && (
                  <div className="bg-amber-500/10 rounded px-2 py-1.5 text-[10px] space-y-1">
                    {plan.impactAnalysis!.warnings.map((w, wi) => (
                      <div key={wi} className="flex items-start gap-1 text-amber-600">
                        <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                        <span>{w}</span>
                      </div>
                    ))}
                    {plan.impactAnalysis!.cascadeFiles.length > 0 && (
                      <div className="text-muted-foreground">
                        <span className="font-semibold">Arquivos em cascata:</span>{" "}
                        {plan.impactAnalysis!.cascadeFiles.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

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

            {/* Diff summaries (post-execution) */}
            {plan.diffSummaries && plan.diffSummaries.length > 0 && (
              <div className="bg-secondary/50 rounded px-2 py-1.5 text-[10px] space-y-0.5">
                <div className="font-semibold text-muted-foreground flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  Resumo de alteracoes:
                </div>
                {plan.diffSummaries.map((d, di) => (
                  <div key={di} className="text-muted-foreground font-mono">
                    {d}
                  </div>
                ))}
              </div>
            )}

            {/* Camada 6: Approval buttons */}
            {plan.status === "idle" && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleApprovePlan(msgIdx)}
                  disabled={executingPlan || !isConnected}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Aprovar e Executar
                </button>
                <button
                  onClick={() => handleRejectPlan(msgIdx)}
                  disabled={executingPlan}
                  className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Rejeitar
                </button>
              </div>
            )}

            {/* Re-execute for error */}
            {plan.status === "error" && (
              <button
                onClick={() => handleApprovePlan(msgIdx)}
                disabled={executingPlan || !isConnected}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Re-executar Plano
              </button>
            )}

            {/* Rejected status */}
            {plan.status === "rejected" && (
              <div className="flex items-center gap-1.5 text-[10px] text-yellow-600 px-2">
                <Info className="h-3 w-3" />
                <span>Plano rejeitado. Descreva as alteracoes desejadas na proxima mensagem.</span>
              </div>
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
          {/* Skills indicator */}
          <div
            className="p-1.5 rounded-md text-muted-foreground"
            title={`Skills ativas: ${activeSkills.map((s) => s.name).join(", ")}`}
          >
            <Zap className="h-3.5 w-3.5" />
          </div>
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

      {/* Project context indicator */}
      {virtualFiles.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-secondary/20 text-[10px] text-muted-foreground">
          <FileText className="h-3 w-3" />
          <span>
            {virtualFiles.length} arquivos | {projectMeta.components.length} componentes | {activeSkills.length} skills ativas
          </span>
          {projectMeta.patterns.hasTailwind && (
            <span className="bg-cyan-500/10 text-cyan-600 px-1.5 py-0.5 rounded">Tailwind</span>
          )}
          {projectMeta.patterns.hasTypeScript && (
            <span className="bg-blue-500/10 text-blue-600 px-1.5 py-0.5 rounded">TS</span>
          )}
          {projectMeta.patterns.routerType && (
            <span className="bg-purple-500/10 text-purple-600 px-1.5 py-0.5 rounded">{projectMeta.patterns.routerType}</span>
          )}
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
              O sistema analisa seu projeto, gera um plano e aguarda sua aprovacao antes de executar.
            </p>
            {activeSkills.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3 justify-center">
                {activeSkills.slice(0, 5).map((s) => (
                  <span
                    key={s.id}
                    className="text-[10px] bg-secondary px-2 py-0.5 rounded-full text-muted-foreground"
                  >
                    {s.name}
                  </span>
                ))}
              </div>
            )}
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
