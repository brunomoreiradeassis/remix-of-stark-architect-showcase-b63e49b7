// Script para renomear arquivos com nomes problemáticos
import fs from 'fs';
import path from 'path';

function gerarNomeValido(nomeAntigo) {
  // Remover instruções e normalizar
  let nomeBase = nomeAntigo
    .replace(/^(Altere|Mude|Crie|Adicione|Implemente|Faça)/i, '')
    .replace(/(ONome|Para|De|A|O|Na|PGina|GestO|ProduO)/gi, '')
    .replace(/BuildAI/gi, '')
    .replace(/ERP/gi, '')
    .replace(/\.tsx$/, '')
    .trim();

  // Converter para PascalCase
  nomeBase = nomeBase
    .split(/[^a-zA-Z0-9]+/)
    .filter(word => word.length > 0)
    .map(palavra => palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase())
    .join('');

  // Se o nome ficar vazio, usar um nome padrão
  if (!nomeBase) {
    nomeBase = 'ComponenteRenomeado';
  }

  return nomeBase + '.tsx';
}

function processarDiretorio(diretorio) {
  const arquivos = fs.readdirSync(diretorio);
  
  arquivos.forEach(arquivo => {
    const caminhoAntigo = path.join(diretorio, arquivo);
    const stat = fs.statSync(caminhoAntigo);
    
    if (stat.isFile() && arquivo.endsWith('.tsx')) {
      // Verificar se o nome é problemático
      const ehProblema = /^(Altere|Mude|Crie|Adicione|Implemente|Faça)/i.test(arquivo) ||
                         /(ONome|Para|De|A|O|Na|PGina|GestO|ProduO)/i.test(arquivo);
      
      if (ehProblema) {
        const novoNome = gerarNomeValido(arquivo);
        const caminhoNovo = path.join(diretorio, novoNome);
        
        // Verificar se o novo nome já existe
        if (!fs.existsSync(caminhoNovo)) {
          console.log(`Renomeando: ${arquivo} -> ${novoNome}`);
          fs.renameSync(caminhoAntigo, caminhoNovo);
        } else {
          console.log(`⚠️  Nome já existe: ${novoNome} (mantendo: ${arquivo})`);
        }
      }
    }
  });
}

// Processar diretório de componentes
const componentesDir = './Projetos/buildai-blank-main/src/components';
if (fs.existsSync(componentesDir)) {
  console.log('Processando diretório de componentes...');
  processarDiretorio(componentesDir);
  console.log('Limpeza concluída!');
} else {
  console.log('Diretório de componentes não encontrado.');
}