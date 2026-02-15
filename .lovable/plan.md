# Plano de Correções do ChatPanel e Layout

## Problemas Identificados

1. **Nomes de arquivos gerados incorretamente** -- A funcao `normalizeName` (linha 282) converte o titulo do passo/task em nome de arquivo (ex: "Renomear arquivo" vira `RenomearArquivo.tsx`). Quando o AI nao especifica filename no bloco de codigo, o fallback usa o titulo da task como nome.
2. **Contexto limitado enviado ao AI** -- Na linha 351-355, apenas o primeiro arquivo virtual e enviado como contexto (limitado a 6000 chars). O AI nao ve a estrutura completa do projeto.
3. **Plano gerado em qualquer mensagem** -- No modo "agente", toda mensagem gera um plano automaticamente (linha 340: `isPlan: chatMode === "agente"`), inclusive mensagens simples como "Ola".
4. **Sem botao flutuante "Gerar Plano" nem "Cancelar Plano"** -- Nao existe separacao entre conversa natural e geracao de plano.
5. **Baloes de mensagem ultrapassando limites** -- O `max-w-[85%]` na linha 1053 pode nao ser suficiente, e falta `overflow-hidden` adequado.
6. **Chat nao e redimensionavel** -- O painel do chat tem largura fixa `w-80` (linha 25 do Index.tsx) sem possibilidade de arrastar.
7. **Preview nao renderiza** -- O iframe depende de `previewUrl` vindo do servidor local. Pode ser problema de configuracao do servidor de comandos.

---

## Solucoes Propostas

### 1. Corrigir Nomes de Arquivos (ChatPanel.tsx)

- Modificar a logica no bloco de execucao (linha 533-537) para NUNCA usar `normalizeName(current.title)` como fallback
- Se o bloco de codigo nao tiver `filename` extraido do comentario na primeira linha, usar um nome generico baseado no indice (`Component1.tsx`, `Component2.tsx`) ou rejeitar o bloco
- Adicionar validacao usando regras do `nomenclatura-paginas.json` antes de salvar

### 2. Enviar Contexto Completo ao AI (ChatPanel.tsx)

- Remover a limitacao da linha 351-355 que envia apenas 1 arquivo para enviar todos
- Enviar lista completa de arquivos com conteudo resumido (todas as linhas de cada arquivo)
- Manter o limite total de caracteres mas distribuir entre todos os arquivos

Antes:

```
const projectContext = currentVf ? `--- ${currentVf.path} ---\n${currentVf.code.slice(0, MAX_CONTEXT_CHARS)}` : "";
```

Depois:

```
const projectContext = virtualFiles
  .map(f => `--- ${f.path} ---\n${f.code.slice(0, Math.floor(MAX_CONTEXT_CHARS / Math.max(1, virtualFiles.length)))}`)
  .join("\n\n");
```

### 3. Conversa Natural + Botao "Gerar Plano" (ChatPanel.tsx)

- No modo "plano", mensagens comuns NAO devem ser marcadas como `isPlan: true`
- O AI deve responder naturalmente (usando `PLAN_ONLY_SYSTEM_PROMPT` como base para conversa)
- Adicionar um botao flutuante "Gerar Plano" que:
  - Coleta todo o historico da conversa atual
  - Envia ao AI com `PLAN_SYSTEM_PROMPT` para gerar um plano estruturado
  - Marca apenas essa resposta como `isPlan: true`
- Adicionar botao "Cancelar Plano" que remove a mensagem do plano anterior

### 4. Responsividade dos Baloes (ChatPanel.tsx)

- Adicionar `overflow-hidden word-break: break-word` nos baloes
- Garantir que `max-w-[85%]` funcione com `min-w-0` no container pai

### 5. Chat Redimensionavel (Index.tsx)

- Substituir o layout fixo `w-80` por `react-resizable-panels` (ja instalado no projeto)
- O chat e o preview/code ficam em paineis redimensionaveis com drag handle

### 6. Preview (PreviewPanel.tsx)

- Verificar se `devServerUrl` esta sendo populado corretamente
- Adicionar fallback visual mais informativo quando o servidor nao esta rodando

---

## Arquivos a Modificar

- `src/components/builder/ChatPanel.tsx` -- Corrigir naming, contexto, conversa natural, botao gerar plano, responsividade dos baloes
- `src/pages/Index.tsx` -- Implementar paineis redimensionaveis com drag
- `src/components/builder/PreviewPanel.tsx` -- Melhorar feedback quando preview nao carrega

## Passos de Implementacao

1. Corrigir `normalizeName` e o fallback de nomes no bloco de execucao
2. Expandir o contexto enviado ao AI para incluir todos os arquivos
3. Separar conversa natural da geracao de planos (botao "Gerar Plano")
4. Adicionar botao "Cancelar Plano"
5. Corrigir overflow dos baloes de mensagem
6. Implementar paineis redimensionaveis com `react-resizable-panels`
7. Melhorar o estado vazio/erro do PreviewPanel