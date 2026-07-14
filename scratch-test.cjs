const fs = require('fs');

async function test() {
  const envContent = fs.readFileSync('.dev.vars', 'utf-8');
  const apiKey = envContent.match(/GEMINI_API_KEY_1=(.*)/)[1].trim();

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: '일본 애니메이션 포켓몬스터 아름다운 소원의 별 지라치 OST 小さきもの 한국어 정식 발매명/번역명은?' }] }],
      tools: [{ googleSearch: {} }]
    })
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

test();
