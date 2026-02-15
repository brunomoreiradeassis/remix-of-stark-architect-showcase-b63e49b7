import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Settings,
  Play,
  Code,
  Eye,
  Layers,
  Server,
  FolderOpen,
  History,
  Terminal as TerminalIcon,
  Zap,
  PanelLeftOpen,
} from "lucide-react";
import { useOllama } from "@/contexts/OllamaContext";
import { OllamaSettings } from "./OllamaSettings";
import { RecentProjectsModal } from "./RecentProjectsModal";
import { FileSidebar } from "./FileSidebar";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/use-toast";

interface TopToolbarProps {
  view: "preview" | "code";
  onViewChange: (view: "preview" | "code") => void;
}

export function TopToolbar({ view, onViewChange }: TopToolbarProps) {
  const { isConnected, isChecking, config, latencyMs, openDirectory, dirHandle, projectPath, devServerPort } = useOllama();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [command, setCommand] = useState("pnpm run dev");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef("");
  const ansiRegex = useRef(/\x1B\[[0-?]*[ -/]*[@-~]/g);

  const derivedCwd = useMemo(() => {
    if (projectPath && projectPath.trim().length > 0) return projectPath;
    if (dirHandle?.name) {
      return `d:\\AI-Projetos\\BuilderAI\\Projetos\\${dirHandle.name}`;
    }
    return null;
  }, [projectPath, dirHandle]);

  useEffect(() => {
    const ping = async () => {
      try {
        const r = await fetch("http://localhost:3001/status").catch(() => null);
        setServerOnline(!!r?.ok);
      } catch {
        setServerOnline(false);
      }
    };
    ping();
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  const exec = async () => {
    if (!command.trim()) return;
    if (serverOnline === false) {
      toast({ title: "Executor offline", description: "Inicie: node scripts/command-server.cjs", variant: "destructive" });
      return;
    }
    if (!derivedCwd) {
      toast({ title: "Projeto não selecionado", description: "Abra uma pasta via 'Abrir Pasta' para sincronizar em Projetos/", variant: "destructive" });
      return;
    }
    setOutput("");
    setRunning(true);
    try {
      const cwd = derivedCwd;
      const res = await fetch("http://localhost:3001/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, cwd })
      });
      if (!res.ok || !res.body) throw new Error("Falha ao iniciar execução");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        bufferRef.current += chunk;
        const lines = bufferRef.current.split(/\r?\n/);
        bufferRef.current = lines.pop() || "";
        const cleaned = lines
          .map((l) => {
            l = l.replace(ansiRegex.current, "");
            const urlMatch = l.match(/http:\/\/localhost:(\d{2,5})/i);
            if (urlMatch) {
              const url = `http://localhost:${urlMatch[1]}/`;
              localStorage.setItem("last-preview-url", url);
              window.dispatchEvent(new StorageEvent("storage", { key: "last-preview-url", newValue: url }));
            }
            if (l.startsWith("STDOUT:")) return l.replace(/^STDOUT:\s?/, "");
            if (l.startsWith("STDERR:")) return l.replace(/^STDERR:\s?/, "");
            if (l.startsWith("CLOSE:")) {
              const code = l.replace(/^CLOSE:\s?/, "").trim();
              return `\n[Processo finalizado: código ${code}]`;
            }
            return l;
          })
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");
        if (cleaned.trim().length > 0) {
          setOutput(prev => (prev ? prev + "\n" : "") + cleaned);
        }
      }
      if (bufferRef.current) {
        const tail = bufferRef.current
          .replace(ansiRegex.current, "")
          .replace(/^STDOUT:\s?/, "")
          .replace(/^STDERR:\s?/, "");
        const finalTail = tail.replace(/\n{3,}/g, "\n\n");
        if (finalTail.trim().length > 0) setOutput(prev => (prev ? prev + "\n" : "") + finalTail);
        bufferRef.current = "";
      }
    } catch (e: any) {
      setOutput(prev => prev + "\nERROR: " + (e?.message || "Falha desconhecida"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <header className="h-12 flex items-center justify-between px-4 bg-toolbar-bg border-b border-border shrink-0">
        {/* Logo & Project Name */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-5 w-5 text-primary" />
            <span className="text-sm font-bold tracking-tight text-foreground">
              BuilderAI
            </span>
          </div>
          <div className="h-4 w-px bg-border" />
          <span
            className="text-xs text-muted-foreground font-mono truncate max-w-[180px]"
            title={projectPath || dirHandle?.name || "meu-projeto"}
          >
            {(() => {
              if (projectPath) {
                const parts = projectPath.replace(/\\+/g, "/").split("/");
                return parts[parts.length - 1] || parts[parts.length - 2] || projectPath;
              }
              return dirHandle ? dirHandle.name : "meu-projeto";
            })()}
          </span>
          {config.selectedModel && (
            <Badge variant="secondary" className="ml-2 hidden sm:flex">
              {config.selectedModel}
            </Badge>
          )}
        </div>

        {/* View Toggle */}
        <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
          <button
            onClick={() => onViewChange("preview")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
              view === "preview"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Preview</span>
          </button>
          <button
            onClick={() => onViewChange("code")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
              view === "code"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Code className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Código</span>
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {devServerPort && (
            <button
              onClick={() => {
                const url = `http://localhost:${devServerPort}/`;
                onViewChange("preview");
                localStorage.setItem("last-preview-url", url);
                window.dispatchEvent(new StorageEvent("storage", { key: "last-preview-url", newValue: url }));
              }}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
              title={`localhost:${devServerPort}`}
            >
              <Zap className="h-3.5 w-3.5" />
              localhost:{devServerPort}
            </button>
          )}

          {/* Open Folder Button */}
          <button
            onClick={openDirectory}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              dirHandle 
                ? "bg-primary/10 text-primary hover:bg-primary/20" 
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
            title={dirHandle ? `Pasta: ${dirHandle.name}` : "Abrir Pasta Local"}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{dirHandle ? "Pasta Aberta" : "Abrir Pasta"}</span>
          </button>

          {/* Recent Projects Button */}
          <button
            onClick={() => setShowRecent(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Projetos Recentes"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Recentes</span>
          </button>

          {/* Ollama Status */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title={
              isConnected
                ? `Ollama: ${config.selectedModel || "conectado"} • ${config.baseUrl} • ${typeof latencyMs === "number" ? `${latencyMs}ms` : "latência n/d"}`
                : "Ollama desconectado"
            }
          >
            <div className="relative">
              <Server className="h-3.5 w-3.5" />
              <div
                className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border border-toolbar-bg ${
                  isChecking ? "bg-warning animate-pulse" : isConnected ? "bg-success" : "bg-destructive"
                }`}
              />
            </div>
            <span className="hidden xl:inline">Ollama</span>
          </button>

          <button className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <Layers className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Componentes</span>
          </button>

          {/* Explorer Sheet (left) */}
          <Sheet open={explorerOpen} onOpenChange={setExplorerOpen}>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SheetTrigger asChild>
                    <button
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      title="Explorer"
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                    </button>
                  </SheetTrigger>
                </TooltipTrigger>
                <TooltipContent>Explorer</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <SheetContent side="left" className="w-72 p-0">
              <FileSidebar />
            </SheetContent>
          </Sheet>

          {/* Terminal Sheet (right) */}
          <Sheet>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SheetTrigger asChild>
                    <button
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      title="Abrir Terminal"
                    >
                      <TerminalIcon className="h-4 w-4" />
                    </button>
                  </SheetTrigger>
                </TooltipTrigger>
                <TooltipContent>Abrir Terminal (direita)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <SheetContent side="right" className="w-[90vw] sm:max-w-lg p-0">
              <div className="flex items-center justify-between px-4 py-3 bg-secondary border-b border-border">
                <h2 className="text-sm font-semibold">Terminal PowerShell</h2>
              </div>
              <div className="p-4 space-y-3 h-full">
                <div className="flex gap-2">
                  <input
                    value={command}
                    onChange={e => setCommand(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        exec();
                      }
                    }}
                    placeholder="Digite um comando PowerShell"
                    className="flex-1 h-9 rounded-md bg-secondary/50 border border-border px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={exec}
                    disabled={running}
                    className={`h-9 px-4 rounded-md text-sm font-medium transition-colors ${
                      running ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90"
                    }`}
                    title="Executar"
                  >
                    {running ? "Executando..." : "Executar"}
                  </button>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  CWD: {derivedCwd ?? "Abra uma pasta para sincronizar em Projetos/"}
                </div>
                <div
                  className="rounded-lg border border-border shadow-inner"
                  style={{ backgroundColor: "#012456" }}
                >
                  <div className="p-3 font-mono text-sm leading-6">
                    <div className="text-white">
                      <span className="text-green-400 select-none">PS {(derivedCwd || "D:\\AI-Projetos\\BuilderAI\\Projetos").replace(/\\/g, "\\")}&gt;</span>{" "}
                      <span className="text-white">{command}</span>
                    </div>
                  </div>
                </div>
                <div ref={outRef} className="h-[55vh] overflow-auto rounded-lg border border-border bg-black text-green-200 p-3 text-xs font-mono whitespace-pre-wrap">
                  {serverOnline === false ? "Executor offline em http://localhost:3001. Rode: node scripts/command-server.cjs" : output || "Pronto."}
                </div>
              </div>
            </SheetContent>
          </Sheet>
          
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <Settings className="h-4 w-4" />
          </button>
          
          <button className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:opacity-90 transition-opacity glow-primary">
            <Play className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Publicar</span>
          </button>
        </div>
      </header>

      <OllamaSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <RecentProjectsModal open={showRecent} onClose={() => setShowRecent(false)} />
    </>
  );
}
