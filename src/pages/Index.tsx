import { useEffect, useState } from "react";
import { TopToolbar } from "@/components/builder/TopToolbar";
import { ChatPanel } from "@/components/builder/ChatPanel";
import { PreviewPanel } from "@/components/builder/PreviewPanel";
import { CodeEditor } from "@/components/builder/CodeEditor";
import { LoadingCard } from "@/components/builder/LoadingCard";
import { OllamaProvider } from "@/contexts/OllamaContext";

function AppShell() {
  const [view, setView] = useState<"preview" | "code">("preview");

  // Listen for file-selected event to auto-switch to code view
  useEffect(() => {
    const handler = () => setView("code");
    window.addEventListener("file-selected", handler);
    return () => window.removeEventListener("file-selected", handler);
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopToolbar view={view} onViewChange={setView} />

      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="w-80 shrink-0 border-r border-border">
          <ChatPanel />
        </div>

        {/* Preview / Code */}
        <div className="flex-1 min-w-0">
          {view === "preview" ? <PreviewPanel /> : <CodeEditor />}
        </div>
      </div>

      <LoadingCard />
    </div>
  );
}

const Index = () => {
  return (
    <OllamaProvider>
      <AppShell />
    </OllamaProvider>
  );
};

export default Index;
