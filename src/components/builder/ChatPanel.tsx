import { useState, useRef, useEffect, useMemo } from "react";
import { Send, Sparkles, Loader2, Plus, ThumbsUp, ThumbsDown, Play, CheckCircle2, FileCode, Eye, X, Download, ChevronRight, Bookmark, MessageSquare } from "lucide-react";
import { useOllama } from "@/contexts/OllamaContext";
import { chatStream, extractAllCodeBlocks, extractFileOperations, extractPlanSteps, pickModel } from "@/services/ollamaService";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";

interface TaskItem {
  title: string;
  files: string[];
  status: "pending" | "running" | "done" | "error";
  context?: string;
  editingFile?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isPlan?: boolean;
  planExecuted?: boolean;
  planPrompt?: string;
  tasks?: TaskItem[];
  isSummary?: boolean;
  editingFile?: string;
  editingDescription?: string;
}

type ChatMode = "agente" | "plano";

const PLAN_ONLY_SYSTEM_PROMPT = `Seu nome é Jonas. Você é um assistente de planejamento e consulta.
Sua função é APENAS analisar o contexto dos arquivos fornecidos e responder perguntas ou sugerir melhorias.
VOCÊ NÃO DEVE gerar blocos de código para execução ou operações de arquivo.
Sempre baseie suas respostas no contexto atual do projeto.`;

const PLAN_SYSTEM_PROMPT = `Você é um assistente especializado em React+TypeScript+Tailwind.
Quando o usuário descrever o que quer, responda APENAS com um plano estruturado de implementação.
NÃO gere código. Apenas descreva o que será feito.

O plano DEVE seguir este formato:

## Plano de Implementação

### Descrição
(breve resumo do que será feito)

### Arquivos a criar:
- caminho/completo/do/arquivo.tsx — descrição

### Arquivos a modificar:
- caminho/completo/do/arquivo.tsx — descrição das mudanças

### Arquivos a excluir:
- caminho/completo/do/arquivo.tsx — motivo

### Passos:
1. Passo 1
2. Passo 2
...

Use caminhos relativos como src/components/MeuComponente.tsx, src/pages/Index.tsx, etc.`;

const EXEC_SYSTEM_PROMPT = `Você é um assistente profissional especializado em React+TypeScript+Tailwind+Vite.
Antes de gerar código, analise TODOS os arquivos do projeto fornecidos no contexto para entender a estrutura, imports e dependências.

REGRAS OBRIGATÓRIAS:
- Retorne blocos de código completos, um por arquivo
- CADA bloco DEVE ter um comentário na PRIMEIRA linha com o caminho relativo: // src/components/MeuComponente.tsx
- Use \`\`\`tsx para blocos React/TypeScript, \`\`\`css para CSS, \`\`\`ts para TypeScript puro
- Cada arquivo deve ser COMPLETO e funcional (não use "// ... resto do código")
- Use apenas classes Tailwind e componentes funcionais React
- Sem dependências externas além de Tailwind
- Organize os arquivos seguindo a estrutura React/Vite: componentes em src/components/, páginas em src/pages/, estilos em src/, assets em public/
- Verifique os imports de cada arquivo e garanta que todos os caminhos estejam corretos
- Se modificar um componente usado por outros arquivos, gere TODOS os arquivos afetados com código completo
- Inclua App.tsx, index.html e outros arquivos essenciais se forem afetados pela mudança
- Gere cada arquivo COMPLETAMENTE, sem abreviações, sem omissões
- Use o máximo de tokens necessário para gerar código completo e funcional`;

// Step exec prompt reserved for future per-step generation

export function ChatPanel() {
  const { config, models, updateConfig, pushPreviewCode, setLastPrompt, lastPrompt, addVirtualFile, deleteVirtualFile, projectTemplate, setCurrentFile, virtualFiles, pendingErrorFix, setPendingErrorFix, chatSessions, currentChatId, setCurrentChatId, saveChatSession, loadChatSession, loadChatSessions, projectName } = useOllama();
  const [chatMode, setChatMode] = useState<ChatMode>("agente");
  
  const [agenteMessages, setAgenteMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem("chat-messages-agente");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      } catch (e) { void e; }
    }
    return [{
      id: "1",
      role: "assistant",
      content: "Olá! 👋 Eu sou o Agente. Posso criar componentes e modificar arquivos para você.",
      timestamp: new Date(),
    }];
  });

  const [planoMessages, setPlanoMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem("chat-messages-plano");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      } catch (e) { void e; }
    }
    return [{
      id: "1",
      role: "assistant",
      content: "Olá! 👋 Eu sou o modo Plano. Posso te ajudar a entender o código e planejar mudanças sem alterar nada.",
      timestamp: new Date(),
    }];
  });

  const messages = chatMode === "agente" ? agenteMessages : planoMessages;
  const setMessages = chatMode === "agente" ? setAgenteMessages : setPlanoMessages;

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [executingPlanId, setExecutingPlanId] = useState<string | null>(null);

  const [chatSessionsList, setChatSessionsList] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);

  // Load chat sessions list when project changes
  useEffect(() => {
    if (projectName) {
      loadChatSessions().then(() => {
        setChatSessionsList(chatSessions);
      });
    }
  }, [projectName]);

  // Keep local list in sync
  useEffect(() => {
    setChatSessionsList(chatSessions);
  }, [chatSessions]);

  // Auto-save current chat to project folder (debounced)
  useEffect(() => {
    if (!projectName || messages.length <= 1) return;
    const timer = setTimeout(() => {
      const chatId = currentChatId || `chat-${Date.now()}`;
      if (!currentChatId) setCurrentChatId(chatId);
      const firstUserMsg = messages.find(m => m.role === "user");
      const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : `Chat ${chatMode}`;
      saveChatSession(chatId, title, messages.map(m => ({ ...m, timestamp: m.timestamp.toISOString() })));
    }, 2000);
    return () => clearTimeout(timer);
  }, [messages, projectName, chatMode]);

  const startNewChat = () => {
    const newChatId = `chat-${Date.now()}`;
    setCurrentChatId(newChatId);
    const initialMessage: Message = {
      id: "1",
      role: "assistant",
      content: chatMode === "agente" 
        ? "Olá! 👋 Eu sou o Agente. Posso criar componentes e modificar arquivos para você."
        : "Olá! 👋 Eu sou o modo Plano. Posso te ajudar a entender o código e planejar mudanças sem alterar nada.",
      timestamp: new Date(),
    };
    setMessages([initialMessage]);
    setRatings({});
    localStorage.removeItem(`chat-ratings-${chatMode}`);
    // Refresh chat list
    loadChatSessions();
    toast({ title: `Novo chat (${chatMode}) iniciado`, duration: 2000 });
  };

  const clearChat = () => {
    setMessages([]);
    setRatings({});
    localStorage.removeItem(`chat-ratings-${chatMode}`);
    localStorage.removeItem(`chat-messages-${chatMode}`);
    toast({ title: `Chat ${chatMode} excluído`, duration: 2000 });
  };

  const handleLoadChat = async (chatId: string) => {
    const msgs = await loadChatSession(chatId);
    if (msgs) {
      const parsed = msgs.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      setMessages(parsed);
      toast({ title: "Chat carregado", duration: 2000 });
    }
  };

  const [ratings, setRatings] = useState<Record<string, "up" | "down" | null>>(() => {
    const raw = localStorage.getItem("chat-ratings");
    return raw ? (JSON.parse(raw) as Record<string, "up" | "down" | null>) : {};
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(
      `chat-messages-${chatMode}`,
      JSON.stringify(messages.map((m) => ({ ...m, timestamp: m.timestamp.toISOString() }))),
    );
  }, [messages, chatMode]);

  useEffect(() => {
    localStorage.setItem("chat-ratings", JSON.stringify(ratings));
  }, [ratings]);

  // Watch for pending error fix from PreviewPanel
  useEffect(() => {
    if (pendingErrorFix && !isLoading) {
      setInput(pendingErrorFix);
      setPendingErrorFix(null);
      // Auto-switch to agente mode and send
      setChatMode("agente");
      setTimeout(() => {
        const userMessage: Message = {
          id: Date.now().toString(),
          role: "user",
          content: pendingErrorFix,
          timestamp: new Date(),
        };
        setAgenteMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);
        setLastPrompt(pendingErrorFix);

        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "",
          timestamp: new Date(),
          isPlan: true,
          planExecuted: false,
          planPrompt: pendingErrorFix,
        };
        setAgenteMessages((prev) => [...prev, assistantMessage]);

        abortRef.current?.abort();
        abortRef.current = new AbortController();

        const projectContext = virtualFiles
          .map((f) => `--- ${f.path} ---\n${f.code}`)
          .join("\n\n");

        const cfgChat = { ...config, selectedModel: pickModel("chat", models.map((m) => m.name), config.selectedModel) };

        const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
          { role: "system", content: PLAN_SYSTEM_PROMPT },
          { role: "system", content: projectTemplate },
          { role: "system", content: `Contexto completo do projeto:\n\n${projectContext}` },
          { role: "user", content: pendingErrorFix },
        ];

        chatStream({
          config: cfgChat,
          messages: msgs,
          onToken: (t) => {
            setAgenteMessages((prev) =>
              prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: m.content + t } : m)),
            );
          },
          signal: abortRef.current.signal,
        }).finally(() => {
          setIsLoading(false);
          abortRef.current = null;
        });
      }, 100);
    }
  }, [pendingErrorFix]);

  const normalizeName = (text: string) => {
    const base = text.replace(/[^a-zA-Z0-9]+/g, " ").trim();
    const pascal = base
      .split(" ")
      .filter(Boolean)
      .map((s) => s[0]?.toUpperCase() + s.slice(1))
      .join("");
    return `${pascal || "GeneratedComponent"}.tsx`;
  };

  const routeFile = (fname: string) => {
    const f = fname.replace(/^[\\/]+/, "");
    if (f.includes("/") || f.includes("\\")) return f;
    const lower = f.toLowerCase();
    if (lower.endsWith(".svg") || lower.endsWith(".ico") || lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
      return `public/${f}`;
    }
    if (lower.endsWith(".css")) return `src/${f}`;
    if (lower.endsWith(".tsx")) {
      const base = f.replace(/\\/g, "/");
      const pages = ["index.tsx", "about.tsx", "contact.tsx"];
      if (pages.includes(lower) || /page\.tsx$/i.test(base)) return `src/pages/${f}`;
      return `src/components/${f}`;
    }
    if (lower.endsWith(".ts")) return `src/${f}`;
    return `src/${f}`;
  };

  // ── SEND: gera plano ──
  const handleSend = () => {
    if (!input.trim() || isLoading) return;

    if (!config.baseUrl) {
      toast({ title: "Configuração inválida", description: "Defina a URL do Ollama em Configurações.", variant: "destructive" });
      return;
    }
    if (!config.selectedModel) {
      toast({ title: "Selecione um modelo", description: "Escolha um modelo Ollama antes de enviar.", variant: "destructive" });
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setLastPrompt(userMessage.content);

    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isPlan: chatMode === "agente",
      planExecuted: false,
      planPrompt: userMessage.content,
    };
    setMessages((prev) => [...prev, assistantMessage]);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const systemPrompt = chatMode === "agente" ? PLAN_SYSTEM_PROMPT : PLAN_ONLY_SYSTEM_PROMPT;

    const MAX_CONTEXT_CHARS = 6000;
    const fileList = virtualFiles.map((f) => f.path).join(", ");
    const activeFile = virtualFiles.length > 0 ? virtualFiles[0] : undefined;
    const currentVf = activeFile;
    const projectContext = currentVf ? `--- ${currentVf.path} ---\n${currentVf.code.slice(0, MAX_CONTEXT_CHARS)}` : "";

    const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "system", content: projectTemplate },
      { role: "system", content: `Arquivos do projeto: ${fileList}` },
      ...(projectContext ? [{ role: "system" as const, content: `Contexto do arquivo ativo:\n\n${projectContext}` }] : []),
      ...messages.filter((m) => m.role === "user" || (m.role === "assistant" && !m.isPlan)).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage.content },
    ];

    const cfgChat = { ...config, selectedModel: pickModel("chat", models.map((m) => m.name), config.selectedModel) };

    chatStream({
      config: cfgChat,
      messages: msgs,
      onToken: (t) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: m.content + t } : m)),
        );
      },
      signal: abortRef.current.signal,
    })
      .then(async (full) => {
        let finalText = full;
        const fences = (finalText.match(/```/g) || []).length;
        if (fences % 2 === 1) {
          const contMsgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
            { role: "system", content: "Continue a resposta anterior e finalize. Retorne apenas o restante do plano." },
            { role: "assistant", content: finalText },
            { role: "user", content: "Continue" },
          ];
          let cont = "";
          await chatStream({
            config: cfgChat,
            messages: contMsgs,
            onToken: (t) => {
              cont += t;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: m.content + t } : m)),
              );
            },
          });
          finalText += cont;
        }
      })
      .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessage.id ? { ...m, content: `❌ Erro: ${errorMsg}` } : m
          ),
        );
        toast({
          title: "Erro ao conversar com o Ollama",
          description: errorMsg,
          variant: "destructive",
          duration: 5000,
        });
      })
      .finally(() => {
        setIsLoading(false);
        abortRef.current = null;
      });
  };

  // ── EXECUTAR PLANO COM TASKS ──
  const handleExecutePlan = async (planMessage: Message) => {
    if (!planMessage.planPrompt || executingPlanId) return;

    setExecutingPlanId(planMessage.id);

    const fileOps = extractFileOperations(planMessage.content);
    const planSteps = extractPlanSteps(planMessage.content);

    const tasks: TaskItem[] = planSteps.length > 0
      ? planSteps.map((s) => ({ title: s.title, files: s.files, status: "pending" as const }))
      : [{ title: "Gerar código completo", files: [], status: "pending" as const }];

    const taskMsg: Message = {
      id: Date.now().toString(),
      role: "assistant",
      content: "",
      timestamp: new Date(),
      tasks: [...tasks],
      editingFile: undefined,
      editingDescription: "Implementando alterações...",
    };
    setMessages((prev) => [...prev, taskMsg]);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const cfgChat = { ...config, selectedModel: pickModel("generate", models.map((m) => m.name), config.selectedModel) };

    const allCreated: string[] = [];
    const allModified: string[] = [];
    const allDeleted: string[] = [];
    const taskSummaries: Array<{ title: string; files: string[]; context: string }> = [];

    try {
      const updateTasks = (newTasks: TaskItem[], editingFile?: string, editingDesc?: string) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === taskMsg.id ? { ...m, tasks: [...newTasks], editingFile: editingFile || m.editingFile, editingDescription: editingDesc || m.editingDescription } : m)),
        );
      };

      for (let i = 0; i < tasks.length; i++) {
        const current = tasks[i];
        tasks.forEach((t, idx) => {
          if (idx < i) t.status = "done";
          else if (idx === i) t.status = "running";
          else t.status = "pending";
        });
        updateTasks(tasks);

        const relevant = new Set(current.files.map((f) => f.replace(/^[\\/]+/, "")));
        const stepContextList = virtualFiles.filter((vf) => relevant.has(vf.path));
        const stepContext = stepContextList.map((f) => `--- ${f.path} ---\n${f.code}`).join("\n\n");

        const execPrompt = `${planMessage.planPrompt}

Plano aprovado:
${planMessage.content}

Passo atual:
${current.title}

Arquivos focados:
${current.files.join("\n")}

Gere apenas os arquivos relacionados a este passo com código completo.
Cada bloco deve começar com o caminho do arquivo na primeira linha.
Não abrevie. Não gere arquivos fora do escopo do passo.`;

        const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
          { role: "system", content: EXEC_SYSTEM_PROMPT },
          { role: "system", content: projectTemplate },
          { role: "system", content: stepContext ? `Contexto dos arquivos relevantes:\n\n${stepContext}` : "Sem contexto de arquivos existentes para este passo." },
          { role: "user", content: execPrompt },
        ];

        let fullResponse = "";
        await chatStream({
          config: cfgChat,
          messages: msgs,
          onToken: (t) => {
            fullResponse += t;
            const fileCommentMatch = fullResponse.match(/\/\/\s*(src\/[^\s\n]+\.\w+)/g);
            if (fileCommentMatch) {
              const lastFile = fileCommentMatch[fileCommentMatch.length - 1].replace(/\/\/\s*/, "").trim();
              updateTasks(tasks, lastFile, `Gerando código para ${lastFile}`);
            }
          },
          signal: abortRef.current!.signal,
        });

        let fences = (fullResponse.match(/```/g) || []).length;
        let retries = 0;
        while (fences % 2 === 1 && retries < 3) {
          retries++;
          const contMsgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
            { role: "system", content: "Continue a resposta anterior e finalize apenas os blocos pendentes deste passo." },
            { role: "system", content: projectTemplate },
            { role: "assistant", content: fullResponse },
            { role: "user", content: "Continue." },
          ];
          await chatStream({
            config: cfgChat,
            messages: contMsgs,
            onToken: (t) => {
              fullResponse += t;
            },
          });
          fences = (fullResponse.match(/```/g) || []).length;
        }

        const blocks = extractAllCodeBlocks(fullResponse);
        blocks.forEach((b, idx) => {
          if (!b.code.trim()) return;
          const baseName = normalizeName((current.title || "Arquivo") + (idx > 0 ? ` ${idx + 1}` : ""));
          const fname = b.filename ?? baseName;
          const path = routeFile(fname);
          const needsHeader =
            !b.code.startsWith("//") &&
            !b.code.trimStart().toLowerCase().startsWith("<!--") &&
            !/^\s*\/\*/.test(b.code);
          const header =
            (b.lang || "").toLowerCase() === "html"
              ? `<!-- ${path} -->\n`
              : `// ${path}\n`;
          const codeWithHeader = needsHeader ? header + b.code : b.code;
          const existed = virtualFiles.some((f) => f.path === path);
          addVirtualFile(path, codeWithHeader, true);
          if (existed) allModified.push(path);
          else allCreated.push(path);
          if (idx === 0) {
            pushPreviewCode(codeWithHeader);
            setCurrentFile(path);
          }
        });

        const deletes = fileOps.delete.filter((f) => current.files.includes(f));
        for (const filePath of deletes) {
          if (virtualFiles.some((f) => f.path === filePath)) {
            deleteVirtualFile(filePath);
            allDeleted.push(filePath);
          }
        }

        tasks[i].status = "done";
        updateTasks(tasks);

        taskSummaries.push({
          title: current.title,
          files: current.files.length > 0 ? current.files : blocks.map((b) => routeFile(b.filename || normalizeName(current.title))),
          context: current.files.some((f) => allCreated.includes(f)) ? "Criado" : "Modificado",
        });

        await new Promise((r) => setTimeout(r, 2500));
      }

      // Build task summaries
      if (taskSummaries.length === 0) {
        const allFiles = [...allCreated, ...allModified];
        tasks.forEach((t) => {
          taskSummaries.push({
            title: t.title,
            files: t.files.length > 0 ? t.files : allFiles,
            context: allCreated.some((f) => (t.files.length > 0 ? t.files : allFiles).includes(f)) ? "Criado" : "Modificado",
          });
        });
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === planMessage.id ? { ...m, planExecuted: true } : m)),
      );

      const summaryMsg: Message = {
        id: (Date.now() + 2).toString(),
        role: "assistant",
        content: "",
        timestamp: new Date(),
        isSummary: true,
        planPrompt: planMessage.planPrompt,
        tasks: taskSummaries.map((ts) => ({
          title: ts.title,
          files: ts.files,
          status: "done" as const,
          context: ts.context,
        })),
      };

      setMessages((prev) => [...prev, summaryMsg]);

      toast({
        title: "Plano executado com sucesso",
        description: `${allCreated.length} criado(s), ${allModified.length} modificado(s), ${allDeleted.length} excluído(s)`,
        duration: 3000,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido";
      tasks.forEach((t) => {
        if (t.status === "running") t.status = "error";
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === taskMsg.id
            ? { ...m, tasks: [...tasks], content: `❌ Erro: ${errorMsg}` }
            : m
        ),
      );
      toast({
        title: "Erro na execução",
        description: errorMsg,
        variant: "destructive",
        duration: 4000,
      });
    } finally {
      setExecutingPlanId(null);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const [codeModal, setCodeModal] = useState<{ filename: string; code: string; lang: string } | null>(null);

  // ── RENDER: Code cards from message ──
  const renderCodeCards = (content: string) => {
    const blocks = extractAllCodeBlocks(content);
    if (blocks.length === 0) return null;
    return (
      <div className="mt-2 space-y-1.5">
        {blocks.map((b, i) => {
          const inferred = b.filename || routeFile(normalizeName((lastPrompt || "Bloco") + (i > 0 ? ` ${i + 1}` : "")));
          const displayName = inferred.replace(/^[\\/]+/, "");
          return (
            <div
              key={i}
              className="flex items-center gap-2 bg-muted/60 border border-border/50 rounded-md px-2.5 py-1.5 text-xs cursor-pointer hover:bg-muted transition-colors group"
              onClick={() => setCodeModal({ filename: displayName, code: b.code, lang: b.lang })}
            >
              <FileCode className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="font-mono text-muted-foreground truncate flex-1">{displayName}</span>
              <Eye className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </div>
          );
        })}
      </div>
    );
  };

  const estimateTokens = (text: string) => {
    const t = text ? text.trim().length : 0;
    return Math.max(0, Math.ceil(t / 4));
  };

  const totalTokens = useMemo(() => messages.reduce((acc, m) => acc + estimateTokens(m.content), 0), [messages]);
  const inputTokens = useMemo(() => estimateTokens(input), [input]);
  const assistantTokens = useMemo(() => messages.filter(m => m.role === "assistant").reduce((acc, m) => acc + estimateTokens(m.content), 0), [messages]);
  const maxAvail = Math.max(1, config.maxTokens || 8192);
  const usedTokens = Math.max(0, totalTokens + inputTokens);
  const pctUsed = Math.min(100, Math.round((usedTokens / maxAvail) * 100));
  const [tokensOpen, setTokensOpen] = useState(false);
  const [warnedHighTokens, setWarnedHighTokens] = useState(false);

  useEffect(() => {
    if (pctUsed >= 80 && !warnedHighTokens) {
      setTokensOpen(true);
      setWarnedHighTokens(true);
      toast({
        title: "Uso de tokens alto",
        description: `Você já usou ${pctUsed}% do limite de tokens.`,
        duration: 3500,
      });
    }
  }, [pctUsed, warnedHighTokens]);

  // ── Spinning SVG icon for running tasks ──
  const SpinnerIcon = () => (
    <svg className="h-4 w-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-80" d="M4 12a8 8 0 018-8" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );

  // ── RENDER: "Editando" card (top card during execution) ──
  const renderEditingCard = (msg: Message) => {
    if (!msg.editingFile) return null;
    return (
      <div className="rounded-xl border border-border bg-secondary/80 overflow-hidden mb-2">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-foreground">Editando</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-primary border border-border/50 truncate max-w-[140px]">
                {msg.editingFile}
              </span>
            </div>
            {msg.editingDescription && (
              <p className="text-[11px] text-muted-foreground leading-snug truncate">{msg.editingDescription}</p>
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>
      </div>
    );
  };

  // ── RENDER: Task list with status icons ──
  const renderTaskList = (tasksList: TaskItem[]) => {
    return (
      <div className="space-y-0.5 py-1">
        {tasksList.map((task, i) => (
          <div key={i} className="flex items-center gap-2.5 px-1 py-1.5">
            {task.status === "done" ? (
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="hsl(142 60% 45%)" />
                <path d="M8 12.5l2.5 2.5 5.5-5.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : task.status === "running" ? (
              <SpinnerIcon />
            ) : task.status === "error" ? (
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="hsl(var(--destructive))" />
                <path d="M8 8l8 8M16 8l-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="hsl(var(--muted-foreground))" strokeWidth="1.5" />
              </svg>
            )}
            <span className={`text-xs leading-snug ${
              task.status === "done" ? "text-foreground" :
              task.status === "running" ? "text-foreground" :
              task.status === "error" ? "text-destructive" :
              "text-muted-foreground"
            }`}>
              {task.title}
            </span>
          </div>
        ))}
      </div>
    );
  };

  // ── RENDER: Summary card (Lovable-style) ──
  const [summaryTab, setSummaryTab] = useState<Record<string, "details" | "preview">>({});

  const renderSummaryCard = (msg: Message) => {
    if (!msg.tasks || !msg.isSummary) return null;
    const tab = summaryTab[msg.id] || "details";
    const promptTitle = msg.planPrompt || msg.content || "Execução concluída";

    return (
      <div className="rounded-xl border border-border bg-secondary/80 overflow-hidden">
        {/* Card header */}
        <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2">
          <Bookmark className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <span className="text-sm font-medium text-foreground leading-snug flex-1">{promptTitle}</span>
        </div>

        {/* Completed tasks checkmarks */}
        <div className="px-3.5 pb-2 space-y-0.5">
          {msg.tasks.map((task, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="hsl(142 60% 45%)" />
                <path d="M8 12.5l2.5 2.5 5.5-5.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{task.title}</span>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex border-t border-border/50">
          <button
            onClick={() => setSummaryTab((prev) => ({ ...prev, [msg.id]: "details" }))}
            className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${
              tab === "details"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            Detalhes
          </button>
          <button
            onClick={() => setSummaryTab((prev) => ({ ...prev, [msg.id]: "preview" }))}
            className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${
              tab === "preview"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            Preview
          </button>
        </div>

        {/* Tab content */}
        {tab === "details" && (
          <div className="px-3.5 py-3 space-y-3">
            {msg.tasks.map((task, i) => (
              <div key={i} className="space-y-1">
                <div className="text-xs">
                  <span className="text-muted-foreground">{i + 1}. </span>
                  <strong className="text-foreground">{task.title}</strong>
                </div>
                {task.files.length > 0 && (
                  <div className="flex flex-wrap gap-1 ml-3">
                    {task.files.map((file, fi) => (
                      <span key={fi} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-primary border border-border/50">
                        {file}
                      </span>
                    ))}
                  </div>
                )}
                {task.context && (
                  <p className="text-[11px] text-muted-foreground ml-3">{task.context}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "preview" && (
          <div className="px-3.5 py-3">
            <p className="text-xs text-muted-foreground text-center">Visualize as alterações no painel de preview →</p>
          </div>
        )}
      </div>
    );
  };

  // Strip code blocks from text for display
  const stripCodeBlocks = (content: string) => {
    return content.replace(/```[\s\S]*?```/g, "").trim();
  };

  // Simple markdown-like rendering
  const renderContent = (content: string) => {
    return content.split("\n").map((line, i) => {
      if (line.startsWith("## ")) {
        return <h2 key={i} className="text-base font-bold mt-3 mb-1 text-primary">{line.replace("## ", "")}</h2>;
      }
      if (line.startsWith("### ")) {
        return <h3 key={i} className="text-sm font-semibold mt-2 mb-1 text-primary/80">{line.replace("### ", "")}</h3>;
      }
      if (line.startsWith("- ")) {
        const codeMatch = line.match(/`([^`]+)`/g);
        if (codeMatch) {
          const parts = line.replace("- ", "").split(/`([^`]+)`/);
          return (
            <div key={i} className="flex items-start gap-1.5 ml-2 text-xs">
              <span className="text-primary mt-0.5">•</span>
              <span>
                {parts.map((part, j) =>
                  j % 2 === 1 ? (
                    <code key={j} className="bg-muted px-1 py-0.5 rounded text-[11px] font-mono text-primary">{part}</code>
                  ) : (
                    <span key={j}>{part}</span>
                  )
                )}
              </span>
            </div>
          );
        }
        return (
          <div key={i} className="flex items-start gap-1.5 ml-2 text-xs">
            <span className="text-primary mt-0.5">•</span>
            <span>{line.replace("- ", "")}</span>
          </div>
        );
      }
      if (/^\d+\.\s/.test(line)) {
        return <div key={i} className="ml-2 text-xs">{line}</div>;
      }
      if (line.startsWith("**") && line.endsWith("**")) {
        return <div key={i} className="font-semibold text-sm mt-1">{line.replace(/\*\*/g, "")}</div>;
      }
      if (line.includes("**")) {
        const parts = line.split(/\*\*([^*]+)\*\*/);
        return (
          <div key={i} className="text-xs">
            {parts.map((part, j) =>
              j % 2 === 1 ? <strong key={j}>{part}</strong> : <span key={j}>{part}</span>
            )}
          </div>
        );
      }
      return <div key={i} className="text-xs">{line}</div>;
    });
  };

  return (
    <div className="h-full flex flex-col bg-chat-bg">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border flex flex-col gap-2 bg-card/30">
        <div className="flex items-center justify-between">
          <div />
          <div className="flex items-center gap-1">
            <button
              onClick={startNewChat}
              className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
              title="Novo Chat"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              onClick={clearChat}
              className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Excluir Histórico"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <div className="flex-1">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                  {chatMode === "agente" ? "Modo Execução" : "Modo Consulta"}
                </span>
              </div>
              <div className="w-full max-w-[280px]">
                <Select
                  value={config.selectedModel || undefined}
                  onValueChange={(v) => {
                    updateConfig({ selectedModel: v });
                    try {
                      const raw = localStorage.getItem("ollama-task-models");
                      const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
                      map["chat"] = v;
                      localStorage.setItem("ollama-task-models", JSON.stringify(map));
                    } catch (e) { void e; }
                  }}
                >
                  <SelectTrigger className="h-7 text-[11px] bg-secondary/30 border-none w-full">
                    <SelectValue placeholder="Modelo" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.name} value={m.name} className="text-xs">
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="h-px bg-border/60 my-2 w-full max-w-[320px]" />
              <div className="w-full max-w-[320px] flex items-start gap-2">
                <Collapsible open={tokensOpen} onOpenChange={setTokensOpen}>
                  <CollapsibleTrigger className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2">
                    Detalhes de tokens
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2">
                    <div className="rounded-md border border-border/60 bg-secondary/40 p-2 space-y-1.5">
                      <div className="flex items-center justify-between text-[12px] text-foreground">
                        <span className="font-medium">Uso: <span className="font-mono">{usedTokens}/{maxAvail}</span></span>
                        <span className="font-semibold">{pctUsed}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Progress value={pctUsed} className="h-1.5 bg-primary/10" />
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 text-[11px] text-muted-foreground pt-0.5">
                        <div>Assist: <span className="font-mono">{assistantTokens}</span></div>
                        <div>Entrada: <span className="font-mono">{inputTokens}</span></div>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
                <div className="ml-auto">
                  <Select
                    value={currentChatId || ""}
                    onValueChange={(v) => {
                      if (v === "__new__") {
                        startNewChat();
                      } else {
                        handleLoadChat(v);
                      }
                    }}
                  >
                    <SelectTrigger className="h-6 text-[10px] bg-secondary/30 border-border/50 w-[120px] px-2">
                      <MessageSquare className="h-3 w-3 mr-1 shrink-0" />
                      <SelectValue placeholder="Histórico" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__new__" className="text-xs">
                        + Novo Chat
                      </SelectItem>
                      {chatSessionsList.map((session) => (
                        <SelectItem key={session.id} value={session.id} className="text-xs">
                          <span className="truncate max-w-[140px] block">{session.title}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>
          <div />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`animate-slide-up ${msg.role === "user" ? "flex justify-end" : ""}`}
          >
            {/* Task-only messages (editing card + task list) */}
            {msg.tasks && !msg.isSummary ? (
              <div className="max-w-[90%] space-y-1">
                {renderEditingCard(msg)}
                {renderTaskList(msg.tasks)}
                {msg.content && (
                  <div className="mt-2 text-xs text-destructive">{msg.content}</div>
                )}
              </div>
            ) : msg.isSummary && msg.tasks ? (
              /* Summary card */
              <div className="max-w-[90%]">
                {renderSummaryCard(msg)}
              </div>
            ) : (
              /* Regular message bubble */
              <div
                className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-card-foreground"
                }`}
              >
                <div className="whitespace-pre-wrap break-words">
                  {msg.isPlan
                    ? renderContent(msg.content)
                    : msg.content.includes("```")
                      ? renderContent(stripCodeBlocks(msg.content))
                      : msg.content}
                </div>

                {/* Code block cards */}
                {msg.role === "assistant" && !msg.isPlan && renderCodeCards(msg.content)}

                {/* Botão Executar Plano */}
                {msg.isPlan && !msg.planExecuted && msg.content.length > 0 && !isLoading && (
                  <div className="mt-3 pt-2 border-t border-border/50">
                    <Button
                      onClick={() => handleExecutePlan(msg)}
                      disabled={executingPlanId !== null}
                      className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white"
                      size="sm"
                    >
                      {executingPlanId === msg.id ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Executando...
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4" />
                          Executar Plano
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {/* Badge plano executado */}
                {msg.isPlan && msg.planExecuted && (
                  <div className="mt-3 pt-2 border-t border-border/50">
                    <div className="flex items-center gap-1.5 text-xs text-green-500">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Plano executado
                    </div>
                  </div>
                )}

                {/* Ratings */}
                {msg.role === "assistant" && msg.content.length > 0 && !msg.isPlan && !msg.tasks && (
                  <div className="mt-2 flex items-center gap-1">
                    <button
                      onClick={() =>
                        setRatings((prev) => ({ ...prev, [msg.id]: prev[msg.id] === "up" ? null : "up" }))
                      }
                      className={`p-1 rounded ${ratings[msg.id] === "up" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                      title="Gostei"
                    >
                      <ThumbsUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        setRatings((prev) => ({ ...prev, [msg.id]: prev[msg.id] === "down" ? null : "down" }))
                      }
                      className={`p-1 rounded ${ratings[msg.id] === "down" ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                      title="Não gostei"
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-end">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-black/20 text-primary hover:bg-black/30 transition-colors cursor-default">
                          <Sparkles className="h-3 w-3" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="font-mono text-xs">{estimateTokens(msg.content)} tokens</span>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="space-y-2">
            <div className="animate-slide-up">
              <div className="bg-secondary rounded-lg px-3.5 py-2.5 text-sm inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Gerando plano...</span>
              </div>
            </div>
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3 w-32" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Code Modal */}
      {codeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setCodeModal(null)}>
          <div className="bg-background border border-border rounded-xl shadow-2xl w-[90vw] max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <FileCode className="h-4 w-4 text-primary" />
                <span className="text-sm font-mono font-medium text-foreground">{codeModal.filename}</span>
              </div>
              <button onClick={() => setCodeModal(null)} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-[12px] font-mono leading-relaxed text-foreground whitespace-pre-wrap break-words">{codeModal.code}</pre>
            </div>
            <div className="px-4 py-3 border-t border-border flex justify-end">
              <Button
                size="sm"
                className="gap-2"
                onClick={() => {
                  const path = routeFile(codeModal.filename);
                  addVirtualFile(path, codeModal.code, true);
                  pushPreviewCode(codeModal.code);
                  setCurrentFile(path);
                  toast({ title: "Arquivo aplicado", description: `${path} substituído com sucesso`, duration: 2000 });
                  setCodeModal(null);
                }}
              >
                <Download className="h-3.5 w-3.5" />
                Aplicar ao arquivo
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-3 pb-3 pt-1">
        <div className="relative bg-secondary rounded-xl border border-border focus-within:border-primary/50 focus-within:glow-primary transition-all">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Descreva o que você quer construir..."
            rows={2}
            className="w-full bg-transparent px-4 pt-3 pb-10 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none"
          />
          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-1.5 bg-secondary/60 px-1 py-0.5 rounded-md border border-border/60">
              <button
                onClick={() => setChatMode("plano")}
                className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all ${
                  chatMode === "plano"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Plano
              </button>
              <button
                onClick={() => setChatMode("agente")}
                className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all ${
                  chatMode === "agente"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Agente
              </button>
            </div>
            <div className="hidden sm:flex items-center gap-1 w-36 mx-2">
              <Progress value={pctUsed} className="h-1 bg-emerald-500/10" />
              <span className="text-[10px] text-muted-foreground">{pctUsed}%</span>
            </div>
            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading || executingPlanId !== null}
              className="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
