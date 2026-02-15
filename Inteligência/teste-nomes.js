// Teste simples de nomenclatura
console.log('=== TESTE DE NOMES ===');

const nomesTeste = [
  'AltereONomeDeBuildAIParaERP5.tsx',
  'MudeONomeBuildAIParaSistemaERP6.tsx',
  'CrieUmBotONaPGinaInicialParaAcessarAPGinaGestOProduO.tsx'
];

nomesTeste.forEach(nome => {
  const comprimento = nome.length;
  const temInstrucao = /^(Altere|Mude|Crie|Adicione|Implemente|Faça)/i.test(nome);
  const temPalavrasProibidas = /(ONome|Para|De|A|O|Na|PGina|GestO|ProduO)/i.test(nome);
  
  console.log(`\n${nome}:`);
  console.log(`Comprimento: ${comprimento} caracteres ${comprimento > 50 ? '❌' : '✅'}`);
  console.log(`Tem instrução: ${temInstrucao ? '❌' : '✅'}`);
  console.log(`Tem palavras proibidas: ${temPalavrasProibidas ? '❌' : '✅'}`);
});