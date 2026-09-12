#!/usr/bin/env bash
# 발화 기록 노트 — GitHub 저장소 생성 + Pages 배포 자동 실행
# 사용: GitHub 계정 연결 후  bash deploy.sh
set -euo pipefail

OWNER="86loading-droid"
REPO="speech-log-note"
DESC="학생 발화를 실시간 텍스트로 기록하는 특수교육 현장용 웹앱 (음성인식·화자/기록자 메타데이터·12~100pt 글자 크기)"
API="https://api.github.com"
AUTH=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -H "Content-Type: application/json")

say(){ printf '\n>> %s\n' "$1"; }

say "1/5 인증 확인"
LOGIN=$(curl -fsS "${AUTH[@]}" "$API/user" | python3 -c 'import json,sys;print(json.load(sys.stdin)["login"])')
echo "   연결된 계정: $LOGIN"

say "2/5 저장소 확인·생성"
if curl -fsS -o /dev/null "${AUTH[@]}" "$API/repos/$OWNER/$REPO" 2>/dev/null; then
  echo "   이미 존재 — 기존 저장소에 push 합니다"
else
  curl -fsS -X POST "${AUTH[@]}" "$API/user/repos" \
    -d "$(python3 -c "import json;print(json.dumps({'name':'$REPO','description':'''$DESC''','private':False,'has_issues':True,'has_wiki':False,'auto_init':False}))")" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print("   생성 완료:",d["html_url"])'
fi

say "3/5 소스 push"
cd "$(dirname "$0")"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/$OWNER/$REPO.git"
git push -u origin main --force
echo "   push 완료"

say "4/5 GitHub Pages 활성화"
curl -fsS -X POST "${AUTH[@]}" "$API/repos/$OWNER/$REPO/pages" \
  -d '{"source":{"branch":"main","path":"/"}}' >/dev/null 2>&1 \
  || curl -fsS -X PUT "${AUTH[@]}" "$API/repos/$OWNER/$REPO/pages" \
       -d '{"source":{"branch":"main","path":"/"}}' >/dev/null
echo "   Pages 설정 완료"

say "5/5 빌드 대기"
URL=""
for i in $(seq 1 30); do
  sleep 10
  S=$(curl -fsS "${AUTH[@]}" "$API/repos/$OWNER/$REPO/pages" 2>/dev/null \
      | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status"),d.get("html_url"))' 2>/dev/null || echo "pending -")
  echo "   [$i] $S"
  case "$S" in built*) URL=${S#built }; break;; esac
done

say "완료"
echo "저장소 : https://github.com/$OWNER/$REPO"
echo "앱 주소 : ${URL:-https://$OWNER.github.io/$REPO/}"
