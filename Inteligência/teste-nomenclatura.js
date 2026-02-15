// Teste do sistema de nomenclatura
import { NomeUtils } from './Inteligência/nome-utils.js';

// Testar os exemplos problemáticos
const exemplosTeste = [
  'AltereONomeDeBuildAIParaERP5',
  'MudeONomeBuildAIParaSistemaERP6',
  'CrieUmBotONaPGinaInicialParaAcessarAPGinaGestOProduO'
];

console.log('=== TESTE DE VALIDAÇÃO ===');
exemplosTeste.forEach(nome => {
  const resultado = NomeUtils.validarNomeArquivo(nome + '.tsx');
  console.log(`${nome}.tsx: ${resultado.valido ? '✅ VÁLIDO' : '❌ INVÁLIDO - ' + resultado.erro}`);
});

console.log('\n=== SUGESTÕES DE NOMES VÁLIDOS ===');
exemplosTeste.forEach(nome => {
  const sugestao = NomeUtils.gerarNomeValido(nome);
  console.log(`${nome} -> ${sugestao}`);
});

console.log('\n=== EXEMPLOS VÁLIDOS DO SISTEMA ===');
NomeUtils.obterExemplosValidos().forEach(exemplo => {
  console.log(`✅ ${exemplo}`);
});