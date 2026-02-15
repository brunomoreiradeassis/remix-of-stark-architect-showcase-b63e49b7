// Script para restaurar nomes baseados no conteúdo real dos arquivos
import fs from 'fs';
import path from 'path';

function extrairNomeDoComponente(conteudo) {
  // Tentar extrair o nome do componente do export default
  const matchExportDefault = conteudo.match(/export\s+default\s+function\s+(\w+)/);
  if (matchExportDefault) return matchExportDefault[1];
  
  // Tentar extrair de const com export default
  const matchConstExport = conteudo.match(/const\s+(\w+)\s*=[\s\S]*?export\s+default\s+\1/);
  if (matchConstExport) return matchConstExport[1];
  
  // Tentar extrair de function nomeada
  const matchFunction = conteudo.match(/function\s+(\w+)\s*\(/);
  if (matchFunction) return matchFunction[1];
  
  // Tentar extrair de const
  const matchConst = conteudo.match(/const\s+(\w+)\s*=/);
  if (matchConst) return matchConst[1];
  
  return null;
}

function determinarNomeAdequado(conteudo, caminhoArquivo) {
  const nomeComponente = extrairNomeDoComponente(conteudo);
  
  if (nomeComponente) {
    // Se encontrou um nome de componente, usar esse nome
    return nomeComponente + '.tsx';
  }
  
  // Se não encontrou, analisar o conteúdo para determinar o tipo
  if (conteudo.includes('<!DOCTYPE') || conteudo.includes('<html')) {
    return 'index.html';
  }
  
  if (conteudo.includes('export const') || conteudo.includes('export function')) {
    // É um utilitário ou hook
    const baseName = path.basename(caminhoArquivo, '.tsx');
    return baseName + '.ts';
  }
  
  // Para outros casos, manter o nome atual mas garantir extensão correta
  return path.basename(caminhoArquivo);
}

function processarDiretorio(diretorio) {
  const arquivos = fs.readdirSync(diretorio);
  const mudanças = [];
  
  arquivos.forEach(arquivo => {
    if (arquivo.endsWith('.tsx') || arquivo.endsWith('.ts')) {
      const caminhoAntigo = path.join(diretorio, arquivo);
      const conteudo = fs.readFileSync(caminhoAntigo, 'utf8');
      
      const novoNome = determinarNomeAdequado(conteudo, caminhoAntigo);
      
      if (novoNome !== arquivo) {
        const caminhoNovo = path.join(diretorio, novoNome);
        
        if (!fs.existsSync(caminhoNovo)) {
          console.log(`Renomeando: ${arquivo} -> ${novoNome}`);
          fs.renameSync(caminhoAntigo, caminhoNovo);
          mudanças.push({ antigo: arquivo, novo: novoNome });
        } else {
          console.log(`⚠️  Nome já existe: ${novoNome} (mantendo: ${arquivo})`);
        }
      }
    }
  });
  
  return mudanças;
}

// Executar a restauração
console.log('Iniciando restauração de nomes baseada no conteúdo...');

const componentesDir = './Projetos/buildai-blank-main/src/components';
if (fs.existsSync(componentesDir)) {
  const mudanças = processarDiretorio(componentesDir);
  
  console.log('\n=== RESUMO DAS ALTERAÇÕES ===');
  mudanças.forEach(mud => {
    console.log(`✅ ${mud.antigo} -> ${mud.novo}`);
  });
  
  console.log(`\nTotal de arquivos renomeados: ${mudanças.length}`);
} else {
  console.log('Diretório de componentes não encontrado.');
}