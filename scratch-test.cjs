const fs = require('fs');

async function test() {
  const envContent = fs.readFileSync('.dev.vars', 'utf-8');
  const apiKey = envContent.match(/GEMINI_API_KEY_1=(.*)/)[1].trim();
  const { extractSongTitle } = await import('./functions/api/gemini.js');

  const title = await extractSongTitle({
    apiKey,
    prompt: `일본 애니메이션 포켓몬스터 아름다운 소원의 별 지라치 OST 小さきもの의 한국 팬덤 통용명을 찾아줘.
반드시 {"final_title":"..."} JSON만 반환해.`
  });

  console.log(title);
}

test();
