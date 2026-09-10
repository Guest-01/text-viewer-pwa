# 본문 명조체용 Noto Serif KR 서브셋 woff2 생성
# 범위: KS X 1001 완성형 한글 2,350자 + 호환 자모 + 라틴/Latin-1 + 일반 구두점 + CJK 기호 + 전각 기호
# 사용:
#   python -m venv .fontenv && .fontenv/Scripts/pip install fonttools brotli   (최초 1회)
#   .fontenv/Scripts/python scripts/make-font.py [--src NotoSerifKR-Regular.otf]
# 원본 OTF를 지정하지 않으면 Noto CJK 저장소에서 임시 폴더로 내려받는다.
import argparse
import os
import sys
import tempfile
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

SRC_URL = 'https://github.com/notofonts/noto-cjk/raw/main/Serif/SubsetOTF/KR/NotoSerifKR-Regular.otf'
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'fonts')
OUT_NAME = 'noto-serif-kr-2350-v1.woff2'


def unicodes():
    cps = set()
    # KS X 1001 완성형 한글 2,350자: euc_kr 코덱에서 2바이트로 인코딩되는 음절만
    # (완성형 밖 음절은 Python이 8바이트 확장 시퀀스로 인코딩하므로 길이로 걸러낸다)
    for cp in range(0xAC00, 0xD7A4):
        try:
            if len(chr(cp).encode('euc_kr')) == 2:
                cps.add(cp)
        except UnicodeEncodeError:
            pass
    ranges = [
        (0x0020, 0x007E),  # ASCII
        (0x00A0, 0x00FF),  # Latin-1 보충 (©, ·, ×, 악센트 문자 등)
        (0x02C6, 0x02DC),  # 수식 기호 일부
        (0x2010, 0x2027),  # 하이픈, 대시, 따옴표, 불릿, 말줄임표
        (0x2030, 0x205E),  # 퍼밀, 프라임, 홑낫표 따옴표 등
        (0x20A9, 0x20A9),  # 원 기호 ₩
        (0x2100, 0x214F),  # ℃ 등 문자형 기호
        (0x2190, 0x2199),  # 화살표
        (0x2200, 0x22FF),  # 수학 기호
        (0x2460, 0x24FF),  # 원문자 ①②
        (0x2500, 0x257F),  # 괘선
        (0x25A0, 0x25FF),  # 도형 ■□●○
        (0x2600, 0x2606),  # ☆★
        (0x3000, 0x303F),  # CJK 기호와 구두점 (「」『』〈〉《》【】 등)
        (0x3131, 0x318E),  # 한글 호환 자모 (ㄱ, ㅏ, ㆍ 등)
        (0xFF01, 0xFF5E),  # 전각 기호와 영숫자
        (0xFFE6, 0xFFE6),  # 전각 원 기호
    ]
    for lo, hi in ranges:
        cps.update(range(lo, hi + 1))
    return cps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', help='NotoSerifKR-Regular.otf 경로 (없으면 내려받음)')
    args = ap.parse_args()

    src = args.src
    if not src:
        src = os.path.join(tempfile.gettempdir(), 'NotoSerifKR-Regular.otf')
        if not os.path.exists(src) or os.path.getsize(src) < 1_000_000:
            print('내려받는 중:', SRC_URL)
            urllib.request.urlretrieve(SRC_URL, src)
    with open(src, 'rb') as f:
        if f.read(4) != b'OTTO':
            sys.exit('원본이 OTF가 아닙니다: ' + src)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, OUT_NAME)

    options = subset.Options()
    options.flavor = 'woff2'
    options.hinting = False
    options.desubroutinize = True
    options.layout_features = ['kern', 'palt', 'liga', 'ccmp', 'locl']
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]  # 저작권/이름 정보는 유지
    options.notdef_outline = True

    font = TTFont(src)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes())
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(out)

    glyphs = len(font.getGlyphOrder())
    print(f'생성: {os.path.relpath(out)}  글리프 {glyphs}개  {os.path.getsize(out) / 1024:.0f}KB')


if __name__ == '__main__':
    main()
