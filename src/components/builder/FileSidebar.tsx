import { useState } from "react";
import {
  FolderOpen,
  FileText,
  FileCode,
  Image,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Sparkles } from "lucide-react";
import { useOllama } from "@/contexts/OllamaContext";

interface FileItem {
  name: string;
  type: "file" | "folder";
  icon?: React.ReactNode;
  children?: FileItem[];
  ai?: boolean;
  full?: string;
}

function getFileIcon(name: string) {
  if (name.endsWith(".tsx") || name.endsWith(".ts"))
    return <FileCode className="h-3.5 w-3.5 text-primary" />;
  if (name.endsWith(".css"))
    return <FileText className="h-3.5 w-3.5 text-warning" />;
  if (name.endsWith(".svg") || name.endsWith(".ico"))
    return <Image className="h-3.5 w-3.5 text-success" />;
  return <FileText className="h-3.5 w-3.5 text-muted-foreground" />;
}

function FileTreeNode({
  item,
  depth = 0,
  selectedFile,
  onSelect,
  parentPath = "",
}: {
  item: FileItem;
  depth?: number;
  selectedFile: string;
  onSelect: (fullPath: string) => void;
  parentPath?: string;
}) {
  const [open, setOpen] = useState(false);

  if (item.type === "folder") {
    return (
      <div>
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-xs hover:bg-secondary/60 rounded-sm transition-colors text-secondary-foreground"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <FolderOpen className="h-3.5 w-3.5 text-primary/70" />
          <span className="font-mono truncate flex-1" title={item.name}>{item.name}</span>
        </button>
        {open &&
          item.children?.map((child) => (
            <FileTreeNode
              key={child.name}
              item={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelect={onSelect}
              parentPath={`${parentPath}${item.name}/`}
            />
          ))}
      </div>
    );
  }

  const fullPath = `${parentPath}${item.name}`;
  const selectKey = item.full ?? fullPath;
  const isSelected = selectedFile === selectKey;

  return (
    <button
      onClick={() => onSelect(selectKey)}
      className={`flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-xs rounded-sm transition-colors font-mono ${
        isSelected
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
      }`}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      {getFileIcon(item.name)}
      <span className="truncate flex-1" title={item.name}>{item.name}</span>
      {item.ai && <Sparkles className="h-3 w-3 text-primary ml-auto" />}
    </button>
  );
}

export function FileSidebar() {
  const [selectedFile, setSelectedFile] = useState("");
  const { virtualFiles, setCurrentFile, dirHandle } = useOllama();

  const tree: FileItem[] = (() => {
    if (dirHandle || virtualFiles.length > 0) {
      const root: FileItem[] = [];
      
      virtualFiles.forEach(file => {
        const parts = file.path.split(/[\\\/]/);
        let currentLevel = root;

        parts.forEach((part, index) => {
          const isFile = index === parts.length - 1;
          let existing = currentLevel.find(item => item.name === part);

          if (!existing) {
            existing = {
              name: part,
              type: isFile ? "file" : "folder",
              ai: isFile ? file.ai : false,
              children: isFile ? undefined : [],
              ...(isFile ? { full: file.path } : {})
            };
            currentLevel.push(existing);
          }

          if (!isFile) {
            currentLevel = existing.children!;
          }
        });
      });

      const sortItems = (items: FileItem[]) => {
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        items.forEach(item => {
          if (item.children) sortItems(item.children);
        });
      };
      
      sortItems(root);
      return root;
    }

    return [];
  })();

  const handleFileSelect = (path: string) => {
    setSelectedFile(path);
    setCurrentFile(path);
    // Dispatch event to switch to code view
    window.dispatchEvent(new CustomEvent("file-selected"));
  };

  return (
    <div className="h-full flex flex-col bg-sidebar overflow-x-auto">
      <div className="px-3 py-3 border-b border-border">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-auto py-1 scrollbar-thin">
        {tree.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-xs text-muted-foreground px-4 text-center">
            Nenhum projeto aberto. Use "Abrir Pasta" no header.
          </div>
        ) : (
          tree.map((item) => (
            <FileTreeNode
              key={item.name}
              item={item}
              selectedFile={selectedFile}
              onSelect={handleFileSelect}
              parentPath=""
            />
          ))
        )}
      </div>
    </div>
  );
}
