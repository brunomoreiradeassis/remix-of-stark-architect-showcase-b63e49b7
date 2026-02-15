import { useOllama } from "@/contexts/OllamaContext";
import { useEffect, useState } from "react";
import { RefreshCw, Maximize2, Minimize2, AlertTriangle, X, Wrench } from "lucide-react";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function PreviewPanel() {
  const { devServerPort, devServerUrl, commandProgress, consoleErrors, clearConsoleErrors, setPendingErrorFix } = useOllama();
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => {
    const saved = localStorage.getItem("last-preview-url");
    return saved || null;
  });
  const [expanded, setExpanded] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [errorsModalOpen, setErrorsModalOpen] = useState(false);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "last-preview-url" && e.newValue) {
        setPreviewUrl(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const containerClasses = expanded
    ? "fixed inset-0 z-50 bg-background p-0"
    : "h-full w-full p-4 overflow-hidden";

  const statusLabel = (() => {
    switch (commandProgress.status) {
      case "checking": return "Verificando...";
      case "installing": return "Instalando dependências...";
      case "installing-force": return "Install --force...";
      case "starting": return "Iniciando servidor...";
      case "running": return "Servidor rodando";
      case "error": return "Erro";
      default: return null;
    }
  })();

  const statusColor = (() => {
    switch (commandProgress.status) {
      case "checking":
      case "installing":
      case "installing-force":
      case "starting":
        return "bg-warning";
      case "running":
        return "bg-success";
      case "error":
        return "bg-destructive";
      default:
        return "bg-muted";
    }
  })();

  const handleFixErrors = () => {
    if (consoleErrors.length === 0) return;
    const errorText = consoleErrors.map((e, i) => `${i + 1}. ${e}`).join("\n");
    const fixPrompt = `Corrija os seguintes erros do console do projeto:\n\n${errorText}\n\nAnalise cada erro, identifique os arquivos afetados e gere as correções necessárias.`;
    setPendingErrorFix(fixPrompt);
    setErrorsModalOpen(false);
  };

  return (
    <div className={containerClasses}>
      <div className="h-full flex flex-col rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 bg-secondary">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Visualizador Web</h2>
            {/* Status indicator */}
            {statusLabel && commandProgress.status !== "idle" && (
              <div className="flex items-center gap-1.5">
                <div className={`h-2 w-2 rounded-full ${statusColor} ${commandProgress.status !== "running" && commandProgress.status !== "error" ? "animate-pulse" : ""}`} />
                <span className="text-[10px] text-muted-foreground font-medium">{statusLabel}</span>
                {commandProgress.progress > 0 && commandProgress.status !== "running" && (
                  <span className="text-[10px] text-muted-foreground">({commandProgress.progress}%)</span>
                )}
              </div>
            )}
          </div>
          <TooltipProvider>
            <div className="flex items-center gap-1.5">
              {/* Error badge */}
              {consoleErrors.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setErrorsModalOpen(true)}
                      className="relative inline-flex items-center justify-center h-8 px-2 rounded-md bg-destructive/10 hover:bg-destructive/20 transition-colors"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      <Badge variant="destructive" className="ml-1 h-4 min-w-4 px-1 text-[10px] leading-none">
                        {consoleErrors.length}
                      </Badge>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{consoleErrors.length} erro(s) detectado(s)</TooltipContent>
                </Tooltip>
              )}

              {previewUrl && (
                <button
                  onClick={() => {
                    const url = devServerUrl || previewUrl;
                    if (url) {
                      localStorage.setItem("last-preview-url", url);
                      window.dispatchEvent(new StorageEvent("storage", { key: "last-preview-url", newValue: url }));
                      setReloadTick((t) => t + 1);
                    }
                  }}
                  className="px-2 h-8 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
                  title={devServerPort ? `localhost:${devServerPort}` : previewUrl}
                >
                  {devServerPort ? `localhost:${devServerPort}` : (previewUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""))}
                </button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setReloadTick((t) => t + 1)}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-muted hover:bg-muted/80 transition-colors"
                    title="Recarregar página"
                    aria-label="Recarregar página"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Recarregar página</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setExpanded((s) => !s)}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-muted hover:bg-muted/80 transition-colors"
                    title={expanded ? "Recolher" : "Expandir"}
                    aria-label={expanded ? "Recolher" : "Expandir"}
                  >
                    {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{expanded ? "Recolher preview" : "Expandir preview"}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        {/* Progress bar */}
        {commandProgress.status !== "idle" && commandProgress.status !== "running" && commandProgress.status !== "error" && (
          <div className="h-1 bg-muted">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${commandProgress.progress}%` }}
            />
          </div>
        )}

        <div className="relative bg-background flex-1 min-h-0">
          {!previewUrl ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground border-t border-border">
              {commandProgress.status !== "idle" ? (
                <div className="text-center space-y-2">
                  <div className="flex items-center justify-center gap-2">
                    <svg className="h-5 w-5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-80" d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span>{commandProgress.message}</span>
                  </div>
                </div>
              ) : (
                "Aguardando URL do servidor… Abra uma pasta para iniciar"
              )}
            </div>
          ) : (
            <>
              {frameError && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <div className="mx-4 rounded-md border border-border bg-secondary p-4 text-sm text-foreground">
                    Falha ao carregar {previewUrl}. Verifique se o servidor está rodando.
                    <div className="mt-2 flex justify-center">
                      <button
                        onClick={() => {
                          setFrameError(null);
                          setReloadTick((t) => t + 1);
                        }}
                        className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                      >
                        Tentar novamente
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <iframe
                key={`${previewUrl}-${reloadTick}`}
                src={previewUrl}
                title="App Preview"
                className="h-full w-full"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onLoad={() => setFrameError(null)}
                onError={() => setFrameError("load-error")}
              />
            </>
          )}
        </div>
      </div>

      {/* Errors Modal */}
      {errorsModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setErrorsModalOpen(false)}>
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[90vw] max-w-lg max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <span className="text-sm font-semibold text-foreground">
                  Erros do Console ({consoleErrors.length})
                </span>
              </div>
              <button onClick={() => setErrorsModalOpen(false)} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-1.5">
              {consoleErrors.map((error, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/5 border border-destructive/20 text-xs">
                  <span className="text-destructive font-mono shrink-0 mt-0.5">{i + 1}.</span>
                  <span className="text-foreground font-mono break-all leading-relaxed">{error}</span>
                </div>
              ))}
              {consoleErrors.length === 0 && (
                <div className="text-center text-muted-foreground text-sm py-8">Nenhum erro detectado.</div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-border flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={() => { clearConsoleErrors(); setErrorsModalOpen(false); }}>
                Limpar erros
              </Button>
              <Button size="sm" className="gap-2 bg-primary" onClick={handleFixErrors} disabled={consoleErrors.length === 0}>
                <Wrench className="h-3.5 w-3.5" />
                Fixar erros
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}