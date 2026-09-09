// 테스트용 데모 텍스트 파일 생성 (UTF-8 / EUC-KR 두 가지 인코딩)
// 사용: node scripts/make-demo.js
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'demo');
fs.mkdirSync(OUT, { recursive: true });

const TITLE = '등대지기의 서고';

const PARAGRAPHS = [
  '바다 끝에 선 등대는 밤마다 같은 속도로 돌았다. 서른두 번의 회전이 한 시간이었고, 그 사이 등대지기 노인은 서고의 책 한 권을 읽었다. 책은 언제나 마지막 장에서 멈춰 있었다. 노인은 그 마지막 장을 읽는 대신, 바람이 창틀을 두드리는 소리를 세었다.',
  '서고는 등대의 나선 계단 아래, 습기가 고이는 방에 있었다. 책장에는 표지가 없는 책들이 빽빽했다. 어느 책도 제목이 없었지만 노인은 손끝의 감촉만으로 어느 책이 어느 밤에 닿았던 것인지 기억했다. 가장 낡은 책은 파도 소리가 났고, 가장 새 책은 아직 아무 소리도 내지 않았다.',
  '"오늘은 배가 오지 않을 겁니다." 소년이 계단을 내려오며 말했다. 소년은 마을에서 매주 한 번 기름과 빵을 가져왔다. 노인은 고개를 끄덕였다. 배가 오지 않는 밤에도 등대는 돌아야 했다. 그것이 등대의 약속이었고, 노인의 약속이었다.',
  '소년은 책장 앞에 서서 오래 망설였다. 표지 없는 책들 사이에서 하나를 고른다는 건, 이름 없는 밤들 가운데 하나를 고르는 것과 같았다. 결국 소년은 눈을 감고 손을 뻗었다. 손끝에 닿은 책은 차갑고 조금 젖어 있었다.',
  '책을 펼치자 첫 문장이 바람처럼 튀어나왔다. "여기서부터는 돌아갈 수 없다." 소년은 그 문장을 세 번 읽었다. 돌아갈 수 없다는 말이 무섭기보다는, 어쩐지 등대 불빛이 바다 위에 남기는 긴 길 같아서 좋았다.',
  '노인은 소년이 책을 읽는 동안 램프의 심지를 갈았다. 심지는 언제나 조금 짧게 잘라야 했다. 너무 길면 그을음이 유리를 덮고, 너무 짧으면 불이 바다까지 닿지 못했다. 노인은 그 길이를 손가락 한 마디로 재었다. 오십 년 동안 그 손가락은 조금씩 굽어 갔지만, 길이는 변하지 않았다.',
  '밤이 깊어지자 파도가 계단 아래까지 올라왔다. 소년은 책을 가슴에 안고 계단을 뛰어올랐다. 노인은 서두르지 않았다. 서고의 책들은 젖어도 마르고, 말라도 다시 젖었다. 그것이 이 서고의 책들이 표지를 갖지 못한 이유였다.',
  '"왜 마지막 장은 읽지 않으세요?" 소년이 물었다. 노인은 등대 창밖으로 회전하는 불빛을 바라보았다. "마지막 장을 읽으면 그 책은 끝나지. 나는 끝나지 않은 것들을 지키는 사람이야." 소년은 그 말을 이해하지 못했지만, 언젠가는 이해하게 될 것 같았다.',
  '새벽이 오기 전, 가장 어두운 시간에 등대 불빛은 유난히 멀리 나갔다. 노인은 그 시간을 "서고의 시간"이라고 불렀다. 그때 서고의 책들은 저마다 조금씩 소리를 냈다. 종이가 마르는 소리, 잉크가 가라앉는 소리, 그리고 아직 쓰이지 않은 페이지가 기다리는 소리.',
  '소년은 그날 밤 서고에서 잠들었다. 꿈속에서 소년은 표지 없는 책이 되어 책장에 꽂혀 있었다. 누군가의 손이 소년을 꺼내 펼쳤고, 첫 문장을 읽었다. "여기서부터는 돌아갈 수 없다." 소년은 그 손이 자신의 손이라는 것을 알았다.',
  '아침에 배가 왔다. 오지 않을 거라던 배였다. 배에는 새 책이 한 권 실려 있었다. 표지가 있는 책이었다. 노인은 그 책을 받아 들고 오래 바라보다가, 표지를 조심스럽게 떼어 냈다. 그리고 서고의 빈 자리에 꽂았다. "이제 이 책도 끝나지 않게 됐군."',
  '등대는 오늘 밤도 서른두 번 돌 것이다. 노인은 서고로 내려가 어제 멈춘 책을 펼칠 것이다. 마지막 장 앞에서 멈출 것이고, 바람이 창틀을 두드리는 소리를 셀 것이다. 그리고 소년은, 언젠가 그 자리에 앉게 될 것이다.',
];

const ENGLISH =
  'This paragraph is in English to check mixed-script wrapping. The lighthouse keeper counted thirty-two rotations per hour, and between each rotation he read one page from a book without a cover. Long words like "incomprehensibilities" and URLs such as https://example.com/very/long/path/that/should/wrap/gracefully must not overflow the page.';

const CHAPTER_TITLES = [
  '서른두 번의 회전', '표지 없는 책', '배가 오지 않는 밤', '눈을 감고 고른 책',
  '돌아갈 수 없다', '심지의 길이', '젖은 계단', '끝나지 않은 것들',
  '서고의 시간', '책이 된 소년', '표지를 떼다', '내일의 등대',
];

function buildStory() {
  const lines = [];
  lines.push(TITLE);
  lines.push('');
  lines.push('※ 이 글은 텍스트 뷰어 PWA 테스트용으로 작성된 짧은 창작 소설입니다.');
  lines.push('※ 문단이 반복되지만, 장(章) 번호와 제목으로 위치를 구분할 수 있습니다.');
  lines.push('');
  lines.push('');
  for (let c = 0; c < CHAPTER_TITLES.length; c++) {
    lines.push(`제${c + 1}장 ${CHAPTER_TITLES[c]}`);
    lines.push('');
    // 장마다 문단 순서를 바꾸고, 문단 앞에 장 표시를 넣어 위치 확인이 쉽도록 한다.
    for (let i = 0; i < PARAGRAPHS.length; i++) {
      const p = PARAGRAPHS[(i + c) % PARAGRAPHS.length];
      lines.push(`  [${c + 1}-${i + 1}] ${p}`);
      lines.push('');
    }
    if (c === 2) {
      lines.push(`  [${c + 1}-EN] ${ENGLISH}`);
      lines.push('');
    }
    if (c === 5) {
      // 줄바꿈 없는 아주 긴 문단 (블록 분할 테스트)
      const long = Array.from({ length: 30 }, (_, k) => `(${k + 1}) ${PARAGRAPHS[k % PARAGRAPHS.length]}`).join(' ');
      lines.push(`  [${c + 1}-LONG] ${long}`);
      lines.push('');
    }
    lines.push('');
  }
  lines.push('— 끝 —');
  return lines.join('\n');
}

// ---------- EUC-KR(CP949) 인코더: TextDecoder 역매핑으로 생성 ----------
function buildEucKrEncoder() {
  let dec;
  try {
    dec = new TextDecoder('euc-kr');
  } catch {
    return null;
  }
  const map = new Map();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x41; trail <= 0xfe; trail++) {
      pair[0] = lead;
      pair[1] = trail;
      const s = dec.decode(pair);
      if (s.length === 1 && s !== '�' && !map.has(s)) map.set(s, [lead, trail]);
    }
  }
  return (text) => {
    const bytes = [];
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 0x80) {
        bytes.push(code);
      } else if (map.has(ch)) {
        bytes.push(...map.get(ch));
      } else {
        bytes.push(0x3f); // '?'
      }
    }
    return Buffer.from(bytes);
  };
}

const story = buildStory();
const utf8Path = path.join(OUT, 'sample-utf8.txt');
fs.writeFileSync(utf8Path, story, 'utf8');
console.log('생성:', path.relative(process.cwd(), utf8Path), `(${story.length}자, ${fs.statSync(utf8Path).size} bytes)`);

const encode = buildEucKrEncoder();
if (encode) {
  // EUC-KR 파일은 Windows 스타일 줄바꿈(CRLF)으로 저장해 정규화도 함께 테스트한다.
  const euc = encode(story.replace(/\n/g, '\r\n'));
  const eucPath = path.join(OUT, 'sample-euckr.txt');
  fs.writeFileSync(eucPath, euc);
  console.log('생성:', path.relative(process.cwd(), eucPath), `(${euc.length} bytes)`);
} else {
  console.warn('이 Node 빌드는 euc-kr TextDecoder를 지원하지 않아 EUC-KR 데모를 건너뜁니다.');
}
