// Script melhorado para renomear arquivos com nomes problemáticos
import fs from 'fs';
import path from 'path';

function gerarNomeSignificativo(nomeAntigo) {
  // Mapeamento de palavras-chave para nomes significativos
  const mapeamento = {
    'altera': 'Configuracao',
    'mude': 'Atualizacao', 
    'crie': 'Criacao',
    'buildai': 'Sistema',
    'erp': 'ERP',
    'industrial': 'Industrial',
    'financeiro': 'Financeiro',
    'estoque': 'Estoque',
    'producao': 'Producao',
    'qualidade': 'Qualidade',
    'logistica': 'Logistica',
    'manutencao': 'Manutencao',
    'rh': 'RH',
    'card': 'Card',
    'page': 'Page',
    'bot': 'Bot',
    'sistema': 'Sistema',
    'gestao': 'Gestao'
  };

  // Extrair palavras significativas
  const palavras = nomeAntigo
    .toLowerCase()
    .replace(/\.tsx$/, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(palavra => palavra.length > 2); // Filtrar palavras muito curtas

  // Mapear palavras para termos significativos
  const palavrasMapeadas = palavras
    .map(palavra => mapeamento[palavra] || palavra)
    .filter(termo => termo && termo.length > 0);

  // Criar nome PascalCase
  let nomeBase = palavrasMapeadas
    .map(termo => termo.charAt(0).toUpperCase() + termo.slice(1))
    .join('');

  // Se o nome ficar vazio ou muito curto, usar nome baseado no conteúdo
  if (!nomeBase || nomeBase.length < 3) {
    if (nomeAntigo.includes('Card')) {
      nomeBase = 'ComponenteCard';
    } else if (nomeAntigo.includes('Page')) {
      nomeBase = 'Pagina';
    } else {
      nomeBase = 'Componente';
    }
    
    // Adicionar número sequencial se necessário
    const numeroMatch = nomeAntigo.match(/\d+$/);
    if (numeroMatch) {
      nomeBase += numeroMatch[0];
    }
  }

  return nomeBase + '.tsx';
}

function processarDiretorio(diretorio) {
  const arquivos = fs.readdirSync(diretorio);
  
  arquivos.forEach(arquivo => {
    const caminhoAntigo = path.join(diretorio, arquivo);
    const stat = fs.statSync(caminhoAntigo);
    
    if (stat.isFile() && arquivo.endsWith('.tsx')) {
      // Verificar se o nome é problemático (contém instruções)
      const ehProblema = /^(Altere|Mude|Crie|Adicione|Implemente|Faça)/i.test(arquivo) ||
                         /(ONome|Para|De|A|O|Na|PGina|GestO|ProduO)/i.test(arquivo) ||
                         arquivo.length > 40; // Nomes muito longos
      
      if (ehProblema) {
        const novoNome = gerarNomeSignificativo(arquivo);
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

// Primeiro, restaurar os nomes originais para testar
console.log('Iniciando limpeza de nomes...');

// Processar diretório de componentes
const componentesDir = './Projetos/buildai-blank-main/src/components';
if (fs.existsSync(componentesDir)) {
  console.log('Processando diretório de componentes...');
  processarDiretorio(componentesDir);
  console.log('Limpeza concluída!');
} else {
  console.log('Diretório de componentes não encontrado.');
}