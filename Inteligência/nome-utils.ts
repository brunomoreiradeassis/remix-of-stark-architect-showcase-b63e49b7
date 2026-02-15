import nomenclaturaConfig from './nomenclatura-paginas.json' assert { type: 'json' };

export class NomeUtils {
  static validarNomeArquivo(nome: string): { valido: boolean; erro?: string } {
    // Verificar comprimento
    if (nome.length > nomenclaturaConfig.regras.comprimentoMaximo) {
      return { 
        valido: false, 
        erro: `Nome muito longo. Máximo: ${nomenclaturaConfig.regras.comprimentoMaximo} caracteres` 
      };
    }

    // Verificar prefixos proibidos
    const prefixoProibido = nomenclaturaConfig.regras.prefixosProibidos.find(prefixo => 
      nome.toLowerCase().startsWith(prefixo.toLowerCase())
    );
    
    if (prefixoProibido) {
      return { 
        valido: false, 
        erro: `Nome não pode começar com instrução: '${prefixoProibido}'` 
      };
    }

    // Verificar palavras proibidas
    const palavraProibida = nomenclaturaConfig.regras.palavrasProibidas.find(palavra =>
      nome.toLowerCase().includes(palavra.toLowerCase())
    );

    if (palavraProibida) {
      return { 
        valido: false, 
        erro: `Nome contém palavra proibida: '${palavraProibida}'` 
      };
    }

    // Verificar PascalCase (apenas para componentes)
    if (nome.endsWith('.tsx') || nome.endsWith('Page.tsx')) {
      if (!this.validarPascalCase(nome.replace(/\.tsx$/, ''))) {
        return { 
          valido: false, 
          erro: 'Nome deve seguir PascalCase para componentes React' 
        };
      }
    }

    return { valido: true };
  }

  static validarPascalCase(texto: string): boolean {
    return /^[A-Z][a-z]*(?:[A-Z][a-z]*)*$/.test(texto);
  }

  static gerarNomeValido(conteudoOuInstrucao: string): string {
    // Remover instruções e normalizar
    let nomeBase = conteudoOuInstrucao
      .replace(/^(Altere|Mude|Crie|Adicione|Implemente|Faça)\s*/i, '')
      .replace(/\b(ONome|Para|De|A|O|Na|PGina|GestO|ProduO)\b/gi, '')
      .replace(/BuildAI/gi, '')
      .replace(/ERP/gi, '')
      .trim();

    // Converter para PascalCase
    nomeBase = nomeBase
      .split(/\s+/)
      .map(palavra => palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase())
      .join('');

    // Adicionar sufixo apropriado
    if (nomeBase.includes('Page') || nomeBase.includes('Pagina')) {
      return nomeBase.replace(/(Page|Pagina)$/i, 'Page.tsx');
    }
    
    return nomeBase + '.tsx';
  }

  static obterExemplosValidos(): string[] {
    return nomenclaturaConfig.exemplos.nomesValidos;
  }

  static obterExemplosInvalidos(): string[] {
    return nomenclaturaConfig.exemplos.nomesInvalidos;
  }
}