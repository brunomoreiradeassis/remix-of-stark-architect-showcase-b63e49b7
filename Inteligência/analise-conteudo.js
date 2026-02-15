// Sistema para analisar conteúdo e renomear arquivos adequadamente
import fs from 'fs';
import path from 'path';

function analisarTipoConteudo(conteudo) {
  // Verificar se é um componente React
  if (conteudo.includes('React') || conteudo.includes('export default') || 
      conteudo.includes('function') || conteudo.includes('const') ||
      conteudo.includes('interface') || conteudo.includes('type')) {
    return 'componente';
  }
  
  // Verificar se é HTML
  if (conteudo.includes('<!DOCTYPE') || conteudo.includes('<html') || 
      conteudo.includes('<head>') || conteudo.includes('<body>')) {
    return 'html';
  }
  
  // Verificar se é documentação/markdown
  if (conteudo.includes('# ') || conteudo.includes('**') || 
      conteudo.includes('```') || conteudo.includes('- [ ]')) {
    return 'documentacao';
  }
  
  // Verificar se é configuração
  if (conteudo.includes('{') && conteudo.includes('}') && 
      (conteudo.includes('"') || conteudo.includes(':') || conteudo.includes(','))) {
    return 'configuracao';
  }
  
  return 'desconhecido';
}

function gerarNomeAdequado(conteudo, nomeAntigo) {
  const tipo = analisarTipoConteudo(conteudo);
  
  switch (tipo) {
    case 'componente':
      // Extrair nome do componente do conteúdo
      const matchComponent = conteudo.match(/export\s+default\s+function\s+(\w+)/) ||
                            conteudo.match(/const\s+(\w+)\s*=/);
      if (matchComponent) {
        return matchComponent[1] + '.tsx';
      }
      return 'ComponenteReact.tsx';
      
    case 'html':
      return 'index.html';
      
    case 'documentacao':
      // Usar nome baseado no conteúdo da documentação
      if (conteudo.includes('ERP') || conteudo.includes('Sistema')) {
        return 'SistemaERP.md';
      }
      return 'Documentacao.md';
      
    case 'configuracao':
      return 'configuracao.json';
      
    default:
      // Para conteúdo desconhecido, usar nome genérico
      return 'ArquivoConteudo.tsx';
  }
}

function processarArquivos() {
  const componentesDir = './Projetos/buildai-blank-main/src/components';
  
  if (!fs.existsSync(componentesDir)) {
    console.log('Diretório não encontrado:', componentesDir);
    return;
  }
  
  const arquivos = fs.readdirSync(componentesDir);
  
  arquivos.forEach(arquivo => {
    if (arquivo.endsWith('.tsx')) {
      const caminho = path.join(componentesDir, arquivo);
      const conteudo = fs.readFileSync(caminho, 'utf8');
      
      console.log('\n=== Analisando:', arquivo);
      console.log('Tipo detectado:', analisarTipoConteudo(conteudo));
      
      const novoNome = gerarNomeAdequado(conteudo, arquivo);
      console.log('Sugestão de nome:', novoNome);
    }
  });
}

console.log('Iniciando análise de conteúdo dos arquivos...');
processarArquivos();