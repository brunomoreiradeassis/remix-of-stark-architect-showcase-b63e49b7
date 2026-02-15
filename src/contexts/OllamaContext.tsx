import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { 
  getDirectoryHandle, 
  saveDirectoryHandle, 
  clearDirectoryHandle, 
  getAllDirectoryHandles, 
  openDB,
  removeDirectoryHandle 
} from "@/lib/db";
import { toast } from "@/components/ui/use-toast";

interface OllamaModel {
  name: string;
  size: string;
  modified_at: string;
}

interface OllamaConfig {
  baseUrl: string;
  selectedModel: string;
  temperature: number;
  maxTokens: number;
}

interface OllamaContextType {
  isConnected: boolean;
  isChecking: boolean;
  latencyMs: number | null;
  config: OllamaConfig;
  models: OllamaModel[];
  updateConfig: (partial: Partial<OllamaConfig>) => void;
  checkConnection: () => Promise<boolean>;
  previewCode: string | null;
  setPreviewCode: (code: string | null) => void;
  pushPreviewCode: (code: string) => void;
  undoPreview: () => void;
  redoPreview: () => void;
  previewHistory: string[];
  previewIndex: number;
  virtualFiles: Array<{ path: string; code: string; ai: boolean }>;
  addVirtualFile: (path: string, code: string, ai?: boolean) => void;
  updateVirtualFile: (path: string, code: string) => void;
  renameVirtualFile: (oldPath: string, newPath: string) => Promise<void>;
  deleteVirtualFile: (path: string) => void;
  dirHandle: FileSystemDirectoryHandle | null;
  projectPath: string | null;
  devServerUrl: string | null;
  devServerPort: number | null;
  openDirectory: () => Promise<void>;
  openRecentDirectory: (handle: FileSystemDirectoryHandle, path?: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  recentProjects: Array<{ name: string; handle: FileSystemDirectoryHandle; path?: string }>;
  removeRecentProject: (name: string) => void;
  runProjectCommands: () => Promise<void>;
  commandProgress: {
    status: "idle" | "checking" | "installing" | "installing-force" | "starting" | "running" | "error";
    progress: number;
    message: string;
  };
  consoleErrors: string[];
  addConsoleError: (error: string) => void;
  clearConsoleErrors: () => void;
  pendingErrorFix: string | null;
  setPendingErrorFix: (msg: string | null) => void;
  projectComponents: string[];
  projectTemplate: string;
  lastPrompt: string | null;
  setLastPrompt: (p: string | null) => void;
  lastError: string | null;
  setLastError: (e: string | null) => void;
  currentFile: string | null;
  setCurrentFile: (p: string | null) => void;
  // Chat session management
  chatSessions: Array<{ id: string; title: string; updatedAt: string }>;
  currentChatId: string | null;
  setCurrentChatId: (id: string | null) => void;
  saveChatSession: (chatId: string, title: string, messages: any[]) => Promise<void>;
  loadChatSession: (chatId: string) => Promise<any[] | null>;
  loadChatSessions: () => Promise<void>;
  projectName: string | null;
}

const defaultConfig: OllamaConfig = {
  baseUrl: "http://localhost:11434",
  selectedModel: "",
  temperature: 0.7,
  maxTokens: 8192,
};

const OllamaContext = createContext<OllamaContextType | null>(null);

export function OllamaProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [previewCode, setPreviewCode] = useState<string | null>(null);
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number>(-1);
  const [virtualFiles, setVirtualFiles] = useState<Array<{ path: string; code: string; ai: boolean }>>([]);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [currentFileState, setCurrentFileState] = useState<string | null>(() => {
    const saved = localStorage.getItem("current-file");
    return saved ? saved : null;
  });
  const currentFile = currentFileState;

  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(() => localStorage.getItem("current-project-path"));
  const [devServerUrl, setDevServerUrl] = useState<string | null>(() => localStorage.getItem("last-preview-url"));
  const [devServerPort, setDevServerPort] = useState<number | null>(() => {
    const p = localStorage.getItem("last-preview-port");
    return p ? Number(p) : null;
  });
  const [recentProjects, setRecentProjects] = useState<Array<{ name: string; handle: FileSystemDirectoryHandle; path?: string }>>([]);
  const [commandProgress, setCommandProgress] = useState<{
    status: "idle" | "checking" | "installing" | "installing-force" | "starting" | "running" | "error";
    progress: number;
    message: string;
  }>({ status: "idle", progress: 0, message: "" });
  const [consoleErrors, setConsoleErrors] = useState<string[]>([]);
  const [pendingErrorFix, setPendingErrorFix] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(() => localStorage.getItem("current-chat-id"));

  const derivedProjectName = dirHandle?.name || (() => {
    if (projectPath) {
      const parts = projectPath.replace(/\\+/g, '/').split('/');
      return parts[parts.length - 1] || parts[parts.length - 2] || null;
    }
    return null;
  })();

  const addConsoleError = useCallback((error: string) => {
    setConsoleErrors(prev => {
      if (prev.includes(error)) return prev;
      return [...prev, error];
    });
  }, []);

  const clearConsoleErrors = useCallback(() => {
    setConsoleErrors([]);
  }, []);

  // Restore directory handle on load
  useEffect(() => {
    async function restore() {
      try {
        const handle = await getDirectoryHandle();
        if (handle) {
          try {
            const status = await (handle as any).queryPermission({ mode: "readwrite" });
            if (status === "granted") {
              setDirHandle(handle);
              // Tenta restaurar o path também
              const savedPath = localStorage.getItem("current-project-path");
              if (savedPath) setProjectPath(savedPath);
              await loadFilesFromHandle(handle);
            } else {
              // We have the handle but need to ask for permission later (on user gesture)
              console.log("Permission not granted yet for persisted handle");
            }
          } catch (e) {
            console.error("Error checking persisted handle permission:", e);
          }
        }

        // Load recent projects from db
        const allHandles = await getAllDirectoryHandles();
        // Nota: O DB pode não ter o path, vamos tentar recuperar do localStorage se possível ou deixar nulo
        setRecentProjects(allHandles);

        // Se não houver handle mas existe um caminho salvo em Projetos, tenta carregar remotamente
        if (!handle) {
          const savedPath = localStorage.getItem("current-project-path");
          if (savedPath) {
            const parts = savedPath.replace(/\\+/g, '/').split('/');
            const projectName = parts[parts.length - 1] || parts[parts.length - 2];
            if (projectName) {
              await loadRemoteProject(projectName, savedPath);
            }
          }
        }
      } catch (e) {
        console.error("Error restoring directory handle:", e);
      }
    }
    restore();
  }, []);

  const runProjectCommands = useCallback(async () => {
    if (!dirHandle) return;
    
    try {
      setCommandProgress({ status: "installing", progress: 5, message: "Conectando ao executor local..." });

      const statusRes = await fetch("http://localhost:3001/status").catch(() => null);
      if (!statusRes || !statusRes.ok) {
        throw new Error("Servidor de comandos não encontrado. Certifique-se de rodar 'node scripts/command-server.cjs'");
      }

      setCommandProgress({ status: "installing", progress: 10, message: "Verificando dependências e iniciando servidor..." });

      // Usa o projectPath se disponível, senão fallback para o path fixo (ou erro)
      const executionCwd = projectPath || "d:\\AI-Projetos\\BuilderAI";
      
      let response = await fetch("http://localhost:3001/smart-dev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: executionCwd, packageManager: "pnpm" })
      }).catch(() => null as any);

      if (!response || !response.ok) {
        const fallbackCmd = "if (-Not (Test-Path node_modules)) { pnpm install }; pnpm run dev";
        response = await fetch("http://localhost:3001/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: fallbackCmd, cwd: executionCwd })
        }).catch(() => null as any);
      }

      if (!response || !response.ok) throw new Error("Falha ao iniciar execução remota");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Falha ao ler stream de saída");

      let installDone = false;
      let hasNodeModules = false;
      let ready = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = new TextDecoder().decode(value);
        console.log("SERVER:", text);

        if (/node_modules encontrado/i.test(text)) {
          hasNodeModules = true;
          setCommandProgress({ status: "starting", progress: 30, message: "node_modules encontrado. Pulando instalação." });
        }
        if (/node_modules ausente/i.test(text) || /Iniciando instalação/i.test(text)) {
          hasNodeModules = false;
          setCommandProgress({ status: "installing", progress: 20, message: "Instalando dependências..." });
        }

        const urlMatch = text.match(/http:\/\/localhost:(\d{2,5})/i) || text.match(/http:\/\/127\.0\.0\.1:(\d{2,5})/i);
        if (urlMatch) {
          const url = `http://localhost:${urlMatch[1]}/`;
          try {
            localStorage.setItem("last-preview-url", url);
            localStorage.setItem("last-preview-port", urlMatch[1]);
            setDevServerUrl(url);
            setDevServerPort(Number(urlMatch[1]));
            window.dispatchEvent(new StorageEvent("storage", { key: "last-preview-url", newValue: url }));
          } catch { /* noop */ }
        }

        if (text.includes("added") || text.includes("audited") || text.includes("up to date")) {
          installDone = true;
          setCommandProgress({ status: "starting", progress: 80, message: "Dependências OK. Iniciando Vite..." });
        }

        if (text.includes("VITE") && text.includes("ready")) {
          setCommandProgress({ status: "running", progress: 100, message: "Servidor local pronto!" });
          ready = true;
          break;
        }

        if (!installDone && !hasNodeModules) {
          setCommandProgress(prev => ({
            ...prev,
            progress: Math.min(prev.progress + 1, 75),
            message: "Instalando dependências (acompanhe no console)..."
          }));
        }
      }

      toast({ 
        title: "Projeto Pronto", 
        description: "Servidor dev rodando via PowerShell.",
      });
      if (!ready) {
        setCommandProgress({ status: "error", progress: 0, message: "Não foi possível detectar a porta do servidor" });
      }

    } catch (e: any) {
      setCommandProgress({ status: "error", progress: 0, message: `Erro: ${e.message}` });
      console.error("Erro ao rodar comandos reais:", e);
      
      toast({
        title: "Erro de Execução",
        description: e.message,
        variant: "destructive"
      });
    }
  }, [dirHandle, projectPath]);

  const openDirectory = useCallback(async () => {
    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
      });
      
      // Ao abrir uma pasta, notificamos o servidor para preparar a subpasta em "Projetos"
      let finalPath = "";
      const fallbackPath = `d:\\AI-Projetos\\BuilderAI\\Projetos\\${handle.name}`;
      try {
        const res = await fetch("http://localhost:3001/prepare-project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectName: handle.name })
        });
        if (res.ok) {
          const data = await res.json();
          finalPath = data.path;
          setProjectPath(finalPath);
          localStorage.setItem("current-project-path", finalPath);
        } else {
          // Fallback imediato para garantir que o terminal aponte para Projetos/<nome>
          setProjectPath(fallbackPath);
          localStorage.setItem("current-project-path", fallbackPath);
        }
      } catch (err) {
        console.warn("Não foi possível sincronizar com o servidor de projetos:", err);
        // Define fallback mesmo sem servidor de comandos
        setProjectPath(fallbackPath);
        localStorage.setItem("current-project-path", fallbackPath);
      }

      const finalPathForDb = projectPath || localStorage.getItem("current-project-path") || undefined;
      await saveDirectoryHandle(handle, finalPathForDb ?? undefined);
      setDirHandle(handle);
      
      // Update recent projects list
      const allHandles = await getAllDirectoryHandles();
      setRecentProjects(allHandles);
      
      // Load files from the newly opened directory AND sync them to remote Projetos folder
      await loadFilesFromHandle(handle, true);

      toast({ 
        title: "Projeto Importado", 
        description: `Os arquivos de ${handle.name} foram copiados para a pasta Projetos.` 
      });
      
      try {
        await runProjectCommands();
      } catch (e: unknown) { void e; }
    } catch (e: any) {
      if (e.name === "AbortError") return;
      console.error(e);
      toast({ 
        title: "Erro ao abrir pasta", 
        description: e.message, 
        variant: "destructive" 
      });
    }
  }, [runProjectCommands]);

  const openRecentDirectory = useCallback(async (handle: FileSystemDirectoryHandle, path?: string) => {
    try {
      // Se for um caminho de Projetos sem handle válido, carrega remotamente
      if (!handle && path && /[\\\/]Projetos[\\\/]/.test(path)) {
        const parts = path.replace(/\\+/g, '/').split('/');
        const projectName = parts[parts.length - 1] || parts[parts.length - 2];
        await loadRemoteProject(projectName, path);
        return;
      }

      const status = await (handle as any).requestPermission({ mode: "readwrite" });
      if (status === "granted") {
        await saveDirectoryHandle(handle, path);
        setDirHandle(handle);
        
        if (path) {
          setProjectPath(path);
          localStorage.setItem("current-project-path", path);
        } else {
          // Tenta recuperar via prepare-project para garantir consistência
          const fallbackPath = `d:\\AI-Projetos\\BuilderAI\\Projetos\\${handle.name}`;
          try {
            const res = await fetch("http://localhost:3001/prepare-project", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectName: handle.name })
            });
            if (res.ok) {
              const data = await res.json();
              setProjectPath(data.path);
              localStorage.setItem("current-project-path", data.path);
            } else {
              setProjectPath(fallbackPath);
              localStorage.setItem("current-project-path", fallbackPath);
            }
          } catch (err) { 
            // Fallback sem servidor
            setProjectPath(fallbackPath);
            localStorage.setItem("current-project-path", fallbackPath);
          }
        }

        await loadFilesFromHandle(handle);
        toast({ 
          title: "Projeto carregado", 
          description: `Pasta: ${handle.name}` 
        });
        try {
          await runProjectCommands();
        } catch (e: unknown) { void e; }
      }
    } catch (e: any) {
      console.error(e);
      toast({ 
        title: "Erro ao abrir projeto recente", 
        description: e.message, 
        variant: "destructive" 
      });
    }
  }, [runProjectCommands]);

  const removeRecentProject = useCallback(async (name: string) => {
    try {
      await removeDirectoryHandle(name);
      setRecentProjects(prev => prev.filter(p => p.name !== name));
      
      if (dirHandle?.name === name) {
        setDirHandle(null);
        setProjectPath(null);
        localStorage.removeItem("current-project-path");
        setVirtualFiles([]);
        await clearDirectoryHandle();
      }
      
      toast({ title: "Removido dos recentes", description: name });
    } catch (e) {
      console.error(e);
    }
  }, [dirHandle]);

  const syncProjectToRemote = async (handle: FileSystemDirectoryHandle, files: Array<{ path: string; code: string }>) => {
    if (!files.length) return;
    
    console.log(`[OllamaContext] Sincronizando ${files.length} arquivos para a pasta Projetos/${handle.name}...`);
    
    // Sincroniza em batches para não sobrecarregar o servidor
    for (const file of files) {
      try {
        await fetch("http://localhost:3001/save-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectName: handle.name,
            filePath: file.path,
            content: file.code
          })
        });
      } catch (err) {
        console.error(`Erro ao sincronizar ${file.path}:`, err);
      }
    }
    console.log(`[OllamaContext] Sincronização concluída para ${handle.name}`);
  };

  const loadFilesFromHandle = async (handle: FileSystemDirectoryHandle, autoSyncToRemote = false) => {
    const files: Array<{ path: string; code: string; ai: boolean }> = [];
    
    async function scan(currentHandle: FileSystemDirectoryHandle, currentPath = "") {
      for await (const entry of (currentHandle as any).values()) {
        const path = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        
        // Ignore common bulky/system directories
        if (entry.kind === "directory") {
          if (["node_modules", ".git", "dist", ".vite"].includes(entry.name)) continue;
          await scan(entry, path);
        } else if (entry.kind === "file") {
          // Only load text-based files for the editor
          if (/\.(tsx|ts|js|jsx|css|json|html|md|txt)$/i.test(entry.name)) {
            const file = await entry.getFile();
            const code = await file.text();
            files.push({ path, code, ai: false });
          }
        }
      }
    }

    try {
      await scan(handle);
      console.log(`[OllamaContext] ${files.length} arquivos carregados do explorador.`);
      
      // Se solicitado, sincroniza os arquivos carregados com o servidor remoto (pasta Projetos)
      if (autoSyncToRemote) {
        syncProjectToRemote(handle, files);
        // Garante que projectPath esteja definido mesmo sem resposta do servidor
        if (!projectPath) {
          const fallbackPath = `d:\\AI-Projetos\\BuilderAI\\Projetos\\${(handle as any).name}`;
          setProjectPath(fallbackPath);
          localStorage.setItem("current-project-path", fallbackPath);
        }
      }
      
      // Só atualiza se houver mudança real para evitar re-renders infinitos ou desnecessários
      setVirtualFiles(prev => {
        const isDifferent = JSON.stringify(prev) !== JSON.stringify(files);
        if (isDifferent) {
          localStorage.setItem("virtual-files", JSON.stringify(files));
          return files;
        }
        return prev;
      });
      
      if (files.length > 0 && !currentFileState) {
        const firstFile = files[0].path;
        setCurrentFileState(firstFile);
        localStorage.setItem("current-file", firstFile);
      }
    } catch (e) {
      console.error("Error scanning directory:", e);
    }
  };

  const refreshFiles = useCallback(async () => {
    if (dirHandle) {
      await loadFilesFromHandle(dirHandle);
    }
  }, [dirHandle]);

  // Carrega um projeto diretamente da pasta "Projetos" via servidor
  const loadRemoteProject = async (projectName: string, absolutePath?: string) => {
    try {
      const res = await fetch("http://localhost:3001/read-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName })
      });
      if (!res.ok) throw new Error("Falha ao ler projeto remoto");
      const data = await res.json();
      const files = (data.files as Array<{ path: string; code: string }>) || [];
      const mapped = files.map(f => ({ ...f, ai: false }));
      setVirtualFiles(mapped);
      localStorage.setItem("virtual-files", JSON.stringify(mapped));
      setProjectPath(absolutePath || data.path);
      localStorage.setItem("current-project-path", absolutePath || data.path);
      if (mapped.length > 0) {
        setCurrentFileState(mapped[0].path);
        localStorage.setItem("current-file", mapped[0].path);
      }
      toast({ title: "Projeto remoto carregado", description: projectName });
    } catch (e: any) {
      console.error(e);
      toast({ title: "Erro ao carregar projeto remoto", description: e.message, variant: "destructive" });
    }
  };

  // Polling para sincronização em tempo real com o disco
  useEffect(() => {
    if (!dirHandle) return;
    
    // Pequeno atraso inicial e depois polling
    const interval = setInterval(() => {
      refreshFiles();
    }, 5000); // Aumentado para 5s para evitar sobrecarga com a nova sincronização remota
    
    return () => clearInterval(interval);
  }, [dirHandle, refreshFiles]);

  const getFileHandle = async (path: string, create = false) => {
    if (!dirHandle) return null;
    
    const parts = path.split(/[\\\/]/);
    let currentDir = dirHandle;
    
    // Navigate/create subdirectories
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create });
      } catch (err) {
        if (!create) return null;
        throw err;
      }
    }
    
    return await currentDir.getFileHandle(parts[parts.length - 1], { create });
  };

  const syncFileToDisk = async (path: string, code: string) => {
    if (!dirHandle) return;
    try {
      // Sync local (FileSystemHandle)
      const fileHandle = await getFileHandle(path, true);
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(code);
        await writable.close();
      }

      // Sync remoto (Servidor Projetos) se estivermos em um projeto identificado
      if (dirHandle.name) {
        fetch("http://localhost:3001/save-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectName: dirHandle.name,
            filePath: path,
            content: code
          })
        }).catch(err => console.error("Erro ao sincronizar arquivo com servidor remoto:", err));
      }
    } catch (e: any) {
      console.error(`Error syncing ${path} to disk:`, e);
      toast({ 
        title: "Erro de sincronização", 
        description: `Não foi possível salvar ${path}: ${e.message}`, 
        variant: "destructive" 
      });
    }
  };

  const deleteFileFromDisk = async (path: string) => {
    // Sync local (FileSystemHandle)
    if (dirHandle) {
      try {
        const parts = path.split(/[\\\/]/);
        let currentDir = dirHandle;
        
        for (let i = 0; i < parts.length - 1; i++) {
          currentDir = await currentDir.getDirectoryHandle(parts[i]);
        }
        
        await currentDir.removeEntry(parts[parts.length - 1]);
      } catch (e: any) {
        if (e.name !== "NotFoundError") {
          console.error(`Error deleting ${path} from disk:`, e);
          toast({ 
            title: "Erro ao excluir", 
            description: `Nao foi possivel excluir ${path}: ${e.message}`, 
            variant: "destructive" 
          });
        }
      }
    }

    // Sync remoto (Servidor Projetos) se estivermos em um projeto identificado
    if (dirHandle?.name) {
      fetch("http://localhost:3001/delete-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: dirHandle.name,
          filePath: path,
        }),
      }).catch((err) =>
        console.error("Erro ao excluir arquivo no servidor remoto:", err)
      );
    }
  };
  const [config, setConfig] = useState<OllamaConfig>(() => {
    const saved = localStorage.getItem("ollama-config");
    return saved ? { ...defaultConfig, ...JSON.parse(saved) } : defaultConfig;
  });

  const updateConfig = useCallback((partial: Partial<OllamaConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem("ollama-config", JSON.stringify(next));
      return next;
    });
  }, []);

  const checkConnection = useCallback(async () => {
    setIsChecking(true);
    try {
      const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      const res = await fetch(`${config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        const modelList = ((data.models as Array<{ name: string; size: number; modified_at: string }>) || []).map((m) => ({
          name: m.name,
          size: (m.size / 1e9).toFixed(1) + " GB",
          modified_at: m.modified_at,
        }));
        setModels(modelList);
        setIsConnected(true);
        const t1 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        setLatencyMs(Math.max(0, Math.round(t1 - t0)));
        if (!config.selectedModel && modelList.length > 0) {
          updateConfig({ selectedModel: modelList[0].name });
        }
        return true;
      }
      setIsConnected(false);
      setLatencyMs(null);
      return false;
    } catch {
      setIsConnected(false);
      setModels([]);
      setLatencyMs(null);
      return false;
    } finally {
      setIsChecking(false);
    }
  }, [config.baseUrl, config.selectedModel, updateConfig]);

  // Poll connection every 5s
  useEffect(() => {
    checkConnection();
    const id = setInterval(checkConnection, 5000);
    return () => clearInterval(id);
  }, [checkConnection]);

  const pushPreviewCode = useCallback((code: string) => {
    setPreviewCode(code);
    setPreviewHistory((prev) => {
      const next = previewIndex >= 0 ? prev.slice(0, previewIndex + 1) : prev;
      const updated = [...next, code];
      localStorage.setItem("preview-history", JSON.stringify(updated));
      return updated;
    });
    setPreviewIndex((prev) => prev + 1);
  }, [previewIndex]);

  useEffect(() => {
    const raw = localStorage.getItem("preview-history");
    if (raw) {
      try {
        const arr = JSON.parse(raw) as string[];
        setPreviewHistory(arr);
        setPreviewIndex(arr.length - 1);
        setPreviewCode(arr.length > 0 ? arr[arr.length - 1] : null);
      } catch (e) {
        void e;
      }
    }
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem("virtual-files");
    if (raw) {
      try {
        const arr = JSON.parse(raw) as Array<{ path: string; code: string; ai: boolean }>;
        setVirtualFiles(arr);
      } catch (e) {
        void e;
      }
    }
  }, []);

  const addVirtualFile = useCallback((path: string, code: string, ai: boolean = true) => {
    setVirtualFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      const next = [...prev];
      if (idx >= 0) {
        next[idx] = { ...next[idx], code, ai };
      } else {
        next.push({ path, code, ai });
      }
      localStorage.setItem("virtual-files", JSON.stringify(next));
      return next;
    });
    
    // Sync to disk
    syncFileToDisk(path, code);

    try {
      setCurrentFileState(path);
      localStorage.setItem("current-file", path);
    } catch (e) { void e; }
  }, [dirHandle]); // Added dirHandle to dependencies

  const updateVirtualFile = useCallback((path: string, code: string) => {
    setVirtualFiles((prev) => {
      const next = prev.map((f) => (f.path === path ? { ...f, code } : f));
      localStorage.setItem("virtual-files", JSON.stringify(next));
      return next;
    });
    
    // Sync to disk
    syncFileToDisk(path, code);
  }, [dirHandle]);

  const renameVirtualFile = useCallback(async (oldPath: string, newPath: string) => {
    // For rename, we delete the old one and create the new one on disk
    // In a real FS API we could move it, but this is simpler for now
    const file = virtualFiles.find(f => f.path === oldPath);
    if (file) {
      await deleteFileFromDisk(oldPath);
      await syncFileToDisk(newPath, file.code);
    }

    setVirtualFiles((prev) => {
      const next = prev.map((f) => (f.path === oldPath ? { ...f, path: newPath } : f));
      localStorage.setItem("virtual-files", JSON.stringify(next));
      return next;
    });
    setCurrentFileState((prev) => {
      const next = prev === oldPath ? newPath : prev;
      if (next) localStorage.setItem("current-file", next);
      return next;
    });
  }, [dirHandle, virtualFiles]);

  const deleteVirtualFile = useCallback((path: string) => {
    setVirtualFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      localStorage.setItem("virtual-files", JSON.stringify(next));
      return next;
    });
    
    // Delete from disk
    deleteFileFromDisk(path);

    setCurrentFileState((prev) => {
      const next = prev === path ? null : prev;
      localStorage.setItem("current-file", next ?? "");
      return next;
    });
  }, [dirHandle]);

  const projectComponents = [
    ...virtualFiles
      .filter((f) => f.path.endsWith(".tsx") && (f.path.startsWith("src/components/") || f.path.startsWith("src/pages/")))
      .map((f) =>
        f.path.startsWith("src/components/")
          ? f.path.replace("src/components/", "")
          : f.path.replace("src/pages/", "")
      ),
  ];
  const projectFiles = [...virtualFiles.map((f) => f.path)];
  const projectTemplate = [
    "Stack: React + TypeScript + Tailwind CSS",
    "Estrutura:",
    "- Páginas: src/pages/*.tsx (Index.tsx, About.tsx, etc.)",
    "- Componentes: src/components/*.tsx",
    "- Módulos: src/modules/**/*.ts",
    "- Assets: public/* (svg, png, jpg, webp, ico)",
    "Regras:",
    "- Use apenas classes Tailwind e componentes funcionais (export function).",
    "- Sem dependências externas além de Tailwind.",
    "- Retorne blocos ```tsx completos; um bloco por arquivo.",
    "- Inclua comentário com caminho relativo no topo do bloco, ex: // src/components/ProdutoCard.tsx",
    "Arquivos existentes: " + projectFiles.join(", "),
  ].join("\n");

  const undoPreview = useCallback(() => {
    setPreviewIndex((idx) => {
      const next = idx - 1;
      if (next >= 0) {
        setPreviewCode(previewHistory[next]);
      }
      return next >= 0 ? next : idx;
    });
  }, [previewHistory]);

  const redoPreview = useCallback(() => {
    setPreviewIndex((idx) => {
      const next = idx + 1;
      if (next < previewHistory.length) {
        setPreviewCode(previewHistory[next]);
      }
      return next < previewHistory.length ? next : idx;
    });
  }, [previewHistory]);

  const saveChatSession = useCallback(async (chatId: string, title: string, msgs: any[]) => {
    if (!derivedProjectName) return;
    localStorage.setItem("current-chat-id", chatId);
    setCurrentChatId(chatId);
    try {
      await fetch("http://localhost:3001/save-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: derivedProjectName,
          filePath: `.builderai/chats/${chatId}.json`,
          content: JSON.stringify({ id: chatId, title, messages: msgs, updatedAt: new Date().toISOString() }, null, 2)
        })
      });
    } catch (e) {
      console.error("Erro ao salvar chat:", e);
    }
  }, [derivedProjectName]);

  const loadChatSession = useCallback(async (chatId: string): Promise<any[] | null> => {
    if (!derivedProjectName) return null;
    try {
      const res = await fetch("http://localhost:3001/read-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: derivedProjectName, chatId })
      });
      if (!res.ok) return null;
      const data = await res.json();
      setCurrentChatId(chatId);
      localStorage.setItem("current-chat-id", chatId);
      return data.messages || null;
    } catch {
      return null;
    }
  }, [derivedProjectName]);

  const loadChatSessions = useCallback(async () => {
    if (!derivedProjectName) {
      setChatSessions([]);
      return;
    }
    try {
      const res = await fetch("http://localhost:3001/list-chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: derivedProjectName })
      });
      if (res.ok) {
        const data = await res.json();
        setChatSessions(data.chats || []);
      }
    } catch {
      setChatSessions([]);
    }
  }, [derivedProjectName]);

  // Load chat sessions when project changes
  useEffect(() => {
    loadChatSessions();
  }, [derivedProjectName]);

  return (
    <OllamaContext.Provider value={{ isConnected, isChecking, latencyMs, config, models, updateConfig, checkConnection, previewCode, setPreviewCode, pushPreviewCode, undoPreview, redoPreview, previewHistory, previewIndex, virtualFiles, addVirtualFile, updateVirtualFile, renameVirtualFile, deleteVirtualFile, dirHandle, projectPath, devServerUrl, devServerPort, openDirectory, openRecentDirectory, refreshFiles, recentProjects, removeRecentProject,
      runProjectCommands,
      commandProgress,
      consoleErrors, addConsoleError, clearConsoleErrors,
      pendingErrorFix, setPendingErrorFix,
      projectComponents, projectTemplate, lastPrompt, setLastPrompt, lastError, setLastError, currentFile, setCurrentFile: (p) => { setCurrentFileState(p); localStorage.setItem("current-file", p ?? ""); },
      chatSessions, currentChatId, setCurrentChatId, saveChatSession, loadChatSession, loadChatSessions, projectName: derivedProjectName }}>
      {children}
    </OllamaContext.Provider>
  );
}

export function useOllama() {
  const ctx = useContext(OllamaContext);
  if (!ctx) throw new Error("useOllama must be used within OllamaProvider");
  return ctx;
}
