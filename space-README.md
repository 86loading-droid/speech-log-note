---
title: 발화 기록 노트 목소리 복제
emoji: 🎙️
colorFrom: blue
colorTo: indigo
sdk: gradio
app_file: app.py
pinned: false
---

발화 기록 노트(https://86loading-droid.github.io/speech-log-note/)의 목소리 복제 읽기 백엔드입니다.

학생 목소리를 참조로 받아 같은 목소리로 한국어 문장을 읽어 줍니다. XTTS-v2 를 사용하며, 모델 라이선스는 CPML(비상업)이라 교육·연구 용도에 적합합니다.

## 올리는 방법

1. 허깅페이스에 로그인하고 New Space 를 만듭니다. SDK 는 Gradio 를 고릅니다.
2. Visibility 는 Private 를 권합니다.
3. Hardware 를 ZeroGPU 로 바꿉니다. 무료 계정도 2개까지 만들 수 있으며, 하루 GPU 5분이 제공됩니다.
4. `app.py`, `requirements.txt`, 이 `README.md` 를 올립니다.
5. 빌드가 끝나면 Space 주소(`https://<계정>-<이름>.hf.space`)를 중계 서버 설정에 넣습니다.

## API

`POST /gradio_api/upload` 로 참조 음성을 올리고, `POST /gradio_api/call/speak` 로 읽기를 요청합니다. 중계 서버(worker.js)가 이 절차를 대신합니다.
